/**
 * Background execution.
 *
 * A long model or runner call should not hold an HTTP request open, and a
 * dropped connection should not lose its result. Execution can instead be
 * queued as a job: the request returns at once, and a worker in any server
 * process claims the job, runs it through exactly the same code path as a
 * synchronous execute, and records the outcome.
 *
 * - Claiming uses FOR UPDATE SKIP LOCKED, so several instances share one
 *   queue without running a job twice at the same time.
 * - A claim is a lease. A worker that dies mid-job loses the lease and the
 *   job is claimed again, up to max_attempts.
 * - Each job runs under its owner's scope after re-checking membership, so
 *   revoking access also stops queued work.
 * - A job pins its task. If the run has moved on, it refuses rather than run
 *   something else; if its task already completed, it records that.
 * - The job row keeps an outcome summary only. Results live in the run's
 *   tasks; the submitted payload is dropped once the job finishes.
 */

import crypto from 'node:crypto';
import { runDbScope, transaction } from './db.js';

const LEASE_MS = 5 * 60_000;
const text = value => String(value ?? '').trim();
const newWorkerId = () => 'jobs-' + process.pid + '-' + crypto.randomUUID();

/** Request fields a job may carry; everything else is dropped. */
const JOB_REQUEST_FIELDS = ['approved', 'executionTarget', 'preflight', 'requirements', 'cloudFallbackAllowed', 'payload', 'modelConsent'];

function presentJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    state: row.state,
    attempts: row.attempts,
    outcome: row.outcome ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null
  };
}

/** What a finished job remembers: status and summary, never model output. */
export function summarizeOutcome({ status, body }) {
  const execution = body?.execution ?? null;
  return {
    httpStatus: status,
    ...(body?.code ? { code: body.code } : {}),
    ...(status >= 400 && body?.error ? { error: body.error } : {}),
    execution: execution ? {
      status: execution.status ?? null,
      executed: execution.executed === true,
      ...(execution.message ? { message: execution.message } : {}),
      ...(execution.provider ? { provider: execution.provider } : {}),
      ...(execution.model ? { model: execution.model } : {}),
      ...(execution.target ? { target: execution.target } : {}),
      ...(execution.launchUrl ? { launchUrl: execution.launchUrl } : {})
    } : null
  };
}

export class JobStore {
  constructor(pool) {
    this.pool = pool;
  }

  async enqueue(scope, principal, { runId, taskId, request = {}, requestId = null }) {
    const id = crypto.randomUUID();
    const kept = Object.fromEntries(JOB_REQUEST_FIELDS
      .filter(name => request[name] !== undefined)
      .map(name => [name, request[name]]));
    const { rows } = await this.pool.query(
      `INSERT INTO run_jobs (id, run_id, task_id, workspace_id, principal_id, request, request_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [id, runId, taskId, scope.workspaceId, principal.id, JSON.stringify(kept), requestId]
    );
    return presentJob(rows[0]);
  }

  async get(scope, runId, jobId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM run_jobs WHERE id = $1 AND run_id = $2 AND workspace_id = $3',
      [text(jobId), text(runId), scope.workspaceId]
    );
    return presentJob(rows[0]);
  }

  /** The queued or running job for a run's task, if one exists. */
  async active(scope, runId, taskId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM run_jobs
        WHERE run_id = $1 AND task_id = $2 AND workspace_id = $3 AND state IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 1`,
      [text(runId), text(taskId), scope.workspaceId]
    );
    return presentJob(rows[0]);
  }

  /** Claim the oldest queued job, or one whose lease expired. */
  async claim({ workerId = null, leaseMs = LEASE_MS } = {}) {
    const owner = text(workerId) || newWorkerId();
    const safeLease = Math.max(10_000, Math.min(900_000, Number(leaseMs) || LEASE_MS));
    return runDbScope({ principalId: '', workspaceId: '', organizationId: '', jurisdiction: '', role: 'job-worker' }, () =>
      transaction(this.pool, async client => {
        const { rows } = await client.query(
          `UPDATE run_jobs
              SET state = 'running', attempts = attempts + 1,
                  lease_until = now() + ($1::int * interval '1 millisecond'),
                  worker_id = $2, updated_at = now()
            WHERE id = (
              SELECT id FROM run_jobs
               WHERE (state = 'queued' OR (state = 'running' AND lease_until < now()))
                 AND attempts <= max_attempts
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1
            )
            RETURNING *`,
          [safeLease, owner]
        );
        return rows[0] ?? null;
      }));
  }

  async renewLease(job, { workerId = job.worker_id, attempts = job.attempts, leaseMs = LEASE_MS } = {}) {
    const owner = text(workerId);
    const safeLease = Math.max(10_000, Math.min(900_000, Number(leaseMs) || LEASE_MS));
    if (!owner) return false;
    const { rowCount } = await this.pool.query(
      `UPDATE run_jobs
          SET lease_until = now() + ($2::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND state = 'running' AND worker_id = $3
          AND attempts = $4 AND lease_until > now()`,
      [job.id, safeLease, owner, Number(attempts) || 0]
    );
    return rowCount > 0;
  }

