import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequirementModel, emptyRequirementModel, nextRequirement, reconcileRequirements, verificationCriteriaFor } from '../src/requirements.js';

test('explicit requirements live independently from the task graph', () => {
  const model = buildRequirementModel({
    goal: 'Build a data dashboard',
    requirements: ['Use CSV input', 'Show monthly totals'],
    successCriteria: ['Totals match the source data']
  });
  assert.equal(model.items.length, 4);
  assert.equal(model.completionReady, false);
  assert.equal(model.overallProgress > 0, true);
  assert.ok(nextRequirement(model)?.id);
});

test('understanding can discover requirements, questions and uncertainties', () => {
  const first = buildRequirementModel({ goal: 'Design the system' });
  const next = reconcileRequirements(first, {
    task: { id: 'understand', type: 'understand' },
    structured: {
      requirements: ['Include battery backup'],
      questions: ['What input voltage is available?'],
      unknowns: ['Peak current draw']
    },
    requirementIds: [first.items[0].id]
  });
  assert.ok(next.items.some(item => item.requirement === 'Include battery backup'));
  assert.ok(next.items.some(item => item.status === 'waiting-for-user'));
  assert.ok(next.items.some(item => item.status === 'unknown'));
  assert.ok(next.unresolvedCount > 0);
});

test('verification is the authority for final criterion satisfaction', () => {
  let model = buildRequirementModel({ goal: 'Build the answer', successCriteria: ['The final number is 42'] });
  const criterion = model.items.find(item => item.kind === 'criterion');
  model = reconcileRequirements(model, {
    task: { id: 'verify', type: 'verify' },
    structured: {
      verdict: 'pass',
      criteria: [{ criterion: 'The final number is 42', met: true, reason: 'Matches evidence.' }]
    }
  });
  assert.equal(model.items.find(item => item.id === criterion.id).status, 'satisfied');
  assert.equal(model.completionReady, true);
  assert.deepEqual(verificationCriteriaFor(model), ['The final number is 42']);
  assert.equal(emptyRequirementModel().overallProgress, 100);
});

test('a material clarification requirement is satisfied only by its clarification step', () => {
  let model = buildRequirementModel({ goal: 'Configure the deployment' });
  model = reconcileRequirements(model, {
    task: { id: 'understand', type: 'understand' },
    structured: { questions: ['Which region should host it?'] }
  });
  const question = model.items.find(item => item.kind === 'question');
  assert.equal(question.status, 'waiting-for-user');
  model = reconcileRequirements(model, {
    task: { id: 'clarify', type: 'clarify' },
    structured: {},
    requirementIds: [question.id],
    summary: 'User selected the deployment region.'
  });
  assert.equal(model.items.find(item => item.id === question.id).status, 'satisfied');
});


test('the next requirement targets concrete unresolved work before the aggregate outcome', () => {
  const model = buildRequirementModel({
    goal: 'Prepare the deployment',
    requirements: ['Confirm the hosting region'],
    successCriteria: ['Deployment matches the approved configuration']
  });
  const next = nextRequirement(model);
  assert.notEqual(next?.kind, 'outcome');
  assert.equal(next?.requirement, 'Confirm the hosting region');
});

test('requirements can be explicitly superseded without deleting their history', () => {
  let model = buildRequirementModel({
    goal: 'Build the report',
    requirements: ['Include a weekly breakdown']
  });
  const item = model.items.find(entry => entry.requirement === 'Include a weekly breakdown');
  model = reconcileRequirements(model, {
    task: { id: 'understand', type: 'understand' },
    structured: { supersededRequirements: [item.id] },
    summary: 'The user no longer needs a weekly breakdown.'
  });
  const updated = model.items.find(entry => entry.id === item.id);
  assert.equal(updated.status, 'superseded');
  assert.equal(updated.required, false);
  assert.equal(model.completionReady, false);
});

test('requirement ids echoed back by the model are not new requirements', () => {
  const model = reconcileRequirements(null, { goal: 'Translate a sentence', task: { type: 'understand' }, structured: { requirements: ['req-1vgfgo9', 'Give the Urdu translation'] } });
  assert.ok(model.items.some(item => item.requirement === 'Give the Urdu translation'));
  assert.ok(!model.items.some(item => /^req-/.test(item.requirement)));
});

test('a clean verify pass satisfies the outputs it covered, so the run can deliver', () => {
  const model = buildRequirementModel({
    goal: 'Calculate the 30th Fibonacci number',
    successCriteria: ['The number is correct'],
    outputs: ['the 30th Fibonacci number']
  });
  const ids = model.items.map(item => item.id);
  const verify = (verdict, criteria) => reconcileRequirements(model, {
    task: { id: 'verify', type: 'verify' }, requirementIds: ids,
    structured: { verdict, criteria }, summary: verdict
  });
  // The checker named only the criterion; the output passed with it.
  const passed = verify('pass', [{ criterion: 'The number is correct', met: true }]);
  assert.equal(passed.items.find(item => item.kind === 'output').status, 'satisfied');
  assert.equal(passed.completionReady, true);
  // A failed criterion leaves the work open.
  const failed = verify('fail', [{ criterion: 'The number is correct', met: false }]);
  assert.equal(failed.completionReady, false);
  assert.notEqual(failed.items.find(item => item.kind === 'output').status, 'satisfied');
});
