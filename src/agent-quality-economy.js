/**
 * Cheap, deterministic quality / latency / cost telemetry for each specialist
 * wave. Model findings are untrusted advisory observations, never verification
 * receipts. This is deliberately model-free: monitoring must not cost another
 * model call.
 */
const finite = (v,defaultValue=0)=>Number.isFinite(Number(v))?Number(v):defaultValue;
const norm = v=>typeof v==='string'
 ? v.replace(/\p{Cc}/gu,' ').replace(/\s+/g,' ').trim().toLowerCase().slice(0,220):'';
const items = (finding,key)=>Array.isArray(finding?.[key])
  ? finding[key].filter(s=>typeof s==='string').map(norm).filter(Boolean):[];
const NEED_FIELDS = ['unknowns','risks','actions'];
const toSet = findings=>new Set((Array.isArray(findings)?findings:[])
  .flatMap(f=>NEED_FIELDS.flatMap(field=>items(f,field))));
const uniqueSummary = findings=>new Set((Array.isArray(findings)?findings:[])
  .map(f=>norm(f?.summary)).filter(Boolean));

/**
 * Track marginal informational value, not just number of workers.
 * An unverified claim is NEVER counted as an accepted check, source or test.
 */
export function agentWaveEconomy({
  before=[],after=[],wave=[],tokens=0,elapsedMs=0,modelCalls=null
}={}){
 const prev=Array.isArray(before)?before.filter(Boolean):[];
 const current=Array.isArray(wave)?wave.filter(Boolean):[];
 const result=Array.isArray(after)?after.filter(Boolean):[...prev,...current];
 const previously=toSet(prev),now=toSet(result);
 const newly=[...now].filter(x=>!previously.has(x));
 const oldSummaries=uniqueSummary(prev),newSummaries=uniqueSummary(current);
 const novelSummaries=[...newSummaries].filter(summary=>!oldSummaries.has(summary));
 const duplicateSummaries=current.length-novelSummaries.length;
 const extra=Number.isFinite(Number(modelCalls))&&Number(modelCalls)>=0
   ? Math.floor(Number(modelCalls)):current.length;
 const tokenCount=Math.max(0,finite(tokens)),time=Math.max(0,finite(elapsedMs));
 const unknowns=result.flatMap(x=>items(x,'unknowns'));
 const risks=result.flatMap(x=>items(x,'risks'));
 const recommendations=new Set(result.map(x=>norm(x?.recommendation)).filter(Boolean));
 return Object.freeze({
   modelCalls:extra,advisoryFindings:current.length,
   tokens:tokenCount,elapsedMs:time,
   tokensPerAdvisoryFinding:current.length?Math.round(tokenCount/current.length):null,
   newDistinctAdvisoryNeeds:newly.length,
   duplicateAdvisorySummaries:duplicateSummaries,
   newDistinctAdvisorySummaries:novelSummaries.length,
   advisoryDuplicationRatio:current.length?Number((duplicateSummaries/current.length).toFixed(3)):0,
   outstandingUnknowns:new Set(unknowns).size,
   outstandingRisks:new Set(risks).size,
   opinionDisagreement:recommendations.size>1,
   valueObserved:newly.length>0||novelSummaries.length>0,
   verifiedResults:0, // valid receipts only come from the parent executor
   verificationStatus:'unverified-advisory',
   signalsAreAdvisory:true
 });
}
/**
 * Pure stop recommendation only for *optional future advisory work*.
 * A verified acceptance/runner gate is never skipped. If risks, gaps, failures
 * or disagreement persist, marginal duplication must not force a "pass".
 */
export function optionalAgentStopDecision({
  report=null,previousReports=[],risk='ordinary',failedRoles=0,
  acceptanceSatisfied=false
}={}){
 if(acceptanceSatisfied)return Object.freeze({stop:true,reason:'parent-acceptance-satisfied',verifiedByThisPolicy:false});
 const consequential=['high','critical','high-impact','regulated','physical'].includes(norm(risk));
 const reports=[...(Array.isArray(previousReports)?previousReports:[]),report].filter(Boolean);
 const recent=reports.slice(-2);
 const exhausted=recent.length>=2&&recent.every(r=>r.advisoryFindings>0
   && r.newDistinctAdvisoryNeeds===0
   && r.advisoryDuplicationRatio>=0.5
   && !r.opinionDisagreement);
 const unresolved=reports.some(r=>r.outstandingUnknowns>0||r.outstandingRisks>0||r.opinionDisagreement);
 const stop=!consequential&&!unresolved&&!failedRoles&&exhausted;
 return Object.freeze({
   stop,
   reason:stop?'repeated-redundant-advisory-waves'
     : consequential?'consequential-work-needs-parent-verification'
       : unresolved?'material-gaps-remain':'retain-evidence-driven-options',
   verifiedByThisPolicy:false
 });
}
