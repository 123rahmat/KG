import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_IDS, modelCatalog, modelIdsForPlan, normalizeModelId, publicModelCatalog, resolveConfiguredModel, modelTier, modelForTask, discoverModels, buildFallbackChain } from '../src/model-catalog.js';
import { loadConfig } from '../src/config.js';

const DB = { DATABASE_URL: 'postgres://user:pass@localhost:5432/kindgleam' };

test('Gemini 3.8 Flash is the default; any Gemini model id is well formed, nothing else is', () => {
  assert.deepEqual(MODEL_IDS, ['google:gemini-3.8-flash']);
  assert.equal(normalizeModelId('google:gemini-3.8-flash'), 'google:gemini-3.8-flash');
  assert.equal(normalizeModelId(' Google:Gemini-3.1-Pro '), 'google:gemini-3.1-pro');
  for (const bad of ['anthropic:claude-opus-5-5', 'openai:gpt-6', 'google:palm-2', 'google:gemini-', 'gemini-3.8-flash', 'google:gemini-3.8-flash; drop']) {
    assert.equal(normalizeModelId(bad), '', bad);
  }
});

test('the operator lists the models admins may choose from; the default comes first', () => {
  const config = loadConfig({ ...DB, AI_PROVIDER: 'google', AI_API_KEY: 'secret', AI_MODELS: 'gemini-3.1-pro, gemini-3.5-flash-lite,gemini-3.8-flash' });
  assert.deepEqual(config.ai.models, ['gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-3.5-flash-lite']);
  assert.deepEqual(modelCatalog(config).map(item => item.name), ['Gemini 3.8 Flash', 'Gemini 3.1 Pro', 'Gemini 3.5 Flash Lite']);
  const view = publicModelCatalog(config);
  assert.deepEqual(view.map(item => [item.id, item.configured, item.isDefault]), [
    ['google:gemini-3.8-flash', true, true], ['google:gemini-3.1-pro', true, false], ['google:gemini-3.5-flash-lite', true, false]
  ]);
  assert.equal(JSON.stringify(view).includes('secret'), false, 'the API key is never exposed');
  // A chosen model resolves to its own model name; an unlisted one falls back to the default.
  assert.equal(resolveConfiguredModel(config, 'google:gemini-3.1-pro').model, 'gemini-3.1-pro');
  assert.equal(resolveConfiguredModel(config, 'google:gemini-9-ultra').model, 'gemini-3.8-flash');
});

test('a successor model can be the default without a code change; malformed names are refused at boot', () => {
  const config = loadConfig({ ...DB, AI_PROVIDER: 'google', AI_API_KEY: 'k', AI_MODEL: 'gemini-3.9-flash' });
  assert.equal(config.ai.model, 'gemini-3.9-flash');
  assert.deepEqual(config.ai.models, ['gemini-3.9-flash']);
  assert.throws(() => loadConfig({ ...DB, AI_PROVIDER: 'google', AI_API_KEY: 'k', AI_MODEL: 'claude-opus-5-5' }), /AI_MODEL must be a Gemini model id/);
  assert.throws(() => loadConfig({ ...DB, AI_PROVIDER: 'google', AI_API_KEY: 'k', AI_MODELS: 'gemini-3.1-pro,gpt-6' }), /AI_MODELS lists "gpt-6"/);
  const json = loadConfig({ ...DB, AI_PROVIDERS_JSON: JSON.stringify({ google: { apiKey: 'k', model: 'gemini-3.1-pro' } }) });
  assert.equal(json.ai.model, 'gemini-3.1-pro');
});

test('plans may name their own models; otherwise every offered model is included', () => {
  const config = loadConfig({ ...DB, AI_PROVIDER: 'google', AI_API_KEY: 'k', AI_MODELS: 'gemini-3.1-pro' });
  assert.deepEqual(modelIdsForPlan({ id: 'free' }, config), ['google:gemini-3.8-flash', 'google:gemini-3.1-pro']);
  assert.deepEqual(modelIdsForPlan({ id: 'free', modelIds: ['google:gemini-3.8-flash'] }, config), ['google:gemini-3.8-flash']);
  // A plan naming only models the deployment does not offer gets the offered ones.
  assert.deepEqual(modelIdsForPlan({ id: 'x', modelIds: ['anthropic:claude-opus-5-5'] }, config), ['google:gemini-3.8-flash', 'google:gemini-3.1-pro']);
});

