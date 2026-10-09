import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCE_REQUEST_KINDS, normalizeAgentResourceRequests,
  summarizeDelegationRequests
} from '../src/agent-resource-delegation.js';
import { admitAgentResourceRequest, triageAgentResourceRequests } from '../src/agent-resource-broker.js';
import { selectFamilySubagents, normalizeChildProbe } from '../src/adaptive-family-subagents.js';

const task={id:'active',type:'plan',purpose:'Complete a delegated user task'};
const owner={principalId:'owner',workspaceId:'team'};
const base={
 id:'run-123',principalId:'owner',workspaceId:'team',state:'running',
 tasks:[task],goal:'Research, test and edit data',
 situation:{risk:'ordinary'},
 adaptation:{safety:{decision:'allow',care:[]},dataClasses:['user-content']},
 governance:{status:'unconfigured'}
};
const resources=['sandbox.execute','file.read','data.analyze','web.fetch'];

test('every parent and child can propose sandbox and terminal command resources in all three workspaces',()=>{
 for(const surface of ['normal-chat','code','research']){
   for(const who of [
      {parentRole:surface+'-lead'},
      {parentRole:surface+'-lead',childId:'dependency-checker'}
   ]){
     const proposals=normalizeAgentResourceRequests([
       {kind:'sandbox-execution',reason:'Run calculations in an isolated sandbox'},
       {kind:'terminal-command',reason:'Check temporary build dependencies in sandbox'},
       {kind:'dependency-installation',reason:'Install required pinned packages in sandbox'},
       {kind:'sandbox-test',reason:'Execute task acceptance tests in sandbox'}
     ],{surface,...who,runId:base.id,taskId:task.id});
     assert.equal(proposals.length,4,surface+JSON.stringify(who));
     assert.ok(proposals.every(p=>p.runId===base.id&&p.taskId===task.id));
     assert.ok(proposals.every(p=>p.executionAuthorized===false&&p.ran===false));
     const outcomes=proposals.map(request=>admitAgentResourceRequest({
       run:{...base,surface},task,scope:owner,request,availableTools:resources}));
     assert.ok(outcomes.every(o=>o.code==='approval-required'),surface);
   }
 }
 assert.ok(RESOURCE_REQUEST_KINDS.includes('terminal-session'));
});

test('separate same-kind work requests survive normalization and parent handoff',()=>{
 const request=normalizeAgentResourceRequests([
   {kind:'terminal-command',reason:'Inspect installed package versions in the sandbox'},
   {kind:'terminal-command',reason:'Check the reproducible build environment'},
   {kind:'terminal-command',reason:'Check the reproducible build environment'},
   {kind:'file-inspection',reason:'Inspect file schema before any edits',paths:['src/index.js']}
 ],{surface:'research',parentRole:'research-methods-lead',childId:'package-check',
    runId:base.id,taskId:task.id});
 assert.equal(request.length,3);
 const handoff=summarizeDelegationRequests(request);
 assert.equal(handoff.length,3);
 assert.deepEqual(handoff[2].paths,['src/index.js']);
 assert.equal(handoff[0].runId,base.id);
 assert.equal(handoff[0].taskId,task.id);
 const triage=triageAgentResourceRequests({
   run:{...base,surface:'research'},task,scope:owner,
   requests:handoff,availableTools:resources});
 assert.equal(triage.length,3);
 assert.deepEqual(triage.map(t=>t.status),
   ['awaiting-user-approval','awaiting-user-approval','read-only-tool-available']);
 assert.ok(triage.every(r=>r.receipt===null && r.executed===false));
});

test('agent tool requests cannot insert raw commands, credentials or cross-run scopes',()=>{
 const raw=[
   {kind:'terminal-command',reason:'Execute a script',command:'rm -rf /'},
   {kind:'dependency-installation',reason:'Package secret credentials',env:{TOKEN:'secret'}},
   {kind:'file-inspection',reason:'Read sensitive workspace path',paths:['.env']},
   {kind:'terminal-command',reason:'Inspect repository build tools in sandbox'}
 ];
 const safe=normalizeAgentResourceRequests(raw,{surface:'code',parentRole:'backend-engineer',runId:base.id,taskId:task.id});
 assert.equal(safe.length,2);
 assert.deepEqual(safe[0].paths,[]);
 assert.deepEqual(safe[1].paths,[]);
 const candidate={...base,surface:'code'};
 for(const request of [
   {kind:'terminal-command',runId:'another-run'},
   {kind:'terminal-command',taskId:'another-task'}
 ]){
   const result=admitAgentResourceRequest({
      run:candidate,task,scope:owner,request,availableTools:resources,approved:true});
   assert.match(result.code,/^resource-(run|task)-mismatch$/);
 }
 const executable=admitAgentResourceRequest({
   run:candidate,task,scope:owner,availableTools:resources,approved:true,
   request:{kind:'terminal-command',command:'cat /etc/passwd'}});
 assert.equal(executable.code,'untrusted-executable-payload');
 const blocked=admitAgentResourceRequest({run:candidate,task,
   scope:{...owner,principalId:'other'},availableTools:resources,
   request:{kind:'sandbox-test'},approved:true});
 assert.equal(blocked.code,'owner-mismatch');
});

test('even approved scoped command requests are admissions, not command execution',()=>{
 for(const surface of ['code','normal-chat','research']){
   const run={...base,surface};
   const admitted=admitAgentResourceRequest({run,task,scope:owner,
     availableTools:resources,approved:true,request:{kind:'terminal-command'}});
   assert.equal(admitted.status,'parent-executor-required');
   assert.equal(admitted.executionAuthorized,false);
   assert.equal(admitted.executed,false);
   assert.deepEqual(admitted.toolNames,['sandbox.execute']);
   const manual=admitAgentResourceRequest({run,task,scope:owner,
     availableTools:resources,approved:true,request:{kind:'terminal-session'}});
   assert.equal(manual.code,'user-terminal-only');
   const notReady=admitAgentResourceRequest({run,task,scope:owner,
     availableTools:['file.read'],approved:true,request:{kind:'terminal-command'}});
   assert.equal(notReady.code,'resource-unavailable');
 }
});

test('read-only children can specify needed tools but remain unable to use them',()=>{
 const plan=selectFamilySubagents({
   surface:'research',role:'research-evidence-verification-lead',
   goal:'Research an unfamiliar claim and verify sources and risks',
   task:{id:'active',type:'plan'},
   situation:{complexity:.9,uncertainty:.95,unknownSituation:true,risk:'high'},
   remainingBudgetRatio:1
 });
 const child=plan.active.find(c=>c.priority==='supporting' &&
   ['investigate','verify'].includes(c.operation));
 assert.ok(child);
 const parsed=normalizeChildProbe({
   summary:'Additional execution receipts needed',
   resourceRequests:[{kind:'terminal-command',reason:'Check reproducing dataset analysis in sandbox'},
                     {kind:'sandbox-test',reason:'Run deterministic statistical test in sandbox'}]
 },plan,child.id,{runId:base.id,taskId:task.id});
 assert.equal(parsed.resourceRequests.length,2);
 assert.ok(parsed.resourceRequests.every(r=>r.childId===child.id));
 assert.equal(parsed.authority,'none');
 assert.equal(parsed.toolCallsPerformed,0);
 assert.equal(parsed.evidenceVerified,false);
});
