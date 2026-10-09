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
test('research workspace does not receive a code sandbox by role confusion',()=>{
  const candidate={...run,surface:'research'};
  const answer=admitAgentResourceRequest({run:candidate,task:plan,scope:owner,
    request:{kind:'sandbox-execution'},availableTools:ready,approved:true});
  assert.equal(answer.code,'workspace-resource-blocked');
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
