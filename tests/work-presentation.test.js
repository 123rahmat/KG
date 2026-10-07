import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../public/adaptive-workspace.js';

const run = (state, tasks = [], extra = {}) => ({ id: 'r', state, tasks, ...extra });
const present = (value, options) => {
  assert.equal(typeof ui.workPresentation, 'function', 'the UI must derive a truthful work presentation');
  return ui.workPresentation(value, options);
};

test('finishing a run does not claim verification without passing evidence', () => {
  assert.equal(present(run('complete')).verified, false);
  assert.equal(present(run('complete')).label, 'Completed');
  assert.equal(present(run('complete', [{ type: 'verify', status: 'skipped' }])).verified, false);
  assert.equal(present(run('complete', [{ type: 'verify', status: 'complete', evidence: { verdict: { verdict: 'fail' } } }])).verified, false);
  const checked = present(run('complete', [{ type: 'verify', status: 'complete', evidence: { verdict: { verdict: 'pass' } } }]));
  assert.equal(checked.verified, true);
  assert.equal(checked.label, 'Completed · verified');
});

test('failed, stopped, waiting and offline work never appear live', () => {
  for (const state of ['failed', 'blocked', 'exhausted', 'waiting', 'iterate']) {
    assert.equal(present(run(state, [{ id: 'build', status: 'pending' }]), { driving: true }).live, false, state);
  }
  const disconnected = present(run('respond', [{ id: 'respond', type: 'respond', status: 'running' }], { next: 'respond' }), { online: false });
  assert.equal(disconnected.live, false);
  assert.equal(disconnected.label, 'Connection lost');
  assert.equal(present(run('complete'), { online: false }).label, 'Completed');
  assert.equal(present(run('failed')).label, 'Stopped');
});

test('approval and clarification are actionable even when the run uses a task state', () => {
  for (const [type, label] of [['approval', 'Your approval is needed'], ['clarify', 'Your answer is needed']]) {
    const result = present(run(type, [{ id: 'next', type, status: 'pending' }], { next: 'next' }), { driving: true });
    assert.equal(result.label, label);
    assert.equal(result.live, false);
    assert.equal(result.tone, 'warn');
  }
});

test('an expanding task graph is never presented as a completion percentage', () => {
  const tasks = [{ id: 'one', status: 'complete' }, { id: 'two', status: 'running' }];
  const before = present(run('respond', tasks));
  const after = present(run('respond', [...tasks, { id: 'three', status: 'pending' }]));
  assert.equal(before.percent, null);
  assert.equal(after.percent, null);
  assert.equal(after.completed, 1);
  assert.equal(present(run('respond', tasks, { requirements: { overallProgress: 15, items: [{ status: 'identified', evidence: [] }] } })).percent, 0);
  assert.equal(present(run('respond', tasks, { requirements: { items: [{ status: 'satisfied', evidence: [{ taskId: 'check' }] }], completionReady: true } })).percent, 100);
  assert.equal(present(run('respond', tasks, { requirements: { items: [{ status: 'satisfied', evidence: [] }], completionReady: true } })).percent, 0);
  assert.equal(present(run('respond', tasks, { requirements: { overallProgress: 'invalid' } })).percent, null);
});

test('a stale verification verdict is not reused after another check fails', () => {
  const tasks = [
    { type: 'verify', status: 'complete', evidence: { verdict: { verdict: 'pass' } } },
    { type: 'verify', status: 'failed', evidence: { verdict: { verdict: 'fail' } } }
  ];
  assert.equal(present(run('complete', tasks)).verified, false);
});
