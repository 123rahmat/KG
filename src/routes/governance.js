/** Workspace governance, the discovered-capability registry and the audit trail. */

import { text } from '../http/context.js';

export function registerGovernanceRoutes(app, { governance, capabilities, audit, scoped, route }) {
  app.get('/api/governance', scoped('admin'), route(async (req, res) => {
    const layer = text(req.query.layer) || 'workspace';
    const allowed = new Set(['organization', 'workspace', 'user']);
    if (!allowed.has(layer)) {
      return res.status(403).json({
        error: 'Only organization, workspace and user policies are managed in the workspace API',
        code: 'governance-layer-forbidden'
      });
    }
    const scopeId = layer === 'organization'
      ? req.scope.organizationId
      : layer === 'user'
        ? req.principal.id
        : req.scope.workspaceId;
    if (!scopeId) return res.status(404).json({ error: 'Governance scope not found', code: 'governance-scope-not-found' });
    const row = await governance.get({ layer, scopeId });
    res.json({ layer, scopeId, policy: row?.policy ?? null, updatedAt: row?.updated_at ?? null });
  }));

  app.post('/api/governance', scoped('admin'), route(async (req, res) => {
    const layer = text(req.body?.layer).toLowerCase();
    const allowed = new Set(['organization', 'workspace', 'user']);
    if (!allowed.has(layer)) {
      return res.status(403).json({
        error: 'Platform and jurisdiction policy are operator-managed; workspace admins manage organization, workspace or user scope only',
        code: 'governance-layer-forbidden'
      });
    }
    if (layer === 'organization' && req.scope.organizationType !== 'enterprise') {
      return res.status(409).json({
        error: 'Organization policy is available only to enterprise workspaces',
        code: 'enterprise-governance-required'
      });
    }
    const scopeId = layer === 'organization'
      ? req.scope.organizationId
      : layer === 'user'
        ? req.principal.id
        : req.scope.workspaceId;
    if (!scopeId) return res.status(404).json({ error: 'Governance scope not found', code: 'governance-scope-not-found' });
    const policy = req.body?.policy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      return res.status(400).json({ error: 'policy must be a JSON object', code: 'invalid-policy' });
    }
    const row = await governance.set({
      layer,
      scopeId,
      policy: req.body?.policy
    });
    await audit.record({
      principalId: req.principal.id,
      workspaceId: req.scope.workspaceId,
      action: 'governance.set',
      target: layer + ':' + scopeId,
      outcome: 'allowed',
      detail: { layer, version: row.version ?? null },
      requestId: req.requestId
    });
    res.status(200).json(row);
  }));

  app.get('/api/capability-specs', scoped('viewer'), route(async (req, res) => {
    if (!capabilities) return res.status(503).json({ error: 'Capability registry is unavailable', code: 'capability-registry-unavailable' });
    res.json({ capabilities: await capabilities.list(req.scope, { status: req.query.status, limit: req.query.limit }) });
  }));

  app.post('/api/capability-specs/:id/approve', scoped('admin'), route(async (req, res) => {
    if (!capabilities) return res.status(503).json({ error: 'Capability registry is unavailable', code: 'capability-registry-unavailable' });
    const result = await capabilities.setStatus(req.scope, req.principal, req.params.id, 'approved', {
      requestId: req.requestId
    });
    if (!result) return res.status(404).json({ error: 'Capability not found', code: 'capability-not-found' });
    res.json(result);
  }));

  app.post('/api/capability-specs/:id/revoke', scoped('admin'), route(async (req, res) => {
    if (!capabilities) return res.status(503).json({ error: 'Capability registry is unavailable', code: 'capability-registry-unavailable' });
    const result = await capabilities.setStatus(req.scope, req.principal, req.params.id, 'revoked', {
      requestId: req.requestId
    });
    if (!result) return res.status(404).json({ error: 'Capability not found', code: 'capability-not-found' });
    res.json(result);
  }));


  app.get('/api/audit', scoped('admin'), route(async (req, res) => res.json({
    entries: await audit.list({
      workspaceId: req.scope.workspaceId, limit: req.query.limit, before: req.query.before
    })
  })));

  /* ---------------------------------------------------------- fallback */
}
