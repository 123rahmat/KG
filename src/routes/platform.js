/** Identity, catalogues, configuration, metrics. */

import { CAPABILITIES, capabilityCatalog } from '../core.js';
import { connectorCatalog } from '../adaptive.js';
import { executionTargetCatalog } from '../execution.js';
import { text, parseCookies, sessionCookieName } from '../http/context.js';
import { targetConfigured } from '../http/policy.js';
import { transaction } from '../db.js';
import { modelsView, resolveModelSelection, adminModelSettings, validateModelChange } from '../model-routing.js';
import { callModel } from '../runtime.js';

/**
 * One tiny Grok call with a model before it becomes a workspace default,
 * so a retired, misspelled or not-yet-available model is refused at the
 * switch instead of breaking every chat afterwards.
 */
async function probeModel(config, fetchImpl, modelId) {
  try {
    const answer = await callModel([{ role: 'user', content: 'Reply with the single word OK.' }], {
      config, fetchImpl, modelId, effort: 'low', retries: 0, timeoutMs: 20_000
    });
    if (!answer) return { ok: false, reason: 'not configured' };
    if (answer.incomplete === 'refusal' || answer.incomplete === 'invalid-provider-response') return { ok: false, reason: answer.incomplete };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.upstreamStatus ? `HTTP ${error.upstreamStatus}` : 'unreachable' };
  }
}

