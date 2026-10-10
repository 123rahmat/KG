/** Strictly read-only projection of task evidence for the main work surface. */
import { safeHref } from './markdown.js';
import { tablePreviewModel } from './table-preview-model.js';

const arr = v => Array.isArray(v) ? v : [];
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const clip = (v, n = 1200) => typeof v === 'string' ? v.slice(0, n) : '';
const name = v => String(v ?? '').slice(0, 110);
const DONE = new Set(['complete','failed','blocked','exhausted','iterate']);
const numeric = v => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
  ? Math.floor(Number(v)) : null;
const terminalValue = v => typeof v === 'string' ? v.slice(-11000) : '';
const outputOf = task => {
  const result = object(task?.evidence?.result);
  return Object.keys(object(result.output)).length ? result.output : result;
};
const validTable = v => v && typeof v === 'object'
  && Array.isArray(v.sample) && v.sample.length > 0;
const rawEvidence = task => object(task?.evidence);
const taskName = task => name(task?.metadata?.title || task?.purpose || task?.id || task?.type || 'Recorded step');
const verifiedReceipt = task => task?.executionReceipt?.serverAuthenticated === true
  || task?.evidence?.executionReceipt?.serverAuthenticated === true;
const artifact = v => v && typeof v === 'object' && typeof v.id === 'string' && v.id
  ? { id:v.id, name:name(v.name || v.title || 'Saved artifact'), contentType:name(v.contentType), format:name(v.format) }
  : null;

function recordOutput(task) {
  const e = rawEvidence(task), out = outputOf(task);
  if (!Object.keys(object(e.result)).length) return null;
  const program = object(out.program);
  const stdout = terminalValue(program.stdout || out.stdout || out.logs);
  const stderr = terminalValue(program.stderr || out.stderr);
  const test = object(out.testSummary);
  const total = numeric(test.total), passed = numeric(test.passed), failed = numeric(test.failed);
  const hasTests = total !== null && passed !== null && failed !== null;
  if (!stdout && !stderr && !hasTests) return null;
  return Object.freeze({
    type:'execution',taskId:name(task.id),title:taskName(task),
    label: verifiedReceipt(task) ? 'Authenticated execution receipt' : 'Recorded execution result · receipt not confirmed',
    stdout, stderr,
    tests:hasTests ? Object.freeze({total,passed,failed}) : null,
    status:name(out.status || task.status || 'recorded'),
    receiptVerified:verifiedReceipt(task)
  });
}

function recordTables(task) {
  const e=rawEvidence(task), output=outputOf(task);
  return [...arr(e.structured?.tables),...arr(output.tables),...arr(e.tables)]
    .filter(validTable).slice(0,2).map(table=>({
      type:'table',taskId:name(task.id),title:taskName(task),table:tablePreviewModel(table,{maxRows:10,maxColumns:8})
    })).filter(entry=>entry.table.rows.length>0);
}

function recordArtifacts(task) {
  const e=rawEvidence(task);
  return [e.result?.artifact,...arr(e.result?.artifacts),...arr(e.artifacts)]
    .map(artifact).filter(Boolean).slice(0,3)
    .map(value=>({type:'artifact',taskId:name(task.id),title:taskName(task),artifact:value}));
}

function recordText(task) {
  const e=rawEvidence(task);
  // Final response already has the full Markdown answer; never duplicate it.
  if (['respond','deliver'].includes(task.type)) return null;
  const body=clip(e.findings || e.summary || e.text || task.summary,1600);
  const prose=body.trim();
  if(!prose || prose.startsWith('{') || prose.startsWith('[')
    || prose===String(task.purpose??'').trim())return null;
  return Object.freeze({type:'text',taskId:name(task.id),title:taskName(task),text:body});
}

