import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, stepsIn } from './helpers.js';

const VERTEX = {
  AI_PROVIDER: 'google',
  GOOGLE_CLOUD_PROJECT: 'test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  VERTEX_ACCESS_TOKEN: 'secret-provider-key',
  AI_MODEL: 'gemini-3.8-flash'
};
const reply = text => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 }
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('the client can tell whether Gemini is connected, and never sees credentials', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const config = await call('GET', '/api/execution/config', { token, workspace });
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.reasoning, { configured: true, provider: 'google' });
    assert.ok(!JSON.stringify(config.body).includes('secret-provider-key'));
  }, { env: VERTEX }));

test('without Gemini configuration the client is told reasoning is not configured', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const config = await call('GET', '/api/execution/config', { token, workspace });
    assert.deepEqual(config.body.reasoning, { configured: false, provider: null });
  }));

test('a person can allow Gemini for a step without starting the work again', () =>
  withServer(async ({ call, seed, worker }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Explain recursion simply.', privacyConsent: { modelProvider: false } }
    });

    const refused = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(refused.body.execution.status, 'consent-required');
    assert.equal(refused.body.run.next, 'respond');

    const queued = await call('POST', `/api/runs/${run.id}/execute`, {
      ...auth, body: { background: true, modelConsent: true }
    });
    assert.equal(queued.status, 202);
    assert.equal(await worker.runOnce(), 1);
    const { body: after } = await call('GET', `/api/runs/${run.id}`, auth);
    assert.equal(after.tasks.find(task => task.id === 'respond').evidence.text, 'Recursion is a function calling itself.');
    assert.equal(after.next, 'verify');
  }, { env: VERTEX, fetchImpl: async () => reply('Recursion is a function calling itself.') }));

let aiCalls = 0;
test('consent cannot override a policy that denies sending data to Gemini', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed({
      policies: { workspace: { id: 'no-ai', deniedDataClasses: ['user-content'] } }
    });
    const { body: run } = await call('POST', '/api/runs', { token, workspace, body: { goal: 'Explain recursion simply.' } });
    const result = await call('POST', `/api/runs/${run.id}/execute`, { token, workspace, body: { modelConsent: true } });
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'situation-governance-blocked');
    assert.match(result.body.error, /server policy (?:denied|does not allow) a required data class/);
    const { body: audit } = await call('GET', '/api/audit', { token, workspace });
    const denied = audit.entries.find(entry => entry.action === 'run.execute.denied');
    assert.equal(denied?.outcome, 'denied');
    assert.equal(denied.detail.code, 'situation-governance-blocked');
    assert.notEqual(result.body.run.tasks.find(task => task.id === 'respond').status, 'complete');
    assert.equal(aiCalls, 0);
  }, { env: VERTEX, fetchImpl: async () => { aiCalls += 1; return reply('should not happen'); } }));

test('unusable Gemini code is explained, not recorded, and the step stays open', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Refactor this Python module.', privacyConsent: { modelProvider: true } }
    });
    for (const taskId of await stepsIn(call, auth, run.id, ['understand', 'discover-capabilities', 'adapt', 'plan'])) {
      await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId } });
    }
    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'approval', approved: true } });
    const result = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(result.status, 200);
    assert.equal(result.body.execution.status, 'invalid-model-output');
    assert.match(result.body.execution.message, /write the code yourself/);
    const { body: after } = await call('GET', `/api/runs/${run.id}`, auth);
    assert.equal(after.next, 'build-code');
    assert.ok(after.tokensUsed > 0);
  }, { env: VERTEX, fetchImpl: async () => reply('Sure! Here is some code.') }));
