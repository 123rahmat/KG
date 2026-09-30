import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../src/runtime.js';
import { discoverModels } from '../src/model-catalog.js';

const response = {
  candidates: [{ content: { parts: [{ text: 'ready' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
};

test('Vertex standard transport is used for Gemini calls', async () => {
  let seen;
  const answer = await callModel([{ role: 'user', content: 'ready?' }], {
    config: {
      ai: { provider: 'google', model: 'gemini-3.8-flash', apiKey: null, vertexProject: 'kindgleam-test', vertexLocation: 'global', vertexAccessToken: 'short-lived-test-token' },
      limits: { responseBytes: 1024 * 1024 }
    },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response(JSON.stringify(response), { status: 200 });
    },
    retries: 0
  });
  assert.match(seen.url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/kindgleam-test\/locations\/global\/publishers\/google\/models\/gemini-3\.8-flash:generateContent$/);
  assert.doesNotMatch(seen.url, /generativelanguage\.googleapis\.com/);
  assert.equal(seen.options.headers.authorization, 'Bearer short-lived-test-token');
  assert.equal(answer.text, 'ready');
  assert.deepEqual(answer.usage, { inputTokens: 3, outputTokens: 2 });
});

test('Vertex Express Mode stays on the Vertex endpoint for API-key development', async () => {
  let seen;
  const answer = await callModel([{ role: 'user', content: 'ready?' }], {
    config: {
      ai: { provider: 'google', model: 'gemini-3.8-flash', apiKey: 'vertex-express-key', vertexProject: null },
      limits: { responseBytes: 1024 * 1024 }
    },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response(JSON.stringify(response), { status: 200 });
    },
    retries: 0
  });
  assert.match(seen.url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(seen.options.headers['x-goog-api-key'], 'vertex-express-key');
  assert.equal(answer.text, 'ready');
});

test('model discovery never calls the Gemini Developer API', async () => {
  let calls = 0;
  const models = await discoverModels('unused', {
    fetchImpl: async () => { calls += 1; throw new Error('should not be called'); }
  });
  assert.deepEqual(models, []);
  assert.equal(calls, 0);
});


test('Gemini request history never ends with a prefilled model turn or empty turn', async () => {
  let body;
  await callModel([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'latest question' },
    { role: 'assistant', content: 'prefilled answer that must be trimmed' }
  ], {
    config: {
      ai: { provider: 'google', model: 'gemini-3.8-flash', apiKey: null, vertexProject: 'kindgleam-test', vertexLocation: 'global', vertexAccessToken: 'short-lived-test-token' },
      limits: { responseBytes: 1024 * 1024 }
    },
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify(response), { status: 200 });
    },
    retries: 0
  });
  assert.deepEqual(body.contents.map(turn => turn.role), ['user', 'model', 'user']);
  assert.equal(body.contents.at(-1).role, 'user');
});

test('a Vertex service-account deployment with no API key still resolves a model (no crash on missing key)', async () => {
  const { resolveConfiguredModel } = await import('../src/model-catalog.js');
  // Production on Google Cloud uses a workload identity: a project and no API key.
  const config = { ai: { provider: 'google', model: 'gemini-3.8-flash', apiKey: null, vertexProject: 'kindgleam-test', vertexLocation: 'global' } };
  const selected = resolveConfiguredModel(config, null);
  assert.ok(selected, 'a model is selected from the Vertex project alone');
  assert.equal(selected.apiKey, null);
  assert.equal(selected.vertexProject, 'kindgleam-test');
});

test('with neither an API key nor a Vertex project no model is selected', async () => {
  const { resolveConfiguredModel } = await import('../src/model-catalog.js');
  assert.equal(resolveConfiguredModel({ ai: { provider: 'google', model: 'gemini-3.8-flash', apiKey: null, vertexProject: null } }, null), null);
});
