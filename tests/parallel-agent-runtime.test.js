import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelDecision, buildParallelExecutionPlan } from '../src/parallel-orchestrator.js';

test('adaptive scheduler exposes bounded parallelism', () => {
  const plan = buildParallelExecutionPlan({
    mode: 'auto',
    maxParallel: 4,
    pressure: 0.8,
    concurrencyOpportunity: 0.8,
    stages: [
      { id: 'research-a', metadata: { readSet: ['docs'] } },
      { id: 'research-b', metadata: { readSet: ['repo'] } },
      { id: 'research-c', metadata: { readSet: ['tests'] } }
    ]
  });
  assert.equal(plan.decision.enabled, true);
  assert.ok(plan.decision.maxParallel <= 4);
  assert.equal(plan.waves[0].items.length, 3);
});

test('high-stakes auto mode stays conservative without explicit concurrency', () => {
  const decision = parallelDecision({
    mode: 'auto',
    pressure: 0.1,
    concurrencyOpportunity: 0.4,
    risk: 'high-impact',
    itemCount: 3
  });
  assert.equal(decision.enabled, false);
});
