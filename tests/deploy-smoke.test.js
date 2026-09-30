import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';
import { runDeploySmoke } from '../src/deploy-smoke.js';

test('the deploy smoke check passes a healthy deployment without creating anything', () =>
  withServer(async ({ base, seed, call }) => {
    const { token, workspace } = await seed();
    const summary = await runDeploySmoke({ baseUrl: base, apiKey: token, workspace });
    assert.equal(summary.ok, true, JSON.stringify(summary.checks));
    assert.deepEqual(summary.checks.map(item => item.name),
      ['health', 'readiness', 'reasoning-configured', 'app-served', 'security-headers', 'auth-required', 'sign-in', 'plan-preview']);
    const runs = await call('GET', '/api/runs', { token, workspace });
    assert.equal(runs.body.runs.length, 0, 'the smoke check created no run');
  }, { env: { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key' } }));

test('the deploy smoke check fails when the service is not ready or the key is wrong', () =>
  withServer(async ({ base, app }) => {
    app.locals.draining = true;
    const summary = await runDeploySmoke({ baseUrl: base, apiKey: 'not-a-key' });
    assert.equal(summary.ok, false);
    const failed = summary.checks.filter(item => !item.ok).map(item => item.name);
    assert.ok(failed.includes('readiness'));
    assert.ok(failed.includes('reasoning-configured'), 'no reasoning provider is configured here');
    assert.ok(failed.includes('sign-in'));
  }));

test('the deploy smoke check needs an http(s) URL', async () => {
  await assert.rejects(runDeploySmoke({ baseUrl: 'ai.example.com' }), /base URL/);
});
