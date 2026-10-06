import { DEFAULT_MODEL, MODEL_IDS, configuredModelIds, modelForTask, normalizeModelId, publicModelCatalog, resolveConfiguredModel } from './model-catalog.js';

export async function workspaceModelSettings(pool, workspaceId) {
  const { rows: [row] } = await pool.query(
    'SELECT default_model, enabled_models FROM workspace_ai_settings WHERE workspace_id = $1',
    [workspaceId]
  ).catch(() => ({ rows: [] }));
  const defaultModel = normalizeModelId(row?.default_model) || `google:${DEFAULT_MODEL}`;
  const enabled = Array.isArray(row?.enabled_models) ? row.enabled_models.map(normalizeModelId).filter(Boolean) : [];
  return { defaultModel, enabledModels: enabled.length ? enabled : [...MODEL_IDS] };
}

export async function planModelIds() {
  return [...MODEL_IDS];
}

export async function resolveModelSelection(pool, config, { workspaceId = '', principalId = '' } = {}) {
  const settings = await workspaceModelSettings(pool, workspaceId);
  const configured = configuredModelIds(config);
  const enabled = settings.enabledModels.filter(id => configured.includes(id));
  const selectedModelId = enabled.includes(settings.defaultModel)
    ? settings.defaultModel
    : configured.includes(`google:${DEFAULT_MODEL}`) ? `google:${DEFAULT_MODEL}` : configured[0] || null;
  return {
    selectedModelId,
    selected: selectedModelId ? resolveConfiguredModel(config, selectedModelId) : null,
    planModelIds: enabled.length ? enabled : configured,
    enabledModelIds: enabled.length ? enabled : configured,
    workspaceDefaultModelId: settings.defaultModel,
    preferredModelId: selectedModelId,
    configuredModelIds: configured,
    adaptive: true
  };
}

export async function modelsView(pool, config, { workspaceId = '', principalId = '', canManage = false } = {}) {
  const selection = await resolveModelSelection(pool, config, { workspaceId, principalId });
  return {
    version: '3',
    provider: 'google-vertex-ai',
    adaptive: true,
    allTiersShareModels: true,
    selectedModelId: selection.selectedModelId,
    workspaceDefaultModelId: selection.workspaceDefaultModelId || null,
    preferredModelId: selection.preferredModelId || null,
    canManage,
    models: publicModelCatalog(config)
  };
}

export function validateModelChange({ modelId, config }) {
  const id = normalizeModelId(modelId);
  if (!id) return { ok: false, code: 'invalid-model', message: 'Only the configured Gemini family is available.' };
  const resolved = resolveConfiguredModel(config, id);
  return resolved
    ? { ok: true, model: resolved }
    : { ok: false, code: 'model-not-configured', message: 'Vertex AI Gemini is not configured on this deployment.' };
}

export function adminModelSettings() {
  return { ok: true, defaultModel: `google:${DEFAULT_MODEL}`, enabledModels: [...MODEL_IDS], adaptive: true };
}

export function modelForStep(selection, { fallback = null, taskType = '', effort = '', adaptiveContext = {} } = {}) {
  const enabled = selection?.enabledModelIds?.length ? selection.enabledModelIds : selection?.configuredModelIds ?? [];
  const configured = enabled.map(id => id.replace(/^google:/, ''));
  const chosen = modelForTask({ taskType, effort, adaptiveContext, configured });
  const chosenId = normalizeModelId(chosen);
  if (chosenId && enabled.includes(chosenId)) return chosenId;
  return selection?.selectedModelId || normalizeModelId(fallback) || `google:${DEFAULT_MODEL}`;
}
