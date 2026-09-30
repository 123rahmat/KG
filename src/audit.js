/**
 * Append-only audit log.
 *
 * Nothing in the application updates or deletes a row here. Writes go through
 * the caller's transaction where one exists, so an audit record and the change
 * it describes commit together or not at all — an action can never be applied
 * without its record, or recorded without being applied.
 */

const text = value => String(value ?? '').trim() || null;

export class Audit {
  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger;
  }

  /**
   * @param entry.outcome 'allowed' | 'denied' | 'failed'
   * @param client        a transaction client, to commit with the change
   */
  async record(entry, client = this.pool) {
    const row = {
      principalId: text(entry.principalId),
      workspaceId: text(entry.workspaceId),
      action: text(entry.action) ?? 'unknown',
      target: text(entry.target),
      outcome: text(entry.outcome) ?? 'allowed',
      detail: entry.detail ?? null,
      requestId: text(entry.requestId),
      ip: text(entry.ip)
    };

    try {
      await client.query(
        `INSERT INTO audit_log (principal_id, workspace_id, action, target, outcome, detail, request_id, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.principalId, row.workspaceId, row.action, row.target, row.outcome,
         row.detail === null ? null : JSON.stringify(row.detail), row.requestId, row.ip]
      );
    } catch (error) {
      // Outside a transaction an audit failure must not sink the request, but
      // it is a real problem and is escalated to the log rather than swallowed.
      if (client === this.pool) {
        this.logger?.error('audit write failed', { error, action: row.action, target: row.target });
        return;
      }
      throw error;
    }
  }

  /** Read the trail for one workspace, newest first. */
  async list({ workspaceId, limit = 50, before = null }) {
    const { rows } = await this.pool.query(
      `SELECT id, at, principal_id, workspace_id, action, target, outcome, detail, request_id
         FROM audit_log
        WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC
        LIMIT $3`,
      [workspaceId, before, Math.min(Math.max(Number(limit) || 50, 1), 200)]
    );
    return rows;
  }
}
