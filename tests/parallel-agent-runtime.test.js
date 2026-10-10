import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelDecision, buildParallelExecutionPlan, workspaceLanesConflict, adaptConcurrency, agentWorkspaceLane, buildWorkspaceParallelPlan, tasksConflict } from '../src/parallel-orchestrator.js';
test('adaptive scheduler exposes elastic but bounded parallelism', () => {
  const plan = buildParallelExecutionPlan({ mode: 'auto', maxParallel: 16, pressure: 0.8, concurrencyOpportunity: 0.8, stages: [{ id: 'a', metadata: {} }, { id: 'b', metadata: {} }, { id: 'c', metadata: {} }] });
  assert.equal(plan.decision.enabled, true); assert.ok(plan.decision.maxParallel <= 4); assert.equal(plan.waves[0].items.length, 3);
});
test('generic tasks serialize readers against same-resource writers but allow shared reads', () => {
  const read = { id: 'read', metadata: { readSet: ['config.json'] } };
  const write = { id: 'write', metadata: { writeSet: ['config.json'] } };
  const otherRead = { id: 'read-2', metadata: { readSet: ['config.json'] } };
  assert.equal(tasksConflict(read, write), true);
  assert.equal(tasksConflict(write, read), true);
  assert.equal(tasksConflict(read, otherRead), false);
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

test('directory-scoped changes serialize descendant edits and reads', () => {
  const parent = { id: 'parent', metadata: { writeSet: ['src/routes/'] } };
  const child = { id: 'child', metadata: { writeSet: ['src/routes/runs.js'] } };
  const sibling = { id: 'sibling', metadata: { writeSet: ['src/runtime.js'] } };
  assert.equal(tasksConflict(parent, child), true);
  assert.equal(tasksConflict(parent, sibling), false);
  assert.equal(workspaceLanesConflict({
    projectId: 'p', revisionId: 'r1', writeSet: ['src/routes']
  }, {
    projectId: 'p', revisionId: 'r1', readSet: ['src/routes/execution.js']
  }), true);
  assert.equal(workspaceLanesConflict({
    projectId: 'p', revisionId: 'r1', writeSet: ['src/api.js']
  }, {
    projectId: 'p', revisionId: 'r1', writeSet: ['src/api-extra.js']
  }), false);
});

test('mandatory skipped or unaccepted prerequisites never unlock follow-up work', async () => {
  const { readyTasks } = await import('../src/parallel-orchestrator.js');
  const { openWorldFrontier, composeOpenWorldDecision } = await import('../src/open-world-task-graph.js');
  const skipped = { id: 'test', status: 'skipped', metadata: { required: true } };
  const pending = { id: 'deliver', status: 'pending', dependsOn: ['test'] };
  assert.deepEqual(readyTasks([skipped, pending]), []);
  assert.deepEqual(openWorldFrontier({ nodes: [skipped, pending] }).ready, []);
  const proposed = composeOpenWorldDecision({
    situation: { uncertainty: 0.9 }, graph: { nodes: [skipped] },
    candidates: [{ id: 'deliver', dependsOn: ['test'] }]
  });
  assert.notEqual(proposed.action, 'propose-work');
  const unaccepted = { ...skipped, status: 'complete', metadata: { acceptanceRequired: true } };
  assert.deepEqual(readyTasks([unaccepted, pending]), []);
  assert.deepEqual(readyTasks([{ ...unaccepted, acceptance: { status: 'accepted' } }, pending]).map(x => x.id), ['deliver']);
  const waived = { ...skipped, metadata: { required: false, waiverApproved: true } };
  assert.deepEqual(readyTasks([waived, pending]).map(x => x.id), ['deliver']);
  assert.deepEqual(readyTasks([{ ...waived, metadata: { required: false } }, pending]), []);
});