  /** Record the outcome only for the worker/attempt that still owns the lease. */
  async finish(job, state, outcome, { workerId = job.worker_id, attempts = job.attempts } = {}) {
    const owner = text(workerId);
    const { rowCount } = await this.pool.query(
      `UPDATE run_jobs
          SET state = $2, outcome = $3::jsonb, request = request - 'payload',
              lease_until = NULL, worker_id = NULL, finished_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'running' AND worker_id = $4
          AND attempts = $5 AND lease_until > now()`,
      [job.id, state, JSON.stringify(outcome), owner, Number(attempts) || 0]
    );
    return rowCount > 0;
  }
}

/**
 * The worker. `start()` polls; `runOnce()` drains the queue once and is what
 * tests use to run jobs deterministically.
 */
export function createJobWorker({ jobs, identity, runs, executeNext, logger, metrics, pollMs = 1_000, leaseMs = LEASE_MS, workerId = null }) {
  const effectiveWorkerId = text(workerId) || newWorkerId();
  const safeLeaseMs = Math.max(10_000, Math.min(900_000, Number(leaseMs) || LEASE_MS));
  let timer = null;
  let active = null;
  let stopping = false;

  async function process(job) {
    const scope = { principalId: job.principal_id, workspaceId: job.workspace_id };
    return runDbScope({ ...scope, organizationId: '', jurisdiction: '', role: '' }, async () => {
      let heartbeat = null;
      try {
        heartbeat = setInterval(() => {
          jobs.renewLease(job, { workerId: effectiveWorkerId, attempts: job.attempts, leaseMs: safeLeaseMs })
            .catch(error => logger?.warn('background job lease renewal failed', { error, jobId: job.id }));
        }, Math.max(1_000, Math.floor(safeLeaseMs / 3)));
        heartbeat.unref?.();

        if (job.attempts > job.max_attempts) {
        await jobs.finish(job, 'failed', { code: 'job-attempts-exhausted', error: 'The job was interrupted too many times.' });
        return;
      }
      let access;
      try {
        // Re-authorize now: membership may have changed since it was queued.
        access = await identity.requireAccess({ id: job.principal_id }, job.workspace_id, 'editor');
      } catch (error) {
        await jobs.finish(job, 'refused', { code: 'access-revoked', error: 'The requester no longer has access to this workspace.' });
        return;
      }
      access.principalId = job.principal_id;
      const principal = { id: job.principal_id };

      const run = await runs.get(access, job.run_id);
      const task = run?.tasks.find(item => item.id === job.task_id);
      if (task?.status === 'complete') {
        // A previous attempt finished the work but not the job record.
        await jobs.finish(job, 'succeeded', { code: 'completed-earlier', execution: { executed: true, status: 'completed' } });
        return;
      }

      try {
        const reply = await executeNext({
          scope: access, principal, runId: job.run_id, body: job.request ?? {},
          requestId: job.request_id, expectedTaskId: job.task_id
        });
        await jobs.finish(job, reply.status < 400 ? 'succeeded' : 'refused', summarizeOutcome(reply));
      } catch (error) {
        // A refusal with a reason (a gate that is not met) is not a crash.
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
          await jobs.finish(job, 'refused', { httpStatus: error.status, code: error.code ?? 'refused', error: error.message, execution: null });
          return;
        }
        // Gemini busy, down or refusing the key: the person is told which.
        if (error?.name === 'ModelProviderError' && error.expose) {
          logger?.warn('background job: model provider unavailable', { code: error.code, jobId: job.id });
          metrics?.increment('model_provider_errors_total', { code: error.code });
          await jobs.finish(job, 'failed', { code: error.code, error: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
          return;
        }
        logger?.error('background job failed', { error, jobId: job.id });
        await jobs.finish(job, 'failed', {
          code: 'execution-error',
          error: 'Execution failed unexpectedly; nothing was recorded for this task.'
        });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    });
  }

  async function runOnce() {
    let processed = 0;
    for (;;) {
      if (stopping) break;
      const job = await jobs.claim({ workerId: effectiveWorkerId, leaseMs: safeLeaseMs });
      if (!job) break;
      metrics?.increment('background_jobs_total', { phase: 'claimed' });
      await process(job);
      processed += 1;
    }
    return processed;
  }

  const tick = async () => {
    if (active) return;
    active = runOnce()
      .catch(error => logger?.error('job worker cycle failed', { error }))
      .finally(() => { active = null; });
  };

  return {
    runOnce,
    start() {
      stopping = false;
      if (!timer) {
        timer = setInterval(tick, pollMs);
        timer.unref?.();
      }
    },
    /** Stop claiming and wait for the job in hand to finish. */
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    }
  };
}
