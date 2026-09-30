/**
 * Server-owned dynamic capability registry.
 *
 * Discovery creates candidates. Only an authorized administrator can promote a
 * capability to approved, and execution paths can require approved status.
 */

import { transaction } from './db.js';
import { normalizeCapabilitySpec } from './capabilities.js';

const text = value => String(value ?? '').trim();

export class CapabilityStore {
  constructor(pool, { audit } = {}) {
    this.pool = pool;
    this.audit = audit;
  }

  async upsertCandidates(scope, principal, specs = [], { requestId } = {}) {
    return transaction(this.pool, client =>
      this.upsertCandidatesTx(client, scope, principal, specs, { requestId })
    );
  }

  async upsertCandidatesTx(client, scope, principal, specs = [], { requestId } = {}) {
    const normalized = Array.isArray(specs)
      ? specs.slice(0, 24).map(spec => normalizeCapabilitySpec(spec))
      : [];
    if (!normalized.length) return [];

    const results = [];
    for (const spec of normalized) {
      const { rows } = await client.query(
        `INSERT INTO capability_specs
           (workspace_id, capability_id, spec, status, created_by, updated_at)
         VALUES ($1, $2, $3::jsonb, 'candidate', $4, now())
         ON CONFLICT (workspace_id, capability_id) DO UPDATE
           SET spec = EXCLUDED.spec, updated_at = now()
         WHERE capability_specs.status = 'candidate'
         RETURNING workspace_id, capability_id, spec, status, created_by, approved_by,
                   created_at, updated_at`,
        [scope.workspaceId, spec.id, JSON.stringify(spec), principal.id]
      );
      if (rows[0]) results.push(present(rows[0]));
    }

    if (results.length) {
      await this.audit?.record({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'capability.discovered',
        target: scope.workspaceId,
        outcome: 'allowed',
        detail: { ids: results.map(item => item.capabilityId) },
        requestId
      }, client);
    }
    return results;
  }

  async list(scope, { status, limit = 100 } = {}) {
    const size = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const { rows } = await this.pool.query(
      `SELECT workspace_id, capability_id, spec, status, created_by, approved_by,
              created_at, updated_at
         FROM capability_specs
        WHERE workspace_id = $1
          AND ($2::text IS NULL OR status = $2)
        ORDER BY updated_at DESC, capability_id
        LIMIT $3`,
      [scope.workspaceId, text(status) || null, size]
    );
    return rows.map(present);
  }

  async get(scope, id) {
    const { rows } = await this.pool.query(
      `SELECT workspace_id, capability_id, spec, status, created_by, approved_by,
              created_at, updated_at
         FROM capability_specs
        WHERE workspace_id = $1 AND capability_id = $2`,
      [scope.workspaceId, text(id)]
    );
    return rows[0] ? present(rows[0]) : null;
  }

  async setStatus(scope, principal, id, status, { requestId } = {}) {
    const next = text(status);
    if (!['approved', 'revoked'].includes(next)) throw new Error('Unsupported capability status');
    const { rows } = await this.pool.query(
      `UPDATE capability_specs
          SET status = $3,
              approved_by = CASE WHEN $3 = 'approved' THEN $4 ELSE approved_by END,
              updated_at = now()
        WHERE workspace_id = $1 AND capability_id = $2
        RETURNING workspace_id, capability_id, spec, status, created_by, approved_by,
                  created_at, updated_at`,
      [scope.workspaceId, text(id), next, principal.id]
    );
    const row = rows[0];
    if (!row) return null;
    await this.audit?.record({
      principalId: principal.id,
      workspaceId: scope.workspaceId,
      action: next === 'approved' ? 'capability.approve' : 'capability.revoke',
      target: row.capability_id,
      outcome: 'allowed',
      detail: { status: row.status },
      requestId
    });
    return present(row);
  }

  async approved(scope, ids = []) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(text).filter(Boolean))].slice(0, 24);
    if (!wanted.length) return [];
    const { rows } = await this.pool.query(
      `SELECT capability_id
         FROM capability_specs
        WHERE workspace_id = $1
          AND status = 'approved'
          AND capability_id = ANY($2::text[])`,
      [scope.workspaceId, wanted]
    );
    return rows.map(row => row.capability_id);
  }
}

function present(row) {
  return {
    workspaceId: row.workspace_id,
    capabilityId: row.capability_id,
    spec: row.spec,
    status: row.status,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}