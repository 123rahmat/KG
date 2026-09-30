/**
 * Provider/model catalogue for the adaptive model router.
 *
 * Google Gemini is the sole AI provider and is transported only through Vertex AI / Gemini Enterprise Agent Platform.
 *
 * The operator lists the Gemini models this deployment offers (AI_MODELS,
 * with Gemini 3.8 Flash first). The runtime never calls the Gemini Developer
 * API; model calls go through Vertex AI.
 */


/** The model a deployment uses unless the operator names another (AI_MODEL). */
export const DEFAULT_MODEL = 'gemini-3.8-flash';
const GEMINI_MODEL = /^gemini-[a-z0-9][a-z0-9.-]{0,60}$/;

/** A Gemini API model id, such as gemini-3.8-flash or gemini-3.1-pro. */
export const isGeminiModel = value => GEMINI_MODEL.test(String(value ?? ''));

// What is known about particular models: context window, tier and strengths.
// tier: 'pro' (strongest reasoning), 'flash' (balanced), 'lite' (fast/cheap).
// strengths: which job types the model handles best.
const KNOWN = {
  'gemini-2.5-pro':        { name: 'Gemini 2.5 Pro',        contextWindow: 1_048_576, tier: 'pro',   strengths: ['reasoning', 'coding', 'complex', 'vision'] },
  'gemini-3.1-pro-preview':{ name: 'Gemini 3.1 Pro Preview', contextWindow: 1_048_576, tier: 'pro',   strengths: ['reasoning', 'coding', 'complex', 'vision'] },
  'gemini-3.8-flash':      { name: 'Gemini 3.8 Flash',      contextWindow: 1_048_576, tier: 'flash', strengths: ['coding', 'reasoning', 'research', 'vision'] },
  'gemini-3.7-flash':      { name: 'Gemini 3.7 Flash',      contextWindow: 1_048_576, tier: 'flash', strengths: ['coding', 'reasoning', 'research', 'vision'] },
  'gemini-3.6-flash':      { name: 'Gemini 3.6 Flash',      contextWindow: 1_048_576, tier: 'flash', strengths: ['coding', 'reasoning', 'research', 'vision'] },
  'gemini-3.5-flash':      { name: 'Gemini 3.5 Flash',      contextWindow: 1_048_576, tier: 'flash', strengths: ['coding', 'reasoning', 'research', 'vision'] },
  'gemini-2.5-flash':      { name: 'Gemini 2.5 Flash',      contextWindow: 1_048_576, tier: 'flash', strengths: ['coding', 'reasoning', 'research', 'vision'] },
  'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash Lite', contextWindow: 1_048_576, tier: 'lite',  strengths: ['classify', 'summarise', 'simple'] },
  'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash Lite', contextWindow: 1_048_576, tier: 'lite',  strengths: ['classify', 'summarise', 'simple'] },
  'gemini-2.5-flash-lite': { name: 'Gemini 2.5 Flash Lite', contextWindow: 1_048_576, tier: 'lite',  strengths: ['classify', 'summarise', 'simple'] }
};
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const CAPABILITIES = Object.freeze(['reasoning', 'coding', 'agents', 'research', 'vision', 'computer-use', 'multimodal']);

/** The tier of a model: 'pro', 'flash' or 'lite'. */
export function modelTier(model) {
  if (KNOWN[model]?.tier) return KNOWN[model].tier;
  const id = String(model ?? '').toLowerCase();
  if (id.includes('-pro')) return 'pro';
  if (id.includes('-lite')) return 'lite';
  return 'flash';
}

/**
 * Pick the best model for a task from the configured list.
 *
 * Strategy:
 *   - complex reasoning, multi-file code, verification of hard tasks → pro
 *   - standard code, research, normal chat, vision/images → flash (default)
 *   - classification, simple summarisation, crisis fallback → lite
 *
 * Returns the model id string, or null when no configured model fits.
 */
export function modelForTask({ taskType, effort, scale, hasImages, configured }) {
  const models = Array.isArray(configured) ? configured.filter(isGeminiModel) : [];
  if (!models.length) return null;

  const tiers = new Map();
  for (const m of models) {
    const t = modelTier(m);
    if (!tiers.has(t)) tiers.set(t, m);
  }

  const pick = tier => tiers.get(tier) ?? null;
  const flash = () => pick('flash') ?? pick('pro') ?? pick('lite');

  if (effort === 'low' && !hasImages) return pick('lite') ?? flash();

  if (scale === 'complex' || scale === 'advanced' || effort === 'high') {
    if (['code', 'verify', 'prototype'].includes(taskType)) return pick('pro') ?? flash();
  }

  if (hasImages) return pick('flash') ?? pick('pro');

  if (['understand', 'classify', 'reassess'].includes(taskType) && effort !== 'high') {
    return pick('lite') ?? flash();
  }

  return flash();
}

/** "gemini-3.1-pro" → "Gemini 3.1 Pro". */
const displayName = model => model.split('-').map(part => (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1))).join(' ');

function entryFor(model) {
  return Object.freeze({
    id: `google:${model}`,
    provider: 'google',
    model,
    name: KNOWN[model]?.name ?? displayName(model),
    family: 'Google',
    tier: modelTier(model),
    contextWindow: KNOWN[model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    capabilities: CAPABILITIES,
    strengths: Object.freeze(KNOWN[model]?.strengths ?? [])
  });
}

/**
 * The models this deployment offers: the operator's AI_MODELS list (the
 * default model first). Workspace administrators choose among these.
 */
export function modelCatalog(config) {
  const models = Array.isArray(config?.ai?.models) && config.ai.models.length ? config.ai.models : [config?.ai?.model || DEFAULT_MODEL];
  return [...new Set(models.filter(isGeminiModel))].map(entryFor);
}

/** The catalogue of a deployment with no model list: the default model. */
export const MODEL_CATALOG = Object.freeze([entryFor(DEFAULT_MODEL)]);
export const MODEL_IDS = Object.freeze(MODEL_CATALOG.map(item => item.id));

/** A well-formed Gemini model id ("google:gemini-…"), or '' for anything else. */
export function normalizeModelId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return id.startsWith('google:') && isGeminiModel(id.slice(7)) ? id : '';
}

