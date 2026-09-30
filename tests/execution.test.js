import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessLocalCompatibility,
  chooseExecutionTarget,
  defaultExecutionRequirements,
  executionTargetCatalog,
  executionTargetsFor,
  normalizePreflight,
  signExecutionReceipt,
  verifyExecutionReceipt,
  executionSucceeded,
  executionIdFor,
  signExecutionChallenge,
  verifyExecutionChallenge
} from '../src/execution.js';

const GB = 1024 ** 3;

test('code execution exposes local and Kindgleam sandbox targets', () => {
  assert.deepEqual(executionTargetsFor('code'), ['local', 'general-ai-sandbox']);
});

test('there is no simulation task type: nothing can be placed for it', () => {
  assert.deepEqual(executionTargetsFor('simulate'), []);
  assert.equal(chooseExecutionTarget('simulate', { availableTargets: ['local', 'generic-tool-router'] }).status, 'unsupported');
});

test('investigation supports generic and provider-backed research targets', () => {
  assert.deepEqual(executionTargetsFor('investigate'), ['generic-tool-router', 'builtin-research']);
  assert.equal(executionTargetCatalog().some(target => target.id === 'builtin-research'), true);
});

test('a sufficient local machine is selected first', () => {
  const decision = chooseExecutionTarget('code', {
    preflight: {
      cpuCores: 8,
      memoryBytes: 32 * GB,
      storageBytes: 100 * GB,
      availableStorageBytes: 50 * GB,
      agent: { available: true, version: '1.0.0' }
    },
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.status, 'approval-required');
  assert.equal(decision.target, 'local');
  assert.equal(decision.requiresApproval, true);
});

test('insufficient local code falls back to the Kindgleam sandbox', () => {
  const decision = chooseExecutionTarget('code', {
    preflight: {
      cpuCores: 1,
      memoryBytes: 1 * GB,
      availableStorageBytes: 256 * 1024 ** 2,
      agent: { available: true, version: '1.0.0' }
    },
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.status, 'approval-required');
  assert.equal(decision.target, 'general-ai-sandbox');
  assert.equal(decision.fallbackFromLocal, true);
});

test('unknown local resources never masquerade as compatible', () => {
  const result = assessLocalCompatibility('code', { agent: { available: true }, }, defaultExecutionRequirements('code'));
  assert.equal(result.status, 'unknown');
  assert.equal(result.compatible, false);
});

test('explicit local selection refuses insufficient resources instead of switching silently', () => {
  const decision = chooseExecutionTarget('code', {
    preference: 'local',
    preflight: {
      cpuCores: 1,
      memoryBytes: 512 * 1024 ** 2,
      availableStorageBytes: 128 * 1024 ** 2,
      agent: { available: true, version: '1.0.0' }
    },
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.status, 'local-insufficient');
  assert.equal(decision.target, null);
});

test('explicit fallback can be disabled by policy or user preference', () => {
  const decision = chooseExecutionTarget('code', {
    preflight: {
      cpuCores: 1,
      memoryBytes: 1 * GB,
      availableStorageBytes: 256 * 1024 ** 2,
      agent: { available: true, version: '1.0.0' }
    },
    cloudFallbackAllowed: false,
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.target, null);
  assert.equal(decision.status, 'local-insufficient');
});

test('preflight normalization strips malformed resource values', () => {
  const preflight = normalizePreflight({
    cpuCores: '8',
    memoryBytes: 'bad',
    gpu: { available: true, name: 'GPU', memoryBytes: '4294967296' },
    software: { python: '3.12', '': 'ignored' }
  });
  assert.equal(preflight.cpuCores, 8);
  assert.equal(preflight.memoryBytes, null);
  assert.equal(preflight.gpu.memoryBytes, 4294967296);
  assert.deepEqual(preflight.software, { python: '3.12' });
});

test('execution target catalog is stable and copy-safe', () => {
  const first = executionTargetCatalog();
  first[0].taskTypes.push('mutated');
  const second = executionTargetCatalog();
  assert.equal(second[0].taskTypes.includes('mutated'), false);
});

test('local code requires a preflight before any target is selected', () => {
  const decision = chooseExecutionTarget('code', {
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.status, 'preflight-required');
  assert.equal(decision.target, null);
});


test('local execution requires a paired local agent even when browser resources look sufficient', () => {
  const decision = chooseExecutionTarget('code', {
    preflight: {
      cpuCores: 8,
      memoryBytes: 16 * GB,
      availableStorageBytes: 32 * GB
    },
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.target, 'general-ai-sandbox');
  assert.equal(decision.fallbackFromLocal, true);
});

test('local execution receipts are cryptographically bound to the run and task', () => {
  const secret = 'a'.repeat(48);
  const receipt = {
    executionTarget: 'local',
    executed: true,
    status: 'completed',
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    outputTruncated: false,
    startedAt: '2026-09-22T16:00:00.000Z',
    completedAt: '2026-09-22T16:00:01.000Z',
    agentVersion: '1.0.0'
  };
  const executionId = executionIdFor({ runId: 'run-1', taskId: 'build-code', attempt: 3, executionTarget: 'local' });
  const context = { runId: 'run-1', taskId: 'build-code', taskType: 'code', attempt: 3, executionId, challengeNonce: 'nonce-3', receipt: { ...receipt, executionId, challengeNonce: 'nonce-3', attempt: 3 } };
  const signature = signExecutionReceipt(secret, context);
  assert.equal(verifyExecutionReceipt(secret, context, signature), true);
  assert.equal(
    verifyExecutionReceipt(secret, { ...context, taskId: 'other-task' }, signature),
    false
  );
  assert.equal(
    verifyExecutionReceipt(secret, {
      ...context,
      receipt: { ...context.receipt, stdout: 'tampered' }
    }, signature),
    false
  );
  assert.equal(
    verifyExecutionReceipt(secret, { ...context, attempt: 4 }, signature),
    false
  );
  assert.equal(
    verifyExecutionReceipt(secret, {
      ...context,
      challengeNonce: 'other-nonce',
      receipt: { ...context.receipt, challengeNonce: 'other-nonce' }
    }, signature),
    false
  );
});

test('execution success is separate from execution occurrence', () => {
  assert.equal(executionSucceeded({ executed: true, status: 'completed', exitCode: 0 }), true);
  assert.equal(executionSucceeded({ executed: true, status: 'failed', exitCode: 1 }), false);
  assert.equal(executionSucceeded({ executed: true, status: 'timeout' }), false);
  assert.equal(executionSucceeded({ executed: false, status: 'failed' }), false);
  assert.notEqual(
    executionIdFor({ runId: 'run-1', taskId: 'build-code', attempt: 3, executionTarget: 'local' }),
    executionIdFor({ runId: 'run-1', taskId: 'build-code', attempt: 4, executionTarget: 'local' })
  );
});


test('explicit remote coding target does not require local preflight', () => {
  const decision = chooseExecutionTarget('code', {
    preference: 'general-ai-sandbox',
    availableTargets: ['local', 'general-ai-sandbox']
  });
  assert.equal(decision.status, 'approval-required');
  assert.equal(decision.target, 'general-ai-sandbox');
});

test('minimum software versions are checked during local preflight', () => {
  const result = assessLocalCompatibility('code', {
    cpuCores: 4,
    memoryBytes: 8 * GB,
    availableMemoryBytes: 8 * GB,
    availableStorageBytes: 8 * GB,
    agent: { available: true },
    software: { node: '18.20.0' }
  }, {
    cpuCores: 2,
    memoryBytes: 2 * GB,
    storageBytes: 1 * GB,
    software: { node: '20.0.0' }
  });
  assert.equal(result.compatible, false);
  assert.ok(result.reasons.some(reason => /node 20/.test(reason)));
});


test('execution challenges expire and bind the exact task', () => {
  const secret = 'b'.repeat(48);
  const context = {
    runId: 'run-1',
    taskId: 'test-code',
    taskType: 'code',
    attempt: 7,
    executionTarget: 'local',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'nonce-1'
  };
  const signature = signExecutionChallenge(secret, context);
  assert.equal(verifyExecutionChallenge(secret, context, signature), true);
  assert.equal(
    verifyExecutionChallenge(secret, { ...context, taskId: 'other' }, signature),
    false
  );
  assert.equal(
    verifyExecutionChallenge(secret, { ...context, attempt: 8 }, signature),
    false
  );
  assert.equal(
    verifyExecutionChallenge(secret, { ...context, expiresAt: new Date(Date.now() - 1_000).toISOString() }, signature),
    false
  );
});


test('no execution target is a simulation engine or a simulation runner', () => {
  const targets = executionTargetCatalog();
  assert.ok(!targets.some(target => ['builtin-simulation', 'professor-cloud'].includes(target.id)));
  assert.ok(!targets.some(target => target.taskTypes.includes('simulate')));
});
