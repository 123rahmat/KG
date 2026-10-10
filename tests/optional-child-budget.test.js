import test from 'node:test';
import assert from 'node:assert/strict';
import { optionalChildCallBudget } from '../src/optional-child-budget.js';
const run=(surface,complexity=.2,extra={})=>({
  surface,situation:{risk:'ordinary',complexity,uncertainty:.1,successCriteria:[],...extra}
});
const task=(type,metadata={})=>({id:type,type,metadata});
test('cheap predictable tasks avoid unnecessary independent child model calls',()=>{
  const trivial=optionalChildCallBudget({run:run('code'),task:task('code'),maxAgents:8});
  assert.equal(trivial.limit,0);
  assert.equal(trivial.reason,'parent-specialists-sufficient');
  assert.equal(optionalChildCallBudget({run:run('research'),task:task('respond')}).limit,0);
  assert.equal(optionalChildCallBudget({run:run('code'),task:{id:'test-code',type:'code'}}).limit,0);
  assert.equal(optionalChildCallBudget({run:run('normal-chat'),task:task('understand')}).limit,0);
});
test('evidence gaps justify a bounded optional probe budget, not the whole main team',()=>{
  const missing=optionalChildCallBudget({
    run:run('research',.84,{unknowns:['No primary paper','Conflicting methods','Missing date']}),
    task:task('investigate'),maxAgents:9
  });
  assert.equal(missing.limit,2);
  const risky=optionalChildCallBudget({
    run:run('code',.8,{risk:'high',successCriteria:['check contract']}),
    task:task('code'),maxAgents:11
  });
  assert.ok(risky.limit>=1&&risky.limit<=2);
  assert.equal(optionalChildCallBudget({run:run('code',.6),
    task:task('step',{ventureDiscovery:true})}).limit,0,
    'routine brainstorm breadth is handled by the main idea panel');
});
test('explicit compute setting is an upper bound but cannot bypass prohibited stages',()=>{
  assert.equal(optionalChildCallBudget({
    run:run('research'),task:task('investigate'),configuredMax:5,maxAgents:3
  }).limit,3);
  assert.equal(optionalChildCallBudget({
    run:run('research'),task:task('investigate'),configuredMax:0,maxAgents:7
  }).limit,0);
  assert.equal(optionalChildCallBudget({
    run:run('code'),task:task('verify'),configuredMax:8,maxAgents:9
  }).limit,0);
  assert.equal(optionalChildCallBudget({
    run:run('code'),task:task('plan'),mode:'off',configuredMax:9,maxAgents:9
  }).limit,0);
});
