import test from 'node:test';
import assert from 'node:assert/strict';
import { codingProgressSnapshot } from '../public/coding-progress-model.js';

const tasks = [
  {id:'understand',status:'complete'},
  {id:'build-code',status:'running',type:'build-code'},
  {id:'test-code',type:'test-code',status:'pending'},
  {id:'verify',type:'verify',status:'pending'}
];

test('progress shows recorded steps rather than forecasting total completion',()=>{
  const view=codingProgressSnapshot({id:'r1',state:'running',next:'build-code',tasks});
  assert.equal(view.progressLabel,'1 of 4 recorded steps done');
  assert.equal(view.status,'Working');
  assert.equal(view.verified,false);
  assert.equal(view.testState,'Test step pending');
  assert.match(view.evidence,/No passing/);
  assert.equal(view.checkpoints[1].current,true);
});
test('completion alone cannot be displayed as verified',()=>{
  const view=codingProgressSnapshot({state:'complete',tasks:[{id:'deliver',status:'complete'}]});
  assert.equal(view.status,'Completed');
  assert.equal(view.verified,false);
  assert.match(view.headline,/not confirmed/);
});
test('only a recorded successful verification verdict grants verified badge',()=>{
  const view=codingProgressSnapshot({state:'complete',tasks:[
    {id:'verify',type:'verify',status:'complete',evidence:{verdict:{verdict:'pass'}}}
  ]});
  assert.equal(view.verified,true);
  assert.equal(view.status,'Verified');
});
test('pending tests never become a passed test count',()=>{
  const view=codingProgressSnapshot({state:'queued',tasks:[{id:'test-code',status:'pending'}]});
  assert.equal(view.testState,'Test step pending');
  assert.equal(view.status,'Queued');
});
test('failed work is not hidden behind a completion meter',()=>{
  const view=codingProgressSnapshot({state:'failed',tasks:[
    {id:'test-code',status:'failed'}
  ]});
  assert.equal(view.status,'Needs attention');
  assert.equal(view.failures,1);
  assert.equal(view.testState,'Test step failed');
});
test('latest six markers are bounded and show omitted record count',()=>{
  const view=codingProgressSnapshot({state:'running',tasks:Array.from({length:15},(_,id)=>({
    id:String(id),status:'complete'
  }))});
  assert.equal(view.checkpoints.length,6);
  assert.equal(view.hiddenCount,9);
});

test('a passing verdict before a later code change is stale, not verified',()=>{
  const view=codingProgressSnapshot({state:'complete',tasks:[
    {id:'build-code',type:'build-code',status:'complete'},
    {id:'verify',type:'verify',status:'complete',evidence:{verdict:{verdict:'pass'}}},
    {id:'build-code-2',type:'build-code',status:'complete'}
  ]});
  assert.equal(view.verified,false);
  assert.equal(view.status,'Completed');
});
test('failed or pending tests cannot be mislabeled verified',()=>{
  for(const testStatus of ['failed','pending','running','stale']){
    const view=codingProgressSnapshot({state:'complete',tasks:[
      {id:'build-code',type:'build-code',status:'complete'},
      {id:'test-code',type:'test-code',status:testStatus},
      {id:'verify',type:'verify',status:'complete',evidence:{verdict:{status:'pass'}}}
    ]});
    assert.equal(view.verified,false,'test task status '+testStatus);
  }
});
test('verification requires terminal run completion',()=>{
  const view=codingProgressSnapshot({state:'running',tasks:[
    {id:'test-code',type:'test-code',status:'complete'},
    {id:'verify',type:'verify',status:'complete',evidence:{verdict:{status:'pass'}}}
  ]});
  assert.equal(view.verified,false);
  assert.equal(view.status,'Working');
});
