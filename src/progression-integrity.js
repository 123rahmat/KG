/**
 * Server-owned "no leapfrogging" gate for Coding and Research progression.
 * One next task is chosen; this policy never starts tools, approves a build,
 * adds model calls, or claims an acceptance check has passed.
 *
 * Applies only to prospective skip-ahead transitions. A genuine clarification,
 * optional investigation, governance approval or reassessment remains possible.
 */
const arr=x=>Array.isArray(x)?x:[];
const done=task=>task?.status==='complete';
const safe=x=>String(x??'').trim();
const FORWARD=new Set(['code','plan','prototype','respond','verify','deliver']);
const FINAL=new Set(['respond','verify','deliver']);
const caps=run=>new Set([...arr(run?.capabilities?.required),...arr(run?.capabilities?.granted)]);
const codePlan=Object.freeze({
  type:'plan',title:'Plan the build with you',buildPlan:true,
  purpose:'Propose the scoped implementation, concrete affected files, acceptance tests and assumptions for user review before writing code.'
});
const existingPlan=Object.freeze({
  ...codePlan,title:'Review and re-plan the existing code',existingCodePlan:true,
  purpose:'Inspect the current code, propose what to keep, change, remove and add, and identify focused regression tests before asking for approval.'
});
const agreement=Object.freeze({
  type:'approval',title:'Agree the plan',planAgreement:true,
  purpose:'Review the proposed implementation and explicitly approve or revise its scope before any code is written.',
  approvalFor:{type:'code',title:'Write the approved code',
    purpose:'Implement only the approved scope and record the changes and tests as evidence.'}
});
const implementation=Object.freeze({
  type:'code',title:'Write the approved code',
  purpose:'Implement the requested and authorized code changes, with tests, as a reviewable package. Do not claim to have executed them.'
});
const testing=Object.freeze({
  type:'code',title:'Test the generated code',
  purpose:'Run the authorized syntax checks and relevant automated tests, record execution evidence, and report runner limitations truthfully.'
});
const investigation=Object.freeze({
  type:'investigate',title:'Investigate the required evidence',
  purpose:'Gather authorized sources for the planned research questions; record provenance, conflicts and remaining gaps. Never invent retrieved sources.'
});
const discovery=Object.freeze({
  type:'discover-capabilities',title:'Discover the required capability',
  purpose:'Inspect what authorized tools or resources are required before selecting execution steps.'
});
function existingCode(run){
  const adaptation=run?.adaptation??{};
  return arr(adaptation.attachments).length>0
    ||arr(adaptation.projectOverlay).length>0
    ||arr(run?.situation?.artifacts).length>0
    ||adaptation.ownWork===true;
}
function selected(stage,reason){
  return Object.freeze({candidate:{...stage,progressionReason:reason},
    changed:true,reason});
}
export function enforceRequiredProgression({
  run={},tasks=[],target={},candidate=null,planRequired=false
}={}){
  if(!candidate)return Object.freeze({candidate:null,changed:false,reason:'no-proposal'});
  const domain=run.surface??run.adaptation?.primarySurface;
  if(!['code','research'].includes(domain)
    ||run.adaptation?.workflow==='direct'||!FORWARD.has(safe(candidate.type))) {
    return Object.freeze({candidate,changed:false,reason:'no-required-stage-conflict'});
  }
  const logged=arr(tasks),granted=caps(run);
  const has=fn=>logged.some(fn);
  const stillPending=fn=>logged.some(item=>fn(item)&&!['complete','failed','skipped'].includes(item.status));
  const protectedStart=logged.length>0;
  if(!protectedStart)return Object.freeze({candidate,changed:false,reason:'no-recorded-graph'});

  // Tool/capability discovery is necessary only when explicitly planned.
  // Never insert it repeatedly from mere doubt or missing model reasoning.
  if(granted.has('capability-discovery')
      && !has(item=>item.type==='discover-capabilities')
      && (FINAL.has(candidate.type)||candidate.type==='code'||candidate.type==='plan')) {
    return selected(discovery,'planned-capability-discovery-before-work');
  }
  // If research was explicitly selected, an answer or build cannot silently
  // pretend the retrieval already happened. After one investigation attempt,
  // ordinary assessment/verification decides whether evidence is sufficient.
  if(granted.has('evidence-retrieval') && !has(item=>item.type==='investigate')
      && (FINAL.has(candidate.type)||candidate.type==='code'||candidate.type==='plan')) {
    return selected(investigation,'planned-evidence-gathering-before-conclusion');
  }

  if(domain==='code' && granted.has('code-generation')) {
    const built=has(item=>item.type==='code' && item.metadata?.execution===false
      && done(item));
    const buildTask=has(item=>item.id==='build-code'||item.type==='code'&&item.metadata?.execution===false);
    const planTask=logged.find(item=>item.type==='plan'&&item.metadata?.buildPlan===true);
    const agreementTask=logged.find(item=>item.type==='approval'&&item.metadata?.planAgreement===true);
    if((planRequired||(planTask && planTask.status!=='skipped'))
        && !built&&!done(agreementTask)) {
      if(!planTask && !stillPending(item=>item.type==='plan')) {
        return selected(existingCode(run)?existingPlan:codePlan,'implementation-plan-not-yet-reviewed');
      }
      if(done(planTask)&&!agreementTask){
        return selected(agreement,'build-plan-requires-user-agreement');
      }
      // Do not create a second plan or approval while one is in progress.
      if(stillPending(item=>item.metadata?.buildPlan===true||item.metadata?.planAgreement===true)){
        return Object.freeze({candidate:null,changed:true,reason:'await-persisted-plan-or-approval'});
      }
    }
    if(!built&&(FINAL.has(candidate.type)||candidate.type==='prototype')){
      if(!buildTask)return selected(implementation,'implementation-required-before-final-checks');
      if(stillPending(item=>item.type==='code'&&item.metadata?.execution===false)){
        return Object.freeze({candidate:null,changed:true,reason:'await-code-task'});
      }
    }
    const testTask=logged.find(item=>item.id==='test-code'||item.id?.startsWith('test-code-'));
    if(built&&!testTask&&!run.adaptation?.codeNotRun&&FINAL.has(candidate.type)){
      return selected(testing,'record-test-results-before-verification');
    }
    if(built && testTask && ['pending','queued','running','waiting'].includes(testTask.status)
        && FINAL.has(candidate.type)) {
      return Object.freeze({candidate:null,changed:true,reason:'await-persisted-test-checkpoint'});
    }
  }
  return Object.freeze({candidate,changed:false,reason:'required-stages-recorded-or-not-applicable'});
}
