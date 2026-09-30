import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

function env(overrides = {}) {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/professor',
    BILLING_ENCRYPTION_KEY: Buffer.from('billing-key-32-bytes-long-000000').toString('base64'),
    PERSONAL_DATA_ENCRYPTION_KEY: Buffer.from('personal-key-32-bytes-long-00000').toString('base64'),
    ...overrides
  };
}

const ALL_AI = {
  AI_PROVIDERS_JSON: JSON.stringify({
    google: { apiKey: 'test-google', model: 'gemini-3.8-flash' }
  })
};


test('local-agent configuration requires a shared secret', () => {
  assert.throws(
    () => loadConfig(env({ LOCAL_AGENT_URL: 'http://127.0.0.1:8765' })),
    /LOCAL_AGENT_SHARED_SECRET is required/
  );
});

test('local-agent shared secret must be strong enough for receipt signing', () => {
  assert.throws(
    () => loadConfig(env({
      LOCAL_AGENT_URL: 'http://127.0.0.1:8765',
      LOCAL_AGENT_SHARED_SECRET: 'short'
    })),
    /at least 32 characters/
  );
});

test('valid local-agent pairing configuration loads', () => {
  const config = loadConfig(env({
    LOCAL_AGENT_URL: 'http://127.0.0.1:8765',
    LOCAL_AGENT_SHARED_SECRET: 'a'.repeat(32)
  }));
  assert.equal(config.execution.localAgentUrl, 'http://127.0.0.1:8765/');
  assert.equal(config.execution.localAgentSharedSecret.length, 32);
});


test('production requires dedicated encryption keys for billing and personal data', () => {
  const base = env({
    NODE_ENV: 'production',
    COOKIE_SECURE: 'true',
    PGSSLMODE: 'verify',
    PGSSLROOTCERT: '/tmp/ca.pem',
    OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
    DATABASE_URL: 'postgres://runtime:secret@db.example/professor',
    DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
    BACKUP_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
    RESTORE_DATABASE_URL: 'postgres://restore:secret@db.example/professor',
    ...ALL_AI
  });
  assert.throws(() => loadConfig({ ...base, BILLING_ENCRYPTION_KEY: '' }), /BILLING_ENCRYPTION_KEY is required in production/);
  assert.throws(() => loadConfig({ ...base, PERSONAL_DATA_ENCRYPTION_KEY: '' }), /PERSONAL_DATA_ENCRYPTION_KEY is required in production/);
});

test('production requires verified database TLS', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_MIGRATION_URL: 'postgres://migrate:secret@localhost:5432/professor',
      PGSSLMODE: 'verify',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64')
    })),
    /PGSSLMODE=verify requires PGSSLROOTCERT/
  );
});

test('production runner endpoints must use HTTPS and a strong runner token', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
      SANDBOX_RUNNER_URL: 'http://runner.internal',
      RUNNER_TOKEN: 'r'.repeat(32)
    })),
    /Managed runner URLs must use HTTPS/
  );

  const config = loadConfig(env({
    NODE_ENV: 'production',
    ...ALL_AI,
    COOKIE_SECURE: 'true',
    PGSSLMODE: 'verify',
    PGSSLROOTCERT: '/tmp/ca.pem',
    OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
    DATABASE_URL: 'postgres://runtime:secret@db.example/professor',
    DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
    BACKUP_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
    RESTORE_DATABASE_URL: 'postgres://restore:secret@db.example/professor',
    SANDBOX_RUNNER_URL: 'https://runner.internal',
    RUNNER_TOKEN: 'r'.repeat(32)
  }));
  assert.equal(config.runners.sandbox, 'https://runner.internal/');
});

test('production requires a separate migration database identity', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64')
    })),
    /DATABASE_MIGRATION_URL is required/
  );
});

test('production rejects reusing the runtime database URL as migration URL', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_MIGRATION_URL: 'postgres://user:pass@localhost:5432/professor',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64')
    })),
    /must use a separate privileged database identity/
  );
});

test('production requires different PostgreSQL usernames for runtime and migration planes', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_URL: 'postgres://professor_runtime:pass@db.example/professor',
      DATABASE_MIGRATION_URL: 'postgres://professor_runtime:other@db.example/professor',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64')
    })),
    /different PostgreSQL username/
  );
});


test('production requires dedicated backup and restore database identities', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_URL: 'postgres://runtime:secret@db.example/professor',
      DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
      BACKUP_DATABASE_URL: 'postgres://runtime:secret@db.example/professor',
      RESTORE_DATABASE_URL: 'postgres://restore:secret@db.example/professor'
    })),
    /BACKUP_DATABASE_URL.*runtime/
  );

  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      DATABASE_URL: 'postgres://runtime:secret@db.example/professor',
      DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
      BACKUP_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
      RESTORE_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64')
    })),
    /BACKUP_DATABASE_URL and RESTORE_DATABASE_URL/
  );

  const config = loadConfig(env({
    NODE_ENV: 'production',
    ...ALL_AI,
    COOKIE_SECURE: 'true',
    DATABASE_URL: 'postgres://runtime:secret@db.example/professor',
    DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
    BACKUP_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
    RESTORE_DATABASE_URL: 'postgres://restore:secret@db.example/professor',
    PGSSLMODE: 'verify',
    PGSSLROOTCERT: '/tmp/ca.pem',
    OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64')
  }));
  assert.equal(config.database.backupUrl.includes('backup:'), true);
  assert.equal(config.database.restoreUrl.includes('restore:'), true);
});


test('production requires a reasoning provider', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
      DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
      BACKUP_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
      RESTORE_DATABASE_URL: 'postgres://restore:secret@db.example/professor'
    })),
    /At least one AI provider must be configured in production/
  );
});

