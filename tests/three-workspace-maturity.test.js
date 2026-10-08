import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModeControllerContract, workspaceComputePolicy } from '../src/mode-controllers.js';
import { evidenceNextTaskGate } from '../src/evidence-next-task-gate.js';

test('daily-life NormalChat remains direct and does not recruit a project team', () => {
  const result = buildModeControllerContract({
    surface: 'normal-chat', situation: { goal: 'Hello!' },
    complexity: .05, uncertainty: .02
  });
  assert.equal(result.mode, 'normal-chat');
  assert.equal(result.everyday.reasoningDepth, 'direct');
  assert.equal(result.decision.recruitSpecialist, false);
  assert.equal(result.compute.maxParallel, 1);
});

test('deep learning and reasoning remain inside NormalChat', () => {
  const result = buildModeControllerContract({
    surface: 'normal-chat',
    situation: { goal: 'Prove a difficult calculus theorem step by step' },
    complexity: .92, uncertainty: .68
  });
  assert.equal(result.mode, 'normal-chat');
  assert.equal(result.everyday.domain, 'education');
  assert.equal(result.everyday.reasoningDepth, 'deep');
  assert.equal(result.everyday.suggestedTransition, null);
});

test('Code and Research preserve distinct constrained specialist policies', () => {
  const code = workspaceComputePolicy({
    surface: 'code', complexity: .9, independentWork: .9, remainingBudgetRatio: .9
  });
  const research = workspaceComputePolicy({
    surface: 'research', complexity: .9, independentWork: .9, remainingBudgetRatio: .9
  });
  assert.equal(code.workspace, 'code');
  assert.equal(research.workspace, 'research');
  assert.notEqual(code.verificationBudget, research.verificationBudget);
  assert.ok(code.maxParallel > 1 && research.maxParallel > 1);
  for (const surface of ['normal-chat', 'code', 'research']) {
    const scarce = workspaceComputePolicy({
      surface, complexity: 1, independentWork: 1, remainingBudgetRatio: .07,
      verificationRequired: true
    });
    assert.equal(scarce.recommendedAgents, 1);
    assert.equal(scarce.maxParallel, 1);
    assert.equal(scarce.qualityFloor, 'verified-before-completion');
  }
});

test('all three workspaces use the same evidence gate for additional work', () => {
  const record = { type: 'code', id: 'test-code', status: 'complete',
    evidence: { result: { exitCode: 1, stdout: 'test failed' } } };
  const needs = { items: [{ required: true, status: 'partially-satisfied' }] };
  for (const surface of ['normal-chat', 'code', 'research']) {
    const proposal = { type: surface === 'research' ? 'investigate' : 'step' };
    assert.equal(evidenceNextTaskGate({
      sourceTask: { type: 'reassess' }, tasks: [record], proposal, requirements: needs
    }).allowed, true);
    assert.equal(evidenceNextTaskGate({
      sourceTask: { type: 'reassess' }, tasks: [], proposal, requirements: needs
    }).allowed, false);
  }
});
