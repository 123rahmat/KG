import test from 'node:test';
import assert from 'node:assert/strict';
import { nextWorkDecision } from '../public/next-work-decision.js';
import { workspaceProgressPanel } from '../public/work-progress-panels.js';

test('display the persisted next task and its evidence-based why/how',()=>{
  const run={state:'test-code',next:'test-code',tasks:[
    {id:'build-code',type:'code',status:'complete',metadata:{title:'Change API'},evidence:{result:{status:'completed'}}},
    {id:'test-code',type:'code',status:'running',metadata:{title:'Run API tests',evidenceAnchorTaskId:'build-code'}}
  ]};
  const item=nextWorkDecision(run);
  assert.equal(item.title,'Run API tests');
  assert.match(item.why,/Change API/);
  assert.match(item.how,/real output/);
  assert.equal(item.speculative,false);
  assert.equal(workspaceProgressPanel(run,'code').nextAction.taskId,'test-code');
});
test('never invent a completed step as a proven evidence anchor',()=>{
  const item=nextWorkDecision({state:'run',next:'investigate',tasks:[
    {id:'plan',type:'plan',status:'complete'},
    {id:'investigate',type:'investigate',status:'pending',metadata:{evidenceAnchorTaskId:'plan'}}
  ]});
  assert.equal(item.evidenceAnchor,null);
  assert.doesNotMatch(item.why,/Following evidence from/);
});
test('terminal, unknown or already-complete tasks yield no next action',()=>{
  assert.equal(nextWorkDecision({state:'complete',next:'verify',tasks:[{id:'verify',status:'pending'}]}),null);
  assert.equal(nextWorkDecision({state:'respond',next:'unknown',tasks:[]}),null);
  assert.equal(nextWorkDecision({state:'respond',next:'respond',tasks:[{id:'respond',status:'complete'}]}),null);
});
test('approval stays human controlled',()=>{
  const item=nextWorkDecision({state:'approval',next:'approval',tasks:[{id:'approval',type:'approval',status:'waiting'}]});
  assert.equal(item.action,'Action needed');
  assert.match(item.how,/approval/);
});
