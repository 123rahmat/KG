/** Gemini-family model catalogue for the adaptive Vertex AI runtime. */
export const LIGHT_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const MODEL_IDS = Object.freeze([`google:${LIGHT_MODEL}`, `google:${DEFAULT_MODEL}`]);

const KNOWN = Object.freeze({
  [LIGHT_MODEL]: Object.freeze({
    name: 'Gemini 3.5 Flash-Lite',
    tier: 'efficient',
    contextWindow: 1_048_576,
    strengths: Object.freeze(['chat', 'classification', 'summarization', 'high-throughput'])
  }),
  [DEFAULT_MODEL]: Object.freeze({
    name: 'Gemini 3.8 Flash',
    tier: 'frontier',
    contextWindow: 1_048_576,
    strengths: Object.freeze(['reasoning', 'coding', 'research', 'agents', 'vision'])
  })
});

export const isGeminiModel = value => Object.hasOwn(KNOWN, String(value ?? '').trim().toLowerCase());

function entry(model) {
  const item = KNOWN[model];
  return Object.freeze({
    id: `google:${model}`,
    provider: 'google',
    model,
    name: item.name,
    family: 'Gemini',
    tier: item.tier,
    contextWindow: item.contextWindow,
    capabilities: Object.freeze(['reasoning', 'coding', 'agents', 'research', 'vision', 'multimodal']),
    strengths: item.strengths
  });
}

const CATALOG_LIST = Object.freeze([entry(LIGHT_MODEL), entry(DEFAULT_MODEL)]);
const CATALOG_DATA = Object.freeze(Object.fromEntries(CATALOG_LIST.map(item => [item.id, item])));
const compat = { ...CATALOG_DATA };
Object.defineProperty(compat, 'map', { enumerable: false, value: callback => CATALOG_LIST.map(callback) });
Object.defineProperty(compat, 'length', { enumerable: false, value: CATALOG_LIST.length });
for (const [index, item] of CATALOG_LIST.entries()) {
  Object.defineProperty(compat, String(index), { enumerable: false, value: item });
}
export const MODEL_CATALOG = Object.freeze(compat);

export function modelCatalog() {
  return CATALOG_LIST.map(item => ({ ...item, capabilities: [...item.capabilities], strengths: [...item.strengths] }));
}

export function normalizeModelId(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (MODEL_IDS.includes(raw)) return raw;
  if (isGeminiModel(raw)) return `google:${raw}`;
  return '';
}

export function modelTier(model = DEFAULT_MODEL) {
  return KNOWN[model]?.tier ?? KNOWN[DEFAULT_MODEL].tier;
}

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

