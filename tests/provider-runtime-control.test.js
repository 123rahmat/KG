import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveProviderGovernor } from '../src/adaptive-provider-governor.js';
import { callModel, providerConcurrencyStats, resetProviderConcurrency, retryAfterMs } from '../src/runtime.js';
import * as runtime from '../src/runtime.js';
import { useTool } from '../src/toolbox.js';
import http from 'node:http';
import { webFetch } from '../src/tools/web.js';
import { readDocumentIsolated } from '../src/document-runner.js';
import { readAttachment } from '../src/attachments.js';

const config = {
  limits: { responseBytes: 100000 }, providerConcurrency: { min: 1, max: 3 },
  ai: { provider: 'google', project: 'test', accessToken: 'test-token', location: 'global',
    model: 'gemini-3.8-flash', models: ['gemini-3.8-flash'], effort: 'high' }
};
const options = { config, modelId: 'google:gemini-3.8-flash', webSearch: false };
const messages = [{ role: 'user', content: 'Explain this function.' }];
const success = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }));

test('HTTP throttling reduces provider concurrency instead of recording a healthy call', async () => {
  resetProviderConcurrency();
  await assert.rejects(callModel(messages, { ...options, retries: 0,
    fetchImpl: async () => new Response('{}', { status: 429 }) }), { code: 'model-rate-limited' });
  const stats = providerConcurrencyStats()[0];
  assert.equal(stats.concurrency, 2);
  assert.equal(stats.successStreak, 0);
  assert.equal(stats.lastFailureCode, 'model-rate-limited');
});

test('throttled research keeps grounding and respects provider retry timing', async () => {
  resetProviderConcurrency();
  const requests = []; const waits = [];
  const answer = await callModel(messages, { ...options, webSearch: true,
    sleep: async ms => waits.push(ms), fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return requests.length === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : success();
    } });
  assert.equal(answer.text, 'Done');
  assert.equal(requests.length, 2);
  assert.equal(requests.every(request => request.tools?.some(tool => tool.googleSearch)), true);
  assert.ok(waits[0] >= 2000);
});

test('retry timing beyond the allowed wait returns throttling without an extra ungrounded call', async () => {
  resetProviderConcurrency();
  let calls = 0;
  await assert.rejects(callModel(messages, { ...options, webSearch: true, sleep: async () => {},
    fetchImpl: async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }); }
  }), { code: 'model-rate-limited', retryAfterSeconds: 60 });
  assert.equal(calls, 1);
});

