import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAgentResourceScope, admitAgentResourceRequest, triageAgentResourceRequests } from '../src/agent-resource-broker.js';
import { useTool } from '../src/toolbox.js';

const owner={principalId:'alice',workspaceId:'team-A',role:'editor'};
const plan={id:'plan',type:'plan',purpose:'Prepare requested project'};
const run={
  id:'run-one',principalId:'alice',workspaceId:'team-A',visibility:'workspace',
  surface:'code',goal:'Build a safe UI',state:'running',
  tasks:[plan],
  adaptation:{safety:{decision:'allow',care:[]},dataClasses:['user-content']},
  governance:{status:'unconfigured'}
};
const ready=['file.read','data.analyze','code.run','web.fetch','file.edit','artifact.create'];

test('the authenticated run owner gets a resource scope without new tool permissions',()=>{
  const v=bindAgentResourceScope({run,task:plan,scope:owner});
  assert.equal(v.allowed,true);
  assert.equal(v.principalId,'alice');
  assert.equal(v.workspaceId,'team-A');
  assert.equal(v.mayGrantTools,false);
  assert.equal(v.mayAssumeOtherIdentity,false);
});

test('private resource use is denied to a different member even if the conversation is workspace-shared',()=>{
  const v=bindAgentResourceScope({run,task:plan,
    scope:{principalId:'bob',workspaceId:'team-A',role:'editor'}});
  assert.equal(v.allowed,false);
  assert.equal(v.code,'owner-mismatch');
});
test('another workspace cannot access resources by guessing a run ID',()=>{
  const v=bindAgentResourceScope({run,task:plan,
    scope:{principalId:'alice',workspaceId:'team-B',role:'editor'}});
  assert.equal(v.code,'workspace-mismatch');
});
test('no authenticated scope or an unknown task fails closed',()=>{
  assert.equal(bindAgentResourceScope({run,task:plan}).code,'missing-scope');
  assert.equal(bindAgentResourceScope({run,task:{id:'other'},scope:owner}).code,'task-mismatch');
  assert.equal(bindAgentResourceScope({run:{id:'fake'},task:plan,scope:owner}).code,'missing-run');
});
test('read-only file access is eligible only when a matching scoped tool is ready',()=>{
  const allowed=admitAgentResourceRequest({run,task:plan,scope:owner,
    request:{kind:'file-inspection',paths:['src/app.js']},availableTools:ready});
  assert.equal(allowed.status,'read-only-tool-available');
  assert.deepEqual(allowed.toolNames,['file.read','data.analyze']);
  assert.equal(allowed.executed,false);
  assert.equal(allowed.executionAuthorized,false);
  const noFile=admitAgentResourceRequest({run,task:plan,scope:owner,
    request:{kind:'file-inspection'},availableTools:['math.evaluate']});
  assert.equal(noFile.code,'resource-unavailable');
});
test('sensitive and traversing paths are blocked even if the tool is otherwise available',()=>{
  for(const paths of [['../other/notes.md'],['.env'],['/etc/passwd'],['.ssh/id_rsa']]){
    const response=admitAgentResourceRequest({run,task:plan,scope:owner,
      request:{kind:'file-inspection',paths},availableTools:ready});
    assert.equal(response.code,'unsafe-resource-path',String(paths));
  }
});
test('sandbox runs, dependency installation, and file changes never self-approve',()=>{
  for(const kind of ['sandbox-test','sandbox-execution','dependency-installation','code-change']){
    const response=admitAgentResourceRequest({run,task:plan,scope:owner,
      request:{kind},availableTools:ready,approved:false});
    assert.equal(response.code,'approval-required',kind);
    assert.equal(response.executed,false,kind);
    const approved=admitAgentResourceRequest({run,task:plan,scope:owner,
      request:{kind},availableTools:ready,approved:true});
    assert.equal(approved.status,'parent-executor-required',kind);
    assert.equal(approved.executionAuthorized,false,kind);
    assert.equal(approved.executed,false,kind);
  }
});
test('an agent cannot control a user terminal even when its parent approves a request',()=>{
  const answer=admitAgentResourceRequest({run,task:plan,scope:owner,
    request:{kind:'terminal-session'},availableTools:ready,approved:true});
  assert.equal(answer.code,'user-terminal-only');
  assert.equal(answer.allowed,false);
});
test('all workspaces may request sandbox execution but receive no direct grant',()=>{
  for(const surface of ['normal-chat','code','research']){
    const candidate={...run,surface};
    for(const kind of ['sandbox-test','sandbox-execution','dependency-installation','terminal-command']){
      const request={kind,reason:'Isolated task-scoped verification with required tools'};
      const pending=admitAgentResourceRequest({run:candidate,task:plan,scope:owner,
        request,availableTools:ready});
      assert.equal(pending.code,'approval-required',surface+'/'+kind);
      const accepted=admitAgentResourceRequest({run:candidate,task:plan,scope:owner,
        request,availableTools:ready,approved:true});
      assert.equal(accepted.status,'parent-executor-required',surface+'/'+kind);
      assert.deepEqual(accepted.toolNames,['code.run']);
      assert.equal(accepted.executionAuthorized,false);
      assert.equal(accepted.executed,false);
    }
  }
});
test('different principal cannot get resource proposals promoted via triage',()=>{
  const a=triageAgentResourceRequests({
    run,task:plan,scope:{principalId:'bob',workspaceId:'team-A'},
    availableTools:ready,requests:[{kind:'file-inspection'},{kind:'sandbox-test'}]
  });
  assert.equal(a.length,2);
  assert.ok(a.every(item=>item.code==='owner-mismatch' && item.executed===false));
});
test('underlying tool execution refuses mismatched run identity before accessing tool data',async()=>{
  const result=await useTool('file.read',{file:'doc.txt'},{
    run,task:plan,scope:{principalId:'bob',workspaceId:'team-A'},
    config:{policy:{blockedTopics:[]}}
  });
  assert.equal(result.code,'owner-mismatch');
});

