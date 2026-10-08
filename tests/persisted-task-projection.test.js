import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPersistedTaskGraph } from '../src/persisted-task-projection.js';
import { composeOpenWorldDecision, openWorldFrontier } from '../src/open-world-task-graph.js';

const task = (id, status = 'pending', dependsOn = [], metadata = {}) =>
  ({ id, type: 'work', status, depends_on: dependsOn, requires: [],
    purpose: id, metadata });

test('new persisted chat task is visible as ready rather than an empty graph', () => {
  const graph = projectPersistedTaskGraph([task('respond')]);
  assert.equal(graph.authoritative, 'server-run-tasks');
  assert.equal(graph.revision, 1);
  assert.deepEqual(openWorldFrontier(graph).ready, ['respond']);
  assert.equal(composeOpenWorldDecision({ goal: 'hi', graph }).action, 'continue-work');
});

test('coding task dependencies and status track server updates with stable revisions', () => {
  const tasks = [task('inspect', 'pending'), task('code', 'pending', ['inspect']),
    task('verify', 'pending', ['code'])];
  const first = projectPersistedTaskGraph(tasks);
  const unchanged = projectPersistedTaskGraph(tasks, first);
  assert.equal(unchanged.revision, first.revision);
  assert.deepEqual(openWorldFrontier(first).ready, ['inspect']);
  tasks[0].status = 'complete';
  const second = projectPersistedTaskGraph(tasks, first);
  assert.equal(second.revision, first.revision + 1);
  assert.deepEqual(openWorldFrontier(second).ready, ['code']);
  tasks[1].status = 'failed';
  const failed = projectPersistedTaskGraph(tasks, second);
  assert.equal(composeOpenWorldDecision({ goal: 'fix', graph: failed }).action, 'recover');
});

test('long-running research chats remain bounded without falsely releasing unmet dependencies', () => {
  const tasks = Array.from({ length: 70 }, (_, i) => task('step-'+i, 'complete'));
  tasks.push(task('research', 'pending', ['step-0', 'step-69']));
  const graph = projectPersistedTaskGraph(tasks);
  assert.equal(graph.nodes.length, 48);
  assert.equal(graph.total, 71);
  assert.equal(graph.archived, 23);
  assert.equal(graph.truncated, true);
  assert.deepEqual(openWorldFrontier(graph).ready, ['research']);
  assert.equal(graph.nodes.at(-1).metadata.archivedPrerequisites, 1);
  tasks[0].status = 'failed';
  const blocked = projectPersistedTaskGraph(tasks, graph);
  assert.equal(blocked.nodes.at(-1).status, 'pending');
  assert.deepEqual(openWorldFrontier(blocked).ready, []);
  assert.equal(composeOpenWorldDecision({ goal:'research', graph:blocked }).action, 'recover');
});

test('no code write or parallelism is presumed from a task without verified lane metadata', () => {
  const tasks = [task('change-a'), task('change-b')];
  const graph = projectPersistedTaskGraph(tasks);
  assert.equal(graph.nodes.every(node => node.metadata.parallel === false), true);
  assert.deepEqual(openWorldFrontier(graph).waves, [['change-a'], ['change-b']]);
  tasks[0].metadata = {parallel: true, parallelEligible: true};
  tasks[1].metadata = {parallel: true, parallelEligible: true};
  const trusted = projectPersistedTaskGraph(tasks, graph);
  assert.deepEqual(openWorldFrontier(trusted).waves, [['change-a','change-b']]);
});

test('projection does not expose raw private evidence or token-bearing task metadata', () => {
  const original = { ...task('research','complete'),
    evidence: { token: 'SECRET', privateNotes:'DO NOT EXPOSE' },
    metadata: { token: 'SECRET', privateNotes: 'DO NOT EXPOSE' },
    summary: 'DO NOT EXPOSE' };
  const graph = projectPersistedTaskGraph([original]);
  assert.equal(JSON.stringify(graph).includes('SECRET'), false);
  assert.equal(JSON.stringify(graph).includes('DO NOT EXPOSE'), false);
});

test('invalid/duplicate IDs in persisted task records fail closed', () => {
  assert.throws(() => projectPersistedTaskGraph([task('a'),task('a')]), /duplicate-id/);
  assert.equal(projectPersistedTaskGraph([task('unknown','arbitrary')]).nodes[0].status, 'blocked');
});