function researchRecords(run) {
  const research=object(run?.adaptation?.researchWorkspace);
  const sources=arr(research.sourceSet).filter(item=>item && typeof item==='object').slice(-6)
    .map(item=>({
      title:name(item.title || item.name || item.url || 'Recorded source'),
      url:/^https?:\/\//i.test(String(item.url??'')) ? safeHref(item.url) : null,
      detail:clip(item.kind || item.type || item.publisher || '',90)
    }));
  const ledger=arr(research.evidenceLedger).filter(item=>item && typeof item==='object')
    .slice(-6).map(item=>({
      finding:clip(item.summary || item.finding || item.text,300),
      sources:arr(item.sourceKeys).length
    })).filter(x=>x.finding);
  const entries=[];
  if (ledger.length>1) entries.push({
    type:'table',title:'Recorded research evidence',
    table:tablePreviewModel({name:'Evidence and linked sources',
      columns:['Evidence','Source links'],sample:ledger.map(item=>[item.finding,String(item.sources)])})
  });
  else if (ledger.length===1) entries.push({
    type:'text',title:'Latest recorded evidence',text:ledger[0].finding
  });
  if (sources.length) entries.push({type:'sources',title:'Sources in the research ledger',sources});
  const gaps=arr(research.unresolvedQuestions).map(item=>clip(typeof item==='string'?item:item?.description,180)).filter(Boolean);
  if(gaps.length)entries.push({type:'gaps',title:'Questions still open',values:gaps.slice(0,4)});
  return entries;
}

/**
 * Prioritize the kinds of output people actually need to inspect.
 * This model never creates synthetic terminal output, charts, files or sources.
 */
export function liveWorkSnapshot(run,{maxItems=6}={}) {
  const domain=run?.surface==='research' || run?.adaptation?.primarySurface==='research'
    ? 'research' : run?.surface==='code' || run?.adaptation?.primarySurface==='code'
      ? 'code' : null;
  const tasks=arr(run?.tasks);
  if(!domain || !tasks.length) return null;
  const terminal=DONE.has(run?.state);
  const current=terminal?null:tasks.find(task=>task.id===run?.next)??null;
  const limit=Math.max(1,Math.min(8,Number.isInteger(maxItems)?maxItems:6));
  const entries=[];
  for(const task of [...tasks].reverse().slice(0,12)) {
    // Never turn a queued/proposed step into "observed output".
    if (task.status==='pending'||task.status==='queued'||task.status==='skipped')continue;
    const execution=recordOutput(task);
    if(execution)entries.push(execution);
    entries.push(...recordTables(task),...recordArtifacts(task));
    const prose=recordText(task);
    if(prose)entries.push(prose);
  }
  if(domain==='research')entries.push(...researchRecords(run));
  const unique=new Set();
  const priority=domain==='code'
    ? {execution:0,table:1,artifact:2,text:3,sources:4,gaps:5}
    : {table:0,sources:1,text:2,artifact:3,execution:4,gaps:5};
  const selected=entries.filter(item=>{
    const key=item.type+'|'+(item.taskId??item.title)+'|'+(item.type==='artifact'?item.artifact.id:item.type==='text'?item.text.slice(0,90):item.type==='table'?item.table.name:'');
    if(unique.has(key))return false;
    unique.add(key);return true;
  }).sort((a,b)=>(priority[a.type]??8)-(priority[b.type]??8)).slice(0,limit);
  const completed=tasks.filter(task=>task.status==='complete').length;
  return Object.freeze({
    domain,
    title:domain==='code'?'Coding output':'Research output',
    currentStep:current?taskName(current):'',
    completedSteps:completed,
    recordedSteps:tasks.length,
    terminal,
    state:name(run.state),
    entries:Object.freeze(selected),
    steps:Object.freeze(tasks.slice(-7).map(task=>Object.freeze({
      title:taskName(task),status:name(task.status||'pending'),
      current:Boolean(current && current.id===task.id)
    }))),
    emptyMessage:current
      ? 'Working on '+taskName(current)+'. Captured output will appear here after the server records it.'
      : 'No execution output, figures, tables or source evidence have been recorded yet.',
    provenance:'Only saved task evidence and authorized artifact references appear here. A progress step alone does not prove execution.'
  });
}