test('production local execution requires a declared isolation boundary', () => {
  assert.throws(
    () => loadConfig(env({
      NODE_ENV: 'production',
      AI_PROVIDER: 'google',
      AI_API_KEY: 'test-key',
      AI_MODEL: 'gemini-3.8-flash',
      COOKIE_SECURE: 'true',
      PGSSLMODE: 'verify',
      PGSSLROOTCERT: '/tmp/ca.pem',
      OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
      DATABASE_MIGRATION_URL: 'postgres://migrate:secret@db.example/professor',
      BACKUP_DATABASE_URL: 'postgres://backup:secret@db.example/professor',
      RESTORE_DATABASE_URL: 'postgres://restore:secret@db.example/professor',
      LOCAL_AGENT_URL: 'https://127.0.0.1:8765',
      LOCAL_AGENT_SHARED_SECRET: 's'.repeat(32)
    })),
    /LOCAL_AGENT_ISOLATION must be container or vm/
  );
});



test('adaptive multi-agent configuration accepts bounded modes and agent counts', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/kindgleam', AI_PROVIDER: 'google', AI_API_KEY: 'k' };
  assert.equal(loadConfig(base).agents.multiAgent, 'auto');
  assert.equal(loadConfig({ ...base, MULTI_AGENT_MODE: 'always', MULTI_AGENT_MAX_AGENTS: '2' }).agents.multiAgent, 'always');
  assert.equal(loadConfig({ ...base, MULTI_AGENT_MAX_AGENTS: '1' }).agents.maxAgents, 1);
  assert.throws(() => loadConfig({ ...base, MULTI_AGENT_MODE: 'sometimes' }), /MULTI_AGENT_MODE must be/);
  assert.equal(loadConfig({ ...base, MULTI_AGENT_MAX_AGENTS: '5' }).agents.maxAgents, 5);
  assert.throws(() => loadConfig({ ...base, MULTI_AGENT_MAX_AGENTS: '6' }), /MULTI_AGENT_MAX_AGENTS must be/);
});

test('AI_EFFORT chooses how deeply Gemini reasons, and only real levels are accepted', () => {
  const env = { DATABASE_URL: 'postgres://u:p@h:5432/d', AI_PROVIDER: 'google', AI_API_KEY: 'k' };
  assert.equal(loadConfig(env).ai.effort, null, 'unset keeps the model default');
  assert.equal(loadConfig({ ...env, AI_EFFORT: 'HIGH' }).ai.effort, 'high');
  assert.throws(() => loadConfig({ ...env, AI_EFFORT: 'extreme' }), /AI_EFFORT must be one of/);
});

test('TRUST_PROXY never trusts every hop', () => {
  const env = extra => ({ DATABASE_URL: 'postgres://u:p@h:5432/d', ...extra });
  assert.equal(loadConfig(env({})).trustProxy, false);
  assert.equal(loadConfig(env({ TRUST_PROXY: 'true' })).trustProxy, 1, 'true means the one proxy you run');
  assert.equal(loadConfig(env({ TRUST_PROXY: '2' })).trustProxy, 2);
  assert.deepEqual(loadConfig(env({ TRUST_PROXY: 'loopback, 10.0.0.0/8' })).trustProxy, ['loopback', '10.0.0.0/8']);
  assert.throws(() => loadConfig(env({ TRUST_PROXY: 'everyone' })), /TRUST_PROXY must be/);
});

test('SHUTDOWN_DRAIN_MS defaults to no delay and is bounded', () => {
  const env = extra => ({ DATABASE_URL: 'postgres://u:p@h:5432/d', ...extra });
  assert.equal(loadConfig(env({})).limits.shutdownDrainMs, 0);
  assert.equal(loadConfig(env({ SHUTDOWN_DRAIN_MS: '5000' })).limits.shutdownDrainMs, 5000);
  assert.throws(() => loadConfig(env({ SHUTDOWN_DRAIN_MS: '600000' })), /SHUTDOWN_DRAIN_MS/);
});

test('METRICS_TOKEN must be long enough to be a secret', () => {
  const env = extra => ({ DATABASE_URL: 'postgres://u:p@h:5432/d', ...extra });
  assert.equal(loadConfig(env({})).metricsToken, null);
  assert.throws(() => loadConfig(env({ METRICS_TOKEN: 'short' })), /METRICS_TOKEN/);
});

test('no simulation runner is configured: its old variables are ignored', () => {
  const base = { DATABASE_URL: 'postgres://user:pass@localhost:5432/kindgleam' };
  const config = loadConfig({ ...base, KINDGLEAM_CLOUD_SIMULATION_RUNNER_URL: 'http://sim.test' });
  assert.equal('professorCloudSimulation' in config.runners, false);
  assert.equal('simulation' in config, false);
});

test('backup Gemini models are read in order and must be Gemini models', () => {
  const env = { DATABASE_URL: 'postgres://u:p@localhost:5432/kindgleam', AI_PROVIDER: 'google', AI_API_KEY: 'k' };
  assert.deepEqual(loadConfig({ ...env, AI_FALLBACK_MODELS: 'gemini-3.5-flash, gemini-3.1-flash-lite' }).ai.fallbackModels, ['gemini-3.5-flash', 'gemini-3.1-flash-lite']);
  assert.deepEqual(loadConfig(env).ai.fallbackModels, []);
  assert.throws(() => loadConfig({ ...env, AI_FALLBACK_MODELS: 'gpt-5' }), /AI_FALLBACK_MODELS lists "gpt-5"/);
});
