/**
 * Proposed actions: what the AI wants to do outside the chat (a reminder, a
 * calendar event, an image that costs money, running code) waits here for a
 * person to approve or decline it. Approval runs the tool once, as the person
 * who approved, and records the outcome.
 */

import crypto from 'node:crypto';
import { runDbScope, transaction } from './db.js';
import { toolNamed } from './toolbox.js';

const text = value => String(value ?? '').trim();
const ACTION_LEASE_MS = 15 * 60_000;

const view = row => ({
  id: row.id, runId: row.run_id, taskId: row.task_id, tool: row.tool, input: row.input,
  summary: row.summary, status: row.status, result: row.result,
  decidedBy: row.decided_by, decidedAt: row.decided_at, createdAt: row.created_at
});

export class ActionError extends Error {
  constructor(message, status = 409, code = 'action-invalid') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class RunActions {
  constructor(pool, { audit } = {}) {
    this.pool = pool;
    this.audit = audit;
  }

  /** Record a proposal from a model step. */
  async propose(scope, { runId, taskId, tool, input, summary }) {
    const id = `act_${crypto.randomUUID()}`;
    const { rows: [row] } = await this.pool.query(
      `INSERT INTO run_actions (id, run_id, task_id, workspace_id, principal_id, tool, input, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
      [id, runId, taskId, scope.workspaceId, scope.principalId, tool, JSON.stringify(input ?? {}), text(summary).slice(0, 300)]
    );
    return view(row);
  }

  async renewLease(actionId, principalId, leaseMs = ACTION_LEASE_MS) {
    const safeLease = Math.max(10_000, Math.min(3_600_000, Number(leaseMs) || ACTION_LEASE_MS));
    const { rowCount } = await this.pool.query(
      `UPDATE run_actions
          SET lease_until = now() + ($3::int * interval '1 millisecond')
        WHERE id = $1 AND status = 'running' AND decided_by = $2 AND lease_until > now()`,
      [text(actionId), principalId, safeLease]
    );
    return rowCount > 0;
  }

  async recoverExpired({ limit = 100 } = {}) {
    return runDbScope({ principalId: '', workspaceId: '', organizationId: '', jurisdiction: '', role: 'job-worker' }, () =>
      transaction(this.pool, async client => {
      const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
      const { rows } = await client.query(
        `WITH expired AS (
           SELECT id FROM run_actions
            WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < now()
            ORDER BY lease_until ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE run_actions a
            SET status = 'uncertain',
                result = jsonb_build_object(
                  'code', 'execution-outcome-uncertain',
                  'error', 'The action lease expired before its final result was recorded.'
                ),
                lease_until = NULL
           FROM expired e
          WHERE a.id = e.id
          RETURNING a.id`,
        [safeLimit]
      );
      return rows.length;
      }));
  }

  async list(scope, runId) {
    const { rows } = await this.pool.query(
      `SELECT a.*
         FROM run_actions a
         JOIN runs r ON r.id = a.run_id
        WHERE a.run_id = $1
          AND a.workspace_id = $2
          AND (
            r.principal_id = $3
            OR (
              r.visibility = 'workspace'
              AND $4 IN ('editor', 'admin', 'job-worker')
            )
          )
        ORDER BY a.created_at`,
      [runId, scope.workspaceId, scope.principalId, scope.role || 'viewer']
    );
    return rows.map(view);
  }

  /**
   * Approve (run it) or decline. `ctxFor` builds the tool context for the
   * approving person. A proposal is decided once; a second decision is refused.
   */
  async decide(scope, principal, { runId, actionId, approve, ctxFor, canApprove = () => true, requestId }) {
    const claimed = await transaction(this.pool, async client => {
      const { rows: [row] } = await client.query(
        `SELECT a.*
           FROM run_actions a
           JOIN runs r ON r.id = a.run_id
          WHERE a.id = $1 AND a.run_id = $2 AND a.workspace_id = $3
            AND (
              r.principal_id = $4
              OR (
                r.visibility = 'workspace'
                AND $5 IN ('editor', 'admin', 'job-worker')
              )
            )
          FOR UPDATE OF a`,
        [actionId, runId, scope.workspaceId, scope.principalId, scope.role || 'viewer']
      );
      if (!row) throw new ActionError('That proposed action does not exist.', 404, 'action-not-found');
      if (row.status !== 'proposed') throw new ActionError('That action was already decided.', 409, 'action-already-decided');
      // Some actions (a tool for the whole workspace) need a higher role to approve.
      if (approve && !canApprove(row.tool)) throw new ActionError('Only a workspace admin can approve this.', 403, 'action-role-required');
      const { rows: [updated] } = await client.query(
        `UPDATE run_actions
            SET status = $2, decided_by = $3, decided_at = now(),
                lease_until = CASE WHEN $2 = 'running'
                  THEN now() + ($4::int * interval '1 millisecond')
                  ELSE NULL END
          WHERE id = $1 RETURNING *`,
        [actionId, approve ? 'running' : 'declined', principal.id, ACTION_LEASE_MS]
      );
      await this.audit?.record({
        principalId: principal.id, workspaceId: scope.workspaceId, action: approve ? 'action.approve' : 'action.decline',
        target: actionId, outcome: 'allowed', detail: { tool: row.tool, runId }, requestId
      }, client);
      return updated;
    });
    if (!approve) return view(claimed);

    let heartbeat = setInterval(() => {
      this.renewLease(claimed.id, principal.id).catch(error => {
        this.audit?.logger?.warn?.('run action lease renewal failed', { error, actionId: claimed.id });
      });
    }, Math.max(1000, Math.floor(ACTION_LEASE_MS / 3)));
    heartbeat.unref?.();

    let status = 'done';
    let result;
    try {
      const ctx = await ctxFor();
      const tool = toolNamed(claimed.tool, ctx);
      if (!tool) throw new Error(`The tool "${claimed.tool}" is no longer available.`);
      const state = tool.ready?.(ctx) ?? { ready: true };
      if (state.ready === false) throw new Error(state.reason || 'This tool is not ready.');
      result = await tool.run(claimed.input ?? {}, ctx);
      if (result?.error) { status = 'failed'; }
    } catch (error) {
      status = 'failed';
      result = { error: text(error?.message) || 'The action failed.' };
    }
    let done;
    try {
      const storedResult = result && typeof result === 'object' ? { ...result } : result;
      // Generated/attached images are binary payloads for the immediate caller;
      // the durable artifact reference is enough for the action history/UI.
      if (storedResult && typeof storedResult === 'object') delete storedResult.showImage;
      const { rows } = await this.pool.query(
        'UPDATE run_actions SET status = $2, result = $3::jsonb, lease_until = NULL WHERE id = $1 AND status = \'running\' AND decided_by = $4 AND lease_until > now() RETURNING *',
        [actionId, status, JSON.stringify(storedResult ?? {}), principal.id]
      );
      done = rows[0] ?? null;
    } finally {
      clearInterval(heartbeat);
    }
    if (!done) {
      return {
        ...view(claimed),
        status: 'uncertain',
        result: { code: 'execution-outcome-uncertain', error: 'The action started but its final database state could not be confirmed safely.' }
      };
    }
    await this.audit?.record({
      principalId: principal.id, workspaceId: scope.workspaceId, action: 'action.run',
      target: actionId, outcome: status === 'done' ? 'allowed' : 'failed', detail: { tool: claimed.tool, runId }, requestId
    });
    return view(done);
  }
}
