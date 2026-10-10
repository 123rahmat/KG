/**
 * Bounded public rationale for task-selected specialists.
 * Advisory metadata only: no model calls, credentials or authority.
 */
import { DOMAIN_SPECIALISTS, domainSpecialistMatch } from './domain-specialists.js';

const safe = (value, max=160) => String(value ?? '').replace(/[\p{Cc}]/gu, ' ').trim().slice(0, max);
const list = value => Array.isArray(value) ? value : [];

export function explainAgentSelection({
  surface='code', goal='', task={}, roles=[], dynamicSpecialists=[],
  topology={}, decision={}, signals={}
}={}) {
  const workspace=['code','research'].includes(surface) ? surface : 'normal-chat';
  const generated=new Map(list(dynamicSpecialists).map(item=>[item?.role,item]));
  const selected=[...new Set(list(roles).filter(item=>typeof item==='string'))]
    .slice(0,24).map(role=>{
      const specialty=DOMAIN_SPECIALISTS[role];
      const uncovered=generated.get(role);
      const matched=specialty && domainSpecialistMatch(role, {surface:workspace,goal,task})>=0.7;
      const name=safe(specialty?.specialty || role.replaceAll('-', ' '),85);
      let why='Complementary task review selected by the parent workflow.';
      if(matched) why='Relevant expertise for this request: '+name+'.';
      if(uncovered) why='Explicit uncovered requirement: '+safe(uncovered.requirement,145)+'.';
      if(role==='debugger' && signals.retrying) why='A previous attempt failed; inspect the failure before a repair.';
      if(role==='security-reviewer' && signals.securityFocus) why='The assigned work has a security-sensitive boundary.';
      return Object.freeze({
        role:safe(role,90),what:name,
        when:safe(task?.metadata?.title || task?.purpose || task?.id || task?.type || 'current task',100),
        why:safe(why,230),
        how:'Read-only scoped advice; execution and verification remain with the parent workflow.',
        status:'selected-not-proof-of-execution'
      });
    });
  const parallel=Number(topology?.maxParallel)>1 && selected.length>1;
  return Object.freeze({
    source:'server-selected-task-allocation',
    workspace,
    whyAgents:safe(selected.length ? decision?.reason || 'task-specific-value'
      : decision?.reason || topology?.reason || 'no-optional-specialists',100),
    roles:Object.freeze(selected),
    parallelPolicy:parallel
      ? 'Parallel work is eligible for independent non-conflicting lanes, but is not proof that work ran.'
      : 'Serial or direct work is currently sufficient or required.',
    budgetPolicy:'Optional specialist calls must justify their cost; mandatory verification remains separate.',
    reassess:'Change the team only at safe wave boundaries based on saved results and budget.',
    modelCallsPerformed:0,
    mayAuthorizeTools:false,mayVerifyCompletion:false
  });
}
