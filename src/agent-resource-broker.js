/**
 * A single, server-owned authority for agent resource access.
 *
 * The browser, model, child-agent output and retrieved pages may propose work,
 * but can NEVER set the principal/workspace or create an execution grant.
 * Only an authenticated server scope can bind a task to its owner's resources.
 */
import { policyAllows } from './core.js';
import { checkTaskPolicy, checkConnectionPolicy } from './policy-gate.js';
import { isSensitiveWorkspacePath } from './workspace-path.js';

const text = v => typeof v === 'string' ? v.trim() : '';
const RESOURCE_TO_TOOLS = Object.freeze({
  'file-inspection': ['file.read','data.analyze'],
  'source-research': ['web.search','web.fetch','mcp.discover'],
  'ui-preview': ['file.read'],
  'specialist-consultation': [],
  'sandbox-test': ['code.run'],
  'sandbox-execution': ['code.run'],
  'dependency-installation': ['code.run'],
  'code-change': ['file.edit','file.create'],
  'terminal-session': []
});
const MUTATIONS = new Set(['sandbox-test','sandbox-execution','dependency-installation','code-change','terminal-session']);
const SURFACES = new Set(['normal-chat','code','research']);
const SCOPE_REASONS = Object.freeze({
  'missing-scope': 'Authenticated user and workspace scope are required.',
  'missing-run': 'The active task is not a valid persisted run.',
  'workspace-mismatch': 'This run belongs to another workspace.',
  'owner-mismatch': 'A shared conversation does not grant access to its owner’s private files or tools.',
  'task-mismatch': 'The requested task is not the active task.'
});
function denial(code, reason) {
  return Object.freeze({allowed:false,code,reason,authority:'server-only'});
}
/** Called after the server has loaded the run under a scoped DB query. */
export function bindAgentResourceScope({run,task,scope}={}) {
  const principalId=text(scope?.principalId);
  const workspaceId=text(scope?.workspaceId);
  if(!principalId || !workspaceId)return denial('missing-scope',SCOPE_REASONS['missing-scope']);
  if(!text(run?.id)||!text(run?.principalId)||!text(run?.workspaceId))
    return denial('missing-run',SCOPE_REASONS['missing-run']);
  if(run.workspaceId!==workspaceId)return denial('workspace-mismatch',SCOPE_REASONS['workspace-mismatch']);
  if(run.principalId!==principalId)return denial('owner-mismatch',SCOPE_REASONS['owner-mismatch']);
  if(task?.id && !Array.isArray(run.tasks))return denial('task-mismatch',SCOPE_REASONS['task-mismatch']);
  if(task?.id && !run.tasks.some(item=>item.id===task.id))
    return denial('task-mismatch',SCOPE_REASONS['task-mismatch']);
  return Object.freeze({
    allowed:true,authority:'server-only',principalId,workspaceId,
    runId:run.id,taskId:text(task?.id)||null,
    surface:SURFACES.has(run.surface)?run.surface:'normal-chat',
    limits:Object.freeze({maxRequestedResources:8,maxParallelModelChildren:2}),
    // No token, shell, credential, or arbitrary tool grant is minted here.
    mayGrantTools:false,mayAssumeOtherIdentity:false
  });
}
/**
 * The same decision interface covers read-only tool discovery and side
 * effects. Tool readiness and the existing actual executor remain decisive;
 * this function NEVER invokes a terminal, container, installer or provider.
 */
