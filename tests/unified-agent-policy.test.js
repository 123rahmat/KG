import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingSpecialistBudget, specialistTopology } from '../src/agent-topology-policy.js';
import { taskSpecialization } from '../src/task-specialization.js';
import { executeAgentLaneWaves } from '../src/agent-lane-executor.js';
import { taskLensFor, contextualSuggestions } from '../public/task-lens.js';
import { agentActivitySnapshot } from '../public/agent-activity.js';

test('optional specialists conserve scarce budgets and respect user opt-out', () => {
  assert.equal(remainingSpecialistBudget({}), null);
  assert.equal(remainingSpecialistBudget({ adaptiveBudget: { budget: { tokens: 100 }, remaining: { tokens: 5 } } }), .05);
  const args = { surface: 'code', proposedAgents: 5, maxAgents: 8, independentWork: .9 };
  assert.equal(specialistTopology({ ...args, mode: 'off' }).agents, 0);
  assert.equal(specialistTopology({ ...args, remainingBudgetRatio: .05 }).agents, 0);
  assert.equal(specialistTopology({ ...args, remainingBudgetRatio: .2 }).agents, 1);
  assert.equal(specialistTopology({ ...args, remainingBudgetRatio: .35 }).agents, 2);
  assert.equal(specialistTopology({ ...args, remainingBudgetRatio: .9 }).agents, 5);
  assert.equal(specialistTopology({ ...args, risk: 'critical', remainingBudgetRatio: 1 }).maxParallel, 1);
});

test('task-specific assignments restrict scope without inventing authority', () => {
  const spec = taskSpecialization('backend-engineer', {
    goal: 'Implement a reliable API',
    task: { id: 'build-code', purpose: 'Implement auth endpoint' },
    situation: { successCriteria: ['No unauthorized access'] },
    workspacePanel: { ownedFiles: ['src/auth.js', 'src/auth.js'] }
  });
  assert.equal(spec.role, 'backend-engineer');
  assert.equal(spec.task, 'Implement auth endpoint');
  assert.deepEqual(spec.scope.ownedFiles, ['src/auth.js']);
  assert.deepEqual(spec.expectedEvidence, ['No unauthorized access']);
  assert.match(spec.authority, /Advisory only/);
});

test('parallel lanes never exceed the limit and dependent waves wait', async () => {
  let active = 0, peak = 0;
  const order = [];
  const lanes = ids => ({ lanes: ids.map(agentId => ({ agentId })) });
  const ids = ['a', 'b', 'c', 'd'];
  const results = await executeAgentLaneWaves({
    lanePlan: { waves: [lanes(['a', 'b', 'c']), lanes(['d'])] },
    jobs: ids.map(agentId => ({ lane: { agentId } })),
    maxParallel: 2,
    execute: async job => {
      active += 1; peak = Math.max(peak, active);
      order.push(job.lane.agentId);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return job.lane.agentId;
    }
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, ids);
  assert.equal(order.at(-1), 'd');
  await assert.rejects(executeAgentLaneWaves({
    lanePlan: { waves: [lanes(['a'])] }, jobs: ids.map(agentId => ({ lane: { agentId } })), execute: async () => 1
  }), /omitted/);
});

test('task presentation respects server-chosen surface and avoids speculative activity', () => {
  const run = { state: 'complete', surface: 'normal-chat', goal: 'Brainstorm new ideas for the clinic' };
  assert.equal(taskLensFor(run).kind, 'brainstorming');
  assert.equal(contextualSuggestions(run).length, 2);
  assert.equal(contextualSuggestions({ ...run, state: 'running' }).length, 0);
  assert.equal(taskLensFor({ ...run, surface: 'research' }).kind, 'researching');
  const activity = agentActivitySnapshot({
    ...run, tasks: [{ evidence: { multiAgent: { agentStates: [{ role: 'analyst', status: 'running' }] } } }]
  });
  assert.equal(activity.active.length, 0);
});
