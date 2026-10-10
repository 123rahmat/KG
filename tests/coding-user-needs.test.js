import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCodingUserNeeds } from '../src/coding-user-needs.js';
import { buildRequirementModel, reconcileRequirements } from '../src/requirements.js';
import { understandTask } from '../src/task-understanding.js';

const multi = 'Fix login and add retry handling, and run integration tests without deleting project files';
const verify = (model, criteria) => reconcileRequirements(model, {
  task: { id:'verify', type:'verify' },
  structured: { verdict:'pass', criteria: criteria.map(criterion => ({ criterion, met:true })) }
});

test('multi-part coding requests keep separate user-defined deliverables', () => {
  const needs = captureCodingUserNeeds({ request:multi });
  assert.equal(needs.source,'explicit-user-request');
  assert.equal(needs.authoritative,false);
  assert.equal(needs.deliverables.length,3);
  assert.ok(needs.explicitCriteria.some(value => /add retry handling/i.test(value)));
  assert.ok(needs.guardrails.includes('without deleting project files'));
  assert.ok(needs.verificationPolicy.includes('named'));
});

test('a one-part bug fix does not invent a second outcome', () => {
  const needs = captureCodingUserNeeds({ request:'Fix regression in package.json' });
  assert.deepEqual(needs.deliverables,[]);
  assert.deepEqual(needs.explicitCriteria,[]);
});
test('subject with and does not split into unrelated tasks', () => {
  const needs = captureCodingUserNeeds({ request:'Fix login and signup in app.js' });
  assert.deepEqual(needs.actionClauses,['Fix login and signup in app.js']);
  assert.deepEqual(needs.deliverables,[]);
});
test('protect explicit no-delete and preservation constraints', () => {
  const needs = captureCodingUserNeeds({
    request:"Refactor auth without deleting old routes",
    constraints:['Keep all user data','No unapproved external writes'],
    successCriteria:['Existing sessions remain valid']
  });
  assert.ok(needs.explicitCriteria.includes('without deleting old routes'));
  assert.ok(needs.explicitCriteria.includes('Keep all user data'));
  assert.ok(needs.explicitCriteria.includes('Existing sessions remain valid'));
  assert.equal(needs.explicitCriteria.length,4);
});
test('vague extreme quality claims are not manufactured into measurable requirements', () => {
  const needs = captureCodingUserNeeds({ request:'Make the perfect best coding system' });
  assert.equal(needs.qualityUnspecified,true);
  assert.deepEqual(needs.explicitCriteria,[]);
});
test('duplicated and oversized attacker-controlled input remains bounded', () => {
  const many = Array.from({ length:90 },(_,i) => 'Add feature'+i).join(';\n');
  const needs = captureCodingUserNeeds({ request:many, constraints:['preserve data','preserve data'] });
  assert.ok(needs.actionClauses.length<=12);
  assert.ok(needs.explicitCriteria.length<=12);
  assert.ok(needs.request.length<=12000);
  assert.ok(needs.explicitCriteria.every(x=>x.length<=240));
});
test('coding task understanding includes explicit coverage without changing admission', () => {
  const task = understandTask({ request:multi });
  assert.equal(task.domain,'coding');
  assert.equal(task.intent,'implement');
  assert.ok(task.userNeeds);
  assert.ok(task.successCriteria.some(x=>x==='without deleting project files'));
  assert.equal(task.needsPlan,true);
  const vague = understandTask({ request:'Make the best coding agent' });
  assert.equal(vague.qualityUnspecified,true);
  assert.equal(vague.needsClarification,false);
});
test('blanket verifier pass cannot silently satisfy specific user requirements', () => {
  const needs = captureCodingUserNeeds({ request:multi });
  const original = buildRequirementModel({ goal:multi, codingNeeds:needs });
  assert.ok(original.items.filter(x=>x.explicitCoverage).length>=3);
  const passed = verify(original,[]);
  assert.equal(passed.completionReady,false);
  assert.ok(passed.items.filter(x=>x.explicitCoverage).every(x=>x.status!=='satisfied'));
});
test('matching one requested feature cannot cover a different guardrail', () => {
  const needs = captureCodingUserNeeds({ request:multi });
  const original = buildRequirementModel({ goal:multi, codingNeeds:needs });
  const partial = verify(original,[needs.explicitCriteria.find(x=>/integration tests/.test(x))]);
  assert.equal(partial.completionReady,false);
  assert.equal(partial.items.find(x=>x.requirement==='without deleting project files').status,'confirmed');
});
test('all explicitly named checks can close a request; a new patch invalidates them', () => {
  const needs = captureCodingUserNeeds({ request:multi });
  const original = buildRequirementModel({ goal:multi, codingNeeds:needs });
  const complete = verify(original,needs.explicitCriteria);
  assert.equal(complete.completionReady,true);
  const revised = reconcileRequirements(complete, {
    task:{id:'build-code',type:'build-code'}, structured:{source:'new revision'}
  });
  assert.equal(revised.completionReady,false);
  assert.equal(revised.items.find(x=>x.kind==='outcome').status,'in-progress');
  assert.ok(revised.items.filter(x=>x.explicitCoverage).every(x=>x.status==='in-progress'));
  const reverified = verify(revised, needs.explicitCriteria);
  assert.equal(reverified.completionReady,true);
});
test('generic legacy requirement models still accept their historical simple pass', () => {
  const model = buildRequirementModel({ goal:'Build utility',successCriteria:['Exports greet function'] });
  const completed = verify(model,['Exports greet function']);
  assert.equal(completed.completionReady,true);
  assert.equal(model.items.some(item=>item.explicitCoverage),false);
});

test('late no-delete guardrail is preserved when a request exceeds the summary cap',()=>{
  const actionList=Array.from({length:35},(_,n)=>'Add feature'+n).join('; ');
  const needs=captureCodingUserNeeds({request:actionList+'; Do not delete production data'});
  assert.equal(needs.coverageLimited,true);
  assert.ok(needs.guardrails.includes('Do not delete production data'));
  assert.ok(needs.explicitCriteria.includes('Do not delete production data'));
  assert.ok(needs.explicitCriteria.some(text=>/remaining requested changes/.test(text)));
});
