/**
 * Child/parent resource delegation as bounded *requests*, never tool execution.
 * All sandbox/terminal/dependency/file/web work still runs through Kindgleam's
 * existing server-owned workflow, policy, approval and receipt boundaries.
 */
export const RESOURCE_REQUEST_KINDS = Object.freeze([
  'specialist-consultation', 'source-research', 'file-inspection',
  'sandbox-test', 'sandbox-execution', 'dependency-installation',
  'terminal-session', 'terminal-command', 'ui-preview', 'code-change'
]);
const KINDS = new Set(RESOURCE_REQUEST_KINDS);
const TERM = new Set(['terminal-session']);
const RESTRICTED = new Set([
  'sandbox-test','sandbox-execution','dependency-installation','terminal-session','terminal-command','code-change'
]);
const normalize = value => String(value ?? '').trim();
const clip = (value,max=160) => normalize(value).slice(0,max);
const safeLabel = value => clip(value).replace(/\p{Cc}/gu,' ');
const safeId = value => clip(value,84).toLowerCase().replace(/[^a-z0-9_-]/g,'-');
const pathSafe = path => typeof path==='string'
  && path.length<=160 && path.length>0
  && !path.startsWith('/') && !/^[a-z]:/i.test(path)
  && !path.split(/[\\/]+/).some(x=>x==='..'||x==='.')
  && !/\p{Cc}/u.test(path)
  && !/\\/.test(path);
const SENSITIVE = /(^|\/)(\.env|\.git|\.ssh|secrets?|credentials?|tokens?|private|id_rsa|\.npmrc|\.pypirc)(\/|\.|$)/i;
const OPERATIONAL = {
  'specialist-consultation': ['normal-chat','code','research'],
  'source-research':['normal-chat','code','research'],
  'file-inspection':['normal-chat','code','research'],
  'sandbox-test':['code','normal-chat','research'],
  'sandbox-execution':['normal-chat','code','research'],
  'dependency-installation':['normal-chat','code','research'],
  'terminal-session':['code'],
  'terminal-command':['normal-chat','code','research'],
  'ui-preview':['normal-chat','code','research'],
  'code-change':['normal-chat','code','research']
};
const capability = {
  'specialist-consultation':'advisory-specialist',
  'source-research':'external-research',
  'file-inspection':'file-read',
  'sandbox-test':'code-execution',
  'sandbox-execution':'code-execution',
  'dependency-installation':'package-install',
  'terminal-session':'interactive-terminal',
  'terminal-command':'sandboxed-command',
  'ui-preview':'sandboxed-ui-preview',
  'code-change':'file-write'
};
export function normalizeAgentResourceRequests(raw=[], {
  surface='normal-chat',parentRole='',childId='',runId='',taskId='',limit=8
}={}) {
 const permitted = ['normal-chat','code','research'].includes(surface) ? surface:'normal-chat';
 const source = Array.isArray(raw) ? raw.slice(0,32) : [];
 const seen = new Set(),out = [];
 const max=Math.max(0,Math.min(12,Number.isFinite(Number(limit))?Math.floor(Number(limit)):8));
 for(const r of source) {
  if(out.length>=max)break;
  if(!r||typeof r!=='object'||Array.isArray(r))continue;
  const kind=clip(r.kind,45).toLowerCase();
  if(!KINDS.has(kind)||!OPERATIONAL[kind].includes(permitted))continue;
  const why=safeLabel(r.reason);
  if(why.length<8)continue;
  const maybePaths=Array.isArray(r.paths)?r.paths:[];
  const paths=maybePaths.slice(0,8).filter(pathSafe).filter(p=>!SENSITIVE.test(p))
    .map(p=>clip(p,160)).slice(0,4);
  // Requests are intent-only. Never forward raw shell commands, scripts,
  // installer flags, tokens or environment variables from agent output.
  if(['command','script','argv','args','environment','env','token','secret','url','input']
      .some(field=>Object.hasOwn(r,field)))continue;
  const safePaths=[...new Set(paths)];
  const key=JSON.stringify([kind,why.slice(0,220),safePaths]);
  if(seen.has(key))continue;
  seen.add(key);
  out.push(Object.freeze({
    kind,reason:why.slice(0,220),paths:Object.freeze(safePaths),
    parentRole:safeId(parentRole),childId:safeId(childId),
    runId:clip(runId,100),taskId:clip(taskId,100),
    requiredCapability:capability[kind],
    state:TERM.has(kind)?'manual-user-terminal-only'
      : RESTRICTED.has(kind)?'requires-authorized-parent-execution'
      :'requires-parent-review',
    executionAuthorized:false,ran:false,verification:'not-executed',
    routing:TERM.has(kind)?'interactive-user-session'
      : 'existing-server-workflow',
    mayBypassPolicy:false,mayInstallDependencies:false,
    mayOpenTerminal:false,mayCallTools:false
  }));
 }
 return Object.freeze(out);
}

