/**
 * Append-only audit log.
 *
 * Event metadata stays queryable for operations; the optional detail payload is
 * encrypted before PostgreSQL sees it because audit rows otherwise become a
 * second plaintext copy of workflow/user data.
 */

import { encryptJson, decryptJsonWithKeys } from './data-protection.js';

const text = value => String(value ?? '').trim() || null;

export class Audit {
  constructor(pool, logger, { encryptionKey = null, previousEncryptionKey = null } = {}) {
    this.pool = pool;
    this.logger = logger;
    this.encryptionKey = encryptionKey;
    this.encryptionKeys = [encryptionKey, previousEncryptionKey].filter(Boolean);
    if (!this.encryptionKeys.length) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for audit detail storage');
  }

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
        `INSERT INTO audit_log
          (principal_id, workspace_id, action, target, outcome, detail, detail_enc, detail_encryption_version, request_id, ip)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, 1, $7, $8)`,
        [
          row.principalId, row.workspaceId, row.action, row.target, row.outcome,
          encryptJson(this.encryptionKey, 'audit-detail-v1', row.detail),
          row.requestId, row.ip
        ]
      );
    } catch (error) {
      if (client === this.pool) {
        this.logger?.error('audit write failed', { error, action: row.action, target: row.target });
        return;
      }
      throw error;
    }
  }

  async list({ workspaceId, limit = 50, before = null }) {
    const { rows } = await this.pool.query(
      `SELECT id, at, principal_id, workspace_id, action, target, outcome,
              detail, detail_enc, detail_encryption_version, request_id
         FROM audit_log
        WHERE workspace_id = $1 AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC
        LIMIT $3`,
      [workspaceId, before, Math.min(Math.max(Number(limit) || 50, 1), 200)]
    );
    return rows.map(row => ({
      id: row.id, at: row.at, principal_id: row.principal_id, workspace_id: row.workspace_id,
      action: row.action, target: row.target, outcome: row.outcome,
      detail: row.detail_enc
        ? decryptJsonWithKeys(this.encryptionKeys, 'audit-detail-v1', row.detail_enc).value
        : row.detail,
      request_id: row.request_id
    }));
  }
}
