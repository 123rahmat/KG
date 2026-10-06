import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentTopology, adaptAgentTopology, executeAdaptiveAgentPlan } from '../src/adaptive-agents.js';

test('simple work stays single-agent', () => {
  const plan = decideAgentTopology({
    tasks: [{ id: 't1', type: 'respond' }],
    scale: 'single'
  });
  assert.equal(plan.mode, 'single');
  assert.equal(plan.agentCount, 1);
  assert.equal(plan.maxParallel, 1);
});

test('independent medium work uses bounded parallel agents', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'research', type: 'investigate' },
      { id: 'code', type: 'build-code' },
      { id: 'test', type: 'test-code' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.4,
    budget: { maxAgents: 4, maxParallelAgents: 3 }
  });
  assert.equal(plan.mode, 'parallel-then-integrate');
  assert.ok(plan.maxParallel <= 3);
  assert.equal(plan.integrationRequired, true);
  assert.equal(plan.authority.modelCannotAuthorize, true);
});

test('dependencies prevent unsafe parallel execution', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'investigate' },
      { id: 'b', type: 'build-code', dependencies: ['a'] },
      { id: 'c', type: 'test-code', dependencies: ['b'] }
    ],
    scale: 'large',
    complexity: 0.9,
    uncertainty: 0.6
  });
  assert.equal(plan.waves.length, 3);
  assert.ok(plan.waves.every(wave => wave.length === 1));
});

test('high-impact or physical work is serialized at the authority boundary', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'execute' },
      { id: 'b', type: 'verify' }
    ],
    scale: 'large',
    risk: 'high-impact',
    externalAction: true
  });
  assert.equal(plan.mode, 'serialized');
  assert.equal(plan.maxParallel, 1);
  assert.equal(plan.authority.externalActionsSerialized, true);
});

test('agent failure causes bounded replanning rather than false completion', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'investigate' },
      { id: 'b', type: 'build-code' }
    ],
    scale: 'medium',
    complexity: 0.8
  });
  const next = adaptAgentTopology(plan, { event: 'failed', taskId: 'a', failed: true });
  assert.equal(next.replanned, true);
  assert.equal(next.mode, 'pipeline');
  assert.equal(next.failedTaskId, 'a');
});

test('adaptive executor runs independent agents in parallel and records checkpoints', async () => {
  const started = [];
  const checkpoints = [];
  const plan = {
    mode: 'parallel-then-integrate',
    agents: [
      { id: 'a1', taskIds: ['a'] },
      { id: 'a2', taskIds: ['b'] }
    ],
    waves: [['a1', 'a2']],
    integrationRequired: true,
    authority: { serverOwned: true }
  };
  const result = await executeAdaptiveAgentPlan(plan, {
    tasks: [
      { id: 'a', resourceKeys: ['a'] },
      { id: 'b', resourceKeys: ['b'] }
    ],
    executeAgent: async agent => {
      started.push(agent.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true };
    },
    integrate: async ({ findings }) => ({ status: 'complete', count: findings.length }),
    checkpoint: state => checkpoints.push(state)
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(started.sort(), ['a1', 'a2']);
  assert.equal(result.integration.status, 'complete');
  assert.equal(result.integration.count, 2);
  assert.ok(checkpoints.length >= 1);
});

test('adaptive executor blocks unmet dependencies instead of racing them', async () => {
  const plan = {
    mode: 'pipeline',
    agents: [
      { id: 'a1', taskIds: ['a'] },
      { id: 'a2', taskIds: ['b'] }
    ],
    waves: [['a2'], ['a1']],
    authority: { serverOwned: true }
  };
  const result = await executeAdaptiveAgentPlan(plan, {
    tasks: [
      { id: 'a' },
      { id: 'b', dependencies: ['a'] }
    ],
    executeAgent: async agent => ({ agentId: agent.id })
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].reason, 'dependencies-not-complete');
});

test('adaptive executor rejects invalid task graphs before execution', async () => {
  let calls = 0;
  const result = await executeAdaptiveAgentPlan({
    agents: [{ id: 'a1', taskIds: ['missing'] }],
    waves: [['a1']],
    authority: { serverOwned: true }
  }, {
    tasks: [{ id: 'a' }],
    executeAgent: async () => {
      calls += 1;
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'unknown-task');
  assert.equal(calls, 0);
});

test('adaptive executor fails closed when integration fails', async () => {
  const result = await executeAdaptiveAgentPlan({
    agents: [{ id: 'a1', taskIds: ['a'] }],
    waves: [['a1']],
    integrationRequired: true,
    authority: { serverOwned: true }
  }, {
    tasks: [{ id: 'a' }],
    executeAgent: async () => ({ ok: true }),
    integrate: async () => {
      throw new Error('integration mismatch');
    }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.integration.status, 'failed');
  assert.equal(result.failedAgents.includes('integrator'), true);
});
