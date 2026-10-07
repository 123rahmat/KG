import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

const gemini = text => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 }
}), { status: 200, headers: { 'content-type': 'application/json' } });

const ENV = {
  AI_PROVIDER: 'google',
  GOOGLE_CLOUD_PROJECT: 'test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  VERTEX_ACCESS_TOKEN: 'test-token',
  AI_MODEL: 'gemini-3.8-flash'
};

test('model catalogue is Gemini-only, adaptive, and not user-selectable', () =>
  withServer(async ({ call, seed }) => {
    const admin = await seed({ role: 'admin' });
    const auth = { token: admin.token, workspace: admin.workspace };

    const view = await call('GET', '/api/models', auth);
    assert.equal(view.status, 200);
    assert.equal(view.body.provider, 'google-vertex-ai');
    assert.equal(view.body.family, 'Gemini');
    assert.equal(view.body.adaptive, true);
    assert.equal(view.body.userSelectable, false);
    assert.deepEqual(view.body.models.map(model => model.id), [
      'google:gemini-3.5-flash-lite',
      'google:gemini-3.8-flash'
    ]);

    const preference = await call('PUT', '/api/models/preference', {
      ...auth, body: { modelId: 'google:gemini-3.8-flash' }
    });
    assert.equal(preference.status, 404);

    const settings = await call('PUT', '/api/models/settings', {
      ...auth, body: { defaultModelId: 'google:gemini-3.8-flash' }
    });
    assert.equal(settings.status, 404);
  }, { env: ENV }));

test('when Vertex AI is rate-limited, the person is told so and nothing is recorded', () => {
  let limited = false;
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth,
      body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } }
    });
    limited = true;
    const busy = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(busy.status, 503);
    assert.equal(busy.body.code, 'model-rate-limited');
    assert.equal(busy.body.retryAfterSeconds, 30);
    assert.equal(busy.headers.get('retry-after'), '30');
    assert.match(busy.body.error, /nothing was recorded/i);
  }, {
    env: ENV,
    fetchImpl: async () => limited
      ? new Response(JSON.stringify({ error: { code: 429 } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' }
        })
      : gemini('ready')
  });
});

test('classifier and verification share the same Vertex Gemini runtime', () => {
  const calls = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth,
      body: { goal: 'What is the boiling point of water at sea level?', privacyConsent: { modelProvider: true } }
    });
    for (let i = 0; i < 6 && run.next; i += 1) {
      await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    }
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(url => /aiplatform\.googleapis\.com/.test(url)));
  }, {
    env: ENV,
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      const body = JSON.parse(options.body || '{}');
      const raw = [
        body.systemInstruction?.parts?.map(part => part.text).join(' ') || '',
        ...(body.contents || []).flatMap(item => item.parts || []).map(part => part.text || '')
      ].join(' ');
      if (/Classify/i.test(raw)) return gemini(JSON.stringify({
        actions: ['answer'],
        signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
        unknownSituation: false,
        confidence: 0.9,
        need: { deliverable: 'the boiling point', form: 'fact', depth: 'brief' }
      }));
      if (/verification|verify/i.test(raw)) return gemini(JSON.stringify({ verdict: 'pass', criteria: [], problems: [] }));
      return gemini('ready');
    }
  });
});
