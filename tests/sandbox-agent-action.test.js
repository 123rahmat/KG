import test from 'node:test';
import assert from 'node:assert/strict';
import { toolNamed,toolCatalog,useTool } from '../src/toolbox.js';
import { sandboxActionPreview } from '../src/tools/sandbox-action.js';

const task={id:'active',type:'respond'};
const owner={principalId:'alice',workspaceId:'team-a'};
const mkRun=surface=>({id:'run-id',principalId:'alice',workspaceId:'team-a',
  surface,goal:'Run a reproducible calculation',tasks:[task],
  governance:{status:'unconfigured'},adaptation:{safety:{decision:'allow',care:[]}}});
const config={runners:{sandbox:'http://127.0.0.1:8767/v1/execute',
  sandboxToken:'local-test-token-with-more-than-32-chars'},
  limits:{responseBytes:100000}};
const sample={language:'python',source:'print(1+1)',tests:''};

test('one-shot sandbox tool is discoverable in every workspace when configured',()=>{
 for(const surface of ['normal-chat','code','research']){
   const context={config,run:mkRun(surface),task,scope:owner,allowedTools:['sandbox.execute']};
   const item=toolCatalog(context).find(tool=>tool.name==='sandbox.execute');
   assert.equal(item.ready,true,surface);
   assert.equal(item.sideEffect,true,surface);
   assert.equal(sandboxActionPreview(sample).language,'python');
 }
 const disabled=toolCatalog({config:{runners:{}},allowedTools:['sandbox.execute']})
    .find(item=>item.name==='sandbox.execute');
 assert.equal(disabled.ready,false);
});

test('sandbox action is proposed but cannot run inside the regular model tool loop',async()=>{
 const proposals=[];
 const ctx={config,run:mkRun('normal-chat'),task,scope:owner,
   allowedTools:['sandbox.execute'],propose:async action=>{
     proposals.push(action);return {id:'user-approval-1'};
   }};
 const r=await useTool('sandbox.execute',sample,ctx);
 assert.equal(r.proposed,true);
 assert.equal(r.actionId,'user-approval-1');
 assert.equal(proposals[0].tool,'sandbox.execute');
 assert.equal(proposals[0].input.language,'python');
 assert.equal(r.executed,undefined);
});

test('sandbox tool refuses direct execution without the real parent policy callback',async()=>{
 const ctx={config,run:mkRun('code'),task,scope:owner,allowedTools:['sandbox.execute']};
 const tool=toolNamed('sandbox.execute',ctx);
 const result=await tool.run(sample,ctx);
 assert.equal(result.code,'sandbox-policy-recheck-required');
 assert.equal(result.executed,false);
});

test('sandbox tool runs only validated structured jobs and with scoped parent check',async()=>{
 const requests=[];
 let policyChecks=0;
 const run=mkRun('research');
 const ctx={
   config,run,task,scope:owner,allowedTools:['sandbox.execute'],beforeRunner:async({tool})=>{
     policyChecks++;assert.equal(tool,'sandbox.execute');
   },
   fetchImpl:async(_endpoint,options)=>{
     const posted=JSON.parse(options.body);
     requests.push(posted);
     assert.equal(options.method,'POST');
     assert.ok(options.headers.authorization.startsWith('Bearer '));
     return new Response(JSON.stringify({
       executed:true,status:'completed',executionId:posted.executionId,
       output:{stdout:'2',status:'passed'}
     }),{status:200,headers:{'content-type':'application/json'}});
   }
 };
 const tool=toolNamed('sandbox.execute',ctx);
 const result=await tool.run(sample,ctx);
 assert.equal(result.executed,true);
 assert.equal(result.status,'completed');
 assert.equal(policyChecks,1);
 assert.equal(requests.length,1);
 assert.equal(requests[0].runId,'run-id');
 assert.equal(requests[0].task.id,'active');
 assert.equal(requests[0].executionTarget,'general-ai-sandbox');
 assert.deepEqual(requests[0].payload.job,sample);
 const unsafe=await tool.run({...sample,command:'cat /etc/passwd'},ctx);
 assert.equal(unsafe.code,'sandbox-input-invalid');
 assert.equal(requests.length,1);
 const forged=await tool.run(sample,{...ctx,scope:{...owner,principalId:'another'}});
 assert.equal(forged.code,'owner-mismatch');
 assert.equal(requests.length,1);
});

test('unexpected shell, environment and unsupported language are rejected before any execution',()=>{
 for(const input of [
   {...sample,command:'ls'},
   {...sample,env:{SECRET:'no'}},
   {...sample,language:'bash'},
   {language:'python',source:''}
 ]){
   assert.ok(sandboxActionPreview(input).error);
 }
});
