import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTraceparent, createTraceContext, traceparentOf } from '../src/observability.js';
import { rankLexical } from '../src/rag.js';

test('trace context rejects malformed and accepts valid W3C traceparent', () => {
  assert.equal(parseTraceparent('bad'), null);
  const incoming = parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  assert.equal(incoming.traceId, '0123456789abcdef0123456789abcdef');
  const context = createTraceContext('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  assert.equal(context.traceId, incoming.traceId);
  assert.match(traceparentOf(context), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('retrieval favors repeated matches and title matches', () => {
  const rows = [
    { id: 'a', sourceId: 'a', title: 'deployment', content: 'deployment' },
    { id: 'b', sourceId: 'b', title: 'deployment resilience', content: 'deployment deployment resilience deployment' }
  ];
  const ranked = rankLexical('deployment resilience', rows, 2);
  assert.equal(ranked[0].id, 'b');
  assert.equal(ranked[0].matchedTerms, 2);
});

import { AdaptiveProviderGovernor, ProviderConcurrencyError } from '../src/adaptive-provider-governor.js';

test('provider governor adapts down on upstream pressure and up after sustained health', async () => {
  const governor = new AdaptiveProviderGovernor({ min: 1, max: 3, initial: 3, queueTimeoutMs: 100 });
  governor.adapt('google:model', { ok: false, code: 'model-rate-limited', latencyMs: 100 });
  governor.adapt('google:model', { ok: false, code: 'model-rate-limited', latencyMs: 100 });
  assert.equal(governor.stats('google:model')[0].concurrency, 1);

  await Promise.all(Array.from({ length: 3 }, async () => governor.run('healthy', async () => null)));
  for (let i = 0; i < 12; i += 1) governor.adapt('healthy', { ok: true, latencyMs: 10 });
  assert.ok(governor.stats('healthy')[0].concurrency >= 2);
});

test('provider governor bounds queue wait', async () => {
  const governor = new AdaptiveProviderGovernor({ min: 1, max: 1, initial: 1, queueTimeoutMs: 25 });
  const release = await governor.acquire('sat');
  await assert.rejects(governor.acquire('sat'), error => error instanceof ProviderConcurrencyError);
  release();
});

test('provider governor never exceeds configured in-flight concurrency', async () => {
  const governor = new AdaptiveProviderGovernor({ min: 1, max: 2, initial: 2, queueTimeoutMs: 1000 });
  let active = 0;
  let peak = 0;
  const hold = ms => new Promise(resolve => setTimeout(resolve, ms));
  await Promise.all(Array.from({ length: 6 }, async () => governor.run('cap', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await hold(10);
    active -= 1;
  })));
  assert.equal(peak, 2);
  assert.equal(governor.stats('cap')[0].active, 0);
});
