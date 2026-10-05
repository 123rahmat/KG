/** Grok-only model catalogue for the adaptive runtime. */
export const DEFAULT_MODEL = 'grok-4.7';
const GROK_MODEL = /^grok-4\\.7$/;
export const isGrokModel = value => GROK_MODEL.test(String(value ?? '').trim().toLowerCase());
const KNOWN = Object.freeze({
  'grok-4.7': { name: 'Grok 4.7', contextWindow: 500_000, tier: 'frontier', strengths: ['reasoning','coding','research','agents','vision'] }
});
export function modelTier() { return 'frontier'; }
export function modelForTask() { return DEFAULT_MODEL; }
export function modelCatalog() { return [Object.freeze({ id:'xai:grok-4.7', provider:'xai', model:DEFAULT_MODEL, name:KNOWN[DEFAULT_MODEL].name, family:'Grok', tier:'frontier', contextWindow:500_000, capabilities:['reasoning','coding','agents','research','vision','multimodal'], strengths:Object.freeze(KNOWN[DEFAULT_MODEL].strengths) })]; }
export const MODEL_CATALOG = Object.freeze(modelCatalog());
export const MODEL_IDS = Object.freeze(['xai:grok-4.7']);
export function normalizeModelId(value) { const id=String(value??'').trim().toLowerCase(); return id==='xai:grok-4.7'?'xai:grok-4.7':''; }
export function modelIdsForPlan() { return ['xai:grok-4.7']; }
export function catalogEntry(id) { return normalizeModelId(id)==='xai:grok-4.7'?MODEL_CATALOG[0]:null; }
export function configuredModelIds(config) { return config?.ai?.apiKey && config.ai.provider==='xai' ? ['xai:grok-4.7'] : []; }
export function resolveConfiguredModel(config, modelId='') { if(config?.ai?.provider!=='xai' || !String(config?.ai?.apiKey??'').trim()) return null; const id=normalizeModelId(modelId)||'xai:grok-4.7'; return id==='xai:grok-4.7'?{...MODEL_CATALOG[0],apiKey:config.ai.apiKey,model:DEFAULT_MODEL}:null; }
export function publicModelCatalog(config) { const configured=Boolean(config?.ai?.provider==='xai'&&config?.ai?.apiKey); return MODEL_CATALOG.map(item=>({...item,capabilities:[...item.capabilities],strengths:[...item.strengths],configured,enabled:configured,allowedByPlan:configured,isDefault:true})); }
export async function discoverModels() { return []; }
export function buildFallbackChain() { return []; }