test('already cancelled model calls do not send or reserve usage', async () => {
  let calls = 0; let reservations = 0;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(callModel(messages, { ...options, signal: controller.signal,
    usageGate: { reserve: async () => { reservations++; return { id: 'reservation' }; }, settle: async () => {}, release: async () => {} },
    fetchImpl: async () => { calls++; return success(); }
  }), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(reservations, 0);
});

test('cancelled provider queue entries never consume a slot or execute later', async () => {
  const governor = new AdaptiveProviderGovernor({ max: 1 });
  const release = await governor.acquire('model');
  const controller = new AbortController(); let calls = 0;
  const queued = governor.run('model', async () => { calls++; }, { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  controller.abort();
  release();
  await rejected;
  assert.equal(calls, 0); assert.equal(governor.stats('model')[0].queued, 0);
  assert.equal(governor.stats('model')[0].active, 0);
});

test('slot releases are idempotent and cannot admit excess work', async () => {
  const governor = new AdaptiveProviderGovernor({ max: 1 });
  const release = await governor.acquire('model');
  const next = governor.acquire('model');
  release(); const releaseNext = await next; release();
  assert.equal(governor.stats('model')[0].active, 1);
  releaseNext();
});

test('cancelling during retry delay prevents another paid request and releases usage', async () => {
  resetProviderConcurrency();
  const controller = new AbortController(); let calls = 0; let released = 0;
  await assert.rejects(callModel(messages, { ...options, signal: controller.signal,
    sleep: async () => controller.abort(),
    usageGate: { reserve: async () => ({ id: 'reservation' }), settle: async () => {}, release: async () => { released++; } },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 503 }); }
  }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(released, 1);
});

test('Retry-After accepts HTTP dates and rejects negative delays', () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Wed, 07 Oct 2026 17:00:02 GMT' }), Date.parse('2026-10-07T17:00:00Z')), 2000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '-1' })), null);
});

test('persisted Stop aborts a running model call and prevents retries', async () => {
  let state = 'respond'; let calls = 0;
  const answer = runtime.withRunControl(async signal => callModel(messages, { ...options, signal,
    fetchImpl: async (_url, request) => {
      calls++; state = 'failed';
      return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    }
  }), { readRun: async () => ({ state, attempt: 1, next: 'answer' }), taskId: 'answer', attempt: 1, pollMs: 10 });
  await assert.rejects(answer, { code: 'run-stopped' });
  assert.equal(calls, 1);
});

test('persisted control refuses stale attempts before starting work', async () => {
  let calls = 0;
  await assert.rejects(runtime.withRunControl(async () => { calls++; }, {
    readRun: async () => ({ state: 'respond', attempt: 2, next: 'answer' }), taskId: 'answer', attempt: 1
  }), { code: 'stale-execution' });
  assert.equal(calls, 0);
});

test('a missing run fails closed and stops issuing requests', async () => {
  let calls = 0;
  await assert.rejects(runtime.withRunControl(async () => { calls++; }, {
    readRun: async () => null, taskId: 'answer', attempt: 1
  }), { code: 'run-stopped' });
  assert.equal(calls, 0);
});

test('cancelled tool work cannot propose a new side effect', async () => {
  const controller = new AbortController(); controller.abort(); let proposals = 0;
  await assert.rejects(useTool('memory.save', { text: 'remember this' }, {
    config, signal: controller.signal, memories: {}, run: { conversationId: 'conversation' },
    scope: { principalId: 'owner' }, propose: async () => { proposals++; return { id: 'action' }; }
  }), { name: 'AbortError' });
  assert.equal(proposals, 0);
});

test('Stop closes an active guarded web request rather than waiting for its timeout', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  const server = http.createServer(() => controller.abort());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(webFetch({ url: `http://127.0.0.1:${port}/slow` }, {
      signal: controller.signal, timeoutMs: 500, ports: [port], isAllowed: () => true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }]
    }), { name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('oversized throttling bodies cannot hide provider pressure or retry timing', async () => {
  resetProviderConcurrency(); let calls = 0;
  await assert.rejects(callModel(messages, { ...options, config: { ...config, limits: { responseBytes: 5 } },
    fetchImpl: async () => { calls++; return new Response('large error body', { status: 429, headers: { 'retry-after': '60' } }); }
  }), { code: 'model-rate-limited', retryAfterSeconds: 60 });
  assert.equal(calls, 1); assert.equal(providerConcurrencyStats()[0].concurrency, 2);
});

test('Stop terminates an active document parser without waiting for the worker deadline', async () => {
  const controller = new AbortController();
  const operation = readDocumentIsolated(Buffer.from('invalid pdf'), { name: 'report.pdf' }, { signal: controller.signal });
  queueMicrotask(() => controller.abort());
  await assert.rejects(operation, { name: 'AbortError' });
});

test('attachment preparation propagates Stop without caching a cancellation as a file error', async () => {
  const controller = new AbortController();
  const store = { read: async () => {
    queueMicrotask(() => controller.abort());
    return { metadata: { digest: 'cancel-attachment', name: 'cancel.pdf', contentType: 'application/pdf' }, content: Buffer.from('invalid pdf') };
  } };
  const scope = { workspaceId: 'cancel-workspace' }; const file = { id: 'file', name: 'cancel.pdf', format: 'pdf' };
  await assert.rejects(readAttachment(store, scope, file, { signal: controller.signal }), { name: 'AbortError' });
  const subsequent = await readAttachment(store, scope, file);
  assert.match(subsequent.error, /PDF/);
});
