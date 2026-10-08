/**
 * Server-owned governance policy store.
 *
 * Planning requests may add a task restriction, but cannot submit or replace
 * platform, jurisdiction, organization, workspace or user policy. Those
 * policies come from PostgreSQL. Authorized policy edits use this store.
 */

import { transaction } from './db.js';

const LAYERS = ['platform', 'jurisdiction', 'organization', 'workspace', 'user'];
const text = value => String(value ?? '').trim();

export function canManagePolicy(layer, scope) {
  if (layer === 'user') return ['viewer', 'editor', 'admin'].includes(scope?.role);
  if (layer === 'workspace') return scope?.role === 'admin';
  return layer === 'organization' && scope?.organizationType === 'enterprise' && scope?.organizationRole === 'admin';
}

export class PolicyError extends Error {
  constructor(message, code = 'invalid-policy', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

const LIST_CONSTRAINTS = ['Capabilities', 'Tools', 'Models', 'DataClasses', 'RiskClasses']
  .flatMap(kind => ['allowed' + kind, 'denied' + kind]);
const POLICY_FIELDS = new Set(['id', 'version', 'maxTokens', 'requireHumanApproval', ...LIST_CONSTRAINTS]);

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new PolicyError('policy must be a JSON object');
  for (const [key, value] of Object.entries(policy)) {
    if (!POLICY_FIELDS.has(key)) throw new PolicyError(`Unknown policy constraint: ${key}`);
    if (LIST_CONSTRAINTS.includes(key)) {
      if (!Array.isArray(value) || value.length > 256 || value.some(rule => typeof rule !== 'string'
        || !rule.trim() || rule.length > 200 || rule !== rule.trim()
        || (rule.includes('*') && rule !== '*' && !/^(?:[^*]+\*|\*[^*]+)$/.test(rule)))) {
        throw new PolicyError(`${key} must contain at most 256 nonempty strings; wildcards may appear only at one end`);
      }
    } else if (key === 'maxTokens') {
      if (!Number.isSafeInteger(value) || value < 0) throw new PolicyError('maxTokens must be a nonnegative safe integer');
    } else if (key === 'requireHumanApproval') {
      if (typeof value !== 'boolean') throw new PolicyError('requireHumanApproval must be true or false');
    } else if (typeof value !== 'string' || !value.trim() || value.length > 200) {
      throw new PolicyError(`${key} must be a nonempty string of at most 200 characters`);
    }
  }
  return policy;
}

/** Original run restrictions remain binding even if a live policy is relaxed. */
export function narrowPolicyDecision(original, current) {
  const decisions = [original, current].filter(Boolean);
  const constraints = {};
  for (const kind of ['Capabilities', 'Tools', 'Models', 'DataClasses', 'RiskClasses']) {
    const allow = 'allowed' + kind;
    const declared = decisions.filter(item => item.constraints?.[allow + 'Specified']);
    constraints[allow + 'Specified'] = declared.length > 0;
    constraints[allow + 'Groups'] = [...new Map(declared.flatMap(item => item.constraints[allow + 'Groups'] ?? [item.constraints[allow] ?? []])
      .map(rules => [JSON.stringify(rules), rules])).values()];
    constraints[allow] = declared.length ? declared.slice(1).reduce(
      (rules, item) => rules.filter(rule => (item.constraints[allow] ?? []).includes(rule)),
      [...(declared[0].constraints[allow] ?? [])]
    ) : [];
    const deny = 'denied' + kind;
    constraints[deny] = [...new Set(decisions.flatMap(item => item.constraints?.[deny] ?? []))];
  }
  const budgets = decisions.map(item => item.constraints?.maxTokens).filter(Number.isFinite);
  constraints.maxTokens = budgets.length ? Math.min(...budgets) : null;
  constraints.requireHumanApproval = decisions.some(item => item.constraints?.requireHumanApproval === true);
  const sources = [...new Map(decisions.flatMap(item => item.sources ?? []).map(source => [JSON.stringify(source), source])).values()];
  return {
    ...current,
    status: decisions.some(item => item.status === 'incomplete') ? 'incomplete' : sources.length ? 'evaluated' : 'unconfigured',
    missingRequired: [...new Set(decisions.flatMap(item => item.missingRequired ?? []))],
    sources,
    approvals: [...new Map(decisions.flatMap(item => item.approvals ?? []).map(item => [JSON.stringify(item), item])).values()],
    constraints
  };
}

/** Operator-only provisioning; the live database role has no registry DML. */
export async function setOrganizationAdmin(pool, { organizationId, principalId, grant = true, audit }) {
  const organization = text(organizationId);
  const principal = text(principalId);
  if (!organization || !principal || !audit) throw new PolicyError('organizationId, principalId and audit are required');
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['kindgleam:organization-admin:' + organization]);
    if (grant) {
      const { rows: [member] } = await client.query(
        `SELECT 1 FROM organizations o JOIN workspaces w ON w.organization_id = o.id JOIN memberships m ON m.workspace_id = w.id
          WHERE o.id = $1 AND o.type = 'enterprise' AND w.archived_at IS NULL AND m.principal_id = $2 LIMIT 1`, [organization, principal]
      );
      if (!member) throw new PolicyError('Organization administrator must be a member of an active enterprise workspace');
      await client.query('INSERT INTO organization_admins (organization_id, principal_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [organization, principal]);
    } else {
      await client.query('DELETE FROM organization_admins WHERE organization_id = $1 AND principal_id = $2', [organization, principal]);
    }
    await audit.record({ principalId: null, workspaceId: null, action: grant ? 'organization.admin.grant' : 'organization.admin.revoke',
      target: organization + ':' + principal, outcome: 'allowed', detail: { organizationId: organization, principalId: principal, source: 'operator' }, critical: true }, client);
    return { organizationId: organization, principalId: principal, organizationRole: grant ? 'admin' : null };
  });
}

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
        'SELECT layer, scope_id, policy, revision FROM governance_policies WHERE ' + clauses.join(' OR '),
        values
      );
      for (const row of result.rows) policies[row.layer] = { ...row.policy, version: `${text(row.policy.version) || '1'}@${row.revision}` };
    }

    if (taskPolicy && typeof taskPolicy === 'object' && !Array.isArray(taskPolicy)) {
      policies.task = taskPolicy;
    }
    return policies;
  }

  async set({ layer, scopeId, policy, expectedRevision = null, audit = null, auditEntry = null }) {
    const name = text(layer).toLowerCase();
    if (!LAYERS.includes(name)) throw new Error('Unknown governance layer ' + name);
    const id = text(scopeId) || (name === 'platform' ? 'global' : '');
    if (!id) throw new Error('scopeId is required for the ' + name + ' layer');
    validatePolicy(policy);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new PolicyError('expectedRevision must be a nonnegative safe integer');
    }
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['kindgleam:policy:' + name + ':' + id]);
      if (expectedRevision !== null) {
        const { rows: [existing] } = await client.query('SELECT revision FROM governance_policies WHERE layer = $1 AND scope_id = $2', [name, id]);
        if ((existing?.revision ?? 0) !== expectedRevision) throw new PolicyError('Policy changed. Reload it before saving again.', 'policy-revision-conflict', 409);
      }
      const { rows } = await client.query(
        'INSERT INTO governance_policies (layer, scope_id, policy, updated_at) ' +
        'VALUES ($1, $2, $3, now()) ' +
        'ON CONFLICT (layer, scope_id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now(), revision = governance_policies.revision + 1 ' +
        'RETURNING layer, scope_id, policy, updated_at, revision',
        [name, id, JSON.stringify(policy)]
      );
      const row = rows[0];
      if (audit && auditEntry) await audit.record({ ...auditEntry, detail: { layer: name, revision: row.revision }, critical: true }, client);
      return row;
    });
  }

  async get({ layer, scopeId }) {
    const name = text(layer).toLowerCase();
    const id = text(scopeId) || (name === 'platform' ? 'global' : '');
    const { rows } = await this.pool.query(
      'SELECT layer, scope_id, policy, updated_at, revision FROM governance_policies ' +
      'WHERE layer = $1 AND scope_id = $2',
      [name, id]
    );
    return rows[0] ?? null;
  }
}

export { LAYERS };
