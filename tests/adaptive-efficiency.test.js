import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveExecutionStrategy, adaptiveEffortProfile, adaptiveBehaviorContract } from '../src/adaptive-efficiency.js';

test('simple work takes the fast path', () => {
  const s = adaptiveExecutionStrategy({ pressure: 0.1, uncertainty: 0, complexity: 0.05 });
  assert.equal(s.strategy, 'fast-path');
  assert.equal(s.reasoning, 'low');
  assert.equal(s.parallelizeIndependentWork, false);
});

test('independent healthy work can parallelize without bypassing verification', () => {
  const s = adaptiveExecutionStrategy({
    pressure: 0.45, complexity: 0.5, independentWork: 0.8,
    verificationRequired: true, remainingBudgetRatio: 0.9
  });
  assert.equal(s.parallelizeIndependentWork, true);
  assert.equal(s.verification, 'required-before-completion');
});

test('failure and uncertainty escalate reasoning', () => {
  const s = adaptiveExecutionStrategy({
    pressure: 0.7, uncertainty: 0.8, complexity: 0.8, previousFailure: true
  });
  assert.equal(s.strategy, 'adaptive-deep');
  assert.equal(s.reasoning, 'high');
  assert.equal(s.avoidRedundantDiscovery, true);
});

test('verified state can short-circuit redundant work but not required verification', () => {
  const s = adaptiveExecutionStrategy({
    pressure: 0.2, cacheHit: true, verificationRequired: true,
    verificationSatisfied: false
  });
  assert.equal(s.reuseVerifiedState, true);
  assert.equal(s.verification, 'required-before-completion');
});

test('behavior contract exposes the execution strategy', () => {
  const profile = adaptiveEffortProfile({ complexity: 0.1, uncertainty: 0, risk: 'low' });
  const contract = adaptiveBehaviorContract(profile, {
    situation: { goal: 'answer', parallelOpportunity: 0 },
    acceptance: {}
  });
  assert.ok(contract.executionStrategy);
  assert.equal(contract.executionStrategy.strategy, 'fast-path');
});
