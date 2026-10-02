import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CASCADE_MS, OVERLOAD_PAUSE_MS, callModel, callRunner, effectiveEffort, ModelProviderError, retryAfterMs, resetModelRest, resetProviderConcurrency } from '../src/runtime.js';
import { thinkingFor, answersInJson } from '../src/routes/execution.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const base = { limits: { responseBytes: 1024 * 1024 } };

test('Gemini 3.8 Flash uses the active model and system instruction', async () => {
  let request;
  const result = await callModel(
    [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
    {
      config: { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } },
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'answer' }] },
            finishReason: 'STOP'
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 9, totalTokenCount: 14 }
        });
      }
    }
  );
  assert.equal(request.url, 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
  const body = JSON.parse(request.options.body);
  assert.equal(body.contents[0].role, 'user');
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system' }] });
  assert.equal(result.text, 'answer');
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 9 });
});

test('Gemini image input is encoded as inline data', async () => {
  let body;
  await callModel(
    [{ role: 'user', content: 'inspect this', images: [{ mediaType: 'image/png', data: 'AAAA' }] }],
    {
      config: { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } },
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
        });
      }
    }
  );
  assert.deepEqual(body.contents[0].parts, [
    { inline_data: { mime_type: 'image/png', data: 'AAAA' } },
    { text: 'inspect this' }
  ]);
});

test('Gemini web search is opt-in and exposes grounding citations', async () => {
  let request;
  const result = await callModel(
    [{ role: 'user', content: 'Research the latest information.' }],
    {
      config: { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } },
      webSearch: true,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'A current result.' }] },
            finishReason: 'STOP',
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://example.com/source', title: 'Example source' } }
              ]
            }
          }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 12, totalTokenCount: 21 }
        });
      }
    }
  );
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
  assert.deepEqual(body.tools, [{ googleSearch: {} }]);
  assert.deepEqual(result.citations, [{ url: 'https://example.com/source', title: 'Example source' }]);
});

test('Gemini thinking effort uses the supported thinkingLevel field', async () => {
  let body;
  await callModel(
    [{ role: 'user', content: 'reason deeply' }],
    {
      config: { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', effort: 'high' } },
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse({
          candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        });
      }
    }
  );
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
});

test('each task asks for the thinking it needs; AI_EFFORT is a ceiling, not a fixed level', async () => {
  assert.equal(effectiveEffort('high', null), 'high');
  assert.equal(effectiveEffort('low', null), 'low');
  assert.equal(effectiveEffort('high', 'medium'), 'medium', 'the operator ceiling wins');
  assert.equal(effectiveEffort('low', 'high'), 'low', 'a ceiling never raises a quick task');
  assert.equal(effectiveEffort(null, 'medium'), 'medium');
  assert.equal(effectiveEffort(null, null), null, 'nothing set keeps the model default');

  assert.equal(thinkingFor({ type: 'respond', metadata: { crisis: true } }), 'low', 'a person in crisis gets an answer now');
  assert.equal(thinkingFor({ type: 'respond', metadata: {} }), 'medium');
  for (const type of ['code', 'verify', 'prototype']) assert.equal(thinkingFor({ type }), 'high', type);
  // The situation moves it: small familiar work thinks less (not its check),
  // complex or high-stakes work and a retry more, a fix after a failure hardest.
  const run = (over = {}) => ({ attempt: 1, workflow: 'full', adaptation: { scale: 'standard', codeRepairs: [] }, situation: {}, ...over });
  assert.equal(thinkingFor({ type: 'code', id: 'build-code' }, run({ adaptation: { scale: 'small' } })), 'medium');
  assert.equal(thinkingFor({ type: 'verify' }, run({ adaptation: { scale: 'small' } })), 'high');
  assert.equal(thinkingFor({ type: 'respond' }, run({ adaptation: { scale: 'complex' } })), 'high');
  assert.equal(thinkingFor({ type: 'respond' }, run({ situation: { risk: 'high-impact' } })), 'high');
  assert.equal(thinkingFor({ type: 'respond' }, run({ attempt: 2 })), 'high');
  assert.equal(thinkingFor({ type: 'code', id: 'build-code' }, run({ adaptation: { scale: 'small', codeRepairs: [{ attempt: 1, round: 1 }] } })), 'high');
  assert.equal(thinkingFor({ type: 'respond' }, run({ workflow: 'direct', situation: { need: { depth: 'brief' } } })), 'low');

  const levels = [];
  const fetchImpl = async (_url, options) => {
    levels.push(JSON.parse(options.body).generationConfig?.thinkingConfig?.thinkingLevel ?? null);
    return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  };
  const ai = effort => ({ ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', effort } });
  await callModel([{ role: 'user', content: 'x' }], { config: ai(null), fetchImpl, effort: 'high' });
  await callModel([{ role: 'user', content: 'x' }], { config: ai('low'), fetchImpl, effort: 'high' });
  await callModel([{ role: 'user', content: 'x' }], { config: ai(null), fetchImpl });
  assert.deepEqual(levels, ['HIGH', 'LOW', null]);
});

test('steps that must answer in JSON ask Gemini to guarantee it, except when searching', async () => {
  const configs = [];
  const fetchImpl = async (_url, options) => {
    configs.push(JSON.parse(options.body).generationConfig ?? {});
    return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }] });
  };
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } };
  await callModel([{ role: 'user', content: 'x' }], { config, fetchImpl, json: true });
  await callModel([{ role: 'user', content: 'x' }], { config, fetchImpl, json: true, webSearch: true });
  await callModel([{ role: 'user', content: 'x' }], { config, fetchImpl });
  assert.deepEqual(configs.map(item => item.responseMimeType ?? null), ['application/json', null, null]);

  for (const task of [{ type: 'verify' }, { type: 'understand' }, { type: 'reassess' }, { type: 'discover-capabilities' }, { id: 'build-code', type: 'code' }, { type: 'tool', metadata: { outputSchema: {} } }]) {
    assert.equal(answersInJson(task), true, JSON.stringify(task));
  }
  for (const task of [{ type: 'respond' }, { type: 'deliver' }, { type: 'prototype' }, { type: 'investigate' }]) {
    assert.equal(answersInJson(task), false, task.type);
  }
});

