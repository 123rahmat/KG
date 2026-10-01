import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelDecision, buildParallelExecutionPlan, workspaceLanesConflict } from '../src/parallel-orchestrator.js';
test('adaptive scheduler exposes bounded parallelism', () => {
  const plan = buildParallelExecutionPlan({ mode: 'auto', maxParallel: 4, pressure: 0.8, concurrencyOpportunity: 0.8, stages: [{ id: 'a', metadata: {} }, { id: 'b', metadata: {} }, { id: 'c', metadata: {} }] });
  assert.equal(plan.decision.enabled, true); assert.ok(plan.decision.maxParallel <= 4); assert.equal(plan.waves[0].items.length, 3);
});
test('high-stakes auto mode stays conservative without explicit concurrency', () => {
  assert.equal(parallelDecision({ mode: 'auto', pressure: 0.1, concurrencyOpportunity: 0.4, risk: 'high-impact', itemCount: 3 }).enabled, false);
});
test('workspace conflict fails closed for overlapping same-project writes', () => {
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r1', writeSet: ['b.js'] }), false);
  assert.equal(workspaceLanesConflict({ projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }, { projectId: 'p', revisionId: 'r1', writeSet: ['a.js'] }), true);
  assert.equal(workspaceLanesConflict({ projectId: 'a' }, { projectId: 'b' }), false);
});