/**
 * The models a plan may use: the plan's own list when it has one (a paid
 * plan may add a Pro model), otherwise every model the deployment offers.
 */
export function modelIdsForPlan(plan, config) {
  const offered = modelCatalog(config).map(item => item.id);
  const own = Array.isArray(plan?.modelIds) ? plan.modelIds.map(normalizeModelId).filter(id => offered.includes(id)) : [];
  return own.length ? own : offered;
}

export function catalogEntry(modelId, config) {
  const id = normalizeModelId(modelId);
  return modelCatalog(config).find(item => item.id === id) ?? null;
}

function configuredProviderModels(config) {
  const entries = config?.ai?.providers;
  if (entries && typeof entries === 'object') return entries;
  if (config?.ai?.provider && config?.ai?.apiKey) {
    return {
      [config.ai.provider]: {
        apiKey: config.ai.apiKey,
        model: config.ai.model || null
      }
    };
  }
  return {};
}

export function configuredModelIds(config) {
  const providers = configuredProviderModels(config);
  return modelCatalog(config)
    .filter(item => String(providers[item.provider]?.apiKey ?? '').trim() || (item.provider === 'google' && String(config?.ai?.vertexProject ?? '').trim()))
    .map(item => item.id);
}

export function resolveConfiguredModel(config, modelId = '') {
  const id = normalizeModelId(modelId);
  const entry = catalogEntry(id, config);
  const providers = configuredProviderModels(config);
  if (entry) {
    const connection = providers[entry.provider];
    if (connection?.apiKey || (entry.provider === 'google' && config?.ai?.vertexProject)) {
      return {
        ...entry,
        apiKey: connection?.apiKey || null,
        model: entry.model,
        vertexProject: config?.ai?.vertexProject || null,
        vertexLocation: config?.ai?.vertexLocation || 'global'
      };
    }
  }

  const fallbackId = normalizeModelId(config?.ai?.modelId)
    || configuredModelIds(config)[0]
    || (config?.ai?.provider ? `${config.ai.provider}:${config.ai.model || ''}` : '');
  const fallback = catalogEntry(fallbackId, config);
  if (!fallback) return null;
  const connection = providers[fallback.provider];
  if (!connection?.apiKey && !(fallback.provider === 'google' && config?.ai?.vertexProject)) return null;
  return {
    ...fallback,
    apiKey: connection?.apiKey || null,
    model: fallback.model,
    vertexProject: config?.ai?.vertexProject || null,
    vertexLocation: config?.ai?.vertexLocation || 'global'
  };
}

export function publicModelCatalog(config, { enabledIds = null, planIds = null } = {}) {
  const catalog = modelCatalog(config);
  const all = catalog.map(item => item.id);
  const configured = new Set(configuredModelIds(config));
  const enabled = new Set(enabledIds ?? all);
  const plan = new Set(planIds ?? all);
  return catalog.map(item => ({
    id: item.id,
    provider: item.provider,
    model: item.model,
    name: item.name,
    family: item.family,
    tier: item.tier,
    contextWindow: item.contextWindow,
    capabilities: [...item.capabilities],
    strengths: [...item.strengths],
    configured: configured.has(item.id),
    enabled: enabled.has(item.id),
    allowedByPlan: plan.has(item.id),
    isDefault: item.model === (config?.ai?.model || DEFAULT_MODEL)
  }));
}

// ── Auto-discovery ────────────────────────────────────────────────────

/**
 * Probe the Gemini API for all models the key can reach, return them
 * sorted newest-first within each tier. Skips TTS, image-gen, embedding,
 * transcription, omni and preview models (preview sorts after stable).
 */
export async function discoverModels() {
  // Vertex is the only model transport; never probe generativelanguage.googleapis.com.
  return [];
}

/**
 * The backups for `primary`, best first: the same tier (newest first), then
 * the tiers below. Pro is a backup only for a Pro model, since that is the
 * tier a plan pays for. With a `limit`, a couple of places are kept for the
 * next tier down, so an overload of one whole tier still has somewhere to go.
 */
export function buildFallbackChain(primary, allModels, { limit = Infinity } = {}) {
  const all = (Array.isArray(allModels) ? allModels : []).filter(isGeminiModel);
  if (!all.length) return [];
  const tiers = { pro: [], flash: [], lite: [] };
  for (const m of all) {
    const t = modelTier(m);
    if (tiers[t] && m !== primary) tiers[t].push(m);
  }
  const primaryTier = modelTier(primary);
  const order = primaryTier === 'pro' ? ['pro', 'flash', 'lite']
    : primaryTier === 'lite' ? ['lite', 'flash']
      : ['flash', 'lite'];
  const same = tiers[order[0]];
  const lower = order.slice(1).flatMap(t => tiers[t]);
  if (!Number.isFinite(limit)) return [...same, ...lower];
  const reserve = Math.min(2, lower.length, limit);
  const head = same.slice(0, limit - reserve);
  const rest = [...same.slice(head.length), ...lower.slice(reserve)];
  return [...head, ...lower.slice(0, reserve), ...rest].slice(0, limit);
}
