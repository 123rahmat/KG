import test from 'node:test';
import assert from 'node:assert/strict';
import { specialistWaveDecision } from '../src/specialist-wave-policy.js';

const finding = (recommendation = 'proceed', confidence = .92, extra = {}) =>
  ({ recommendation, confidence, ...extra });

test('simple Chat stays small and serial without established independent work', () => {
  const result = specialistWaveDecision({ workspace: 'normal-chat', plannedAgents: 1, maxAgents: 6 });
  assert.equal(result.targetAgents, 1);
  assert.equal(result.maxParallel, 1);
  assert.equal(result.action, 'hold');
});

test('credible independent convergence contracts additional advisory work', () => {
  const result = specialistWaveDecision({ workspace: 'research', plannedAgents: 5,
    completedRoles: ['researcher', 'source-checker'],
    findings: [finding(), finding('proceed', .94)], independence: .9 });
  assert.equal(result.action, 'contract');
  assert.equal(result.stopRecruitment, true);
  assert.equal(result.targetAgents, 2);
  assert.equal(result.verificationAuthority, 'parent-workflow-only');
});

test('disagreement can recruit one bounded extra specialist for evidence review', () => {
  const result = specialistWaveDecision({ workspace: 'research',
    plannedAgents: 2, maxAgents: 4, completedRoles: ['analyst', 'reviewer'],
    findings: [finding('proceed', .75), finding('revise', .7)],
    remainingBudgetRatio: .8, independence: .95 });
  assert.equal(result.action, 'recruit');
  assert.equal(result.targetAgents, 3);
  assert.ok(result.maxParallel <= 4);
});

test('unresolved evidence gaps justify recruitment but not fabricated completion', () => {
  const result = specialistWaveDecision({ workspace: 'code', plannedAgents: 2,
    maxAgents: 4, pressure: .85, findings: [finding('investigate', .65, { unknowns: ['broken test'] })],
    completedRoles: ['builder'], independence: 1 });
  assert.equal(result.action, 'hold');
  assert.equal(result.stopRecruitment, false);
});

test('low budget prevents optional follow-on calls while preserving core verification', () => {
  const result = specialistWaveDecision({ workspace: 'research', plannedAgents: 4,
    completedRoles: ['analyst'], findings: [finding()], remainingBudgetRatio: .2 });
  assert.equal(result.stopRecruitment, true);
  assert.equal(result.maxParallel, 1);
  assert.equal(result.targetAgents, 1);
});

test('high-stakes work and failures serialize specialist lanes', () => {
  for (const condition of [{ risk: 'high' }, { failedRoles: ['bad-result'] }]) {
    const result = specialistWaveDecision({ workspace: 'code', plannedAgents: 4,
      maxAgents: 7, independence: 1, ...condition });
    assert.equal(result.maxParallel, 1);
  }
});

test('explicit agent mode holds chosen team except hard budget and acceptance gates', () => {
  const requested = specialistWaveDecision({ mode: 'always', workspace: 'code',
    plannedAgents: 4, maxAgents: 5,
    completedRoles: ['a', 'b'], findings: [finding(), finding()] });
  assert.equal(requested.action, 'hold');
  assert.equal(requested.targetAgents, 4);
  assert.equal(specialistWaveDecision({ mode: 'always', plannedAgents: 4,
    remainingBudgetRatio: .02 }).stopRecruitment, true);
});

test('no task-level success is inferred from individual model self-confidence', () => {
  const unverified = specialistWaveDecision({ plannedAgents: 3, maxAgents: 5,
    completedRoles: ['a'], findings: [finding('proceed', 1)] });
  assert.equal(unverified.stopRecruitment, false);
  assert.equal(unverified.verificationAuthority, 'parent-workflow-only');
  const approved = specialistWaveDecision({ plannedAgents: 3, acceptanceSatisfied: true });
  assert.equal(approved.action, 'stop');
});

test('unknown budgets are not falsely interpreted as exhausted', () => {
  for (const remainingBudgetRatio of [undefined, null, '', 'not-measured']) {
    const result = specialistWaveDecision({ plannedAgents: 3, maxAgents: 5, remainingBudgetRatio });
    assert.equal(result.budgetKnown, false);
    assert.equal(result.targetAgents, 3);
  }
});
