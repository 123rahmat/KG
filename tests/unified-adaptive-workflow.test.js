import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnifiedAdaptiveWorkflow,
  reassessUnifiedWorkflow,
  completionGate,
  unifiedRecoveryDecision,
  subsystemCanAct,
  SUBSYSTEMS
} from '../src/unified-adaptive-workflow.js';

test('one workflow contract governs all subsystems', () => {
  const workflow = buildUnifiedAdaptiveWorkflow({
    goal: 'answer a simple question',
    situation: { uncertainty: 0.05, riskScore: 0.1 },
    acceptance: { criteria: ['answer provided'] },
    candidates: ['respond']
  });
  assert.equal(workflow.authority.authority, 'server-owned');
  assert.equal(workflow.subsystems.length, SUBSYSTEMS.length);
  assert.ok(workflow.subsystems.every(item => item.lifecycle === 'shared-workflow'));
  assert.ok(workflow.subsystems.every(item => item.mayGrantAuthority === false));
});

test('material evidence causes reassessment instead of workflow restart', () => {
  const first = buildUnifiedAdaptiveWorkflow({
    goal: 'fix a project',
    situation: { uncertainty: 0.2, riskScore: 0.45 },
    acceptance: { criteria: ['tests pass'] }
  });
  const next = reassessUnifiedWorkflow(first, {
    event: { type: 'test-result', material: true },
    situation: { uncertainty: 0.7, riskScore: 0.75 },
    evidence: [{ kind: 'observed', test: 'failed' }]
  });
  assert.equal(next.reassessment.count, 1);
  assert.ok(next.authority.pressure >= first.authority.pressure);
});

test('completion gate blocks consequential completion without verification', () => {
  const workflow = buildUnifiedAdaptiveWorkflow({
    goal: 'make a consequential change',
    situation: { riskScore: 0.9, uncertainty: 0.4, peopleDecision: true },
    acceptance: { criteria: ['decision supported'], evidenceRequired: ['independent review'] }
  });
  const gate = completionGate({
    workflow,
    status: 'complete',
    taskType: 'code',
    evidence: [{ kind: 'observed', text: 'implemented' }],
    verification: { verdict: 'fail' }
  });
  assert.equal(gate.allowed, false);
  assert.ok(gate.gaps.includes('verification-missing'));
});

test('ordinary conversational completion is not forced through an artificial evidence gate', () => {
  const workflow = buildUnifiedAdaptiveWorkflow({
    goal: 'say hello',
    situation: { uncertainty: 0, riskScore: 0.05 }
  });
  const gate = completionGate({ workflow, status: 'complete', taskType: 'respond', evidence: [] });
  assert.equal(gate.allowed, true);
});

test('recovery remains part of the same adaptive lifecycle', () => {
  const recovery = unifiedRecoveryDecision({ reason: 'revision conflict', attempts: 1, maxAttempts: 3 });
  assert.equal(recovery.action, 'reassess');
  assert.equal(recovery.blindRetryForbidden, true);
});

test('subsystems cannot bypass server authority', () => {
  const workflow = buildUnifiedAdaptiveWorkflow({
    goal: 'execute',
    situation: { riskScore: 1, peopleDecision: true },
    acceptance: { criteria: ['approved'], authorizationRequired: true, authorizationSatisfied: false }
  });
  assert.equal(subsystemCanAct(workflow, 'coder').allowed, false);
  assert.equal(subsystemCanAct(workflow, 'unknown-agent').allowed, false);
});
