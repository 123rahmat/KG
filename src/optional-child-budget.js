/**
 * Value-based admission for OPTIONAL child-model probes. This is a ceiling,
 * not a promise to spend calls. The parent verification, human approval and
 * evidence-retrieval stages are never suppressed here.
 */
const num=x=>Number.isFinite(Number(x))?Math.max(0,Math.min(1,Number(x))):0;
const array=x=>Array.isArray(x)?x:[];
const consequence=new Set(['high','critical','high-impact','physical','regulated']);
export function optionalChildCallBudget({
  run={},task={},mode='auto',maxAgents=6,configuredMax=null,
  observedFindings=[]
}={}){
  const surface=run.surface??run.adaptation?.primarySurface??'normal-chat';
  const taskType=task.type??'';
  const full=Math.max(0,Math.min(12,Math.floor(Number(maxAgents)||1)));
  if(mode==='off'||surface==='normal-chat'||['verify','respond','deliver','approval','clarify'].includes(taskType)
    ||(task.id==='test-code'))return Object.freeze({limit:0,reason:'parent-or-direct-stage'});
  // An explicit operator-provided child allowance is still an upper bound,
  // never a mandate to execute (the existing per-child evidence gate decides).
  const explicit=configuredMax!==null && configuredMax!==undefined
    && Number.isFinite(Number(configuredMax)) && Number(configuredMax)>=0;
  if(explicit)return Object.freeze({
    limit:Math.min(full,Math.floor(Number(configuredMax))),
    reason:'explicit-child-compute-allowance'
  });
  const situation=run.situation??{};
  const pressure=Math.max(num(situation.complexity),num(situation.uncertainty));
  const criteria=array(situation.successCriteria).length;
  const unknowns=array(situation.unknowns).length+
    array(run.adaptation?.researchWorkspace?.unresolvedQuestions).length;
  const conflicts=array(run.adaptation?.researchWorkspace?.conflicts).length;
  const openFindings=array(observedFindings).filter(x=>
    array(x?.unknowns).length || array(x?.risks).length
    || ['investigate','revise'].includes(x?.recommendation)).length;
  const highRisk=consequence.has(String(situation.risk??'').toLowerCase());
  const isBrainstorm=task.metadata?.ventureDiscovery===true||task.ventureDiscovery===true;
  const isCodingBuild=surface==='code'&&['code','plan','reassess','step','understand'].includes(taskType);
  const isResearch=surface==='research'&&['investigate','step','reassess','plan','understand'].includes(taskType);
  if(!isCodingBuild&&!isResearch)return Object.freeze({limit:0,reason:'no-independent-child-work'});
  if(!highRisk && pressure<.55 && criteria<4 && unknowns===0 && conflicts===0 && openFindings===0)
    return Object.freeze({limit:0,reason:'parent-specialists-sufficient'});
  if(isBrainstorm && !highRisk && conflicts===0 && openFindings===0 && unknowns===0 && pressure<.8)
    return Object.freeze({limit:0,reason:'creative-breadth-covered-by-main-panel'});
  const need=Math.max(
    pressure>=.85?2:pressure>=.55?1:0,
    criteria>=6?2:criteria>=4?1:0,
    unknowns>=3||conflicts>=2?2:unknowns+conflicts>0?1:0,
    openFindings>=2?2:openFindings>0?1:0,
    highRisk?1:0
  );
  return Object.freeze({
    limit:Math.min(full,Math.max(0,need)),
    reason:'observed-independent-evidence-need'
  });
}
