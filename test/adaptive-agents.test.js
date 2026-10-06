import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentTopology, adaptAgentTopology } from '../src/adaptive-agents.js';

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
