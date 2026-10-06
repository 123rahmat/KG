import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';

const scope = {
  user: { id: 'principal-1', crossChatMemory: false },
  workspace: { id: 'workspace-1' }
};

test('planner carries one adaptive execution envelope into every non-empty plan', () => {
  const plan = planGoal('Explain how this works', scope);
  assert.ok(plan.adaptiveExecution);
  assert.equal(plan.adaptiveExecution.version, '1');
  assert.equal(plan.adaptiveExecution.verification.required, true);
  assert.equal(plan.adaptiveExecution.webSearch.shouldSearch, false);
});

test('planner escalates evidence gathering for current research', () => {
  const plan = planGoal('Research the latest documentation and cite the sources', {
    ...scope,
    activeSurface: 'research'
  });
  assert.ok(plan.adaptiveExecution);
  assert.equal(plan.adaptiveExecution.webSearch.shouldSearch, true);
  assert.equal(plan.adaptiveExecution.webSearch.provenance.citationsRequired, true);
});

test('explicit web-search disable remains authoritative', () => {
  const plan = planGoal('Research the latest documentation', {
    ...scope,
    activeSurface: 'research',
    adaptiveControl: { webSearch: false }
  });
  assert.ok(plan.adaptiveExecution);
  assert.equal(plan.adaptiveExecution.webSearch.shouldSearch, false);
  assert.equal(plan.adaptiveExecution.webSearch.reason, 'caller-disabled-search');
});


test('direct work materializes only the current response step', () => {
  const plan = planGoal('Explain what adaptive execution means', scope);
  assert.equal(plan.workflow, 'direct');
  assert.deepEqual(plan.tasks.map(task => task.type), ['respond']);
  assert.equal(plan.tasks[0].metadata.verificationPending, true);
});

test('pure conversation stays one-step and does not request verification', () => {
  const plan = planGoal('hello', scope);
  assert.equal(plan.workflow, 'direct');
  assert.deepEqual(plan.tasks.map(task => task.type), ['respond']);
  assert.equal(plan.tasks[0].metadata.conversational, true);
  assert.equal(plan.tasks[0].metadata.verificationPending, false);
});
