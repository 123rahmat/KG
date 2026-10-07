/**
 * Background execution: same code path as a synchronous execute, durable,
 * re-authorized when it runs, pinned to its task, and recoverable after a
 * worker dies mid-job.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';

const ANTHROPIC = { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key', AI_MODEL: 'claude-opus-5-5' };
const answer = text => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 3 } });
const directRun = (call, token, workspace) => call('POST', '/api/runs', {
  token, workspace, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
});

test('Stop reaches a running background provider request without advancing the task', { timeout: 15000 }, async () => {
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  let aborted = false;
  await withServer(async ({ call, seed, worker }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const queued = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { background: true } });
    assert.equal(queued.status, 202);
    const working = worker.runOnce();
    await providerStarted;
    const stopped = await call('POST', `/api/runs/${run.id}/fail`, { token, workspace, body: { reason: 'stopped by user' } });
    assert.equal(stopped.status, 200);
    await working;
    assert.equal(aborted, true);
    const result = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    assert.equal(result.body.state, 'failed');
    assert.notEqual(result.body.tasks.find(task => task.id === 'respond').status, 'complete');
    const job = await call('GET', `/api/runs/${run.id}/jobs/${queued.body.job.id}`, { token, workspace });
    assert.equal(job.body.outcome.code, 'run-stopped');
  }, {
    env: { ...ANTHROPIC, MULTI_AGENT_MODE: 'off', AGENTS_REVIEW: 'off' },
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      const step = (payload.input ?? []).some(message => {
        try { return JSON.parse(message.content).task?.id === 'respond'; } catch { return false; }
      });
      if (!step) return answer('A function that calls itself.');
      started();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(answer('Late answer.')), 5000);
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer); aborted = true; reject(request.signal.reason);
        }, { once: true });
      });
    }
  });
});

test('a queued execution returns at once and the worker records the same result', () =>
  withServer(async ({ call, seed, worker, pool }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);

    const queued = await call('POST', `/api/runs/${run.id}/execute`, {
      token, workspace, body: { background: true, payload: { note: 'private input' } }
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.body.job.state, 'queued');
    assert.equal(queued.body.job.taskId, 'respond');

    assert.equal(await worker.runOnce(), 1);
    const { body: { job } } = await call('GET', `/api/runs/${run.id}/jobs/${queued.body.job.id}`, { token, workspace });
    assert.equal(job.state, 'succeeded');
    assert.equal(job.outcome.execution.executed, true);
    // The job keeps a summary; the answer lives only in the run's task.
    assert.ok(!JSON.stringify(job).includes('A function that calls itself'));
    const { body: after } = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    assert.equal(after.tasks.find(task => task.id === 'respond').evidence.text, 'A function that calls itself.');
    // The submitted payload is not retained once the job has finished.
    const { rows: [row] } = await pool.query('SELECT request FROM run_jobs WHERE id = $1', [job.id]);
    assert.equal(row.request.payload, undefined);
  }, { env: ANTHROPIC, fetchImpl: async () => answer('A function that calls itself.') }));

test('the same task cannot be queued twice', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const first = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { background: true } });
    const second = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { background: true } });
    assert.equal(first.status, 202);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'job-already-active');
    // A client whose first response was lost can attach to the running job.
    assert.equal(second.body.job.id, first.body.job.id);
  }, { env: ANTHROPIC, fetchImpl: async () => answer('x') }));

test('an execution pinned to a task refuses when the run is elsewhere', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const pinned = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { taskId: 'verify' } });
    assert.equal(pinned.status, 409);
    assert.equal(pinned.body.code, 'stale-execution');
  }, { env: ANTHROPIC, fetchImpl: async () => { throw new Error('nothing may execute'); } }));

test('revoking access stops work that was already queued', () =>
  withServer(async ({ call, seed, worker, pool }) => {
    const { token, workspace, principal } = await seed({ role: 'editor' });
    const { body: run } = await directRun(call, token, workspace);
    const queued = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { background: true } });
    await pool.query('DELETE FROM memberships WHERE principal_id = $1', [principal.id]);

    await worker.runOnce();
    const { rows: [job] } = await pool.query('SELECT state, outcome FROM run_jobs WHERE id = $1', [queued.body.job.id]);
    assert.equal(job.state, 'refused');
    assert.equal(job.outcome.code, 'access-revoked');
    const { rows: [task] } = await pool.query("SELECT status FROM run_tasks WHERE run_id = $1 AND id = 'respond'", [run.id]);
    assert.equal(task.status, 'pending');
  }, { env: ANTHROPIC, fetchImpl: async () => { throw new Error('a revoked user\'s job must not execute'); } }));

test('a job abandoned by a crashed worker is reclaimed after its lease', () =>
  withServer(async ({ call, seed, worker, jobs, pool }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const queued = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { background: true } });

    // A worker claims the job and dies without finishing it.
    const claimed = await jobs.claim();
    assert.equal(claimed.id, queued.body.job.id);
    assert.equal(await worker.runOnce(), 0, 'a leased job is not claimed twice');
    await pool.query("UPDATE run_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [claimed.id]);

    assert.equal(await worker.runOnce(), 1);
    const { rows: [job] } = await pool.query('SELECT state, attempts FROM run_jobs WHERE id = $1', [claimed.id]);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.attempts, 2);
  }, { env: ANTHROPIC, fetchImpl: async () => answer('Recovered answer.') }));

test('jobs are private to the person who queued them', () =>
  withServer(async ({ call, seed }) => {
    const owner = await seed({ workspace: 'shared', name: 'Owner' });
    const peer = await seed({ workspace: 'shared', name: 'Peer' });
    const { body: run } = await call('POST', '/api/runs', {
      token: owner.token, workspace: 'shared',
      body: { goal: 'Explain recursion.', visibility: 'workspace', privacyConsent: { modelProvider: true } }
    });
    const queued = await call('POST', `/api/runs/${run.id}/execute`, {
      token: owner.token, workspace: 'shared', body: { background: true }
    });
    const seen = await call('GET', `/api/runs/${run.id}/jobs/${queued.body.job.id}`, { token: peer.token, workspace: 'shared' });
    assert.equal(seen.status, 404);
  }, { env: ANTHROPIC, fetchImpl: async () => answer('x') }));

test('local execution cannot be queued in the background', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const response = await call('POST', `/api/runs/${run.id}/execute`, {
      token, workspace, body: { background: true, executionTarget: 'local' }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'background-not-supported');
  }));


test('a stale worker cannot finish a job reclaimed by another worker', () =>
  withServer(async ({ call, seed, jobs, pool }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const queued = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { background: true } });

    const first = await jobs.claim({ workerId: 'worker-a' });
    assert.equal(first.worker_id, 'worker-a');
    await pool.query(`UPDATE run_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [first.id]);
    const second = await jobs.claim({ workerId: 'worker-b' });
    assert.equal(second.worker_id, 'worker-b');
    assert.equal(second.attempts, first.attempts + 1);

    assert.equal(await jobs.finish(first, 'succeeded', { code: 'stale' }, { workerId: 'worker-a', attempts: first.attempts }), false);
    assert.equal(await jobs.finish(second, 'succeeded', { code: 'fresh' }, { workerId: 'worker-b', attempts: second.attempts }), true);
    const { rows: [row] } = await pool.query('SELECT state, outcome, worker_id FROM run_jobs WHERE id = $1', [queued.body.job.id]);
    assert.equal(row.state, 'succeeded');
    assert.equal(row.outcome.code, 'fresh');
    assert.equal(row.worker_id, null);
  }, { env: ANTHROPIC, fetchImpl: async () => answer('x') }));


test('a successful background step queues a safe server-side continuation', () =>
  withServer(async ({ call, seed, worker }) => {
    const { token, workspace } = await seed();
    const { body: run } = await directRun(call, token, workspace);
    const queued = await call('POST', `/api/runs/${run.id}/execute`, {
      token, workspace, body: { background: true }
    });
    assert.equal(queued.status, 202);
    assert.equal(await worker.runOnce(), 1);
    const { body: after } = await call('GET', `/api/runs/${run.id}`, { token, workspace });
    assert.ok(after.tasks.some(task => task.id === 'verify'));
    assert.equal(after.tasks.find(task => task.id === 'respond')?.status, 'complete');
    assert.equal(await worker.runOnce(), 1);
  }, { env: ANTHROPIC, fetchImpl: async () => answer('A function that calls itself.') }));
