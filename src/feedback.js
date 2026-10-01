/**
 * User outcome signals for the evaluation/evolution loop.
 * Feedback is evidence about a Run, never an instruction to mutate prompts.
 */
import crypto from 'node:crypto';
import { encryptJson, decryptField } from './data-protection.js';

const text = value => String(value ?? '').trim();
const REASONS = new Set(['correct','incorrect','incomplete','unsafe','too-slow','too-expensive','other']);

export class FeedbackStore {
  constructor(pool, { encryptionKey } = {}) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
    if (!this.encryptionKey) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for feedback');
  }

  async add(scope, principal, runId, { rating, reason = 'other', note = '' } = {}) {
    const normalizedRating = text(rating);
    if (!['positive','negative'].includes(normalizedRating)) {
      const error = new Error('Feedback rating must be positive or negative'); error.status = 400; error.code = 'feedback-invalid'; throw error;
    }
    const normalizedReason = REASONS.has(text(reason)) ? text(reason) : 'other';
    const cleanNote = text(note).slice(0, 1000);
    const encrypted = cleanNote ? encryptJson(this.encryptionKey, 'run-feedback-v1', { note: cleanNote }) : null;
    const { rows: [row] } = await this.pool.query(
      `INSERT INTO run_feedback
        (id, run_id, workspace_id, principal_id, rating, reason, note_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id, principal_id)
       DO UPDATE SET rating = EXCLUDED.rating, reason = EXCLUDED.reason, note_enc = EXCLUDED.note_enc, updated_at = now()
       RETURNING id, run_id AS "runId", rating, reason, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [crypto.randomUUID(), runId, scope.workspaceId, principal.id, normalizedRating, normalizedReason, encrypted]
    );
    return row;
  }

  async list(scope, runId) {
    const { rows } = await this.pool.query(
      'SELECT id, run_id AS "runId", rating, reason, note_enc, created_at AS "createdAt", updated_at AS "updatedAt" FROM run_feedback WHERE run_id = $1 AND workspace_id = $2 ORDER BY updated_at DESC',
      [runId, scope.workspaceId]
    );
    return rows.map(row => {
      let note = '';
      if (row.note_enc) { try { note = JSON.parse(decryptField(this.encryptionKey, 'run-feedback-v1', row.note_enc))?.note ?? ''; } catch {} }
      const { note_enc, ...item } = row;
      return { ...item, note: scope.principalId ? (row.principal_id === scope.principalId ? note : '') : note };
    });
  }
}