test('Gemini refusal and truncation are never reported as complete', async () => {
  const call = body => callModel([{ role: 'user', content: 'hello' }], {
    config: { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } },
    fetchImpl: async () => jsonResponse(body)
  });
  const usage = { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 };

  // A safety block is the model declining, which the app reports as such.
  const refused = await call({ candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [] } }], usageMetadata: usage });
  assert.equal(refused.incomplete, 'refusal');
  const promptBlocked = await call({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: usage });
  assert.equal(promptBlocked.incomplete, 'refusal', 'a blocked prompt is declined too');

  const truncated = await call({ candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: 'half' }] } }], usageMetadata: usage });
  assert.equal(truncated.incomplete, 'max_tokens');

  const empty = await call({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [] } }], usageMetadata: usage });
  assert.equal(empty.incomplete, 'empty-response');

  const complete = await call({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'done' }] } }], usageMetadata: usage });
  assert.equal(complete.incomplete, null);
  assert.equal(complete.text, 'done');
  assert.deepEqual(complete.usage, { inputTokens: 5, outputTokens: 4 });
});

test('an unconfigured model never claims work happened', async () => {
  const result = await callModel([{ role: 'user', content: 'hello' }], {
    config: { ...base, ai: null }
  });
  assert.equal(result, null);
});

test('managed runner preserves explicit failure status while proving execution occurred', async () => {
  const result = await callRunner('http://runner.test/v1/execute', {
    runId: 'run-1',
    executionId: 'run-1',
    task: { id: 'test-code', type: 'code' },
    executionTarget: 'general-ai-sandbox'
  }, {
    config: { ...base, runners: { token: 'runner-token' } },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['x-kindgleam-execution-id'], 'run-1');
      return jsonResponse({
        executed: true,
        status: 'failed',
        exitCode: 1,
        output: { stderr: 'test failure' }
      });
    }
  });
  assert.equal(result.executed, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.executionReceipt.status, 'failed');
  assert.equal(result.executionReceipt.executed, true);
  assert.equal(result.executionReceipt.executionId, 'run-1');
});

test('managed runner does not retry an ambiguous transport failure', async () => {
  let calls = 0;
  const result = await callRunner('http://runner.test/v1/execute', {
    runId: 'run-transport',
    executionId: 'run-transport',
    task: { id: 'test-code', type: 'code' },
    executionTarget: 'general-ai-sandbox'
  }, {
    config: { ...base, runners: { token: 'runner-token' } },
    sleep: async () => { throw new Error('sleep should not be called'); },
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('connection reset');
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.executed, false);
  assert.equal(result.status, 'unreachable');
});

test('malformed provider responses are incomplete instead of throwing', async () => {
  const result = await callModel([{ role: 'user', content: 'hello' }], {
    config: { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } },
    fetchImpl: async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  });
  assert.equal(result.incomplete, 'invalid-provider-response');
});

