import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptFleetCapacity, fleetHealthUpdate, fleetPartition,
  normalizeProjectSpec, projectDispatchScore, selectFleetProjects, updateFleetTelemetry
} from '../src/fleet-control.js';

test('fleet projects are bounded and normalized', () => {
  const project = normalizeProjectSpec({
    name: 'A', priority: 9999, maxConcurrency: 99,
    tags: Array.from({ length: 40 }, (_, i) => String(i))
  });
  assert.equal(project.priority, 1000);
  assert.equal(project.maxConcurrency, 8);
  assert.equal(project.tags.length, 24);
});

test('fair selection keeps old work eligible', () => {
  const now = Date.now();
  const projects = [
    { id: 'high', state: 'active', priority: 100, lastDispatchAt: new Date(now - 60000).toISOString(), healthScore: 1, maxConcurrency: 1, inFlight: 0 },
    { id: 'old', state: 'active', priority: 0, lastDispatchAt: new Date(now - 10 * 86400000).toISOString(), healthScore: 1, maxConcurrency: 1, inFlight: 0 }
  ];
  const selected = selectFleetProjects(projects, { maxProjects: 2, nowMs: now });
  assert.deepEqual(selected.map(p => p.id), ['high', 'old']);
  assert.ok(projectDispatchScore(projects[0], { nowMs: now }) > 0);
});

test('capacity adapts to database pressure and healthy queueing', () => {
  assert.equal(adaptFleetCapacity({ current: 8, dbWaiting: 4 }).next, 7);
  assert.equal(adaptFleetCapacity({
    current: 2, queueDepth: 10, usefulParallelism: 0.8,
    errorRate: 0.01, dbWaiting: 0, remainingBudgetRatio: 0.8, averageLatencyMs: 1000
  }).next, 3);
});

test('partitioning is stable and health recovers', () => {
  assert.equal(fleetPartition('project-a', 8), fleetPartition('project-a', 8));
  const failed = fleetHealthUpdate({ healthScore: 1, consecutiveFailures: 0 }, { failed: true });
  const recovered = fleetHealthUpdate(failed, { succeeded: true });
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.ok(recovered.score > failed.score);
});

test('fleet telemetry feeds real latency and error signals into adaptation', () => {
  let telemetry = { averageLatencyMs: 0, errorRate: 0, samples: 0 };
  telemetry = updateFleetTelemetry(telemetry, { ok: true, latencyMs: 1000 });
  telemetry = updateFleetTelemetry(telemetry, { ok: false, latencyMs: 3000 });
  assert.equal(telemetry.samples, 2);
  assert.ok(telemetry.averageLatencyMs > 1000);
  assert.ok(telemetry.errorRate > 0);
});
