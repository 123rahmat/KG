import test from 'node:test';
import assert from 'node:assert/strict';
import { updateAdaptiveRuntimeState } from '../src/adaptive-runtime-state.js';

test('tracks the authoritative next stage', () => {
  const state = updateAdaptiveRuntimeState({}, {
    run: { attempt: 1 }, target: { id: 'reason', type: 'reason' },
    nextTask: { id: 'plan', type: 'plan' }, evidence: { observed: true }
  });
  assert.equal(state.currentTask, 'plan');
  assert.equal(state.currentStage, 'plan');
  assert.equal(state.lastCompletedTask, 'reason');
  assert.equal(state.evidenceObserved, true);
});

test('bounds history and preserves failure', () => {
  let state = {};
  for (let i = 0; i < 40; i += 1) state = updateAdaptiveRuntimeState(state, {
    run: { attempt: 2 }, target: { id: 'step-' + i, type: 'code' },
    nextTask: { id: 'verify', type: 'verify' },
    status: i === 39 ? 'failed' : 'complete', evidence: { observed: true },
    execution: true, reason: i === 39 ? 'test failed' : ''
  });
  assert.equal(state.history.length, 32);
  assert.equal(state.lastFailure.task, 'step-39');
});

test('passing verification clears a previous failure', () => {
  const failed = updateAdaptiveRuntimeState({}, {
    run: { attempt: 1 }, target: { id: 'test-code', type: 'code' },
    nextTask: { id: 'replan', type: 'replan' }, status: 'failed',
    evidence: { stderr: 'failure' }, execution: true, reason: 'test failed'
  });
  const verified = updateAdaptiveRuntimeState(failed, {
    run: { attempt: 1 }, target: { id: 'verify', type: 'verify' },
    nextTask: { id: 'deliver', type: 'deliver' },
    evidence: { verdict: { verdict: 'pass' } },
    verification: { verdict: 'pass' }
  });
  assert.equal(verified.verificationPassed, true);
  assert.equal(verified.lastFailure, null);
});