export function registerPlatformRoutes(app, { config, identity, capabilities, metrics, fetchImpl, route, scoped, pool, audit }) {
  /* -------------------------------------------------------------- self */

  app.get('/api/me', route(async (req, res) => res.json({
    principal: {
      id: req.principal.id, name: req.principal.name, kind: req.principal.kind, via: req.principal.via,
      email: req.principal.email ?? null, platformAdmin: req.principal.platformAdmin === true
    },
    workspaces: (await identity.workspacesFor(req.principal.id)).map(row => ({
      id: row.id,
      name: row.name,
      role: row.role,
      maxBytes: row.max_bytes,
      maxObjects: row.max_objects,
      organization: {
        id: row.organization_id,
        name: row.organization_name,
        type: row.organization_type || 'personal'
      },
      jurisdiction: row.jurisdiction || null
    }))
  })));

  app.delete('/api/session', route(async (req, res) => {
    await identity.endSession(parseCookies(req.get('cookie'))[sessionCookieName(config)]);
    res.append('set-cookie', `${sessionCookieName(config)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
    res.status(204).end();
  }));


  app.get('/api/capabilities', (_req, res) => res.json({
    capabilities: capabilityCatalog(),
    connectors: connectorCatalog(),
    count: CAPABILITIES.length
  }));

  app.get('/api/models', scoped('viewer'), route(async (req, res) => {
    res.json(await modelsView(pool, config, {
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id,
      canManage: req.scope.role === 'admin'
    }));
  }));

  app.put('/api/models/preference', scoped('viewer'), route(async (req, res) => {
    const selection = await resolveModelSelection(pool, config, {
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id
    });
    const chosen = validateModelChange({
      modelId: req.body?.modelId,
      planModelIds: selection.planModelIds,
      enabledModelIds: selection.enabledModelIds,
      config
    });
    if (!chosen.ok) return res.status(chosen.code === 'model-plan-forbidden' ? 403 : 400).json({
      error: chosen.message, code: chosen.code
    });
    const modelId = chosen.model.id;
    await transaction(pool, async client => {
      const { rows: [existing] } = await client.query(
        'SELECT settings FROM user_preferences WHERE principal_id = $1',
        [req.principal.id]
      );
      const settings = { ...(existing?.settings ?? {}), preferredModel: modelId };
      await client.query(
        `INSERT INTO user_preferences (principal_id, settings, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (principal_id) DO UPDATE
           SET settings = EXCLUDED.settings, updated_at = now()`,
        [req.principal.id, JSON.stringify(settings)]
      );
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'model.preference.update', target: modelId, outcome: 'allowed',
        detail: { provider: chosen.model.provider, model: chosen.model.model },
        requestId: req.requestId
      }, client);
    });
    res.json({ selectedModelId: modelId, model: chosen.model.name });
  }));

  app.put('/api/models/settings', scoped('admin'), route(async (req, res) => {
    const current = await resolveModelSelection(pool, config, {
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id
    });
    const normalized = adminModelSettings({
      defaultModelId: req.body?.defaultModelId,
      enabledModelIds: req.body?.enabledModelIds,
      planModelIds: current.planModelIds,
      config
    });
    if (!normalized.ok) return res.status(400).json({ error: normalized.message, code: normalized.code });
    // A new default is tried once before anyone's chats depend on it.
    if (normalized.defaultModel !== current.selectedModelId) {
      const probe = await probeModel(config, fetchImpl, normalized.defaultModel);
      if (!probe.ok) {
        await audit?.record({
          principalId: req.principal.id, workspaceId: req.scope.workspaceId,
          action: 'model.workspace-settings.update', target: req.scope.workspaceId, outcome: 'denied',
          detail: { defaultModelId: normalized.defaultModel, reason: probe.reason }, requestId: req.requestId
        });
        return res.status(400).json({
          error: `Grok did not accept ${normalized.defaultModel.replace(/^xai:/, '')} (${probe.reason}). Check the model name and that this API key can use it; nothing was changed.`,
          code: 'model-unavailable'
        });
      }
    }
    await transaction(pool, async client => {
      await client.query(
        `INSERT INTO workspace_ai_settings (workspace_id, default_model, enabled_models, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (workspace_id) DO UPDATE SET
           default_model = EXCLUDED.default_model,
           enabled_models = EXCLUDED.enabled_models,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [req.scope.workspaceId, normalized.defaultModel, JSON.stringify(normalized.enabledModels), req.principal.id]
      );
      await audit?.record({
        principalId: req.principal.id, workspaceId: req.scope.workspaceId,
        action: 'model.workspace-settings.update', target: req.scope.workspaceId,
        outcome: 'allowed',
        detail: { defaultModelId: normalized.defaultModel, enabledModelIds: normalized.enabledModels },
        requestId: req.requestId
      }, client);
    });
    res.json(await modelsView(pool, config, {
      workspaceId: req.scope.workspaceId,
      principalId: req.principal.id,
      canManage: true
    }));
  }));

  const normalizePreferences = input => {
    const body = input && typeof input === 'object' ? input : {};
    const out = {};
    const strings = {
      language: 40, style: 40, length: 40, country: 80, about: 600,
      theme: 20, autonomy: 20, adaptiveIntensity: 20, adaptiveDepth: 20, capabilityInvestment: 30,
      externalContext: 20, voiceLanguage: 20
    };
    for (const [key, max] of Object.entries(strings)) {
      if (body[key] !== undefined) out[key] = text(body[key]).slice(0, max);
    }
    const booleans = [
      'consent','share','enterSends','reducedMotion','highContrast','captions',
      'notifications','voiceInput','offlineQueue','crossChatMemory','allowAdaptiveExpansion'
    ];
    for (const key of booleans) if (body[key] !== undefined) out[key] = body[key] === true;
    // Old clients used "memory"; it now controls only optional cross-chat sharing.
    if (body.crossChatMemory === undefined && body.memory !== undefined) out.crossChatMemory = body.memory === true;
    if (out.autonomy && !['guided','assist','autopilot'].includes(out.autonomy)) delete out.autonomy;
    if (out.adaptiveIntensity && !['low','standard','high'].includes(out.adaptiveIntensity)) delete out.adaptiveIntensity;
    if (out.adaptiveDepth && !['brief','standard','thorough'].includes(out.adaptiveDepth)) delete out.adaptiveDepth;
    if (out.capabilityInvestment && !['ask','prepare','build-candidate'].includes(out.capabilityInvestment)) delete out.capabilityInvestment;
    if (out.externalContext && !['ask','allow','deny'].includes(out.externalContext)) delete out.externalContext;
    return out;
  };

  app.get('/api/preferences', route(async (req, res) => {
    const { rows: [row] } = await pool.query(
      'SELECT settings, updated_at FROM user_preferences WHERE principal_id = $1',
      [req.principal.id]
    );
    const settings = { ...(row?.settings ?? {}) };
    if (settings.crossChatMemory === undefined && typeof settings.memory === 'boolean') settings.crossChatMemory = settings.memory;
    delete settings.memory;
    res.json({ settings, updatedAt: row?.updated_at ?? null });
  }));

  app.patch('/api/preferences', route(async (req, res) => {
    const patch = normalizePreferences(req.body);
    const { rows: [row] } = await pool.query(
      'SELECT settings FROM user_preferences WHERE principal_id = $1',
      [req.principal.id]
    );
    const settings = { ...(row?.settings ?? {}) };
    if (settings.crossChatMemory === undefined && typeof settings.memory === 'boolean') settings.crossChatMemory = settings.memory;
    delete settings.memory;
    Object.assign(settings, patch);
    await transaction(pool, async client => {
      await client.query(
        `INSERT INTO user_preferences (principal_id, settings, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (principal_id) DO UPDATE
           SET settings = EXCLUDED.settings, updated_at = now()`,
        [req.principal.id, JSON.stringify(settings)]
      );
      await metrics.increment?.('preferences_updated_total', { source: 'user' });
    });
    res.json({ settings });
  }));

  app.get('/api/execution/config', route(async (_req, res) => {
    res.json({
      capabilityContract: 'server-owned execution target selection with human approval and evidence-bound receipts',
      targets: executionTargetCatalog().map(target => ({
        ...target,
        taskTypes: [...target.taskTypes],
        configured: targetConfigured(config, target.id)
      })),
      localAgentUrl: config.execution.localAgentUrl,
      // Whether reasoning steps can run on a model. Never the key.
      reasoning: { configured: Boolean(config.ai), provider: config.ai?.provider ?? null }
    });
  }));



  app.get('/api/metrics', route(async (req, res) => {
    // Any authenticated principal may read aggregate, non-tenant numbers.
    res.set('content-type', 'text/plain; version=0.0.4');
    res.send(metrics.render());
  }));
}
