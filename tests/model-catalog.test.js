import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL, LIGHT_MODEL, MODEL_IDS, buildFallbackChain, discoverModels,
  modelCatalog, modelDecisionForTask, modelForTask, normalizeModelId, publicModelCatalog, resolveConfiguredModel
} from '../src/model-catalog.js';
import { loadConfig } from '../src/config.js';

const DB = { DATABASE_URL: 'postgres://user:pass@localhost:5432/kindgleam' };
const vertex = {
  ...DB,
  AI_PROVIDER: 'google',
  GOOGLE_CLOUD_PROJECT: 'test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  VERTEX_ACCESS_TOKEN: 'test-token',
  AI_MODEL: DEFAULT_MODEL
};

test('only the approved Vertex Gemini family is exposed', () => {
  assert.deepEqual(MODEL_IDS, ['google:gemini-3.5-flash-lite', 'google:gemini-3.8-flash']);
  assert.equal(normalizeModelId('google:gemini-3.8-flash'), 'google:gemini-3.8-flash');
  assert.equal(normalizeModelId('gemini-3.5-flash-lite'), 'google:gemini-3.5-flash-lite');
  for (const bad of ['unsupported:model-a', 'legacy:model-b', 'other:model-c', 'gemini-4']) {
    assert.equal(normalizeModelId(bad), '', bad);
  }
});

test('configuration exposes Gemini through Vertex without leaking credentials', () => {
  const config = loadConfig(vertex);
  assert.equal(config.ai.provider, 'google');
  assert.equal(config.ai.project, 'test-project');
  assert.equal(config.ai.model, DEFAULT_MODEL);
  assert.deepEqual(config.ai.models, [LIGHT_MODEL, DEFAULT_MODEL]);
  assert.deepEqual(modelCatalog(config).map(item => item.id), MODEL_IDS);
  assert.equal(resolveConfiguredModel(config, 'google:gemini-3.8-flash').model, DEFAULT_MODEL);
  assert.equal(resolveConfiguredModel(config, 'unsupported:model-a'), null);
  assert.equal(JSON.stringify(publicModelCatalog(config)).includes('test-token'), false);
});

test('other providers and unknown Gemini models are rejected', () => {
  assert.throws(() => loadConfig({ ...DB, AI_PROVIDER: 'unsupported', GOOGLE_CLOUD_PROJECT: 'p' }), /AI_PROVIDER must be google/);
  assert.throws(() => loadConfig({ ...vertex, AI_MODEL: 'gemini-4' }), /supported Gemini model/);
});

test('adaptive task selection uses Flash-Lite for light work and 3.8 Flash for deep work', () => {
  assert.equal(modelForTask({ taskType: 'classifier', effort: 'low' }), LIGHT_MODEL);
  assert.equal(modelForTask({ taskType: 'chat', effort: 'low' }), LIGHT_MODEL);
  assert.equal(modelForTask({ taskType: 'code', effort: 'high' }), DEFAULT_MODEL);
  assert.equal(modelForTask({ taskType: 'code', effort: 'low', adaptiveContext: { complexity: 0.1 } }), LIGHT_MODEL);
  assert.equal(modelForTask({ taskType: 'research', effort: 'low', adaptiveContext: { complexity: 0.1, uncertainty: 0.1 } }), LIGHT_MODEL);
  assert.equal(modelForTask({ taskType: 'code', effort: 'low', adaptiveContext: { complexity: 0.8 } }), DEFAULT_MODEL);
  assert.equal(modelForTask({ taskType: 'research', effort: 'low', adaptiveContext: { requiresVerification: true } }), DEFAULT_MODEL);
  assert.equal(modelForTask({ taskType: 'research', effort: 'medium' }), DEFAULT_MODEL);
  assert.equal(modelForTask({ taskType: 'chat', effort: 'medium', adaptiveContext: { complexity: 0.2 } }), LIGHT_MODEL);
  assert.equal(modelForTask({ taskType: 'chat', effort: 'medium', adaptiveContext: { uncertainty: 0.7 } }), DEFAULT_MODEL);
  assert.equal(modelForTask({ taskType: 'chat', effort: 'low', adaptiveContext: { failureCount: 1 } }), DEFAULT_MODEL);
  assert.equal(modelDecisionForTask({ taskType: 'chat', effort: 'low' }).reason, 'minimum-sufficient-model');
});

test('fallback stays inside the Gemini family and discovery never adds providers', async () => {
  assert.deepEqual(buildFallbackChain(DEFAULT_MODEL), ['google:gemini-3.5-flash-lite']);
  assert.deepEqual(buildFallbackChain(LIGHT_MODEL), []);
  assert.deepEqual(await discoverModels(), []);
});
