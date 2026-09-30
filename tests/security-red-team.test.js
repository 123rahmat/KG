import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptField, decryptField, encryptJson, decryptJson
} from '../src/data-protection.js';
import {
  checkUrl, resolvePublic, isPublicAddress, GuardError
} from '../src/tools/net-guard.js';
import {
  signWebhook, verifyWebhook, StripeError
} from '../src/stripe.js';
import {
  mintKey, parseKey
} from '../src/identity.js';
import {
  signExecutionChallenge, verifyExecutionChallenge, executionPayloadDigest
} from '../src/execution.js';
import {
  assertProductionSandboxConfiguration, containerArgs, DEFAULT_IMAGES
} from '../src/sandbox.js';

const billingKey = Buffer.from('billing-key-32-bytes-long-000000');
const personalKey = Buffer.from('personal-key-32-bytes-long-00000');

test('crypto boundary rejects tampering and key crossover', () => {
  const encrypted = encryptField(billingKey, 'workspace-billing-v1', 'private billing text');
  assert.equal(decryptField(billingKey, 'workspace-billing-v1', encrypted), 'private billing text');
  assert.throws(() => decryptField(personalKey, 'workspace-billing-v1', encrypted));
  const parts = encrypted.split('.');
  parts[3] = parts[3].slice(0, -1) + (parts[3].endsWith('A') ? 'B' : 'A');
  assert.throws(() => decryptField(billingKey, 'workspace-billing-v1', parts.join('.')));
  const json = encryptJson(billingKey, 'workspace-billing-v1', { stripeCustomerId: 'cus_123' });
  assert.equal(decryptJson(billingKey, 'workspace-billing-v1', json).stripeCustomerId, 'cus_123');
  assert.equal(json.includes('cus_123'), false);
});

test('SSRF guard blocks private and special address families', async () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '2001:db8::1'
  ]) assert.equal(isPublicAddress(address), false, address);

  assert.throws(() => checkUrl('http://127.0.0.1:8080/'), GuardError);
  await assert.rejects(
    resolvePublic('rebind.example', {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]
    }),
    /non-public/
  );
});

test('Stripe webhook verification is time-bounded and tamper resistant', () => {
  const secret = 'whsec_red_team_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { metadata: {} } } });
  const now = Date.now();
  const header = signWebhook(payload, secret, Math.floor(now / 1000));
  assert.equal(verifyWebhook(Buffer.from(payload), header, secret, { now })?.id, 'evt_1');
  assert.throws(() => verifyWebhook(payload + 'x', header, secret, { now }), StripeError);
  assert.throws(() => verifyWebhook(payload, signWebhook(payload, secret, Math.floor(now / 1000) - 301), secret, { now }), StripeError);
});

test('execution challenges are bound to payload and expiry', () => {
  const ctx = {
    runId: 'run-a',
    taskId: 'task-a',
    taskType: 'code',
    attempt: 1,
    executionId: 'exec-a',
    executionTarget: 'local',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: 'n-1',
    payloadDigest: executionPayloadDigest({ language: 'python', source: 'print(1)' })
  };
  const secret = 'x'.repeat(64);
  const sig = signExecutionChallenge(secret, ctx);
  assert.equal(verifyExecutionChallenge(secret, ctx, sig), true);
  assert.equal(verifyExecutionChallenge(secret, { ...ctx, payloadDigest: executionPayloadDigest({ language: 'python', source: 'print(2)' }) }, sig), false);
  assert.equal(verifyExecutionChallenge(secret, { ...ctx, expiresAt: new Date(Date.now() - 1000).toISOString() }, sig), false);
});

test('API key token parser rejects malformed credential shapes', () => {
  const key = mintKey();
  assert.deepEqual(parseKey(key.token).id, key.id);
  for (const bad of ['', 'kg', 'kg..', 'kg.' + key.id, 'kg.' + key.id + '.x.y', 'pai.bad']) {
    assert.equal(parseKey(bad), null, bad);
  }
});

