/**
 * Proposed actions: what the AI wants to do outside the chat (a reminder, a
 * calendar event, an image that costs money, running code) waits here for a
 * person to approve or decline it. Approval runs the tool once, as the person
 * who approved, and records the outcome.
 */

import crypto from 'node:crypto';
import { transaction } from './db.js';
import { toolNamed } from './toolbox.js';

const text = value => String(value ?? '').trim();

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

  async list(scope, runId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM run_actions WHERE run_id = $1 AND workspace_id = $2 ORDER BY created_at',
      [runId, scope.workspaceId]
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
        'SELECT * FROM run_actions WHERE id = $1 AND run_id = $2 AND workspace_id = $3 FOR UPDATE',
        [actionId, runId, scope.workspaceId]
      );
      if (!row) throw new ActionError('That proposed action does not exist.', 404, 'action-not-found');
      if (row.status !== 'proposed') throw new ActionError('That action was already decided.', 409, 'action-already-decided');
      // Some actions (a tool for the whole workspace) need a higher role to approve.
      if (approve && !canApprove(row.tool)) throw new ActionError('Only a workspace admin can approve this.', 403, 'action-role-required');
      const { rows: [updated] } = await client.query(
        `UPDATE run_actions SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
        [actionId, approve ? 'running' : 'declined', principal.id]
      );
      await this.audit?.record({
        principalId: principal.id, workspaceId: scope.workspaceId, action: approve ? 'action.approve' : 'action.decline',
        target: actionId, outcome: 'allowed', detail: { tool: row.tool, runId }, requestId
      }, client);
      return updated;
    });
    if (!approve) return view(claimed);

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
    const { rows: [done] } = await this.pool.query(
      'UPDATE run_actions SET status = $2, result = $3::jsonb WHERE id = $1 RETURNING *',
      [actionId, status, JSON.stringify(result ?? {})]
    );
    await this.audit?.record({
      principalId: principal.id, workspaceId: scope.workspaceId, action: 'action.run',
      target: actionId, outcome: status === 'done' ? 'allowed' : 'failed', detail: { tool: claimed.tool, runId }, requestId
    });
    return view(done);
  }
}
