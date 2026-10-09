import test from 'node:test';
import assert from 'node:assert/strict';
import { agentActivitySnapshot } from '../public/agent-activity.js';

test('adaptive specialist transitions are visible only from persisted wave records', () => {
  const run = {
    state: 'complete',
    adaptation: { multiAgent: {
      allocation: { specialistLifecycle: {
        action: 'contract', reason: 'independent-findings-converged'
      } },
      waves: [{
        index: 0, parallel: true,
        specialistAdaptation: { action: 'recruit', reason: 'observed-disagreement-needs-review' }
      }]
    }}
  };
  const view = agentActivitySnapshot(run);
  assert.equal(view.observedParallel, true);
  assert.deepEqual(view.adaptations, [
    { action: 'recruit', reason: 'observed-disagreement-needs-review', wave: 1 },
    { action: 'contract', reason: 'independent-findings-converged', wave: null }
  ]);
  assert.deepEqual(view.active, []);
});

test('unknown or unrecorded team transitions are not fabricated', () => {
  const run = { state: 'running', adaptation: { multiAgent: {
    waves: [{ index: 0, parallel: false }],
    allocation: { specialistLifecycle: { action: 'hold', reason: 'steady' } }
  } } };
  const view = agentActivitySnapshot(run);
  assert.deepEqual(view.adaptations, []);
  assert.equal(view.mode, 'single');
});

test('server-persisted roles do not imply live agents after task completion', () => {
  const run = { state: 'complete', adaptation: { multiAgent: {
    agentStates: [{ role: 'analyst', status: 'running' }, { role: 'critic', status: 'complete' }]
  } } };
  const view = agentActivitySnapshot(run);
  assert.equal(view.roles.length, 2);
  assert.equal(view.active.length, 0);
});


test('only the current running parent task can display active subagents', () => {
  const saved = {
    agentStates: [
      { role: 'child:frontend-engineer:accessibility', subagent: true, status: 'running',
        parentRole: 'frontend-engineer', summary: 'Saved advisory check' },
      { role: 'frontend-engineer', status: 'complete', summary: 'Completed review' }
    ],
    waves: [{ index: 0, parallel: true }]
  };
  const run = {
    state: 'running', next: 'verify',
    tasks: [
      { id: 'build-code', type: 'code', status: 'complete', evidence: { multiAgent: saved } },
      { id: 'verify', type: 'verify', status: 'running' }
    ]
  };
  const previous = agentActivitySnapshot(run);
  assert.equal(previous.roles.length, 2, 'saved work should remain visible');
  assert.equal(previous.active.length, 0, 'old unfinished statuses must never appear live');
  assert.equal(previous.sourceTask.id, 'build-code');
  const working = agentActivitySnapshot({
    ...run, next: 'build-code',
    tasks: [
      { id: 'build-code', type: 'code', status: 'running', evidence: { multiAgent: saved } },
      { id: 'verify', status: 'pending' }
    ]
  });
  assert.equal(working.active.length, 1);
  assert.equal(working.active[0].kind, 'subagent');
  assert.equal(working.active[0].verification, 'unverified-advisory');
  const waiting = agentActivitySnapshot({ ...run, state: 'waiting', next: 'build-code',
    tasks: [{ id: 'build-code', status: 'running', evidence: { multiAgent: saved } }] });
  assert.deepEqual(waiting.active, []);
});

test('no task owner means no live-agent claim even with stale allocation metadata', () => {
  const view = agentActivitySnapshot({
    state: 'running', next: 'analyze',
    adaptation: { multiAgent: { agentStates: [
      { role: 'researcher', status: 'running' }
    ] } },
    tasks: [{ id: 'analyze', status: 'running' }]
  });
  assert.equal(view.roles.length, 1);
  assert.equal(view.active.length, 0);
});
