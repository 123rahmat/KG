import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel, effectiveEffort, ModelProviderError, retryAfterMs } from '../src/runtime.js';

const base = {
  limits: { responseBytes: 1024 * 1024 },
  providerConcurrency: {},
  ai: {
    provider: 'google',
    project: 'test-project',
    location: 'global',
    accessToken: 'token',
    model: 'gemini-3.8-flash',
    modelId: 'google:gemini-3.8-flash',
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
    effort: 'high'
  }
};
const response = (text = 'ready') => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1 }
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('Vertex generateContent transport and usage are parsed correctly', async () => {
  let seen;
  const answer = await callModel([
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'ready?' }
  ], {
    config: base,
    modelId: 'google:gemini-3.8-flash',
    fetchImpl: async (url, options) => { seen = { url, options }; return response(); },
    retries: 0
  });
  assert.match(seen.url, /aiplatform\.googleapis\.com\/v1\/projects\/test-project\/locations\/global\/publishers\/google\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(seen.options.headers.authorization, 'Bearer token');
  const body = JSON.parse(seen.options.body);
  assert.equal(body.systemInstruction.parts[0].text, 'Be concise.');
  assert.equal(body.contents[0].role, 'user');
  assert.equal(answer.text, 'ready');
  assert.equal(answer.provider, 'google');
  assert.deepEqual(answer.usage, { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 });
});

test('adaptive reasoning clamps xhigh to Vertex HIGH', () => {
  assert.equal(effectiveEffort('low', 'high'), 'low');
  assert.equal(effectiveEffort('xhigh', 'high'), 'high');
  assert.equal(effectiveEffort('xhigh', 'xhigh'), 'high');
  assert.equal(effectiveEffort(null, null), 'high');
});

test('web search throttling never silently falls back to ungrounded inference', async () => {
  const searched = [];
  await assert.rejects(callModel([{ role: 'user', content: 'latest facts' }], {
    config: base,
    modelId: 'google:gemini-3.8-flash',
    webSearch: true,
    retries: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      searched.push(Boolean(body.tools));
      return searched.at(-1)
        ? new Response(JSON.stringify({ error: 'quota' }), { status: 429 })
        : response('fallback answer');
    }
  }), { code: 'model-rate-limited' });
  assert.deepEqual(searched, [true]);
});

test('upstream auth and malformed responses remain explicit failures', async () => {
  await assert.rejects(
    callModel([{ role: 'user', content: 'x' }], {
      config: base, modelId: 'google:gemini-3.8-flash', retries: 0,
      fetchImpl: async () => new Response('{}', { status: 403 })
    }),
    error => error instanceof ModelProviderError && error.code === 'model-not-authorized'
  );
  const malformed = await callModel([{ role: 'user', content: 'x' }], {
    config: base, modelId: 'google:gemini-3.8-flash', retries: 0,
    fetchImpl: async () => new Response('not-json', { status: 200 })
  });
  assert.equal(malformed.incomplete, 'invalid-provider-response');
});

test('retry-after is parsed without provider-specific assumptions', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' })), 2000);
  assert.equal(retryAfterMs(new Headers()), null);
});
