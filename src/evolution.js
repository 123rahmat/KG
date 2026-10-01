/**
 * Controlled evolution: negative feedback becomes a reviewable candidate.
 *
 * Nothing here changes prompts, Skills, policy or model routing automatically.
 * A candidate is evidence that a part of the system deserves an evaluated
 * change; promotion remains an explicit control-plane action.
 */
import crypto from 'node:crypto';
import { encryptJson, decryptField, keyedDigest } from './data-protection.js';

const text = value => String(value ?? '').trim();
const TARGET_BY_REASON = Object.freeze({
  incorrect: 'reasoning',
  incomplete: 'reasoning',
  unsafe: 'safety',
  'too-slow': 'efficiency',
  'too-expensive': 'efficiency',
  'other': 'orchestration'
});

export function evolutionTarget(reason) {
  return TARGET_BY_REASON[text(reason)] ?? 'orchestration';
}

export class EvolutionStore {
  constructor(pool, { encryptionKey, logger = null } = {}) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
    this.logger = logger;
    if (!this.encryptionKey) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for evolution proposals');
  }

  async captureFeedback(scope, { feedbackId, runId, reason, note = '' } = {}) {
    if (!text(feedbackId) || !text(runId) || !scope?.workspaceId || !scope?.principalId) return null;
    const target = evolutionTarget(reason);
    const cleanNote = text(note).slice(0, 2000);
    const summary = {
      source: 'user-feedback',
      reason: text(reason) || 'other',
      target,
      runId: text(runId)
    };
    const evidence = cleanNote ? { note: cleanNote } : null;
    const fingerprint = keyedDigest(this.encryptionKey, 'evolution-proposal-v1', JSON.stringify(summary));
    const { rows: [row] } = await this.pool.query(
      `INSERT INTO evolution_proposals
        (id, workspace_id, principal_id, run_id, feedback_id, target, status, summary_enc, evidence_enc, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,'candidate',$7,$8,$9)
       ON CONFLICT (feedback_id, target) DO UPDATE SET
         summary_enc = EXCLUDED.summary_enc,
         evidence_enc = EXCLUDED.evidence_enc,
         fingerprint = EXCLUDED.fingerprint,
         updated_at = now()
       RETURNING id, run_id AS "runId", feedback_id AS "feedbackId", target, status,
                 created_at AS "createdAt", updated_at AS "updatedAt", fingerprint`,
      [
        crypto.randomUUID(), scope.workspaceId, scope.principalId, text(runId), text(feedbackId),
        target,
        encryptJson(this.encryptionKey, 'evolution-proposal-summary-v1', summary),
        evidence ? encryptJson(this.encryptionKey, 'evolution-proposal-evidence-v1', evidence) : null,
        fingerprint
      ]
    );
    return row;
  }

  async list(scope, { status = null, limit = 50 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const { rows } = await this.pool.query(
      `SELECT id, run_id AS "runId", feedback_id AS "feedbackId", target, status,
              summary_enc, evidence_enc, fingerprint, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM evolution_proposals
        WHERE workspace_id = $1
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [scope.workspaceId, status ? text(status) : null, cap]
    );
    return rows.map(row => {
      let summary = null;
      let evidence = null;
      try { summary = JSON.parse(decryptField(this.encryptionKey, 'evolution-proposal-summary-v1', row.summary_enc)); } catch {}
      try { evidence = row.evidence_enc ? JSON.parse(decryptField(this.encryptionKey, 'evolution-proposal-evidence-v1', row.evidence_enc)) : null; } catch {}
      return { id: row.id, runId: row.runId, feedbackId: row.feedbackId, target: row.target, status: row.status, summary, evidence, fingerprint: row.fingerprint, createdAt: row.createdAt, updatedAt: row.updatedAt };
    });
  }

  async setStatus(scope, _principal, id, status) {
    const allowed = new Set(['candidate','approved','rejected','implemented']);
    if (!allowed.has(text(status))) {
      const error = new Error('Invalid evolution proposal status'); error.status = 400; error.code = 'evolution-status-invalid'; throw error;
    }
    const { rows: [current] } = await this.pool.query(
      'SELECT id, status FROM evolution_proposals WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
      [text(id), scope.workspaceId]
    );
    if (!current) {
      const error = new Error('Evolution proposal not found'); error.status = 404; error.code = 'evolution-proposal-not-found'; throw error;
    }
    const allowedTransitions = {
      candidate: new Set(['approved', 'rejected']),
      approved: new Set(['implemented', 'rejected']),
      rejected: new Set(['candidate']),
      implemented: new Set([])
    };
    if (!allowedTransitions[current.status]?.has(text(status)) && current.status !== text(status)) {
      const error = new Error('That evolution proposal cannot move from ' + current.status + ' to ' + text(status));
      error.status = 409; error.code = 'evolution-transition-invalid'; throw error;
    }
    const { rows: [row] } = await this.pool.query(
      `UPDATE evolution_proposals
          SET status = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = $2
        RETURNING id, target, status, updated_at AS "updatedAt"`,
      [text(id), scope.workspaceId, text(status)]
    );
    return row;
  }
}