test('a rate limit waits as long as Gemini asks, and a long wait is not held open', async () => {
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token' } };
  const ok = () => jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  const limited = (headers = {}, body = { error: { code: 429 } }) => new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', ...headers } });

  // Retry-After in seconds is honoured, then the retry succeeds.
  let slept = [];
  let calls = 0;
  const answer = await callModel([{ role: 'user', content: 'x' }], {
    config, sleep: async ms => { slept.push(ms); },
    fetchImpl: async () => (++calls === 1 ? limited({ 'retry-after': '3' }) : ok())
  });
  assert.equal(answer.text, 'ok');
  assert.deepEqual(slept, [3000]);

  // Gemini's own retryDelay beyond the cap: no wait, a clear error with the time.
  slept = [];
  await assert.rejects(callModel([{ role: 'user', content: 'x' }], {
    config, sleep: async ms => { slept.push(ms); },
    fetchImpl: async () => limited({}, { error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } })
  }), error => error instanceof ModelProviderError && error.code === 'model-rate-limited' && error.status === 503 && error.retryAfterSeconds === 37);
  assert.deepEqual(slept, []);

  // A rejected key is not retried and says what to do; the upstream body is never echoed.
  calls = 0;
  await assert.rejects(callModel([{ role: 'user', content: 'secret prompt' }], {
    config, sleep: async () => {}, fetchImpl: async () => { calls += 1; return new Response('{"error":"secret prompt"}', { status: 403 }); }
  }), error => error.code === 'model-not-authorized' && !error.message.includes('secret') && error.expose === true);
  assert.equal(calls, 1);

  // A request Gemini rejects (400) is ours to fix: a server error, not exposed.
  await assert.rejects(callModel([{ role: 'user', content: 'x' }], { config, fetchImpl: async () => new Response('{}', { status: 400 }) }),
    error => error.code === 'model-request-rejected' && error.status === 502 && error.expose === false);

  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' }), ''), 2000);
  assert.equal(retryAfterMs(null, '{"retryDelay": "1.5s"}'), 1500);
  assert.equal(retryAfterMs(null, '{}'), null);
});

test('when a model is out of quota, overloaded or retired, the operator\'s backup models answer instead', async () => {
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.5-flash', 'gemini-3.1-flash-lite'] } };
  const ok = () => jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  const modelOf = url => url.match(/models\/([^:]+):/)[1];
  const slept = [];
  const run = (replies, { fresh = true } = {}) => {
    if (fresh) resetModelRest();
    const asked = [];
    return { asked, promise: callModel([{ role: 'user', content: 'x' }], {
      config, sleep: async ms => { slept.push(ms); },
      fetchImpl: async url => { asked.push(modelOf(url)); return replies[modelOf(url)](); }
    }) };
  };

  // The day's quota of the chosen model is used up: the first backup answers at once, and says so.
  const quota = run({ 'gemini-3.8-flash': () => new Response('{}', { status: 429 }), 'gemini-3.5-flash': ok });
  assert.equal((await quota.promise).model, 'gemini-3.5-flash');
  assert.deepEqual(quota.asked, ['gemini-3.8-flash', 'gemini-3.5-flash'], 'the exhausted model is not retried');
  assert.deepEqual(slept, [], 'nor waited on');

  // The next request goes straight to the backup while the exhausted model rests.
  const next = run({ 'gemini-3.5-flash': ok }, { fresh: false });
  assert.equal((await next.promise).model, 'gemini-3.5-flash');
  assert.deepEqual(next.asked, ['gemini-3.5-flash']);

  // Overloaded, then retired: each backup is tried in order.
  const both = run({ 'gemini-3.8-flash': () => new Response('{}', { status: 503 }), 'gemini-3.5-flash': () => new Response('{}', { status: 404 }), 'gemini-3.1-flash-lite': ok });
  assert.equal((await both.promise).model, 'gemini-3.1-flash-lite');

  // A rejected key is the same for every model: reported at once, no backups tried.
  const key = run({ 'gemini-3.8-flash': () => new Response('{}', { status: 403 }) });
  await assert.rejects(key.promise, error => error.code === 'model-not-authorized');
  assert.deepEqual(key.asked, ['gemini-3.8-flash']);

  // Every model out of quota: the person gets the usual rate-limit message.
  const none = run({ 'gemini-3.8-flash': () => new Response('{}', { status: 429 }), 'gemini-3.5-flash': () => new Response('{}', { status: 429 }), 'gemini-3.1-flash-lite': () => new Response('{}', { status: 429 }) });
  await assert.rejects(none.promise, error => error.code === 'model-rate-limited');
});