export function modelDecisionForTask({ taskType = '', effort = '', adaptiveContext = {}, configured = [] } = {}) {
  const available = new Set((configured.length ? configured : [LIGHT_MODEL, DEFAULT_MODEL])
    .map(value => normalizeModelId(value).replace(/^google:/, '') || String(value)));
  const task = String(taskType).toLowerCase();
  const requestedEffort = String(effort).toLowerCase();
  const risk = String(adaptiveContext?.risk ?? '').toLowerCase();
  const complexity = clamp01(adaptiveContext?.complexity);
  const uncertainty = clamp01(adaptiveContext?.uncertainty);
  const qualityGap = clamp01(adaptiveContext?.qualityGap ?? adaptiveContext?.verificationGap);
  const failures = Math.max(0, Number(adaptiveContext?.failureCount ?? adaptiveContext?.failedAttempts) || 0);
  const remainingBudgetRatio = adaptiveContext?.remainingBudgetRatio == null
    ? 1
    : clamp01(adaptiveContext.remainingBudgetRatio);
  const specialized = ['code', 'coding', 'research', 'investigate', 'verify', 'review', 'agent', 'multi-agent']
    .some(kind => task.includes(kind));
  const highRisk = ['high', 'critical', 'high-impact', 'physical', 'regulated'].includes(risk);
  // Cheap independent coordination/classification should not be upgraded
  // solely because it belongs to a Code or Research run. Critical work and
  // recovery still use the stronger model, even if a caller asks for low effort.
  const lightSpecialistStep = requestedEffort === 'low'
    && complexity < 0.45 && uncertainty < 0.45 && qualityGap < 0.2
    && !highRisk && failures === 0 && adaptiveContext?.requiresVerification !== true;
  const hardQualityNeed = (specialized && !lightSpecialistStep)
    || ((adaptiveContext?.research === true || adaptiveContext?.code === true)
      && !lightSpecialistStep)
    || ['high', 'xhigh'].includes(requestedEffort)
    || highRisk
    || failures > 0
    || qualityGap >= 0.35;
  const mediumNeed = requestedEffort === 'medium'
    && (complexity >= (remainingBudgetRatio < 0.2 ? 0.7 : 0.45)
      || uncertainty >= 0.5
      || qualityGap >= 0.2);
  const frontier = hardQualityNeed || mediumNeed;

  if (frontier && available.has(DEFAULT_MODEL)) {
    const reason = specialized ? 'specialized-task'
      : highRisk ? 'risk-requires-quality'
        : failures > 0 ? 'recovery-after-failure'
          : qualityGap >= 0.35 ? 'verification-gap'
            : ['high', 'xhigh'].includes(requestedEffort) ? 'high-reasoning'
              : 'adaptive-complexity';
    return {
      model: DEFAULT_MODEL,
      tier: 'frontier',
      reason,
      qualityProtected: true,
      budgetConstrained: remainingBudgetRatio < 0.2
    };
  }
  if (available.has(LIGHT_MODEL)) {
    return {
      model: LIGHT_MODEL,
      tier: 'efficient',
      reason: frontier ? 'frontier-unavailable' : 'minimum-sufficient-model',
      qualityProtected: !frontier,
      budgetConstrained: remainingBudgetRatio < 0.2
    };
  }
  return {
    model: DEFAULT_MODEL,
    tier: 'frontier',
    reason: 'only-configured-model',
    qualityProtected: true,
    budgetConstrained: remainingBudgetRatio < 0.2
  };
}

export function modelForTask(options = {}) {
  return modelDecisionForTask(options).model;
}

export function modelIdsForPlan() {
  return [...MODEL_IDS];
}

export function catalogEntry(id) {
  return CATALOG_DATA[normalizeModelId(id)] ?? null;
}

function vertexConfigured(config) {
  return Boolean(config?.ai?.provider === 'google' && String(config?.ai?.project ?? '').trim());
}

export function configuredModelIds(config) {
  return vertexConfigured(config) ? [...MODEL_IDS] : [];
}

export function resolveConfiguredModel(config, modelId = '') {
  if (!vertexConfigured(config)) return null;
  const raw = String(modelId ?? '').trim();
  const id = raw ? normalizeModelId(raw) : `google:${DEFAULT_MODEL}`;
  if (!id) return null;
  const base = CATALOG_DATA[id];
  if (!base) return null;
  return {
    ...base,
    project: config.ai.project,
    location: config.ai.location || 'global',
    accessToken: config.ai.accessToken || null
  };
}

export function publicModelCatalog(config) {
  const configured = vertexConfigured(config);
  return CATALOG_LIST.map(item => ({
    ...item,
    capabilities: [...item.capabilities],
    strengths: [...item.strengths],
    configured,
    enabled: configured,
    allowedByPlan: configured,
    isDefault: item.model === DEFAULT_MODEL,
    adaptiveRole: item.model === LIGHT_MODEL ? 'lightweight' : 'complex'
  }));
}

export async function discoverModels() {
  return [];
}

export function buildFallbackChain(model = DEFAULT_MODEL) {
  const id = normalizeModelId(model);
  return id === `google:${DEFAULT_MODEL}` ? [`google:${LIGHT_MODEL}`] : [];
}
