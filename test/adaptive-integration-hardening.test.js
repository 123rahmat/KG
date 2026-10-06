import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';
import { buildRealWorldOutcomeContract } from '../src/real-world-outcome.js';
import { completionGate, buildUnifiedAdaptiveWorkflow } from '../src/unified-adaptive-workflow.js';

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


test('real-world action requires observed and verified outcome evidence', () => {
  const contract = buildRealWorldOutcomeContract({
    goal: 'send the approved report to the client',
    realWorld: {
      realWorld: true,
      intent: 'action',
      risk: 'consequential',
      signals: { externalAction: true }
    },
    successCriteria: ['client received the report'],
    authorizationSatisfied: true,
    evidence: []
  });
  assert.equal(contract.realWorldTask, true);
  assert.equal(contract.controls.observationRequired, true);
  assert.equal(contract.completion.eligible, false);
  assert.ok(contract.gaps.includes('world-observation-required'));
});

test('real-world outcome becomes complete only after observation and verification', () => {
  const evidence = [
    { kind: 'observed', provenance: { source: 'authorized-tool-result', executed: true } },
    { kind: 'verified', verification: { verdict: 'pass' } }
  ];
  const contract = buildRealWorldOutcomeContract({
    goal: 'send the approved report to the client',
    realWorld: {
      realWorld: true,
      intent: 'action',
      risk: 'consequential',
      signals: { externalAction: true }
    },
    successCriteria: ['client received the report'],
    authorizationSatisfied: true,
    evidence
  });
  assert.equal(contract.completion.eligible, true);

  const workflow = buildUnifiedAdaptiveWorkflow({
    goal: contract.goal,
    situation: {
      goal: contract.goal,
      realWorld: contract,
      outcomeContract: contract,
      successCriteria: contract.successCriteria,
      consequence: 0.8,
      externalSideEffect: true
    },
    acceptance: {
      criteria: contract.successCriteria,
      evidence,
      verificationRequired: true,
      verificationSatisfied: true
    },
    evidence
  });
  const gate = completionGate({
    workflow,
    status: 'complete',
    taskType: 'deliver',
    evidence,
    verification: { verdict: 'pass' },
    authorizationSatisfied: true
  });
  assert.equal(gate.allowed, true);
});
