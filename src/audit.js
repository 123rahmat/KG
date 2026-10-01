/**
 * Append-only, tamper-evident audit log.
 */

import crypto from 'node:crypto';
import { encryptJson, decryptJsonWithKeys } from './data-protection.js';
import { transaction } from './db.js';

const text = value => String(value ?? '').trim() || null;
const SEP = '\x1f';
const AUDIT_LOCK = 0x4b474155;

function canonicalAudit({ id, at, principalId, workspaceId, action, target, outcome, detailEnc, detailEncryptionVersion, requestId, ip, prevHash }) {
  return [
    id, at, principalId, workspaceId, action, target, outcome, detailEnc,
    detailEncryptionVersion, requestId, ip, prevHash
  ].map(value => value == null ? '' : String(value)).join(SEP);
}

function hashAudit(input) {
  return crypto.createHash('sha256').update(canonicalAudit(input), 'utf8').digest('hex');
}

export class Audit {
  constructor(pool, logger, { encryptionKey = null, previousEncryptionKey = null } = {}) {
    this.pool = pool;
    this.logger = logger;
    this.encryptionKey = encryptionKey;
    this.encryptionKeys = [encryptionKey, previousEncryptionKey].filter(Boolean);
    if (!this.encryptionKeys.length) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for audit detail storage');
  }

  async record(entry, client = null) {
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

    const write = async db => {
      await db.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
      const { rows: [sequence] } = await db.query(
        `SELECT nextval(pg_get_serial_sequence('audit_log', 'id')) AS id, now() AS at`
      );
      const id = Number(sequence.id);
      const at = sequence.at;
      const { rows: [previous] } = await db.query(
        'SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR SHARE'
      );
      const prevHash = previous?.entry_hash ?? null;
      const detailEnc = encryptJson(this.encryptionKey, 'audit-detail-v1', row.detail);
      const entryHash = hashAudit({
        id, at, principalId: row.principalId, workspaceId: row.workspaceId,
        action: row.action, target: row.target, outcome: row.outcome,
        detailEnc, detailEncryptionVersion: 1, requestId: row.requestId,
        ip: row.ip, prevHash
      });
      await db.query(
        `INSERT INTO audit_log
          (id, at, principal_id, workspace_id, action, target, outcome,
           detail, detail_enc, detail_encryption_version, request_id, ip, prev_hash, entry_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,1,$9,$10,$11,$12)`,
        [id, at, row.principalId, row.workspaceId, row.action, row.target, row.outcome,
         detailEnc, row.requestId, row.ip, prevHash, entryHash]
      );
      return { id, entryHash };
    };

    try {
      if (client) return await write(client);
      return await transaction(this.pool, write);
    } catch (error) {
      this.logger?.error('audit write failed', { error, action: row.action, target: row.target });
      if (client) throw error;
      return null;
    }
  }

  async list({ workspaceId, limit = 50, before = null }) {
    const { rows } = await this.pool.query(
      `SELECT id, at, principal_id, workspace_id, action, target, outcome,
              detail, detail_enc, detail_encryption_version, request_id,
              prev_hash, entry_hash
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
      request_id: row.request_id, prev_hash: row.prev_hash, entry_hash: row.entry_hash
    }));
  }

  async verify({ limit = 1000 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 1000, 2), 5000);
    const { rows } = await this.pool.query(
      `SELECT id, at, principal_id, workspace_id, action, target, outcome,
              detail_enc, detail_encryption_version, request_id, ip, prev_hash, entry_hash
         FROM audit_log ORDER BY id DESC LIMIT $1`,
      [cap + 1]
    );
    const ordered = rows.reverse();
    if (!ordered.length) return { ok: true, checked: 0 };
    if (ordered[0].prev_hash) {
      const { rows: [previous] } = await this.pool.query(
        'SELECT entry_hash FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT 1',
        [ordered[0].id]
      );
      if ((previous?.entry_hash ?? null) !== ordered[0].prev_hash) {
        return { ok: false, checked: 1, brokenAt: ordered[0].id, reason: 'previous-hash-mismatch' };
      }
    }
    for (let i = 0; i < ordered.length; i += 1) {
      const item = ordered[i];
      const expected = hashAudit({
        id: item.id, at: item.at, principalId: item.principal_id, workspaceId: item.workspace_id,
        action: item.action, target: item.target, outcome: item.outcome,
        detailEnc: item.detail_enc, detailEncryptionVersion: item.detail_encryption_version,
        requestId: item.request_id, ip: item.ip, prevHash: item.prev_hash
      });
      if (item.entry_hash !== expected) return { ok: false, checked: i + 1, brokenAt: item.id, reason: 'entry-hash-mismatch' };
      if (i > 0 && item.prev_hash !== ordered[i - 1].entry_hash) {
        return { ok: false, checked: i + 1, brokenAt: item.id, reason: 'chain-link-mismatch' };
      }
    }
    return { ok: true, checked: ordered.length };
  }
}