test('modelTier returns the correct tier for known and unknown models', () => {
  assert.equal(modelTier('gemini-2.5-pro'), 'pro');
  assert.equal(modelTier('gemini-3.1-pro-preview'), 'pro');
  assert.equal(modelTier('gemini-3.8-flash'), 'flash');
  assert.equal(modelTier('gemini-3.5-flash-lite'), 'lite');
  assert.equal(modelTier('gemini-99-pro'), 'pro');
  assert.equal(modelTier('gemini-99-flash-lite'), 'lite');
  assert.equal(modelTier('gemini-99-flash'), 'flash');
  assert.equal(modelTier(null), 'flash');
});

test('modelForTask picks the right tier based on task type, effort, scale, and images', () => {
  const configured = ['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

  assert.equal(modelTier(modelForTask({ taskType: 'classify', effort: 'low', configured })), 'lite');
  assert.equal(modelTier(modelForTask({ taskType: 'code', effort: 'high', scale: 'complex', configured })), 'pro');
  assert.equal(modelTier(modelForTask({ taskType: 'verify', scale: 'advanced', configured })), 'pro');
  assert.equal(modelTier(modelForTask({ taskType: 'chat', hasImages: true, configured })), 'flash');
  assert.equal(modelTier(modelForTask({ taskType: 'understand', effort: 'medium', configured })), 'lite');
  assert.equal(modelTier(modelForTask({ taskType: 'chat', effort: 'medium', configured })), 'flash');
  assert.equal(modelForTask({ configured: [] }), null);
  assert.equal(modelForTask({ configured: ['not-a-model'] }), null);
});

test('backups: the same tier first, then cheaper tiers; Pro only backs up Pro', () => {
  const all = ['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'];

  const flashChain = buildFallbackChain('gemini-3.8-flash', all);
  assert.deepEqual(flashChain, ['gemini-3.7-flash', 'gemini-3.5-flash-lite'], 'no Pro for a Flash model');

  const proChain = buildFallbackChain('gemini-2.5-pro', all);
  assert.deepEqual(proChain, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite']);

  // A long same-tier list still keeps places for the tier below, so an
  // overload of every Flash model has somewhere to go.
  const flashes = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  const limited = buildFallbackChain('gemini-3.8-flash', [...flashes, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], { limit: 6 });
  assert.equal(limited.length, 6);
  assert.deepEqual(limited.slice(4), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);

  assert.deepEqual(buildFallbackChain('gemini-3.8-flash', []), []);
});

test('model discovery is disabled; only operator-configured Gemini models are eligible', async () => {
  const fetchImpl = async () => { throw new Error('model discovery must never call an upstream API'); };
  assert.deepEqual(await discoverModels('unused', { fetchImpl }), []);
  assert.deepEqual(buildFallbackChain('gemini-3.8-flash', ['gemini-3.7-flash', 'gemini-3.5-flash-lite']), [
    'gemini-3.7-flash', 'gemini-3.5-flash-lite'
  ]);
});

test('each step goes to the tier that suits it, only among models the plan allows, unless someone chose one', async () => {
  const { modelForStep } = await import('../src/model-routing.js');
  const all = ['google:gemini-3.8-flash', 'google:gemini-2.5-pro', 'google:gemini-3.5-flash-lite'];
  const selection = { planModelIds: all, enabledModelIds: all, configuredModelIds: all, preferredModelId: '', workspaceDefaultModelId: '' };
  const fallback = 'google:gemini-3.8-flash';
  const hardCode = { run: { adaptation: { scale: 'complex' } }, task: { type: 'code' }, effort: 'high', fallback };

  assert.equal(modelForStep(selection, hardCode), 'google:gemini-2.5-pro');
  assert.equal(modelForStep(selection, { run: {}, task: { type: 'classify' }, effort: 'low', fallback }), 'google:gemini-3.5-flash-lite');
  assert.equal(modelForStep(selection, { run: {}, task: { type: 'respond' }, effort: 'low', hasImages: true, fallback }), 'google:gemini-3.8-flash');
  // A plan without Pro never reaches it, and a model an admin disabled is never used.
  assert.equal(modelForStep({ ...selection, planModelIds: [all[0], all[2]] }, hardCode), 'google:gemini-3.8-flash');
  assert.equal(modelForStep({ ...selection, enabledModelIds: [all[0]] }, hardCode), 'google:gemini-3.8-flash');
  // A person's or admin's choice wins; so does a policy that refuses the routed model.
  assert.equal(modelForStep({ ...selection, preferredModelId: all[2] }, hardCode), fallback);
  assert.equal(modelForStep({ ...selection, workspaceDefaultModelId: all[0] }, hardCode), fallback);
  assert.equal(modelForStep(selection, { ...hardCode, allows: id => !id.includes('pro') }), fallback);
});
