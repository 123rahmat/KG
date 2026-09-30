/**
 * Server-owned governance policy store.
 *
 * Clients may add a task-level restriction, but they cannot submit or replace
 * platform, jurisdiction, organization, workspace or user policy. Those
 * policies come from PostgreSQL and are therefore part of the trusted state.
 */

const LAYERS = ['platform', 'jurisdiction', 'organization', 'workspace', 'user'];
const text = value => String(value ?? '').trim();

export class GovernanceStore {
  constructor(pool) {
    this.pool = pool;
  }

  async forScope({ workspaceId, principalId, taskPolicy = null }) {
    const { rows } = await this.pool.query(
      'SELECT w.id AS workspace_id, w.jurisdiction, w.organization_id, o.id AS org_id ' +
      'FROM workspaces w LEFT JOIN organizations o ON o.id = w.organization_id ' +
      'WHERE w.id = $1 AND w.archived_at IS NULL',
      [text(workspaceId)]
    );
    const workspace = rows[0];
    if (!workspace) return taskPolicy ? { task: taskPolicy } : {};

    const scopeIds = {
      platform: 'global',
      jurisdiction: workspace.jurisdiction || null,
      organization: workspace.org_id || workspace.organization_id || null,
      workspace: workspace.workspace_id,
      user: text(principalId) || null
    };

    const clauses = [];
    const values = [];
    for (const layer of LAYERS) {
      const scopeId = scopeIds[layer];
      if (!scopeId) continue;
      values.push(layer, scopeId);
      const base = values.length - 1;
      clauses.push('(layer = $' + base + ' AND scope_id = $' + (base + 1) + ')');
    }

    const policies = {};
    if (clauses.length) {
      const result = await this.pool.query(
        'SELECT layer, scope_id, policy FROM governance_policies WHERE ' + clauses.join(' OR '),
        values
      );
      for (const row of result.rows) policies[row.layer] = row.policy;
    }

    if (taskPolicy && typeof taskPolicy === 'object' && !Array.isArray(taskPolicy)) {
      policies.task = taskPolicy;
    }
    return policies;
  }

  async set({ layer, scopeId, policy }) {
    const name = text(layer).toLowerCase();
    if (!LAYERS.includes(name)) throw new Error('Unknown governance layer ' + name);
    const id = text(scopeId) || (name === 'platform' ? 'global' : '');
    if (!id) throw new Error('scopeId is required for the ' + name + ' layer');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('policy must be a JSON object');
    }

    const { rows } = await this.pool.query(
      'INSERT INTO governance_policies (layer, scope_id, policy, updated_at) ' +
      'VALUES ($1, $2, $3, now()) ' +
      'ON CONFLICT (layer, scope_id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now() ' +
      'RETURNING layer, scope_id, policy, updated_at',
      [name, id, JSON.stringify(policy)]
    );
    return rows[0];
  }

  async get({ layer, scopeId }) {
    const name = text(layer).toLowerCase();
    const id = text(scopeId) || (name === 'platform' ? 'global' : '');
    const { rows } = await this.pool.query(
      'SELECT layer, scope_id, policy, updated_at FROM governance_policies ' +
      'WHERE layer = $1 AND scope_id = $2',
      [name, id]
    );
    return rows[0] ?? null;
  }
}

export { LAYERS };