test('one-shot terminal commands are requests for approved sandbox tools, never PTY grants',()=>{
  const request={kind:'terminal-command',reason:'Run the authorized repository test suite in an isolated sandbox'};
  const blocked=admitAgentResourceRequest({run,task:plan,scope:owner,request,availableTools:ready});
  assert.equal(blocked.code,'approval-required');
  const admitted=admitAgentResourceRequest({run,task:plan,scope:owner,
    request,availableTools:ready,approved:true});
  assert.equal(admitted.status,'parent-executor-required');
  assert.deepEqual(admitted.toolNames,['code.run']);
  assert.equal(admitted.executionAuthorized,false);
  assert.equal(admitted.executed,false);
  const research={...run,surface:'research'};
  assert.equal(admitAgentResourceRequest({run:research,task:plan,scope:owner,
    request,availableTools:ready,approved:true}).status,'parent-executor-required');
  assert.equal(admitAgentResourceRequest({run,task:plan,
    scope:{...owner,principalId:'bob'},request,availableTools:ready,approved:true}).code,'owner-mismatch');
});
test('research can request sandbox work but cannot run it directly',()=>{
  const research={...run,surface:'research'};
  const testOnly=admitAgentResourceRequest({run:research,task:plan,scope:owner,
    request:{kind:'sandbox-test'},availableTools:ready,approved:true});
  assert.equal(testOnly.status,'parent-executor-required');
  assert.equal(testOnly.executed,false);
  for(const kind of ['sandbox-execution','dependency-installation','terminal-command']){
    const submitted=admitAgentResourceRequest({run:research,task:plan,scope:owner,
      request:{kind},availableTools:ready,approved:true});
    assert.equal(submitted.status,'parent-executor-required',kind);
    assert.equal(submitted.executed,false,kind);
  }
});
