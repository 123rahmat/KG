import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse } from './helpers.js';

const gemini = text => jsonResponse({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
});

test('a workspace admin changes the model in Settings; it is tried first and chats then use it', () => {
  const calls = [];
  return withServer(async ({ call, seed }) => {
    const admin = await seed({ role: 'admin' });
    const member = await seed({ workspace: admin.workspace, role: 'editor', name: 'Member' });
    const auth = { token: admin.token, workspace: admin.workspace };

    const before = await call('GET', '/api/models', auth);
    assert.equal(before.body.canManage, true);
    assert.equal(before.body.selectedModelId, 'google:gemini-3.8-flash');
    assert.deepEqual(before.body.models.map(model => model.id), ['google:gemini-3.8-flash', 'google:gemini-3.1-pro', 'google:gemini-3.0-retired']);
    const all = before.body.models.map(model => model.id);

    // A model Gemini no longer serves is refused, and nothing changes.
    const refused = await call('PUT', '/api/models/settings', { ...auth, body: { defaultModelId: 'google:gemini-3.0-retired', enabledModelIds: all } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'model-unavailable');
    assert.match(refused.body.error, /gemini-3\.0-retired \(HTTP 404\).*nothing was changed/);
    assert.equal((await call('GET', '/api/models', auth)).body.selectedModelId, 'google:gemini-3.8-flash');

    // Only an admin may change it.
    const denied = await call('PUT', '/api/models/settings', { token: member.token, workspace: admin.workspace, body: { defaultModelId: 'google:gemini-3.1-pro', enabledModelIds: all } });
    assert.equal(denied.status, 403);

    const switched = await call('PUT', '/api/models/settings', { ...auth, body: { defaultModelId: 'google:gemini-3.1-pro', enabledModelIds: all } });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.selectedModelId, 'google:gemini-3.1-pro');
    assert.ok(calls.some(url => url.includes('/models/gemini-3.1-pro:generateContent')), 'the new model was tried before saving');

    // The next chat runs on the new model.
    calls.length = 0;
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } } });
    const answered = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(answered.body.execution.executed, true);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(url => url.includes('/models/gemini-3.1-pro:generateContent')), calls.join('\n'));
  }, {
    env: { AI_PROVIDER: 'google', AI_API_KEY: 'test-key', AI_MODELS: 'gemini-3.1-pro,gemini-3.0-retired' },
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).includes('gemini-3.0-retired')) return jsonResponse({ error: { code: 404, message: 'not found' } }, 404);
      return gemini('OK. Recursion is when a function calls itself.');
    }
  });
});

test('when Gemini is rate-limited, the person is told so and when to retry; nothing is recorded', () => {
  let limited = false;
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Explain recursion.', privacyConsent: { modelProvider: true } } });
    limited = true;
    const busy = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(busy.status, 503);
    assert.equal(busy.body.code, 'model-rate-limited');
    assert.equal(busy.body.retryAfterSeconds, 30);
    assert.equal(busy.headers.get('retry-after'), '30');
    assert.match(busy.body.error, /Nothing was recorded/);
    const after = await call('GET', `/api/runs/${run.id}`, auth);
    assert.equal(after.body.tasks.find(task => task.id === after.body.next).status !== 'complete', true);
  }, {
    env: { AI_PROVIDER: 'google', AI_API_KEY: 'test-key' },
    fetchImpl: async () => (limited
      ? jsonResponse({ error: { code: 429, details: [{ retryDelay: '30s' }] } }, 429)
      : gemini('not json'))
  });
});

test('a greeting costs one Gemini call; a factual question keeps its check', () => {
  const tasks = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const drive = async goal => {
      tasks.length = 0;
      let { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal, privacyConsent: { modelProvider: true } } });
      for (let i = 0; i < 5 && run.next; i += 1) {
        await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
        run = (await call('GET', `/api/runs/${run.id}`, auth)).body;
      }
      return { run, calls: [...tasks] };
    };
    const hello = await drive('Hello!');
    assert.deepEqual(hello.calls, ['respond'], 'no classifier and no separate check');
    assert.equal(hello.run.state, 'complete');
    assert.deepEqual(hello.run.tasks.map(task => task.id), ['respond']);

    const fact = await drive('What is the boiling point of water at sea level?');
    assert.deepEqual(fact.calls, ['classify', 'respond', 'verify']);
  }, {
    env: { AI_PROVIDER: 'google', AI_API_KEY: 'test-key' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const system = body.systemInstruction?.parts?.map(part => part.text).join('') ?? '';
      if (system.startsWith('Classify')) {
        tasks.push('classify');
        return gemini(JSON.stringify({ actions: ['answer'], signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false }, unknownSituation: false, confidence: 0.9, need: { deliverable: 'the boiling point', form: 'fact', depth: 'brief' } }));
      }
      const request = JSON.parse(body.contents[0].parts.map(part => part.text ?? '').join(''));
      tasks.push(request.task?.type);
      if (request.task?.type === 'verify') return gemini(JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] }));
      return gemini('Hello! How can I help?');
    }
  });
});
