import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateSubsystemCount,
  buildSubsystemPlan,
  compactSubsystemPlan,
  createSubsystemMessage,
  mergeSubsystemMessages,
  subsystemAssignment,
  subsystemCommunicationContext
} from '../src/subsystem-orchestrator.js';

function syntheticIndex({
  scale = 'large',
  roots = ['auth', 'orders', 'payments', 'notifications'],
  crossEdges = []
} = {}) {
  const files = [];
  for (const root of roots) {
    for (let i = 0; i < 10; i += 1) {
      files.push({
        path: `${root}/file-${i}.js`,
        bytes: 1000,
        test: i === 9,
        language: 'javascript',
        kind: i === 9 ? 'test' : 'code'
      });
    }
  }
  const dependencies = crossEdges.map(([fromRoot, toRoot]) => ({
    from: `${fromRoot}/file-0.js`,
    to: `${toRoot}/file-0.js`
  }));
  return {
    version: 1,
    scale,
    revisionId: 'rev-1',
    contentHash: 'hash-1',
    fileCount: files.length,
    files,
    dependencies,
    totals: {
      bytes: files.length * 1000,
      dependencies: dependencies.length
    },
    hierarchy: {
      scale,
      directories: [
        { path: '', depth: 0, fileCount: files.length, bytes: files.length * 1000, digest: 'root' },
        ...roots.map(root => ({
          path: root,
          depth: 1,
          fileCount: 10,
          bytes: 10_000,
          digest: `${root}-digest`
        }))
      ],
      root: { path: '', depth: 0, fileCount: files.length, bytes: files.length * 1000, digest: 'root' }
    }
  };
}

test('adaptive subsystem count scales with project size and is bounded', () => {
  const medium = estimateSubsystemCount(syntheticIndex({
    scale: 'medium',
    roots: ['api', 'ui', 'db']
  }), { maxSubsystems: 8 });
  const veryLarge = estimateSubsystemCount(syntheticIndex({
    scale: 'very-large',
    roots: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  }), { maxSubsystems: 8 });

  assert.ok(medium.count >= 1 && medium.count <= 8);
  assert.ok(veryLarge.count >= medium.count);
  assert.ok(veryLarge.count <= 8);
});

test('strong coupling reduces subsystem pressure rather than creating needless coordination', () => {
  const lowCoupling = estimateSubsystemCount(syntheticIndex({
    scale: 'large',
    roots: ['a', 'b', 'c', 'd', 'e'],
    crossEdges: [['a', 'b']]
  }), { maxSubsystems: 8 });
  const highCoupling = estimateSubsystemCount(syntheticIndex({
    scale: 'large',
    roots: ['a', 'b', 'c', 'd', 'e'],
    crossEdges: [
      ['a', 'b'], ['a', 'c'], ['a', 'd'], ['a', 'e'],
      ['b', 'c'], ['b', 'd'], ['b', 'e'],
      ['c', 'd'], ['c', 'e'], ['d', 'e']
    ]
  }), { maxSubsystems: 8 });

  assert.ok(highCoupling.count <= lowCoupling.count);
  assert.ok(highCoupling.coupling >= lowCoupling.coupling);
});

test('subsystem plan assigns every owned file, builds contracts, and orders dependency waves', () => {
  const index = syntheticIndex({
    scale: 'large',
    roots: ['auth', 'orders', 'payments', 'notifications'],
    crossEdges: [['orders', 'auth'], ['payments', 'orders'], ['notifications', 'payments']]
  });
  const plan = buildSubsystemPlan(index, { maxSubsystems: 4 });

  assert.equal(plan.kind, 'adaptive-subsystem-plan');
  assert.equal(plan.project.contentHash, 'hash-1');
  assert.ok(plan.subsystems.length >= 1 && plan.subsystems.length <= 4);

  const owned = new Set(plan.subsystems.flatMap(item => item.files));
  assert.equal(owned.size, index.files.length);
  assert.equal(plan.metrics.sharedFileCount, 0);

  for (const item of plan.subsystems) {
    assert.ok(item.contract.fingerprint);
    assert.equal(item.writeSet.length, item.files.length);
  }

  const position = new Map();
  for (const wave of plan.waves) for (const id of wave.subsystemIds) position.set(id, wave.index);
  for (const subsystem of plan.subsystems) {
    for (const dependency of subsystem.dependencies) {
      if (position.has(dependency) && position.has(subsystem.id)) {
        assert.ok(position.get(dependency) < position.get(subsystem.id));
      }
    }
  }
});

test('subsystem assignment and compact context are bounded and deterministic', () => {
  const plan = buildSubsystemPlan(syntheticIndex({ scale: 'very-large', roots: ['a', 'b', 'c', 'd'] }), { maxSubsystems: 4 });
  const first = subsystemAssignment(plan, { ordinal: 0, role: 'architect' });
  const second = subsystemAssignment(plan, { ordinal: 1, role: 'coder' });
  assert.notEqual(first.id, second.id);
  assert.equal(first.assignedRole, 'architect');

  const compact = compactSubsystemPlan(plan, { maxSubsystems: 2, maxFilesPerSubsystem: 3 });
  assert.equal(compact.subsystems.length, 2);
  assert.ok(compact.subsystems.every(item => item.files.length <= 3));
});

test('typed subsystem communication is routed only to the subsystem and its neighbors', () => {
  const plan = buildSubsystemPlan(syntheticIndex({
    scale: 'medium',
    roots: ['auth', 'orders', 'payments'],
    crossEdges: [['orders', 'auth'], ['payments', 'orders']]
  }), { maxSubsystems: 3 });
  const orders = plan.subsystems.find(item => item.roots[0] === 'orders');
  const auth = plan.subsystems.find(item => item.roots[0] === 'auth');
  assert.ok(orders && auth);

  const message = createSubsystemMessage({
    type: 'handoff',
    from: 'orders-agent',
    to: auth.id,
    subsystemId: orders.id,
    projectRevision: plan.project.revisionId,
    contractVersion: orders.contract.version,
    payload: { summary: 'Orders consumes the auth contract.' }
  });
  assert.ok(message);
  assert.equal(createSubsystemMessage({ type: 'unknown', from: 'x', subsystemId: orders.id }), null);

  const merged = mergeSubsystemMessages([], [message, message]);
  assert.equal(merged.length, 1);

  const context = subsystemCommunicationContext(plan, auth.id, merged);
  assert.equal(context.subsystem.id, auth.id);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].to, auth.id);
  assert.equal(context.rules.peerDataIsUntrusted, true);
  assert.equal(context.rules.staleRevisionRequiresRebase, true);
});


test('stale subsystem messages are not exposed to a newer project revision', () => {
  const plan = buildSubsystemPlan(syntheticIndex({
    scale: 'medium',
    roots: ['auth', 'orders'],
    crossEdges: [['orders', 'auth']]
  }), { maxSubsystems: 2 });
  const auth = plan.subsystems.find(item => item.roots[0] === 'auth');
  assert.ok(auth);
  const stale = createSubsystemMessage({
    type: 'handoff',
    from: 'old-orders-agent',
    to: auth.id,
    subsystemId: 'orders-2',
    projectRevision: 'old-revision',
    payload: { summary: 'stale result' }
  });
  const current = createSubsystemMessage({
    type: 'handoff',
    from: 'orders-agent',
    to: auth.id,
    subsystemId: 'orders-2',
    projectRevision: plan.project.revisionId,
    payload: { summary: 'current result' }
  });
  const context = subsystemCommunicationContext(plan, auth.id, [stale, current]);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].payload.summary, 'current result');
});