test('a model that does not answer in time is unavailable, and the backup answers', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.5-flash'] } };
  const asked = [];
  const answer = await callModel([{ role: 'user', content: 'x' }], {
    config, sleep: async () => {},
    fetchImpl: async url => {
      const model = url.match(/models\/([^:]+):/)[1];
      asked.push(model);
      if (model === 'gemini-3.8-flash') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    }
  });
  assert.equal(answer.model, 'gemini-3.5-flash');
  assert.deepEqual(asked, ['gemini-3.8-flash', 'gemini-3.5-flash']);

  // With no backup, the person is told the model is unavailable, not that something broke.
  resetModelRest();
  await assert.rejects(callModel([{ role: 'user', content: 'x' }], {
    config: { ...config, ai: { ...config.ai, fallbackModels: [] } }, sleep: async () => {}, retries: 0,
    fetchImpl: async () => { throw new TypeError('fetch failed'); }
  }), error => error instanceof ModelProviderError && error.code === 'model-unavailable');
});

test('when web search is out of quota, the answer comes without it and says so', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash' } };
  const searched = [];
  const answer = await callModel([{ role: 'user', content: 'price of copper' }], {
    config, webSearch: true, retries: 0, sleep: async () => {},
    fetchImpl: async (_url, options) => {
      const withSearch = Boolean(JSON.parse(options.body).tools);
      searched.push(withSearch);
      return withSearch ? new Response('{}', { status: 429 })
        : jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'About 9,800 USD.' }] }, finishReason: 'STOP' }] });
    }
  });
  assert.deepEqual(searched, [true, false]);
  assert.equal(answer.text, 'About 9,800 USD.');
  assert.equal(answer.webSearchUnavailable, true);
});

test('a model that cannot use the search tool answers without it', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.1-flash-lite' } };
  const answer = await callModel([{ role: 'user', content: 'x' }], {
    config, webSearch: true, retries: 0, sleep: async () => {},
    fetchImpl: async (_url, options) => JSON.parse(options.body).tools
      ? jsonResponse({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] })
      : jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'An answer.' }] }, finishReason: 'STOP' }] })
  });
  assert.equal(answer.text, 'An answer.');
  assert.equal(answer.incomplete, null);
  assert.equal(answer.webSearchUnavailable, true);
});

test('a garbled tool call when no tool was offered is asked for once more', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.5-flash-lite' } };
  let calls = 0;
  const answer = await callModel([{ role: 'user', content: 'x' }], {
    config, retries: 0, sleep: async () => {},
    fetchImpl: async () => (++calls === 1
      ? jsonResponse({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] })
      : jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Rest and water.' }] }, finishReason: 'STOP' }] }))
  });
  assert.equal(calls, 2);
  assert.equal(answer.text, 'Rest and water.');
  assert.equal(answer.incomplete, null);
});

test('a wide outage stops moving through backups once the time limit is spent', async t => {
  resetModelRest();
  const backups = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro'];
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: backups } };
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const asked = [];
  await assert.rejects(callModel([{ role: 'user', content: 'x' }], {
    config, sleep: async () => {}, retries: 0,
    fetchImpl: async url => {
      asked.push(url.match(/models\/([^:]+):/)[1]);
      // Each model takes most of a minute to time out.
      now += MODEL_CASCADE_MS / 2 + 1;
      return new Response('{}', { status: 503 });
    }
  }), error => error.code === 'model-unavailable');
  assert.deepEqual(asked, ['gemini-3.8-flash', 'gemini-3.7-flash'], 'the rest are not waited on');
});

test('a model that does not exist is left out while it rests, and never hides an overload', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.7-flash', 'gemini-2.5-flash'] } };
  const modelOf = url => url.match(/models\/([^:]+):/)[1];
  const replies = { 'gemini-3.8-flash': 503, 'gemini-3.7-flash': 503, 'gemini-2.5-flash': 404 };
  const call = asked => callModel([{ role: 'user', content: 'x' }], {
    config, retries: 0, sleep: async () => {},
    fetchImpl: async url => { asked.push(modelOf(url)); return new Response('{}', { status: replies[modelOf(url)] }); }
  });

  // Everything fails: the person hears "busy, try again", not "not found".
  const first = [];
  await assert.rejects(call(first), error => error.code === 'model-unavailable');
  // The overloaded models were tried once more after a pause; the missing one was not.
  assert.deepEqual(first, ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.7-flash']);

  // Later, when the overload has passed, the missing model is not asked at all.
  const second = [];
  await assert.rejects(call(second), error => error.code === 'model-unavailable');
  assert.ok(!second.includes('gemini-2.5-flash'));
});

