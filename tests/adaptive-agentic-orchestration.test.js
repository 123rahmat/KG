import test from 'node:test';
import assert from 'node:assert/strict';
import { multiAgentDecision } from '../src/multi-agent.js';
import { adaptiveParallelLimit, buildWorkspaceParallelPlan } from '../src/parallel-orchestrator.js';

test('agent orchestration remains single-agent for simple work', () => {
  const decision = multiAgentDecision(
    { goal: 'answer a simple question', situation: { risk: 'low', uncertainty: 0 } },
    { id: 't1', type: 'respond', metadata: {} },
    { mode: 'auto' }
  );
  assert.equal(decision.enabled, false);
});

test('agent orchestration exposes server-owned adaptive authority', () => {
  const decision = multiAgentDecision(
    { goal: 'debug a complex project', situation: { risk: 'high', uncertainty: 0.8, verificationGap: 0.7 } },
    { id: 't1', type: 'build-code', metadata: { buildPlan: true } },
    { mode: 'auto' }
  );
  assert.equal(decision.adaptiveAuthority?.authority, 'server-owned');
});

test('parallelism is bounded by adaptive authority and budget', () => {
  const decision = adaptiveParallelLimit({
    pressure: 0.8,
    concurrencyOpportunity: 0.8,
    itemCount: 6,
    max: 6,
    remainingBudgetRatio: 0.2
  });
  assert.ok(decision.maxParallel <= 2);
  assert.equal(decision.authorityDecision?.authority, 'server-owned');
});

test('code writers only parallelize on the same immutable revision and disjoint paths', () => {
  const plan = buildWorkspaceParallelPlan({
    maxParallel: 3,
    lanes: [
      { agentId: 'a', role: 'implementer', authority: 'mutation', valid: true, projectId: 'p', revisionId: 'r1', writeSet: ['a.js'], readSet: [] },
      { agentId: 'b', role: 'implementer', authority: 'mutation', valid: true, projectId: 'p', revisionId: 'r1', writeSet: ['b.js'], readSet: [] },
      { agentId: 'c', role: 'implementer', authority: 'mutation', valid: true, projectId: 'p', revisionId: 'r2', writeSet: ['c.js'], readSet: [] }
    ]
  });
  assert.equal(plan.waves[0].parallel, true);
  assert.equal(plan.waveCount, 2);
});
