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
