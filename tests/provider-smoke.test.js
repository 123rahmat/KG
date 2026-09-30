/**
 * The live provider check itself, against recorded provider shapes: it must
 * pass a well-formed provider, fail a broken one, and never count an
 * unconfigured provider as passing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderSmoke } from '../src/provider-smoke.js';

const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const classification = JSON.stringify({
  actions: ['answer'],
  signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
  unknownSituation: false,
  confidence: 0.9
});
// Gemini puts instructions in systemInstruction; the classifier's begin "Classify".
const isClassifier = options => String(JSON.parse(options.body).systemInstruction?.parts?.map(part => part.text).join('') ?? '').startsWith('Classify');
const gemini = (text, usage = true) => reply({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  ...(usage ? { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2, totalTokenCount: 14 } } : {})
});

test('unconfigured providers are skipped, not passed', async () => {
  const summary = await runProviderSmoke({ env: {}, fetchImpl: () => { throw new Error('nothing may be called'); } });
  assert.equal(summary.ran, 0);
  assert.ok(summary.results.every(result => result.skipped));
});

test('a provider honouring the contract passes', async () => {
  const summary = await runProviderSmoke({
    env: { SMOKE_GOOGLE_API_KEY: 'k' },
    fetchImpl: async (_url, options) => gemini(isClassifier(options) ? classification : 'ready')
  });
  assert.equal(summary.ran, 1);
  assert.equal(summary.ok, true, JSON.stringify(summary.results));
});

test('a changed or broken provider fails with the reason', async () => {
  const summary = await runProviderSmoke({
    env: { AI_PROVIDER: 'google', AI_API_KEY: 'k' },
    // Text but no usage, and a classifier reply that does not validate.
    fetchImpl: async () => gemini('ready', false)
  });
  assert.equal(summary.ok, false);
  const failed = summary.results.find(result => result.provider === 'google').checks.filter(check => !check.ok).map(check => check.name);
  assert.deepEqual(failed, ['usage-reported', 'classifier-contract']);
});
