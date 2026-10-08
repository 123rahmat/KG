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

test('a failed parallel wave settles started peers before releasing the parent', async () => {
  const failure = new Error('provider failed');
  const gate = Promise.withResolvers();
  const ids = ['failed', 'peer', 'dependent'];
  const completed = [];
  let returned = false;
  const outcome = executeAgentLaneWaves({
    lanePlan: { waves: [
      { lanes: ids.slice(0, 2).map(agentId => ({ agentId })) },
      { lanes: [{ agentId: 'dependent' }] }
    ] },
    jobs: ids.map(agentId => ({ lane: { agentId } })), maxParallel: 2,
    execute: async job => {
      if (job.lane.agentId === 'failed') throw failure;
      if (job.lane.agentId === 'peer') await gate.promise;
      completed.push(job.lane.agentId);
      return job.lane.agentId;
    }
  }).then(() => { returned = true; return null; }, error => { returned = true; return error; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false, 'parent must wait for in-flight peer usage and evidence');
    assert.deepEqual(completed, []);
  } finally {
    gate.resolve();
    await outcome;
  }
  assert.equal(await outcome, failure);
  assert.deepEqual(completed, ['peer']);
});

test('invalid lane plans fail before any agent is invoked', async () => {
  const jobs = ids => ids.map(agentId => ({ lane: { agentId } }));
  const wave = ids => ({ lanes: ids.map(agentId => ({ agentId })) });
  for (const fixture of [
    { jobs: jobs(['a', 'a']), waves: [wave(['a'])] },
    { jobs: jobs(['a', 'b']), waves: [wave(['a']), wave(['unknown'])] },
    { jobs: jobs(['a', 'b']), waves: [wave(['a']), wave(['a', 'b'])] },
    { jobs: jobs(['a', 'b']), waves: [wave(['a'])] },
    { jobs: jobs(['']), waves: [wave([''])] }
  ]) {
    let calls = 0;
    await assert.rejects(executeAgentLaneWaves({
      jobs: fixture.jobs, lanePlan: { waves: fixture.waves },
      execute: async () => { calls += 1; }
    }));
    assert.equal(calls, 0, 'validation must precede model calls');
  }
});

test('cancellation drains the current batch and never starts dependent work', async () => {
  const controller = new AbortController();
  const gate = Promise.withResolvers();
  const ids = ['cancel', 'peer', 'later'];
  const completed = [];
  let returned = false;
  const outcome = executeAgentLaneWaves({
    signal: controller.signal, maxParallel: 2,
    jobs: ids.map(agentId => ({ lane: { agentId } })),
    lanePlan: { waves: [{ lanes: ids.map(agentId => ({ agentId })) }] },
    execute: async job => {
      if (job.lane.agentId === 'cancel') {
        controller.abort(new Error('user cancelled'));
        throw controller.signal.reason;
      }
      await gate.promise;
      completed.push(job.lane.agentId);
    }
  }).then(() => { returned = true; return null; }, error => { returned = true; return error; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
  } finally {
    gate.resolve();
    await outcome;
  }
  assert.equal(await outcome, controller.signal.reason);
  assert.deepEqual(completed, ['peer']);
});
