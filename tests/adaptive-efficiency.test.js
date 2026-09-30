import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptiveEffortProfile,
  adaptiveResourceDecision,
  normalizeAdaptiveRisk
} from '../src/adaptive-efficiency.js';

test('keeps simple deterministic work on the minimal path', () => {
  const profile = adaptiveEffortProfile({ complexity: 0.1, uncertainty: 0.05, risk: 'low' });
  assert.equal(profile.level, 'minimal');
  assert.equal(profile.contextDepth, 'minimal');
  assert.equal(profile.verificationDepth, 'light');
});

test('raises effort for uncertainty and high-risk work', () => {
  const profile = adaptiveEffortProfile({
    complexity: 0.5,
    uncertainty: 0.8,
    risk: 'high',
    verificationGap: 0.4
  });
  assert.equal(profile.level, 'deep');
  assert.equal(profile.contextDepth, 'broad');
  assert.equal(profile.verificationDepth, 'deep');
  assert.equal(profile.expansionAllowed, true);
});

test('failure increases effort instead of repeating the same path', () => {
  const profile = adaptiveEffortProfile({ complexity: 0.3, uncertainty: 0.2, risk: 'medium', failureCount: 1 });
  assert.equal(profile.verificationDepth, 'deep');
});

test('does not spend when confidence is already sufficient', () => {
  const profile = adaptiveEffortProfile({ complexity: 0.2, uncertainty: 0.1, risk: 'low' });
  const decision = adaptiveResourceDecision({
    profile,
    estimatedCost: 10,
    expectedBenefit: 2,
    requiredConfidence: 0.9,
    currentConfidence: 0.95
  });
  assert.equal(decision.decision, 'stop');
});

test('normalizes unknown risk conservatively', () => {
  assert.equal(normalizeAdaptiveRisk('unknown-risk'), 'medium');
});
