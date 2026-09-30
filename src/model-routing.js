/**
 * Resolve the model used by a request.
 *
 * Selection order:
 *   1. a person's explicit preferred model, when enabled and configured;
 *   2. the workspace admin's default model;
 *   3. the first configured model in the catalogue.
 *
 * Plan/model access is intentionally checked here and again before execution.
 * That makes the browser a presentation layer, not the authority for model use.
 */
import { ACTIVE_STATUSES } from './stripe.js';
import { configuredModelIds, modelForTask, modelIdsForPlan, normalizeModelId, publicModelCatalog, resolveConfiguredModel } from './model-catalog.js';

const DEFAULT_ENABLED = null;

export async function workspaceModelSettings(pool, workspaceId) {
  const { rows: [row] } = await pool.query(
    'SELECT default_model, enabled_models FROM workspace_ai_settings WHERE workspace_id = $1',
    [workspaceId]
  ).catch(() => ({ rows: [] }));
  return {
    defaultModel: normalizeModelId(row?.default_model),
    enabledModels: Array.isArray(row?.enabled_models)
      ? row.enabled_models.map(normalizeModelId).filter(Boolean)
      : DEFAULT_ENABLED
  };
}

async function planModelIds(pool, config, workspaceId) {
  const fallback = [...configuredModelIds(config)];
  if (!config?.stripe || !workspaceId) return fallback;
  const { rows: [row] } = await pool.query(
    'SELECT plan_id, subscription_status FROM workspace_billing WHERE workspace_id = $1',
    [workspaceId]
  );
  const plan = row && ACTIVE_STATUSES.includes(row.subscription_status)
    ? config.stripe.plans.find(item => item.id === row.plan_id)
    : null;
  return plan ? modelIdsForPlan(plan, config).filter(id => fallback.includes(id)) : fallback;
}

export async function resolveModelSelection(pool, config, {
  workspaceId = '',
  principalId = ''
} = {}) {
  const settings = await workspaceModelSettings(pool, workspaceId);
  const planIds = await planModelIds(pool, config, workspaceId);
  const enabled = settings.enabledModels === null
    ? new Set(planIds)
    : new Set(settings.enabledModels.filter(id => planIds.includes(id)));

  const { rows: [prefs] } = principalId
    ? await pool.query('SELECT settings FROM user_preferences WHERE principal_id = $1', [principalId])
    : { rows: [{}] };
  const preferred = normalizeModelId(prefs?.settings?.preferredModel);
  const candidates = [preferred, settings.defaultModel, ...planIds];
  const selectedModelId = candidates.find(id => id && enabled.has(id) && configuredModelIds(config).includes(id)) || '';

  return {
    selectedModelId,
    selected: resolveConfiguredModel(config, selectedModelId),
    planModelIds: planIds,
    enabledModelIds: [...enabled],
    workspaceDefaultModelId: settings.defaultModel && enabled.has(settings.defaultModel) ? settings.defaultModel : '',
    preferredModelId: preferred && enabled.has(preferred) ? preferred : '',
    configuredModelIds: configuredModelIds(config)
  };
}

export async function modelsView(pool, config, {
  workspaceId = '',
  principalId = '',
  canManage = false
} = {}) {
  const selection = await resolveModelSelection(pool, config, { workspaceId, principalId });
  return {
    version: '1',
    allTiersShareModels: true,
    selectedModelId: selection.selectedModelId,
    workspaceDefaultModelId: selection.workspaceDefaultModelId || null,
    preferredModelId: selection.preferredModelId || null,
    canManage,
    models: publicModelCatalog(config, {
      enabledIds: selection.enabledModelIds,
      planIds: selection.planModelIds
    })
  };
}

export function validateModelChange({
  modelId,
  planModelIds,
  enabledModelIds,
  config
}) {
  const id = normalizeModelId(modelId);
  if (!id) return { ok: false, code: 'invalid-model', message: 'Choose one of the supported models.' };
  if (!planModelIds.includes(id)) return { ok: false, code: 'model-plan-forbidden', message: 'That model is not included in this plan.' };
  if (!enabledModelIds.includes(id)) return { ok: false, code: 'model-disabled', message: 'An administrator has disabled that model for this workspace.' };
  const resolved = resolveConfiguredModel(config, id);
  if (!resolved) return { ok: false, code: 'model-not-configured', message: 'That model is not configured on this deployment yet.' };
  return { ok: true, model: resolved };
}

export function adminModelSettings({ defaultModelId, enabledModelIds, planModelIds, config }) {
  const configured = new Set(configuredModelIds(config));
  const enabled = [...new Set((Array.isArray(enabledModelIds) ? enabledModelIds : []).map(normalizeModelId).filter(Boolean))]
    .filter(id => planModelIds.includes(id) && configured.has(id));
  if (!enabled.length) return { ok: false, code: 'no-models-enabled', message: 'At least one configured model must remain enabled.' };
  const requestedDefault = normalizeModelId(defaultModelId);
  const defaultModel = requestedDefault && enabled.includes(requestedDefault) ? requestedDefault : enabled[0];
  return { ok: true, defaultModel, enabledModels: enabled };
}

/**
 * The model one step runs on. A model the person or the workspace admin
 * chose is used as chosen. Otherwise the step goes to the tier that suits it
 * (a light check to Lite, hard code to Pro, images to Flash), but only among
 * the models the workspace's plan allows and an admin has enabled, and only
 * when policy allows it. Returns a "google:…" id, or `fallback`.
 */
export function modelForStep(selection, { run, task, effort, hasImages = false, fallback, allows = () => true }) {
  const explicit = selection?.preferredModelId || selection?.workspaceDefaultModelId;
  if (explicit || !selection) return fallback;
  const allowed = (selection.planModelIds ?? [])
    .filter(id => (selection.enabledModelIds ?? []).includes(id) && (selection.configuredModelIds ?? []).includes(id))
    .map(id => id.slice('google:'.length));
  const model = modelForTask({ taskType: task?.type, effort, scale: run?.adaptation?.scale, hasImages, configured: allowed });
  const id = model ? `google:${model}` : null;
  return id && allows(id) ? id : fallback;
}