test('an overloaded model that recovers after a pause answers', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.7-flash'] } };
  const paused = [];
  let calls = 0;
  const answer = await callModel([{ role: 'user', content: 'x' }], {
    config, retries: 0, sleep: async ms => { paused.push(ms); },
    fetchImpl: async () => (++calls <= 2 ? new Response('{}', { status: 503 })
      : jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }))
  });
  assert.equal(answer.text, 'ok');
  assert.equal(answer.model, 'gemini-3.8-flash');
  assert.deepEqual(paused, [OVERLOAD_PAUSE_MS]);
});

test('backups never move a step up to Pro, and obey the caller\'s rules', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: ['gemini-2.5-pro', 'gemini-3.7-flash', 'gemini-3.5-flash-lite'] } };
  const asked = [];
  await assert.rejects(callModel([{ role: 'user', content: 'x' }], {
    config, retries: 0, sleep: async () => {},
    allowBackup: model => model !== 'gemini-3.7-flash',
    fetchImpl: async url => { asked.push(url.match(/models\/([^:]+):/)[1]); return new Response('{}', { status: 429 }); }
  }), error => error.code === 'model-rate-limited');
  assert.deepEqual(asked, ['gemini-3.8-flash', 'gemini-3.5-flash-lite'], 'no Pro, and not the model a rule refused');
});

test('an empty answer or a garbled search call from one model goes to the next model', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.5-flash-lite', fallbackModels: ['gemini-3.1-flash-lite'] } };
  const modelOf = url => url.match(/models\/([^:]+):/)[1];
  const asked = [];
  const answer = await callModel([{ role: 'user', content: 'WHO BMI categories' }], {
    config, webSearch: true, retries: 0, sleep: async () => {},
    fetchImpl: async url => {
      asked.push(modelOf(url));
      return modelOf(url) === 'gemini-3.5-flash-lite'
        ? jsonResponse({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] })
        : jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Underweight below 18.5.' }] }, finishReason: 'STOP' }] });
    }
  });
  assert.equal(answer.text, 'Underweight below 18.5.');
  assert.equal(answer.model, 'gemini-3.1-flash-lite');
  assert.deepEqual(asked, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
});

test('a quick 503 does not demote the chosen model for the next request', async () => {
  resetModelRest();
  const config = { ...base, ai: { provider: 'google', apiKey: 'key', vertexProject: 'test-project', vertexAccessToken: 'test-token', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.5-flash-lite'] } };
  const modelOf = url => url.match(/models\/([^:]+):/)[1];
  const ok = () => jsonResponse({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
  let busy = true;
  const asked = [];
  const call = () => callModel([{ role: 'user', content: 'x' }], {
    config, retries: 0, sleep: async () => {},
    fetchImpl: async url => { asked.push(modelOf(url)); return modelOf(url) === 'gemini-3.8-flash' && busy ? new Response('{}', { status: 503 }) : ok(); }
  });
  assert.equal((await call()).model, 'gemini-3.5-flash-lite');
  busy = false;
  asked.length = 0;
  assert.equal((await call()).model, 'gemini-3.8-flash', 'the better model is asked first again');
  assert.deepEqual(asked, ['gemini-3.8-flash']);
});


test('model calls are bounded by the adaptive provider concurrency governor', async () => {
  resetModelRest();
  resetProviderConcurrency();
  const config = {
    ...base,
    ai: { provider: 'google', apiKey: 'key', model: 'gemini-3.8-flash' },
    providerConcurrency: { min: 1, max: 1, initial: 1, queueTimeoutMs: 1000 }
  };
  let active = 0;
  let peak = 0;
  let calls = 0;
  const answer = () => callModel([{ role: 'user', content: 'x' }], {
    config,
    retries: 0,
    fetchImpl: async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 35));
      active -= 1;
      return jsonResponse({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }]
      });
    }
  });
  const [first, second] = await Promise.all([answer(), answer()]);
  assert.equal(first.text, 'ok');
  assert.equal(second.text, 'ok');
  assert.equal(calls, 2);
  assert.equal(peak, 1, 'the request boundary must enforce the configured model concurrency');
  resetProviderConcurrency();
});


test('estimated model tokens include prompt and requested output headroom', async () => {
  const { estimateModelTokens } = await import('../src/runtime.js');
  const estimate = estimateModelTokens([{ role: 'user', content: 'x'.repeat(400) }], { maxOutputTokens: 1000 });
  assert.ok(estimate >= 1100);
});
