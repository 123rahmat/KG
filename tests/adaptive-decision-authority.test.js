import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptiveDecisionAuthority,
  buildAcceptanceContract,
  classifyAdaptiveFailure,
  recoveryDecision,
  invalidateDependents,
  idempotencyKey
} from '../src/adaptive-decision-authority.js';
import { adaptiveEffortProfile, adaptiveBehaviorContract } from '../src/adaptive-efficiency.js';

test('adaptive authority keeps simple work minimal', () => {
  const profile = adaptiveEffortProfile({ complexity: 0.1, uncertainty: 0.05, risk: 'low' });
  const acceptance = buildAcceptanceContract({
    goal: 'answer a simple question',
    criteria: ['answer'],
    evidence: [{ kind: 'verified', text: 'answer' }]
  });
  const decision = adaptiveDecisionAuthority({
    situation: { uncertainty: 0.05, riskScore: 0.15 },
    profile,
    acceptance,
    candidates: ['answer']
  });
  assert.equal(decision.action, 'execute');
  assert.equal(decision.controls.humanControlRequired, false);
});

test('consequential work does not silently bypass authority or verification', () => {
  const profile = adaptiveEffortProfile({
    risk: 'critical',
    peopleDecision: true,
    uncertainty: 0.4,
    verificationGap: 0.8
  });
  const acceptance = buildAcceptanceContract({
    criteria: ['decision supported by evidence'],
    evidenceRequired: ['independent review'],
    evidence: [],
    authorizationRequired: true,
    authorizationSatisfied: false,
    verificationRequired: true
  });
  const decision = adaptiveDecisionAuthority({
    situation: { consequence: 1, peopleDecision: true, authorizationRequired: true },
    profile,
    acceptance,
    candidates: ['execute']
  });
  assert.equal(decision.action, 'human-control');
  assert.equal(decision.controls.independentVerificationRequired, true);
  assert.equal(decision.controls.neverAutoPromoteAuthority, true);
});

test('failure recovery changes strategy instead of blindly retrying', () => {
  assert.equal(classifyAdaptiveFailure('revision conflict after another write'), 'stale-state');
  assert.equal(recoveryDecision({ reason: 'revision conflict', attempts: 1 }).action, 'reassess');
  assert.equal(recoveryDecision({ reason: 'permission denied', attempts: 1 }).action, 'stop');
  assert.equal(recoveryDecision({ reason: 'missing capability: x', attempts: 1 }).action, 'expand');
});

test('dependency invalidation is transitive and bounded to affected work', () => {
  assert.deepEqual(
    invalidateDependents('A', { B: ['A'], C: ['B'], D: ['X'], E: ['C', 'D'] }).sort(),
    ['A', 'B', 'C', 'E']
  );
});

test('idempotency key is stable and scoped to the target revision', () => {
  assert.equal(idempotencyKey({ runId: 'r1', taskId: 't1', action: 'write', targetRevision: 'v1' }),
    'r1:t1:write:v1');
  assert.notEqual(
    idempotencyKey({ runId: 'r1', taskId: 't1', action: 'write', targetRevision: 'v1' }),
    idempotencyKey({ runId: 'r1', taskId: 't1', action: 'write', targetRevision: 'v2' })
  );
});

test('adaptive behavior exposes the unified authority decision', () => {
  const profile = adaptiveEffortProfile({ complexity: 0.8, uncertainty: 0.7, risk: 'high' });
  const contract = adaptiveBehaviorContract(profile);
  assert.equal(contract.authority, 'server-owned');
  assert.ok(contract.authorityDecision);
  assert.ok(contract.acceptanceContract);
  assert.equal(contract.controls?.neverAutoPromoteAuthority, undefined);
});


import { adaptiveBehaviorContract } from '../src/adaptive-efficiency.js';

test('adaptive behavior contract is structurally complete', () => {
  const contract = adaptiveBehaviorContract(undefined, {
    situation: { goal: 'simple answer', uncertainty: 0.05, riskScore: 0.1 },
    acceptance: { criteria: ['answer provided'], evidence: [] }
  });
  assert.equal(contract.authorityDecision.authority, 'server-owned');
  assert.equal(contract.neverAutoPromoteAuthority, true);
  assert.ok(contract.behavior.agents);
  assert.ok(contract.behavior.parallelism);
  assert.ok(contract.acceptanceContract);
});
