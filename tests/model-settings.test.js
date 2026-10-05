import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';

const grok = text => jsonResponse({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 3, output_tokens: 2 }
});

test('the model settings surface exposes one Grok model consistently', () => {
  return withServer(async ({ call, seed }) => {
    const admin = await seed({ role: 'admin' });
    const member = await seed({ workspace: admin.workspace, role: 'editor', name: 'Member' });
    const auth = { token: admin.token, workspace: admin.workspace };

    const before = await call('GET', '/api/models', auth);
    assert.equal(before.status, 200);
    assert.equal(before.body.canManage, true);
    assert.equal(before.body.selectedModelId, 'xai:grok-4.7');
    assert.deepEqual(before.body.models.map(model => model.id), ['xai:grok-4.7']);

    const denied = await call('PUT', '/api/models/settings', {
      token: member.token,
      workspace: admin.workspace,
      body: { defaultModelId: 'xai:grok-4.7', enabledModelIds: ['xai:grok-4.7'] }
    });
    assert.equal(denied.status, 403);

    const switched = await call('PUT', '/api/models/settings', {
      ...auth,
      body: { defaultModelId: 'xai:grok-4.7', enabledModelIds: ['xai:grok-4.7'] }
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.selectedModelId, 'xai:grok-4.7');

    const invalid = await call('PUT', '/api/models/settings', {
      ...auth,
      body: { defaultModelId: 'google:gemini-3.8-flash', enabledModelIds: ['google:gemini-3.8-flash'] }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid-model');
  });
});

test('when Grok is rate-limited, the person is told so and nothing is recorded', () => {
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
    assert.match(busy.body.error, /Nothing was recorded/);
  }, {
    env: { AI_PROVIDER: 'xai', AI_API_KEY: 'test-key', AI_MODEL: 'grok-4.7' },
    fetchImpl: async () => (limited
      ? jsonResponse({ error: { code: 429, details: [{ retryDelay: '30s' }] } }, 429)
      : grok('ready'))
  });
});

test('the classifier and verification still share the same Grok runtime', () => {
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
    assert.ok(calls.every(url => url.startsWith('https://api.x.ai/v1/responses')));
  }, {
    env: { AI_PROVIDER: 'xai', AI_API_KEY: 'test-key', AI_MODEL: 'grok-4.7' },
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      const body = JSON.parse(options.body);
      const raw = Array.isArray(body.input)
        ? body.input.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(item => item?.type === 'input_text').map(item => item.text).join('')
        : '';
      if (/Classify/i.test(raw)) return grok(JSON.stringify({
        actions: ['answer'],
        signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
        unknownSituation: false,
        confidence: 0.9,
        need: { deliverable: 'the boiling point', form: 'fact', depth: 'brief' }
      }));
      if (/verification|verify/i.test(raw)) return grok(JSON.stringify({ verdict: 'pass', criteria: [], problems: [] }));
      return grok('ready');
    }
  });
});
