/**
 * Task-scoped recruitment supervisor.
 *
 * Reconciles the server's evidence-selected main roles, their task-derived
 * subagent lenses, and their requested resources at safe wave boundaries.
 * This is a controller role, NOT another privileged model or executor.
 * A "resource" below is only an intent/proposal; actual sandbox instances
 * are ephemeral and still require separate owner, approval and policy gates.
 */
import { createHash } from 'node:crypto';
import { selectFamilySubagents } from './adaptive-family-subagents.js';
import { normalizeAgentResourceRequests } from './agent-resource-delegation.js';

const str=(value,max=120)=>String(value??'').trim().slice(0,max);
const unique=values=>[...new Set((Array.isArray(values)?values:[]).map(x=>str(x,90)).filter(Boolean))];
const idFor=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);
const ratio=value=>value==null||!Number.isFinite(Number(value))?null:Math.max(0,Math.min(1,Number(value)));
const activeRecord=(id,kind,owner,details)=>Object.freeze({id,kind,owner,...details,status:'recruited',authority:'advisory-only'});
const resourceKey=request=>idFor([request.kind,request.reason,request.paths,request.parentRole,request.childId]);
const validSurface=s=>['normal-chat','code','research'].includes(s)?s:'normal-chat';

function needFromFindings(findings) {
  return (Array.isArray(findings)?findings:[])
    .filter(item=>item&&item.status!=='failed'&&item.status!=='unavailable')
    .filter(item=>['investigate','revise','stop'].includes(str(item.recommendation,30))
      || item.unknowns?.length || item.risks?.length);
}

/**
 * Call at a wave boundary; never while a worker is running.
 *
 * desiredRoles are already selected by the server's policy-aware allocator,
 * not supplied directly by the model. The supervisor can shrink for budget,
 * stop on acceptance, and de-recruit stale roles and child lenses. It CANNOT
 * elevate suggestions into permitted tool calls.
 */
export function reconcileTaskRecruitment({
  runId='',taskId='',surface='normal-chat',goal='',task={},situation={},
  desiredRoles=[],completedRoles=[],failedRoles=[],findings=[],requests=[],
  resolvedResourceIds=[],previous=null,budgetRatio=null,acceptanceSatisfied=false,mode='auto',
  maxAgents=6,waveIndex=0
}={}) {
  const run=str(runId),step=str(taskId),workspace=validSurface(surface);
  const budget=ratio(budgetRatio),limit=Math.max(0,Math.floor(Number(maxAgents)||0));
  const completed=new Set(unique(completedRoles)),failed=new Set(unique(failedRoles));
  const unresolved=needFromFindings(findings);
  const stop=mode==='off'||acceptanceSatisfied||(budget!==null&&budget<.08);
  const candidates=unique(desiredRoles).filter(role=>!completed.has(role)&&!failed.has(role));
  const elected=stop?[]:candidates.slice(0,limit);
  const oldRoles=new Set(unique(previous?.activeRoles));
  const oldSubagents=new Set(unique(previous?.subagents?.map(child=>child.id)));
  const subagents=[];
  for(const role of elected){
    const plan=selectFamilySubagents({
      surface:workspace,goal,role,situation,task,
      observedFindings:unresolved,remainingBudgetRatio:budget??1
    });
    for(const lens of plan.active){
      const id=role+':'+lens.id;
      subagents.push(activeRecord(id,'subagent',role,{
        family:plan.family,operation:lens.operation,
        modelInvocation:'shared-parent-by-default',
        independentModelCallAuthorized:false
      }));
    }
  }
  // Resource demand remains visible for parent approval even after an
  // advisory parent has completed. It is not a live container reservation.
  // Only the server-owned workflow may supply IDs with actual resolution evidence.
  const resolved=new Set(unique(resolvedResourceIds));
  const resources=[],seen=new Set();
  if(!stop){
    for(const item of (Array.isArray(requests)?requests:[])){
      if(!item||typeof item!=='object')continue;
      if(item.runId&&str(item.runId)!==run)continue;
      if(item.taskId&&str(item.taskId)!==step)continue;
      const parentRole=str(item.parentRole,84);
      // A requester must actually have participated in the owning task.
      if(!parentRole || (!completed.has(parentRole)&&!failed.has(parentRole)
          && !elected.includes(parentRole)))continue;
      if(failed.has(parentRole))continue;
      const normalized=normalizeAgentResourceRequests([item],{
        surface:workspace,parentRole,childId:str(item.childId,84),
        runId:run,taskId:step,limit:1
      });
      if(!normalized.length)continue;
      const request=normalized[0],id=resourceKey(request);
      if(seen.has(id)||resolved.has(id))continue;
      seen.add(id);
      resources.push(Object.freeze({
        ...request,id,owner:request.childId?parentRole+':'+request.childId:parentRole,
        status:'proposed-not-allocated',executionAuthorized:false,ran:false
      }));
    }
  }
  const oldResources=new Set(unique(previous?.resources?.map(r=>r.id)));
  const currentRoles=new Set(elected);
  const currentSubagents=new Set(subagents.map(child=>child.id));
  const currentResources=new Set(resources.map(r=>r.id));
  const retiredRoles=[...oldRoles].filter(role=>!currentRoles.has(role));
  const retiredSubagents=[...oldSubagents].filter(id=>!currentSubagents.has(id));
  const retiredResources=[...oldResources].filter(id=>!currentResources.has(id));
  const lifecycle=Object.freeze({
    waveIndex:Math.max(0,Math.floor(Number(waveIndex)||0)),
    recruitRoles:Object.freeze(elected.filter(role=>!oldRoles.has(role))),
    retireRoles:Object.freeze(retiredRoles),
    recruitSubagents:Object.freeze(subagents.filter(c=>!oldSubagents.has(c.id)).map(c=>c.id)),
    retireSubagents:Object.freeze(retiredSubagents),
    requestResources:Object.freeze(resources.filter(r=>!oldResources.has(r.id)).map(r=>r.id)),
    releaseProposals:Object.freeze(retiredResources),
    reason:stop?'task-done-disabled-or-budget-exhausted'
      :unresolved.length?'unresolved-evidence-reassessed'
        :'current-task-requirements-reconciled',
    inFlightCanceled:false,externalToolsExecuted:false,sandboxSessionsCreated:false
  });
  return Object.freeze({
    agent:'situational-recruitment-supervisor',
    scope:Object.freeze({runId:run,taskId:step,surface:workspace}),
    activeRoles:Object.freeze(elected),
    subagents:Object.freeze(subagents),
    resources:Object.freeze(resources),
    lifecycle,
    budgetKnown:budget!==null,
    authority:'parent-controller-only',
    policy:'wave-boundary-reconciliation; no direct execution or authority grants'
  });
}

/** Compact activity/approval handoff, never an executed-resource receipt. */
export function recruitmentSummary(state) {
  return Object.freeze({
    agent:'situational-recruitment-supervisor',
    activeMainAgents:state?.activeRoles?.length??0,
    advisorySubagents:state?.subagents?.length??0,
    resourceProposals:state?.resources?.length??0,
    lifecycle:state?.lifecycle??null,
    resourceState:'intent-only; parent authorization and actual runner receipts required'
  });
}
