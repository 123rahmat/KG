import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAdaptiveAgentPlan } from '../src/adaptive-agents.js';

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
