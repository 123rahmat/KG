/**
 * Encrypted, versioned blackboard for a single server-owned Run.
 *
 * The blackboard is shared working state, not durable memory and not a source
 * of authority. It is optimistic-concurrency controlled so two writers cannot
 * silently overwrite one another.
 */
import crypto from 'node:crypto';
import { encryptJson, decryptField, keyedDigest } from './data-protection.js';
import { mergeSubsystemMessages } from './subsystem-orchestrator.js';

const text = value => String(value ?? '').trim();
const MAX_BYTES = 120_000;
const emptyBoard = runId => ({
  version: 0,
  runId: text(runId),
  objective: null,
  facts: [],
  hypotheses: [],
  decisions: [],
  findings: [],
  blockers: [],
  evidence: [],
  openQuestions: [],
  subsystemPlan: null,
  subsystemMessages: [],
  updatedAt: null
});

function normalizeList(value, limit = 100, maxItem = 1200) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => text(item).slice(0, maxItem)).filter(Boolean))].slice(0, limit)
    : [];
}

function normalizeBoard(value = {}, runId = null) {
  value = value && typeof value === 'object' ? value : {};
  const base = emptyBoard(runId);
  const merged = {
    ...base,
    ...value,
    runId: text(runId || value.runId),
    version: Number.isInteger(Number(value.version)) ? Math.max(0, Number(value.version)) : 0,
    objective: text(value.objective).slice(0, 2000) || null,
    facts: normalizeList(value.facts),
    hypotheses: normalizeList(value.hypotheses),
    decisions: normalizeList(value.decisions),
    findings: normalizeList(value.findings),
    blockers: normalizeList(value.blockers),
    evidence: normalizeList(value.evidence),
    openQuestions: normalizeList(value.openQuestions),
    subsystemPlan: value.subsystemPlan && typeof value.subsystemPlan === 'object' ? value.subsystemPlan : null,
    subsystemMessages: mergeSubsystemMessages([], value.subsystemMessages, { limit: 64 }),
    updatedAt: value.updatedAt ?? null
  };
  return merged;
}

function mergeUnique(left, right, limit = 100) {
  return [...new Set([...normalizeList(left, limit), ...normalizeList(right, limit)])].slice(0, limit);
}

export function mergeBlackboard(current, contribution = {}, runId = null) {
  const base = normalizeBoard(current, runId);
  const next = {
    ...base,
    // A pure in-memory merge advances an already-existing board; the first
    // materialization remains version 0 so BlackboardStore can assign version 1
    // atomically when it creates the persisted row.
    version: current && typeof current === 'object' ? base.version + 1 : 0,
    objective: text(contribution.objective) || base.objective,
    facts: mergeUnique(base.facts, contribution.facts),
    hypotheses: mergeUnique(base.hypotheses, contribution.hypotheses),
    decisions: mergeUnique(base.decisions, contribution.decisions),
    findings: mergeUnique(base.findings, contribution.findings),
    blockers: mergeUnique(base.blockers, contribution.blockers),
    evidence: mergeUnique(base.evidence, contribution.evidence),
    openQuestions: mergeUnique(base.openQuestions, contribution.openQuestions),
    subsystemPlan: contribution.subsystemPlan && typeof contribution.subsystemPlan === 'object'
      ? contribution.subsystemPlan
      : base.subsystemPlan,
    subsystemMessages: mergeSubsystemMessages(base.subsystemMessages, contribution.subsystemMessages, { limit: 64 }),
    updatedAt: new Date().toISOString()
  };
  return next;
}

export class BlackboardStore {
  constructor(pool, { encryptionKey } = {}) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
    if (!this.encryptionKey) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for the blackboard');
  }

  async load(scope, runId) {
    const { rows: [row] } = await this.pool.query(
      'SELECT version, state_enc FROM run_blackboards WHERE run_id = $1 AND workspace_id = $2 AND principal_id = $3 LIMIT 1',
      [text(runId), scope.workspaceId, scope.principalId]
    );
    if (!row) return emptyBoard(runId);
    try {
      const raw = decryptField(this.encryptionKey, 'run-blackboard-v1', row.state_enc);
      return normalizeBoard(JSON.parse(raw), runId);
    } catch {
      return emptyBoard(runId);
    }
  }

  async merge(scope, runId, contribution = {}, expectedVersion = null) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.load(scope, runId);
      if (expectedVersion !== null && Number(current.version) !== Number(expectedVersion)) {
        const error = new Error('The blackboard changed while this contribution was being prepared.');
        error.code = 'blackboard-conflict';
        error.status = 409;
        error.currentVersion = current.version;
        throw error;
      }
      const next = mergeBlackboard(current, contribution, runId);
      next.version = Math.max(current.version + 1, next.version);
      const packed = JSON.stringify(next);
      if (Buffer.byteLength(packed, 'utf8') > MAX_BYTES) {
        const error = new Error('Run blackboard is full; summarize before adding more state.');
        error.code = 'blackboard-too-large';
        error.status = 409;
        throw error;
      }
      const enc = encryptJson(this.encryptionKey, 'run-blackboard-v1', next);
      const digest = keyedDigest(this.encryptionKey, 'run-blackboard-digest-v1', packed);
      if (current.version === 0) {
        try {
          const id = crypto.randomUUID();
          await this.pool.query(
            'INSERT INTO run_blackboards (id, run_id, workspace_id, principal_id, version, state_enc, state_digest) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, text(runId), scope.workspaceId, scope.principalId, next.version, enc, digest]
          );
          return next;
        } catch (error) {
          if (error?.code === '23505') continue;
          throw error;
        }
      }
      const { rowCount } = await this.pool.query(
        'UPDATE run_blackboards SET version = $1, state_enc = $2, state_digest = $3, updated_at = now() WHERE run_id = $4 AND workspace_id = $5 AND principal_id = $6 AND version = $7',
        [next.version, enc, digest, text(runId), scope.workspaceId, scope.principalId, current.version]
      );
      if (rowCount === 1) return next;
    }
    const error = new Error('The blackboard could not be updated after concurrent changes.');
    error.code = 'blackboard-conflict';
    error.status = 409;
    throw error;
  }
}
