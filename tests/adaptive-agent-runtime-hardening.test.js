import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAdaptiveAgentPlan, decideAgentTopology, adaptAgentTopology } from '../src/adaptive-agents.js';

test('serialized and retrying topologies retain every selected task', () => {
  for (const options of [{ risk: 'high-impact' }, { retrying: true }]) {
    const plan = decideAgentTopology({ tasks: [{ id: 'a', type: 'analyze' }, { id: 'b', type: 'analyze' }, { id: 'c', type: 'verify' }], ...options });
    assert.equal(plan.waves.every(wave => wave.length === 1), true);
    assert.deepEqual(plan.waves.flat().sort(), plan.agents.map(agent => agent.id).sort());
  }
});

test('planned waves respect the parallel budget without discarding work', () => {
  const plan = decideAgentTopology({ tasks: ['a', 'b', 'c', 'd'].map(id => ({ id, type: 'analyze' })), scale: 'medium', budget: { maxAgents: 4, maxParallelAgents: 2 } });
  assert.equal(plan.waves.every(wave => wave.length <= 2), true);
  assert.equal(plan.waves.flat().length, 4);
  const recovered = adaptAgentTopology(plan, { failed: true, taskId: 'a' });
  assert.equal(recovered.maxParallel, 1);
  assert.deepEqual(recovered.waves.flat(), plan.waves.flat());
});

test('executor enforces concurrency even for an oversized supplied wave', async () => {
  let active = 0; let peak = 0;
  const result = await executeAdaptiveAgentPlan({ maxParallel: 2, agents: ['a', 'b', 'c', 'd'].map(id => ({ id, taskIds: [id] })), waves: [['a', 'b', 'c', 'd']] }, {
    tasks: ['a', 'b', 'c', 'd'].map(id => ({ id })),
    executeAgent: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.completedAgents.length, 4);
  assert.equal(peak, 2);
});

test('executor rejects incomplete or duplicate wave schedules before execution', async () => {
  for (const waves of [[['a']], [['a', 'b', 'unknown']], [['a', 'b'], ['a']]]) {
    let calls = 0;
    const result = await executeAdaptiveAgentPlan({ agents: [{ id: 'a', taskIds: ['a'] }, { id: 'b', taskIds: ['b'] }], waves }, {
      tasks: [{ id: 'a' }, { id: 'b' }], executeAgent: async () => { calls++; }
    });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 0);
  }
});

test('executor cannot declare unassigned work completed', async () => {
  const result = await executeAdaptiveAgentPlan({ agents: [{ id: 'a', taskIds: ['a'] }], waves: [['a']] }, {
    tasks: [{ id: 'a' }, { id: 'unassigned' }], executeAgent: async () => ({ ok: true })
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'unassigned-task');
});

async function withinDeadline(operation) {
  let watchdog;
  try { return await Promise.race([operation, new Promise(resolve => { watchdog = setTimeout(() => resolve({ status: 'hung' }), 250); })]); }
  finally { clearTimeout(watchdog); }
}

test('noncooperative agent times out instead of hanging the workflow', async () => {
  const result = await withinDeadline(executeAdaptiveAgentPlan({ agents: [{ id: 'a', taskIds: ['a'] }], waves: [['a']] }, {
    tasks: [{ id: 'a' }], timeoutMs: 20, executeAgent: () => new Promise(() => {})
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.results[0].reason, 'agent-timeout');
});

test('cancellation settles promptly even when the agent ignores its signal', async () => {
  const controller = new AbortController();
  const result = await withinDeadline(executeAdaptiveAgentPlan({ agents: [{ id: 'a', taskIds: ['a'] }], waves: [['a']] }, {
    tasks: [{ id: 'a' }], timeoutMs: 100, signal: controller.signal,
    executeAgent: () => { controller.abort(); return new Promise(() => {}); }
  }));
  assert.equal(result.status, 'cancelled');
});

test('integration also has a hard deadline', async () => {
  const result = await withinDeadline(executeAdaptiveAgentPlan({ agents: [{ id: 'a', taskIds: ['a'] }], waves: [['a']], integrationRequired: true }, {
    tasks: [{ id: 'a' }], timeoutMs: 20, executeAgent: async () => ({ ok: true }), integrate: () => new Promise(() => {})
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.integration.reason, 'agent-timeout');
});

test('non-Error rejections become failed results instead of crashing orchestration', async () => {
  for (const reason of [null, undefined, 'provider unavailable']) {
    const result = await executeAdaptiveAgentPlan({ agents: [{ id: 'a', taskIds: ['a'] }], waves: [['a']] }, {
      tasks: [{ id: 'a' }], maxRetries: 0, executeAgent: () => Promise.reject(reason)
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.results[0].status, 'failed');
  }
});

test('adaptive executor fails closed on unknown dependencies before any agent runs', async () => {
  let calls = 0;
  const result = await executeAdaptiveAgentPlan({
    agents: [{ id: 'lead-1', taskIds: ['a'] }],
    waves: [['lead-1']]
  }, {
    tasks: [{ id: 'a', type: 'analyze', dependencies: ['missing'] }],
    executeAgent: async () => { calls += 1; }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'unknown-dependency');
  assert.equal(calls, 0);
});

test('adaptive executor never runs a wave whose task dependency is incomplete', async () => {
  const calls = [];
  const result = await executeAdaptiveAgentPlan({
    agents: [
      { id: 'a1', taskIds: ['a'] },
      { id: 'b1', taskIds: ['b'] }
    ],
    waves: [['a1', 'b1']]
  }, {
    tasks: [
      { id: 'a', type: 'analyze' },
      { id: 'b', type: 'verify', dependencies: ['a'] }
    ],
    executeAgent: async agent => { calls.push(agent.id); }
  });
  assert.equal(result.status, 'failed');
  assert.equal(calls.includes('b1'), false);
});

test('adaptive executor converts integration exceptions into an explicit failed outcome', async () => {
  const result = await executeAdaptiveAgentPlan({
    agents: [{ id: 'a1', taskIds: ['a'] }, { id: 'b1', taskIds: ['b'] }],
    waves: [['a1', 'b1']],
    integrationRequired: true,
    authority: { serverOwned: true }
  }, {
    tasks: [{ id: 'a' }, { id: 'b' }],
    executeAgent: async agent => ({ agent: agent.id }),
    integrate: async () => { throw new Error('integration unavailable'); }
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.integration.status, 'failed');
  assert.equal(result.integration.reason, 'integration unavailable');
  assert.equal(result.failedAgents.includes('integrator'), true);
});
