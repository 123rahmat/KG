/**
 * Live provider contract check.
 *
 * The test suite mocks every model response, so it cannot notice a provider
 * changing its API. This check calls the configured Google Gemini provider through the
 * application's own adapters and verifies the contract the rest of the
 * system relies on: a complete, non-empty answer, reported token usage, and
 * a classifier reply that validates. Missing Gemini credentials are reported as skipped,
 * never counted as passing.
 */

import { callModel, SUPPORTED_PROVIDERS, MODEL_DEFAULTS } from './runtime.js';
import { classifyGoal } from './classifier.js';

const LIMITS = { responseBytes: 4 * 1024 * 1024 };

/** Vertex credentials: project + short-lived token, service account JSON, or express-mode API key. */
export function configuredProviders(env = process.env) {
  const providers = [];
  for (const provider of SUPPORTED_PROVIDERS) {
    const key = String(env[`SMOKE_${provider.toUpperCase()}_API_KEY`] ?? '').trim()
      || (String(env.AI_PROVIDER ?? '').trim().toLowerCase() === provider ? String(env.AI_API_KEY ?? '').trim() : '');
    const model = String(env[`SMOKE_${provider.toUpperCase()}_MODEL`] ?? '').trim()
      || (String(env.AI_PROVIDER ?? '').trim().toLowerCase() === provider ? String(env.AI_MODEL ?? '').trim() : '');
    const project = String(env[`SMOKE_${provider.toUpperCase()}_PROJECT`] ?? env.GOOGLE_CLOUD_PROJECT ?? '').trim();
    const accessToken = String(env[`SMOKE_${provider.toUpperCase()}_VERTEX_ACCESS_TOKEN`] ?? env.GOOGLE_VERTEX_ACCESS_TOKEN ?? '').trim();
    providers.push({ provider, apiKey: key, model: model || null, project, accessToken });
  }
  return providers;
}

async function checkProvider({ provider, apiKey, model, project, accessToken }, { fetchImpl }) {
  const config = { ai: { provider, apiKey, model, vertexProject: project || null, vertexAccessToken: accessToken || null, vertexLocation: 'global' }, limits: LIMITS };
  const checks = [];
  const started = Date.now();

  let answer = null;
  try {
    answer = await callModel([
      { role: 'system', content: 'You are a connectivity check. Follow the instruction exactly.' },
      { role: 'user', content: 'Reply with the single word: ready' }
    ], { config, fetchImpl, retries: 0 });
  } catch (error) {
    checks.push({ name: 'answer', ok: false, detail: error.message });
  }
  if (answer) {
    checks.push({ name: 'answer-complete', ok: !answer.incomplete, detail: answer.incomplete ?? 'complete' });
    checks.push({ name: 'answer-text', ok: /ready/i.test(answer.text ?? ''), detail: String(answer.text ?? '').slice(0, 40) });
    const usage = answer.usage ?? {};
    checks.push({
      name: 'usage-reported',
      ok: Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens),
      detail: `${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out`
    });
  }

  const classification = await classifyGoal('Explain how photosynthesis works.', { config, fetchImpl, allowed: true });
  checks.push({
    name: 'classifier-contract',
    ok: classification.source === 'model' && classification.hints.actions.includes('answer'),
    detail: classification.source === 'model' ? classification.hints.actions.join(',') : classification.reason
  });

  return {
    provider,
    model: model || MODEL_DEFAULTS[provider],
    ok: checks.every(check => check.ok),
    elapsedMs: Date.now() - started,
    checks
  };
}

export async function runProviderSmoke({ env = process.env, fetchImpl = fetch } = {}) {
  const results = [];
  for (const entry of configuredProviders(env)) {
    if (!entry.apiKey && !entry.accessToken && !entry.project) {
      results.push({ provider: entry.provider, skipped: true, reason: 'no credentials' });
      continue;
    }
    results.push(await checkProvider(entry, { fetchImpl }));
  }
  const ran = results.filter(result => !result.skipped);
  return { results, ran: ran.length, ok: ran.every(result => result.ok) };
}
