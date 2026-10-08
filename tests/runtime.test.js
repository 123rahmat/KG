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

test('a current-policy rejection prevents provider calls and token reservations', async () => {
  let requests = 0;
  let reservations = 0;
  const denial = Object.assign(new Error('Current policy denies this model'), { code: 'policy-blocked' });
  await assert.rejects(callModel([{ role: 'user', content: 'Hello' }], {
    config: base,
    modelId: 'google:gemini-3.8-flash',
    beforeCall: async ({ model }) => { assert.equal(model, 'gemini-3.8-flash'); throw denial; },
    fetchImpl: async () => { requests++; return response(); },
    usageGate: { reserve: async () => { reservations++; return null; } }
  }), error => error === denial);
  assert.equal(requests, 0);
  assert.equal(reservations, 0);
});

test('provider retries recheck policy after waiting and release their reservation', async () => {
  let revoked = false;
  let requests = 0;
  let released = false;
  const denial = Object.assign(new Error('Policy revoked'), { code: 'policy-blocked', status: 403, expose: true });
  await assert.rejects(callModel([{ role: 'user', content: 'Hello' }], {
    config: base, retries: 1, sleep: async () => { revoked = true; },
    beforeCall: async () => { if (revoked) throw denial; },
    fetchImpl: async () => { requests++; return new Response('{}', { status: 429 }); },
    usageGate: { reserve: async () => ({ id: 'reservation', estimatedTokens: 100 }), release: async () => { released = true; } }
  }), error => error === denial);
  assert.equal(requests, 1);
  assert.equal(released, true);
});

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

test('dispatch revalidates and shrinks queued token reservations before sending', async () => {
  let sentLimit; let revalidations = 0;
  await callModel([{ role: 'user', content: 'Hello' }], {
    config: base, retries: 0, maxOutputTokens: 1000,
    usageGate: {
      reserve: async () => ({ id: 'reservation', estimatedTokens: 1000 }),
      revalidate: async reservation => { revalidations++; assert.equal(reservation.id, 'reservation'); return { ...reservation, estimatedTokens: 64 }; },
      settle: async () => ({ recorded: true }), release: async () => {}
    },
    fetchImpl: async (_url, options) => { sentLimit = JSON.parse(options.body).generationConfig.maxOutputTokens; return response(); }
  });
  assert.equal(revalidations, 1);
  assert.equal(sentLimit, 64);
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


test('adaptive routing chooses the efficient model for low-pressure chat and explains the choice', async () => {
  let seenUrl = '';
  const answer = await callModel([{ role: 'user', content: 'Summarize this short note.' }], {
    config: base,
    effort: 'low',
    adaptiveContext: { complexity: 0.1, uncertainty: 0, risk: 'ordinary' },
    retries: 0,
    fetchImpl: async (url) => { seenUrl = url; return response('short summary'); }
  });
  assert.match(seenUrl, /gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(answer.model, 'gemini-3.5-flash-lite');
  assert.equal(answer.modelRouting.tier, 'efficient');
  assert.equal(answer.modelRouting.reason, 'minimum-sufficient-model');
});
