import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveProviderGovernor } from '../src/adaptive-provider-governor.js';

test('provider telemetry exposes bounded load without changing scheduling authority', async () => {
  const governor = new AdaptiveProviderGovernor({ min: 1, max: 2, initial: 2 });
  const release = await governor.acquire('google:test');
  const stats = governor.stats('google:test')[0];
  assert.equal(stats.active, 1);
  assert.equal(stats.concurrency, 2);
  assert.equal(stats.maxConcurrency, 2);
  assert.equal(stats.utilization, 0.5);
  assert.equal(stats.queuePressure, 0);
  assert.equal(stats.capacityState, 'active');
  release();
  assert.equal(governor.stats('google:test')[0].capacityState, 'idle');
});

test('queued provider work is cancellable and cancellation does not consume capacity', async () => {
  const governor = new AdaptiveProviderGovernor({ min: 1, max: 1, initial: 1, queueTimeoutMs: 5000 });
  const release = await governor.acquire('google:test');
  const controller = new AbortController();
  const queued = governor.acquire('google:test', { signal: controller.signal });
  assert.equal(governor.stats('google:test')[0].capacityState, 'queued');
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(queued, error => error?.name === 'AbortError');
  assert.equal(governor.stats('google:test')[0].queued, 0);
  release();
});
