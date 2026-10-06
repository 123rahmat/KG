import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderSmoke } from '../src/provider-smoke.js';

const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const gemini = text => reply({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 }
});
const classifierReply = () => gemini(JSON.stringify({
  actions: ['answer'],
  signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
  unknownSituation: false,
  confidence: 1,
  crisis: 'none'
}));

test('unconfigured Vertex AI is skipped', async () => {
  const summary = await runProviderSmoke({ env: {}, fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(summary.ran, 0);
});

test('configured Vertex Gemini passes the smoke contract', async () => {
  const summary = await runProviderSmoke({
    env: {
      SMOKE_GOOGLE_CLOUD_PROJECT: 'test-project',
      SMOKE_VERTEX_ACCESS_TOKEN: 'token',
      SMOKE_VERTEX_MODEL: 'gemini-3.8-flash'
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options?.body || '{}');
      const raw = [
        body.systemInstruction?.parts?.map(part => part.text).join(' ') || '',
        ...(body.contents || []).flatMap(item => item.parts || []).map(part => part.text || '')
      ].join(' ');
      return /Classify the goal/i.test(raw) ? classifierReply() : gemini('ready');
    }
  });
  assert.equal(summary.ran, 1);
  assert.equal(summary.ok, true, JSON.stringify(summary.results));
});