test('production sandbox policy requires immutable images, isolated runtime, TLS, and controlled install egress', () => {
  const images = {
    ...DEFAULT_IMAGES,
    python: 'python:3.12-slim@sha256:' + 'a'.repeat(64),
    node: 'node:22-slim@sha256:' + 'b'.repeat(64),
    go: 'golang:1.23-alpine@sha256:' + 'c'.repeat(64),
    java: 'eclipse-temurin:21-jdk-alpine@sha256:' + 'd'.repeat(64),
    gcc: 'gcc:14@sha256:' + 'e'.repeat(64),
    rust: 'rust:1-alpine@sha256:' + 'e'.repeat(64)
  };
  assert.throws(() => assertProductionSandboxConfiguration({ images, runtime: '', installProxy: 'https://proxy.example', tlsConfigured: true }), /SANDBOX_RUNTIME/);
  assert.throws(() => assertProductionSandboxConfiguration({ images, runtime: 'runc', installProxy: 'https://proxy.example', tlsConfigured: true }), /isolated runtime/);
  assert.throws(() => assertProductionSandboxConfiguration({ images, runtime: 'runsc', installProxy: '', tlsConfigured: true }), /SANDBOX_INSTALL_PROXY/);
  assert.throws(() => assertProductionSandboxConfiguration({ images, runtime: 'runsc', installProxy: 'https://proxy.example', tlsConfigured: false }), /TLS/);
  assert.doesNotThrow(() => assertProductionSandboxConfiguration({ images, runtime: 'runsc', installProxy: 'https://proxy.example', tlsConfigured: true, pullOnDemand: false }));
});

test('sandbox run phase keeps host escape controls disabled', () => {
  const args = containerArgs(
    {
      language: 'python',
      files: new Map([['main.py', Buffer.from('print(1)')]]),
      packages: [],
      timeoutMs: 1000,
      memoryMb: 128,
      stdin: '',
      spec: { run: ['python'], image: 'python' },
      project: false
    },
    { phase: 'run', workdir: '/tmp/work', name: 'red-team', images: DEFAULT_IMAGES, runtime: 'runsc' }
  );
  const joined = args.join(' ');
  assert.match(joined, /--network none/);
  assert.match(joined, /--read-only/);
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /no-new-privileges/);
  assert.match(joined, /--pids-limit 256/);
  assert.match(joined, /65534:65534/);
});


test('idempotency replay cache encrypts private workflow responses', () =>
  withServer(async ({ call, seed, pool }) => {
    const person = await seed();
    const headers = {
      'idempotency-key': 'red-team-private-replay',
      'x-workspace-id': person.workspace
    };
    const first = await call('POST', '/api/runs', {
      token: person.token,
      workspace: person.workspace,
      headers,
      body: { goal: 'Private workflow material that must not sit in a replay cache.' }
    });
    assert.equal(first.status, 201);
    const { rows: [stored] } = await pool.query(
      'SELECT response, response_enc, encryption_version FROM idempotency_keys WHERE key = $1 AND principal_id = $2',
      ['red-team-private-replay', person.principal.id]
    );
    assert.deepEqual(stored.response, {});
    assert.ok(stored.response_enc);
    assert.equal(stored.encryption_version, 1);
    assert.equal(stored.response_enc.includes('Private workflow material'), false);

    const replay = await call('POST', '/api/runs', {
      token: person.token,
      workspace: person.workspace,
      headers,
      body: { goal: 'Private workflow material that must not sit in a replay cache.' }
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotent-replay'), 'true');
    assert.equal(replay.body.goal, first.body.goal);
  }));

test('audit detail is encrypted at rest while event metadata remains queryable', () =>
  withServer(async ({ call, seed, pool }) => {
    const person = await seed();
    const created = await call('POST', '/api/runs', {
      token: person.token,
      workspace: person.workspace,
      body: { goal: 'Audit should preserve event shape without storing private detail in plaintext.' }
    });
    assert.equal(created.status, 201);
    const { rows: [row] } = await pool.query(
      'SELECT detail, detail_enc, detail_encryption_version FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY id DESC LIMIT 1',
      [person.workspace, 'run.create']
    );
    assert.equal(row.detail, null);
    assert.ok(row.detail_enc);
    assert.equal(row.detail_encryption_version, 1);
  }));

test('invalid bearer credentials hit an IP admission ceiling before key lookup', async () => {
  await withServer(async ({ call }) => {
    let last = null;
    for (let i = 0; i < 125; i += 1) {
      last = await call('GET', '/api/me', {
        token: 'kg.invalid-id-' + String(i).padStart(8, '0') + '.invalid-secret-' + String(i)
      });
      if (last.status === 429) break;
    }
    assert.equal(last?.status, 429);
    assert.equal(last?.body?.code, 'rate-limited');
  });
});
