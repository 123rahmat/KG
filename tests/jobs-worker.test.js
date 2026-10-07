import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobWorker } from '../src/jobs.js';
import { RunError } from '../src/runs.js';
import { ModelProviderError } from '../src/runtime.js';

function workerFor(executeNext) {
  const finished = [];
  let queued = [{ id: 'j1', principal_id: 'p', workspace_id: 'w', run_id: 'r', task_id: 'verify', attempts: 1, max_attempts: 3 }];
  const worker = createJobWorker({
    jobs: { claim: async () => queued.shift() ?? null, finish: async (job, state, outcome) => finished.push({ state, outcome }) },
    identity: { requireAccess: async () => ({ workspaceId: 'w' }) },
    runs: { get: async () => ({ tasks: [{ id: 'verify', status: 'pending' }] }) },
    executeNext,
    logger: { error() {}, warn() {} }
  });
  return { worker, finished };
}

test('a background step refused for a reason says why, instead of "failed unexpectedly"', async () => {
  const { worker, finished } = workerFor(async () => {
    throw new RunError('Verification cannot complete yet.', { status: 422, code: 'verification-preconditions' });
  });
  await worker.runOnce();
  assert.deepEqual(finished, [{ state: 'refused', outcome: { httpStatus: 422, code: 'verification-preconditions', error: 'Verification cannot complete yet.', execution: null } }]);
});

test('a real crash is still reported without its internals', async () => {
  const { worker, finished } = workerFor(async () => { throw new Error('socket hang up at 10.0.0.3'); });
  await worker.runOnce();
  assert.equal(finished[0].state, 'failed');
  assert.equal(finished[0].outcome.code, 'execution-error');
  assert.doesNotMatch(finished[0].outcome.error, /10\.0\.0\.3/);
});

test('Gemini being rate-limited is reported as that, with when to retry', async () => {
  const { worker, finished } = workerFor(async () => { throw new ModelProviderError('google', 429, { retryAfterMs: 20_000 }); });
  await worker.runOnce();
  assert.equal(finished[0].state, 'failed');
  assert.equal(finished[0].outcome.code, 'model-rate-limited');
  assert.equal(finished[0].outcome.retryAfterSeconds, 20);
  assert.match(finished[0].outcome.error, /rate-limited|nothing was recorded/i);
});
