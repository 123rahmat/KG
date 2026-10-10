import test from 'node:test';
import assert from 'node:assert/strict';
import { researchResponseTokenCap } from '../src/response-economy-policy.js';

const research=(goal, extra={})=>({
  surface:'research',goal,situation:{risk:'low',complexity:.12,
    need:{deliverable:'Findings',depth:'brief'},...extra}
});
test('only final Research answers get an optional output token ceiling',()=>{
  assert.equal(researchResponseTokenCap({run:research('Quick comparison'),task:{type:'respond'}}),2600);
  assert.equal(researchResponseTokenCap({run:research('Quick comparison'),task:{type:'deliver'}}),2600);
  for(const type of ['verify','investigate','understand','build-code','plan']) {
    assert.equal(researchResponseTokenCap({run:research('Quick comparison'),task:{type}}),null,type);
  }
  assert.equal(researchResponseTokenCap({run:{surface:'code',goal:'test'},task:{type:'deliver'}}),null);
  assert.equal(researchResponseTokenCap({run:{surface:'normal-chat'},task:{type:'respond'}}),null);
});
test('long scholarly deliverables and user detail requests are never truncated by the economy policy',()=>{
  for(const goal of ['Write a comprehensive thesis on this topic',
    'Prepare a detailed literature review with complete bibliography',
    'Create a full research report of the methods and supporting results']) {
    assert.equal(researchResponseTokenCap({run:research(goal),task:{type:'deliver'}}),null,goal);
  }
  assert.equal(researchResponseTokenCap({run:research('Study trends',{
    need:{deliverable:'Research answer',depth:'thorough'}
  }),task:{type:'deliver'}}),null);
  assert.equal(researchResponseTokenCap({run:research('Study trends',{
    need:{deliverable:'Write a paper',form:'report',depth:'brief'}
  }),task:{type:'deliver'}}),null);
});
test('elevated uncertainty or risk leaves room for responsible evidence and caveats',()=>{
  const hard=research('Find reasons',{complexity:.83,uncertainty:.9,risk:'high'});
  assert.equal(researchResponseTokenCap({run:hard,task:{type:'deliver'}}),5400);
  const medium=research('Compare',{complexity:.5});
  assert.equal(researchResponseTokenCap({run:medium,task:{type:'respond'}}),3600);
  assert.equal(researchResponseTokenCap({run:research('Assess',
    {successCriteria:Array.from({length:12},(_,n)=>'Criterion '+n)}),task:{type:'deliver'}}),null);
});

test('explicit response preferences and multiple acceptance checks change token allowance',()=>{
  assert.equal(researchResponseTokenCap({run:research('Find practical evidence',{
    need:{deliverable:'Brief findings',depth:'brief'},
    user:{preferences:{answerLength:'detailed'}}
  }),task:{type:'deliver'}}),null);
  assert.equal(researchResponseTokenCap({run:research('Find practical evidence',{
    successCriteria:['one','two','three']
  }),task:{type:'deliver'}}),3600);
});
