import {
  DEFAULT_MODEL,
  MODEL_IDS,
  configuredModelIds,
  modelForTask,
  normalizeModelId,
  publicModelCatalog,
  resolveConfiguredModel
} from './model-catalog.js';

/**
 * Model routing is server-owned and adaptive.
 *
 * There is deliberately no per-user or per-workspace model preference. The
 * approved Gemini family is configured by deployment, then the adaptive
 * controller chooses the least expensive sufficient model for each task.
 */
export async function workspaceModelSettings() {
  return {
    defaultModel: `google:${DEFAULT_MODEL}`,
    enabledModels: [...MODEL_IDS],
    adaptive: true,
    userSelectable: false
  };
}

export async function planModelIds() {
  return [...MODEL_IDS];
}

export async function resolveModelSelection(_pool, config) {
  const configured = configuredModelIds(config);
  const selectedModelId = configured.includes(`google:${DEFAULT_MODEL}`)
    ? `google:${DEFAULT_MODEL}`
    : configured[0] || null;

  return {
    selectedModelId,
    selected: selectedModelId ? resolveConfiguredModel(config, selectedModelId) : null,
    planModelIds: configured,
    enabledModelIds: configured,
    workspaceDefaultModelId: null,
    preferredModelId: null,
    configuredModelIds: configured,
    adaptive: true,
    userSelectable: false
  };
}

export async function modelsView(pool, config) {
  const selection = await resolveModelSelection(pool, config);
  return {
    version: '4',
    provider: 'google-vertex-ai',
    family: 'Gemini',
    adaptive: true,
    userSelectable: false,
    selectedModelId: selection.selectedModelId,
    models: publicModelCatalog(config)
  };
}

export function modelForStep(selection, { fallback = null, taskType = '', effort = '', adaptiveContext = {} } = {}) {
  const enabled = selection?.enabledModelIds?.length
    ? selection.enabledModelIds
    : selection?.configuredModelIds ?? [];
  const configured = enabled.map(id => id.replace(/^google:/, ''));
  const chosen = modelForTask({ taskType, effort, adaptiveContext, configured });
  const chosenId = normalizeModelId(chosen);
  if (chosenId && enabled.includes(chosenId)) return chosenId;
  return selection?.selectedModelId || normalizeModelId(fallback) || `google:${DEFAULT_MODEL}`;
}
