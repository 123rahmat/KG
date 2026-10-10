/**
 * Read-only explanation for the exact next task persisted by the server.
 * Neither the browser nor model prose gets to schedule a future step.
 */
const safe=(v,max=160)=>String(v??'').replace(/[\p{Cc}]/gu,' ').trim().slice(0,max);
const terminal=new Set(['complete','failed','blocked','exhausted','iterate']);
const GUIDE=Object.freeze({
  understand:['The requested outcome and constraints must be established.','Identify the acceptance criteria before selecting capabilities.'],
  discover:['Needed context or a capability is not yet established.','Inspect only the authorized, relevant evidence.'],
  investigate:['Current evidence cannot yet support the requested conclusion.','Gather permitted sources and track conflicts, uncertainty and provenance.'],
  'build-code':['The requested change needs implementation.','Use the selected revision and file ownership; only recorded writes count.'],
  'test-code':['The change requires executable checks.','Run an authorized test runner; report real output or clearly label unavailability.'],
  code:['The assigned software change still needs work.','Use scoped project files; check actual edits before claiming success.'],
  verify:['The outcome needs acceptance verification.','Compare saved evidence with criteria; do not invent test execution.'],
  reassess:['Observed evidence or unmet criteria may change the next action.','Reuse verified work and choose the smallest additional necessary step.'],
  approval:['The action requires authorization.','Request approval before protected operations.'],
  clarify:['Essential information is missing.','Ask only for the input needed to continue safely.'],
  deliver:['Saved work needs a truthful final handoff.','Summarize completed checks, artifacts and unresolved limits.'],
  respond:['The current task needs an answer.','Use available context; investigate only material gaps.']
});
export function nextWorkDecision(run){
  if(!run || terminal.has(safe(run.state)))return null;
  const tasks=Array.isArray(run.tasks)?run.tasks:[];
  const id=safe(run.next,120);
  if(!id)return null;
  const next=tasks.find(item=>safe(item?.id,120)===id);
  if(!next || ['complete','failed','skipped','blocked'].includes(next.status))return null;
  const kind=['build-code','test-code'].includes(id)?id:safe(next.type)||id;
  const venture=next.metadata?.ventureDiscovery===true;
  const [why,how]=venture
    ? ['Alternative ideas need a testable, user-relevant choice before a product is planned or built.',
       'Compare distinct ideas, customer needs, assumptions and feasibility; choose a small validation experiment without claiming it ran.']
    : GUIDE[kind]||[
    'The server selected this next recorded task.',
    'Work within the task permissions and verify the resulting evidence.'
  ];
  const anchor=safe(next.metadata?.evidenceAnchorTaskId,80);
  const previous=anchor&&tasks.find(t=>t?.id===anchor
    &&['complete','failed'].includes(t?.status)
    &&t.evidence&&typeof t.evidence==='object'&&Object.keys(t.evidence).length>0);
  return Object.freeze({
    taskId:id,
    title:safe(next.metadata?.title||next.purpose||next.id,105),
    action:next.status==='waiting'||['approval','clarify'].includes(kind)
      ?'Action needed':next.status==='running'?'Working now':'Up next',
    why:safe(previous?'Following evidence from '+safe(previous.metadata?.title||previous.purpose||previous.id,85)+': '+why:why,250),
    how:safe(how,230),
    evidenceAnchor:previous?anchor:null,
    source:'persisted-run-next-task',speculative:false
  });
}
