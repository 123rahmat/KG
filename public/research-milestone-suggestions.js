/**
 * Optional Research recommendations at MATERIAL evidence checkpoints.
 * Derived only from persisted work. No model call, no invented source,
 * citation, factual verification or automatic action.
 */
const arr=x=>Array.isArray(x)?x:[];
const clean=x=>String(x??'').trim().slice(0,180);
const finalStates=new Set(['complete','failed','blocked','exhausted','iterate']);
export function researchMilestoneSuggestion(run){
  if(!run || (run.surface??run.adaptation?.primarySurface)!=='research')return null;
  const tasks=arr(run.tasks);
  if(!tasks.length)return null;
  const workspace=run.adaptation?.researchWorkspace??{};
  const sources=arr(workspace.sourceSet);
  const findings=arr(workspace.evidenceLedger);
  const conflicts=arr(workspace.conflicts);
  const gaps=arr(workspace.unresolvedQuestions);
  const next=finalStates.has(run.state)?null:tasks.find(task=>task?.id===run.next);
  const saved=tasks.filter(t=>t?.status==='complete');
  const stageId=clean(next?.id||saved.at(-1)?.id||run.state||'research');
  const report=(kind,title,why,request)=>Object.freeze({
    id:String(run.id??'local')+'|'+String(run.attempt??1)+'|research-'+kind+'|'+stageId,
    kind,title,why,request,
    provenance:'Suggestion from saved Research state, not new evidence. Nothing runs until you submit it.'
  });
  if(conflicts.length){
    return report('conflicting-sources','Resolve the recorded evidence conflict',
      String(conflicts.length)+' unresolved conflict'+(conflicts.length===1?'':'s')+' recorded',
      'Compare the conflicting recorded claims and their actual source dates, methods, and limitations. State which interpretation is supported and which remains uncertain; retrieve independent evidence only if authorized.');
  }
  if(next?.type==='investigate' && sources.length===0){
    return report('source-discovery','Prioritize primary, traceable evidence',
      'Investigation is selected and no source has been recorded in this Research workspace',
      'Prioritize authoritative primary sources, publication dates, and the exact claims each can support. Clearly distinguish unknown data from established facts.');
  }
  if(gaps.length && saved.some(task=>task.type==='investigate')){
    return report('evidence-gap','Check the most decisive unanswered question',
      String(gaps.length)+' unresolved evidence question'+(gaps.length===1?'':'s')+' recorded',
      'Identify which recorded unresolved research question could change the answer most, then propose the smallest authorized evidence check. Do not assume missing evidence has been resolved.');
  }
  if(next?.type==='verify' && findings.length){
    const withSources=findings.filter(f=>arr(f?.sourceKeys).length>0).length;
    return report('citation-audit','Check claim-to-source coverage',
      String(withSources)+' of '+findings.length+' recorded findings have associated source keys',
      'Check each material research claim against its actually recorded source and date. Separate unsupported findings, conflicting evidence and limitations before concluding.');
  }
  if(finalStates.has(run.state) && findings.length && sources.length){
    return report('research-next','Consider the next useful research test',
      'The Research workspace has '+findings.length+' saved finding'+(findings.length===1?'':'s')+' and '+sources.length+' source'+(sources.length===1?'':'s'),
      'Propose one testable follow-up question that would most improve the recorded research, without repeating already-supported claims or assuming further investigation is required.');
  }
  return null;
}