export function admitAgentResourceRequest({
  run,task,scope,request,availableTools=[],approved=false,
  config={},dataClasses=null
}={}) {
  const identity=bindAgentResourceScope({run,task,scope});
  if(!identity.allowed)return identity;
  const kind=text(request?.kind);
  if(!Object.hasOwn(RESOURCE_TO_TOOLS,kind))return denial('invalid-resource','Unknown requested resource.');
  const allowedBySurface=identity.surface==='code'
    || (!['terminal-session'].includes(kind)
        && !(['sandbox-test','sandbox-execution','dependency-installation'].includes(kind)
             && identity.surface==='research'));
  if(!allowedBySurface)return denial('workspace-resource-blocked','This resource is unavailable for this workspace.');
  const policy=checkTaskPolicy(run,task??{id:'',type:'respond'});
  if(!policy.allowed)return denial(policy.code,policy.reason);
  const requestedPaths=(Array.isArray(request?.paths)?request.paths:[]).slice(0,8);
  if(requestedPaths.some(path=>typeof path!=='string'
     || path.startsWith('/') || path.includes('..') || path.includes('\\')
     || isSensitiveWorkspacePath(path)))return denial('unsafe-resource-path','The request includes an unsafe or sensitive file path.');

  // An interactive PTY cannot be handed to an AI process; the authenticated
  // user's WebSocket terminal manager owns its own access and isolation.
  if(kind==='terminal-session')return Object.freeze({
    ...identity,allowed:false,code:'user-terminal-only',
    reason:'The user may open a scoped, disposable terminal session; agents cannot control the PTY.',
    status:'manual-user-action',toolNames:Object.freeze([])
  });
  const names=RESOURCE_TO_TOOLS[kind];
  const available=new Set((Array.isArray(availableTools)?availableTools:[]).map(item=>
    typeof item==='string'?item:text(item?.name)));
  const matching=names.filter(name=>available.has(name) &&
    (!run?.governance || policyAllows(run.governance,{tool:name})));
  if(kind==='specialist-consultation')return Object.freeze({
    ...identity,allowed:true,status:'parent-schedules-advisory',
    toolNames:Object.freeze([]),requiresUserApproval:false,
    executionAuthorized:false,executed:false
  });
  if(!matching.length)return denial('resource-unavailable','No matching authorized and ready tool is available in this task.');
  const mutates=MUTATIONS.has(kind);
  if(mutates&&!approved)return Object.freeze({
    ...identity,allowed:false,code:'approval-required',
    reason:'The parent must propose this operation for explicit user approval.',
    status:'awaiting-user-approval',
    toolNames:Object.freeze(matching),executionAuthorized:false,executed:false
  });
  // Even after approval this is an *admission*, NOT an execution receipt:
  // sandbox/code.run and other side effects still use the existing action
  // token, validation and runner. No untrusted model input is forwarded.
  if(mutates)return Object.freeze({
    ...identity,allowed:true,status:'parent-executor-required',
    toolNames:Object.freeze(matching),requiresUserApproval:true,
    executionAuthorized:false,executed:false
  });
  const egress=['source-research'].includes(kind);
  if(egress){
    const destination='external-tool';
    const privacy=checkConnectionPolicy(run,{
      dataClasses:dataClasses??run.adaptation?.dataClasses??['user-content'],
      destination,explicitConsent:approved===true
    });
    if(!privacy.allowed)return denial(privacy.code,privacy.reason);
  }
  return Object.freeze({
    ...identity,allowed:true,status:'read-only-tool-available',
    toolNames:Object.freeze(matching),requiresUserApproval:false,
    executionAuthorized:false,executed:false
  });
}
export function triageAgentResourceRequests({run,task,scope,requests=[],availableTools=[]}={}) {
  const results=[];
  for(const request of (Array.isArray(requests)?requests:[]).slice(0,8)){
    const outcome=admitAgentResourceRequest({run,task,scope,request,availableTools});
    results.push(Object.freeze({
      kind:text(request?.kind).slice(0,48),parentRole:text(request?.parentRole).slice(0,80),
      status:outcome.status??(outcome.code==='approval-required'?'awaiting-user-approval':'blocked'),
      code:outcome.code??null,
      reason:text(outcome.reason).slice(0,200),
      suggestedTools:Object.freeze(outcome.toolNames??[]),
      executed:false,
      receipt:null
    }));
  }
  return Object.freeze(results);
}
