/**
 * One shared, explicitly approved sandbox action for all workspaces.
 * Specialist advice and child-agent resource requests do NOT invoke it.
 * The parent tool action is user-approved, owner-bound, policy-checked and
 * executed by the existing isolated sandbox runner, never the host terminal.
 */
import crypto from 'node:crypto';
import { registerTools } from '../toolbox.js';
import { callRunner, SANDBOX_TIMEOUT_MS } from '../runtime.js';
import { validateJob } from '../sandbox.js';
import { bindAgentResourceScope } from '../agent-resource-broker.js';

const ALLOWED = new Set([
  'language','source','tests','packages','files','project','entry',
  'check','stdin','timeoutMs','memoryMb'
]);
function prepare(input = {}) {
  if(!input || typeof input!=='object' || Array.isArray(input))
    return {error:'A structured sandbox program is required.'};
  if(Object.keys(input).some(key=>!ALLOWED.has(key)))
    return {error:'Only structured sandbox code, tests, packages and project files are permitted.'};
  try {
    const job=validateJob(input);
    // Validation occurs in the web process AND again inside the runner.
    // Return only allowed JSON job input; do not forward normalized commands.
    return {job:Object.fromEntries(Object.entries(input).filter(([k])=>ALLOWED.has(k))),
      language:job.language};
  } catch(error) {
    return {error:String(error?.message??'Sandbox input is invalid.').slice(0,220)};
  }
}
export function sandboxActionPreview(input) {
  const prepared=prepare(input);
  return prepared.error ? {error:prepared.error} :
    {language:prepared.language,packages:prepared.job.packages?.length??0,
      files:Object.keys(prepared.job.files??{}).length,proposalOnly:true};
}

registerTools([{
  name:'sandbox.execute',
  title:'Isolated code sandbox',
  description:'Run a supported code or test job in an ephemeral, network-isolated container after user approval. Dependencies are validated and installed in a separate restricted phase. This never opens a terminal session.',
  input:{language:'python | javascript | go | rust | java | c | cpp',
    source:'program source, or project files',tests:'optional tests',
    packages:['optional pinned package names'],files:{'relative/path':'file source'}},
  sideEffect:true,
  ready:ctx=>ctx?.config?.runners?.sandbox && ctx?.config?.runners?.sandboxToken
    ? {ready:true} : {ready:false,needs:'sandbox',reason:'A separate authorized sandbox runner and token must be configured.'},
  validate:input=>{
    const parsed=prepare(input);
    return parsed.error ? {error:parsed.error} : {valid:true};
  },
  summarize:input=>{
    const p=sandboxActionPreview(input);
    return p.error ? 'Invalid sandbox execution request'
      : 'Run '+p.language+' program or tests in an isolated, disposable sandbox (explicit approval required)';
  },
  run:async(input,ctx)=>{
    const auth=bindAgentResourceScope({run:ctx?.run,task:ctx?.task,scope:ctx?.scope});
    if(!auth.allowed)return {error:auth.reason,code:auth.code,executed:false};
    const parsed=prepare(input);
    if(parsed.error)return {error:parsed.error,code:'sandbox-input-invalid',executed:false};
    const url=ctx?.config?.runners?.sandbox;
    const token=ctx?.config?.runners?.sandboxToken;
    if(!url||!token)return {error:'Sandbox runner is not configured.',code:'resource-unavailable',executed:false};
    // The approved action route installs beforeRunner, which rechecks active
    // execution policy, consent, and owner authorization at time of use.
    if(typeof ctx.beforeRunner!=='function')return {
      error:'Parent execution-policy recheck is required.',
      code:'sandbox-policy-recheck-required',executed:false
    };
    const hash=crypto.createHash('sha256').update(JSON.stringify([
      auth.runId,auth.taskId,parsed.job
    ])).digest('hex').slice(0,32);
    const executionId='agent-sandbox:'+hash;
    const output=await callRunner(url,{
      runId:auth.runId,goal:String(ctx.run.goal??'').slice(0,2000),
      task:{id:auth.taskId,type:'code',
        purpose:'Execute the user-approved isolated sandbox action'},
      payload:{job:parsed.job},executionTarget:'general-ai-sandbox',
      executionId
    },{
      config:ctx.config,fetchImpl:ctx.fetchImpl??fetch,signal:ctx.signal,
      token,timeoutMs:SANDBOX_TIMEOUT_MS,
      beforeCall:async()=>{
        ctx.signal?.throwIfAborted();
        await ctx.beforeRunner({tool:'sandbox.execute'});
      }
    });
    return output;
  }
}]);
