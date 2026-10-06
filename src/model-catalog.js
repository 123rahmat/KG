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

export function modelForTask({ taskType = '', effort = '', adaptiveContext = {}, configured = [] } = {}) {
  const available = new Set((configured.length ? configured : [LIGHT_MODEL, DEFAULT_MODEL]).map(value => normalizeModelId(value).replace(/^google:/, '') || String(value)));
  const heavy = ['code', 'coding', 'research', 'investigate', 'verify', 'agent', 'multi-agent'].some(kind => String(taskType).toLowerCase().includes(kind))
    || adaptiveContext?.research === true
    || adaptiveContext?.code === true
    || ['medium', 'high', 'xhigh'].includes(String(effort).toLowerCase())
    || ['high', 'critical'].includes(String(adaptiveContext?.risk).toLowerCase());
  if (heavy && available.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
  if (available.has(LIGHT_MODEL)) return LIGHT_MODEL;
  return DEFAULT_MODEL;
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
  const id = normalizeModelId(modelId) || `google:${DEFAULT_MODEL}`;
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
