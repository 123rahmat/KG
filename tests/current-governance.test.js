import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';
import { runDbScope } from '../src/db.js';
import { GovernanceStore, setOrganizationAdmin } from '../src/governance.js';

const vertexReply = () => jsonResponse({
  candidates: [{ content: { parts: [{ text: 'Hello.' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }
});

test('policy changes block existing foreground and background runs before model calls', () =>
  withServer(async ({ call, seed, pool, worker }) => {
    const governance = new GovernanceStore(pool);
    const user = await seed();
    const created = await call('POST', '/api/runs', { ...user, body: { goal: 'Hello', modelConsent: true } });
    assert.equal(created.status, 201);
    await governance.set({ layer: 'workspace', scopeId: user.workspace, policy: { deniedModels: ['*'] } });
    const execute = await call('POST', `/api/runs/${created.body.id}/execute`, user);
    assert.equal(execute.body.execution?.status ?? execute.body.code, 'policy-blocked');
    const queued = await call('POST', `/api/runs/${created.body.id}/execute`, { ...user, body: { background: true, taskId: created.body.next } });
    assert.equal(queued.status, 202);
    assert.equal(await worker.runOnce(), 1);
    const { body: { job } } = await call('GET', `/api/runs/${created.body.id}/jobs/${queued.body.job.id}`, user);
    assert.equal(job.outcome.execution?.status ?? job.outcome.code, 'policy-blocked');
    const usage = await pool.query('SELECT count(*)::int AS count FROM usage_events WHERE principal_id = $1', [user.principal.id]);
    assert.equal(usage.rows[0].count, 0);
  }, { env: { AI_PROVIDER: 'google', GOOGLE_CLOUD_PROJECT: 'test', VERTEX_ACCESS_TOKEN: 'test', AI_MODEL: 'gemini-3.8-flash' }, fetchImpl: async () => { throw new Error('policy must block outbound calls'); } }));

test('new human approval requires a current policy token before existing work resumes', () =>
  withServer(async ({ call, seed, pool }) => {
    const governance = new GovernanceStore(pool);
    const user = await seed();
    const created = await call('POST', '/api/runs', { ...user, body: { goal: 'Hello', modelConsent: true } });
    await governance.set({ layer: 'workspace', scopeId: user.workspace, policy: { requireHumanApproval: true } });
    const denied = await call('POST', `/api/runs/${created.body.id}/execute`, { ...user, body: { approved: true } });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'policy-approval-required');
    assert.ok(denied.body.policyRevision);
    const allowed = await call('POST', `/api/runs/${created.body.id}/execute`, { ...user, body: { approved: true, policyRevision: denied.body.policyRevision } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.execution.executed, true);
    assert.equal(allowed.body.execution.text, 'Hello.');
  }, { env: { AI_PROVIDER: 'google', GOOGLE_CLOUD_PROJECT: 'test', VERTEX_ACCESS_TOKEN: 'test', AI_MODEL: 'gemini-3.8-flash' }, fetchImpl: async () => vertexReply() }));

test('runtime cannot provision organization authority or forge workspace policy authority', () =>
  withServer(async ({ seed, pool, appPool, identity }) => {
    const user = await seed({ workspace: 'enterprise', organizationType: 'enterprise', role: 'viewer' });
    await assert.rejects(appPool.query('INSERT INTO organization_admins (organization_id, principal_id) VALUES ($1, $2)', ['org-enterprise', user.principal.id]), error => error.code === '42501');
    const scope = await runDbScope({ principalId: user.principal.id }, () => identity.requireAccess(user.principal, user.workspace));
    await assert.rejects(runDbScope({ ...scope, principalId: user.principal.id, role: 'admin' }, () => appPool.query("INSERT INTO governance_policies (layer, scope_id, policy) VALUES ('workspace', $1, '{}'::jsonb)", [user.workspace])), error => error.code === '42501');
    await pool.query('INSERT INTO organization_admins (organization_id, principal_id) VALUES ($1, $2)', ['org-enterprise', user.principal.id]);
    await runDbScope({ ...scope, principalId: user.principal.id }, () => appPool.query("INSERT INTO governance_policies (layer, scope_id, policy) VALUES ('organization', 'org-enterprise', '{}'::jsonb)"));
    await assert.rejects(runDbScope({ ...scope, principalId: user.principal.id }, () => appPool.query("INSERT INTO governance_policies (layer, scope_id, policy) VALUES ('user', 'other-user', '{}'::jsonb)")), error => error.code === '42501');
  }));

test('policy audit failure rolls back the policy mutation', () =>
  withServer(async ({ pool }) => {
    const governance = new GovernanceStore(pool);
    const audit = { record: async () => { throw new Error('audit unavailable'); } };
    await assert.rejects(governance.set({ layer: 'platform', scopeId: 'global', policy: { maxTokens: 100 }, audit, auditEntry: { action: 'governance.set' } }), /audit unavailable/);
    const unchanged = await governance.get({ layer: 'platform', scopeId: 'global' });
    assert.deepEqual(unchanged.policy, {});
    assert.equal(unchanged.revision, 1);
  }));

test('a newly lowered policy budget constrains provider admission and stays lowered', () => {
  let admittedOutput = null;
  return withServer(async ({ call, seed, pool }) => {
    const user = await seed();
    const governance = new GovernanceStore(pool);
    const created = await call('POST', '/api/runs', { ...user, body: { goal: 'Hello', modelConsent: true } });
    await governance.set({ layer: 'workspace', scopeId: user.workspace, policy: { maxTokens: 512 } });
    const result = await call('POST', `/api/runs/${created.body.id}/execute`, user);
    assert.equal(result.status, 200);
    assert.equal(result.body.execution.executed, true);
    assert.equal(result.body.execution.text, 'Hello.');
    assert.ok(admittedOutput > 0 && admittedOutput <= 512, String(admittedOutput));
    const saved = await call('GET', `/api/runs/${created.body.id}`, user);
    assert.equal(saved.body.maxTokens, 512);
    assert.equal(saved.body.tokensUsed, 7);
    await governance.set({ layer: 'workspace', scopeId: user.workspace, policy: {} });
    const relaxed = await call('GET', `/api/runs/${created.body.id}`, user);
    assert.equal(relaxed.body.maxTokens, 512);
  }, { env: { AI_PROVIDER: 'google', GOOGLE_CLOUD_PROJECT: 'test', VERTEX_ACCESS_TOKEN: 'test', AI_MODEL: 'gemini-3.8-flash' }, fetchImpl: async (_url, request) => {
    admittedOutput = JSON.parse(request.body).generationConfig.maxOutputTokens;
    return vertexReply();
  } });
});

test('concurrent policy editors cannot both overwrite the same revision', () =>
  withServer(async ({ call, seed, pool }) => {
    const user = await seed();
    const results = await Promise.all([100, 200].map(maxTokens => call('POST', '/api/governance', {
      ...user, body: { layer: 'workspace', policy: { maxTokens }, expectedRevision: 0 }
    })));
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    const { rows: [row] } = await pool.query("SELECT revision FROM governance_policies WHERE layer = 'workspace' AND scope_id = $1", [user.workspace]);
    assert.equal(row.revision, 1);
    const audit = await call('GET', '/api/audit', user);
    assert.equal(audit.body.entries.filter(entry => entry.action === 'governance.set').length, 1);
  }));

test('operator organization provisioning is audited and does not promote workspace membership', () =>
  withServer(async ({ call, seed, pool, audit }) => {
    const user = await seed({ role: 'viewer', organizationType: 'enterprise' });
    await setOrganizationAdmin(pool, { organizationId: 'org-' + user.workspace, principalId: user.principal.id, audit });
    const orgWrite = await call('POST', '/api/governance', { ...user, body: { layer: 'organization', policy: { maxTokens: 100 } } });
    assert.equal(orgWrite.status, 200);
    const workspaceWrite = await call('POST', '/api/governance', { ...user, body: { layer: 'workspace', policy: {} } });
    assert.equal(workspaceWrite.status, 403);
    await setOrganizationAdmin(pool, { organizationId: 'org-' + user.workspace, principalId: user.principal.id, grant: false, audit });
    const revoked = await call('POST', '/api/governance', { ...user, body: { layer: 'organization', policy: {} } });
    assert.equal(revoked.status, 403);
    const { rows: [entries] } = await pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action IN ('organization.admin.grant', 'organization.admin.revoke')");
    assert.equal(entries.count, 2);
  }));
