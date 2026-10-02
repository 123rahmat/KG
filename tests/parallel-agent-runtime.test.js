import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelDecision, buildParallelExecutionPlan, workspaceLanesConflict, adaptConcurrency, agentWorkspaceLane, buildWorkspaceParallelPlan } from '../src/parallel-orchestrator.js';
test('adaptive scheduler exposes elastic but bounded parallelism', () => {
  const plan = buildParallelExecutionPlan({ mode: 'auto', maxParallel: 16, pressure: 0.8, concurrencyOpportunity: 0.8, stages: [{ id: 'a', metadata: {} }, { id: 'b', metadata: {} }, { id: 'c', metadata: {} }] });
  assert.equal(plan.decision.enabled, true); assert.ok(plan.decision.maxParallel <= 4); assert.equal(plan.waves[0].items.length, 3);
});
test('high-stakes auto mode stays conservative without explicit concurrency', () => {
  assert.equal(parallelDecision({ mode: 'auto', pressure: 0.1, concurrencyOpportunity: 0.4, risk: 'high-impact', itemCount: 3 }).enabled, false);
});
test('workspace conflict fails closed for overlapping or stale same-project writes', () => {
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r1', writeSet: ['b.js'] }), false);
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }), true);
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r1', readSet: ['a.js'] }), true);
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r1', readSet: ['b.js'] }), false);
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r2', writeSet: ['b.js'] }), true);
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', readSet: ['a.js'] }, { projectId: 'p', revisionId: 'r2', writeSet: ['b.js'] }), true);
  assert.equal(workspaceLanesConflict({ projectId: 'a' }, { projectId: 'b' }), false);
});

test('workspace lane contracts and scheduler preserve advisory reads and safe disjoint writes', () => {
  const advisory = agentWorkspaceLane({
    agentId: 'a1', role: 'architect', projectId: 'p', revisionId: 'r1',
    readSet: ['src/a.js'], authority: 'advisory'
  });
  const mutationA = agentWorkspaceLane({
    agentId: 'm1', role: 'builder', projectId: 'p', revisionId: 'r1',
    readSet: ['src/a.js'], writeSet: ['src/a.js'], authority: 'mutation'
  });
  const mutationB = agentWorkspaceLane({
    agentId: 'm2', role: 'builder', projectId: 'p', revisionId: 'r1',
    readSet: ['src/b.js'], writeSet: ['src/b.js'], authority: 'mutation'
  });
  const staleMutation = agentWorkspaceLane({
    agentId: 'm3', role: 'builder', projectId: 'p', revisionId: 'r2',
    writeSet: ['src/c.js'], authority: 'mutation'
  });
  assert.equal(advisory.valid, true);
  assert.equal(mutationA.valid, true);
  assert.equal(staleMutation.valid, true);
  const plan = buildWorkspaceParallelPlan({ lanes: [mutationA, mutationB], maxParallel: 2 });
  assert.equal(plan.waves[0].parallel, true);
  const serialized = buildWorkspaceParallelPlan({ lanes: [mutationA, staleMutation], maxParallel: 2 });
  assert.equal(serialized.waves.length, 2);
});

test('concurrency narrows under failures and expands only when healthy', () => {
  assert.equal(adaptConcurrency({ current: 4, max: 4, errorRate: 0.4, averageLatencyMs: 1000, remainingBudgetRatio: 0.8, benefit: 0.8 }).next, 3);
  assert.equal(adaptConcurrency({ current: 2, max: 4, errorRate: 0.01, averageLatencyMs: 1000, remainingBudgetRatio: 0.9, benefit: 0.8 }).next, 3);
  assert.equal(adaptConcurrency({ current: 4, max: 4, risk: 'high-impact', errorRate: 0, averageLatencyMs: 1000, remainingBudgetRatio: 0.9, benefit: 0.9 }).next, 2);
});

test('healthy high latency does not shrink concurrency and slow the critical path', () => {
  assert.equal(
    adaptConcurrency({
      current: 3,
      max: 6,
      errorRate: 0,
      averageLatencyMs: 9000,
      remainingBudgetRatio: 0.9,
      benefit: 0.8
    }).next,
    4
  );
  assert.equal(
    adaptConcurrency({
      current: 4,
      max: 6,
      errorRate: 0.12,
      averageLatencyMs: 9000,
      remainingBudgetRatio: 0.9,
      benefit: 0.3
    }).next,
    4
  );
});