/** A specialist can delegate advisory scope. A parent must grant resources. */
export function summarizeDelegationRequests(requests=[],{limit=8}={}) {
 const seen=new Set(),result=[];
 for(const item of (Array.isArray(requests)?requests:[]).slice(0,20)){
   if(!item||!KINDS.has(item.kind)||item.executionAuthorized===true)continue;
   const key=JSON.stringify([item.kind,item.parentRole,item.childId,item.reason,item.paths??[]]);
   if(seen.has(key))continue;
   seen.add(key);
   result.push(Object.freeze({
     kind:item.kind,reason:clip(item.reason,220),
     ...(item.id?{resourceId:clip(item.id,64)}:{}),
     paths:Object.freeze(Array.isArray(item.paths)?item.paths.slice(0,4):[]),
     runId:clip(item.runId,100),taskId:clip(item.taskId,100),
     parentRole:clip(item.parentRole,84),childId:clip(item.childId,84),
     state:item.state,
     capability:item.requiredCapability,
     status:'proposal-only',ran:false,receipt:null
   }));
   if(result.length>=Math.max(0,Math.min(12,Number(limit)||8)))break;
 }
 return Object.freeze(result);
}

/**
 * Fairly assign scarce child model slots across already approved parent jobs.
 * Round robin one child per eligible parent before allowing further children;
 * task-family relevance and observed uncertainty determine eligibility.
 * No child model is called by this pure function.
 */
export function distributeSubagentCapacity({
 jobs=[],globalLimit=0,maxParallel=1,needForRole=()=>0,servedRoles=[]
}={}) {
 const limit=Math.max(0,Number.isFinite(Number(globalLimit))?Math.floor(Number(globalLimit)):0);
 const concurrency=Math.max(1,Number.isFinite(Number(maxParallel))?Math.floor(Number(maxParallel)):1);
 const already = new Set(Array.isArray(servedRoles)?servedRoles:[]);
 const unique=new Set(),eligible=[];
 for(const job of (Array.isArray(jobs)?jobs:[])) {
   const role=clip(job?.role,84);
   if(!role || unique.has(role) || !job?.modelId)continue;
   unique.add(role);
   const need = Math.max(0,Math.floor(Number(needForRole(job))||0));
   if(need) eligible.push({job,role,need,allocated:0,previous:already.has(role)});
 }
 eligible.sort((a,b)=>Number(a.previous)-Number(b.previous));
 let remaining=limit;
 // Round-robin distribution and deterministic priority.
 while(remaining>0) {
   let added=false;
   for(const item of eligible) {
     if(remaining===0)break;
     if(item.allocated>=item.need)continue;
     item.allocated++;remaining--;added=true;
   }
   if(!added)break;
 }
 const allocations=eligible.filter(item=>item.allocated>0).map(item=>Object.freeze({
   role:item.role,job:item.job,maxExtraCalls:item.allocated
 }));
 return Object.freeze({allocations:Object.freeze(allocations),
   assigned:limit-remaining,maxParallel:concurrency,
   policy:'read-only; same parent budget and provider admission; no autonomous tools'
 });
}
