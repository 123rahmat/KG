import test from 'node:test';
import assert from 'node:assert/strict';
import { specialistTopology, remainingSpecialistBudget } from '../src/agent-topology-policy.js';

test('explicit specialists can safely parallelize but still respect provider and user caps', () => {
  const result = specialistTopology({ mode: 'always', surface: 'normal-chat',
    maxAgents: 4, proposedAgents: 4, independentWork: 0.05, remainingBudgetRatio: 1 });
  assert.equal(result.agents, 4);
  assert.equal(result.maxParallel, 2);
  assert.equal(result.mode, 'parallel');
});

test('advanced high-risk engineering work scales specialists but serializes execution', () => {
  const r = specialistTopology({ mode: 'auto', surface: 'normal-chat', proposedAgents: 11,
    maxAgents: 11, risk: 'high-impact', advancedBuild: true, independentWork: 1 });
  assert.equal(r.agents, 11);
  assert.equal(r.maxParallel, 1);
  assert.equal(r.qualityGate, 'independent-verification-required');
});

test('ordinary conversation does not scale merely because an agent count is configured', () => {
  const r = specialistTopology({ mode: 'auto', surface: 'normal-chat', proposedAgents: 11, maxAgents: 11 });
  assert.equal(r.agents, 3);
  assert.equal(r.maxParallel, 1);
});

test('low remaining budget overrules explicit multi-agent demand', () => {
  const budget = remainingSpecialistBudget({ adaptiveBudget: {
    budget: { tokens: 100, skillCost: 10 }, remaining: { tokens: 6, skillCost: 9 }
  } });
  assert.equal(budget, .06);
  const r = specialistTopology({ mode: 'always', proposedAgents: 11, maxAgents: 11,
    remainingBudgetRatio: budget, independentWork: 1 });
  assert.equal(r.agents, 0);
  assert.equal(r.maxParallel, 1);
  assert.equal(r.reason, 'specialist-budget-exhausted');
});

test('high-risk tasks remain serialized even with an explicit parallel request', () => {
  const r = specialistTopology({ mode: 'always', explicitParallel: true, proposedAgents: 5,
    maxAgents: 5, remainingBudgetRatio: 1, risk: 'regulated' });
  assert.equal(r.agents, 5);
  assert.equal(r.maxParallel, 1);
});

test('missing budget readings do not suppress justified optional specialists', () => {
  for (const value of [null, undefined, '', ' ', NaN, Infinity]) {
    const ratio = remainingSpecialistBudget({ adaptiveBudget: {
      budget: { tokens: 100 }, remaining: { tokens: value }
    } });
    assert.equal(ratio, null, String(value));
    const result = specialistTopology({ surface: 'code', proposedAgents: 4,
      independentWork: .9, remainingBudgetRatio: value });
    assert.equal(result.agents, 4, String(value));
    assert.equal(result.budgetKnown, false, String(value));
  }
});
