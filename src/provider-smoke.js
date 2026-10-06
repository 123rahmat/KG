/**
 * Live Google Vertex AI Gemini contract check.
 *
 * The test suite mocks model responses, so this command catches upstream API
 * changes using the same runtime path as production. Missing project/auth
 * configuration is reported as skipped, never as passing.
 */
import { callModel, SUPPORTED_PROVIDERS, MODEL_DEFAULTS } from './runtime.js';
import { classifyGoal } from './classifier.js';

const LIMITS = { responseBytes: 4 * 1024 * 1024 };

export function configuredProviders(env = process.env) {
  const project = String(env.SMOKE_GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT || '').trim();
  const location = String(env.SMOKE_GOOGLE_CLOUD_LOCATION || env.GOOGLE_CLOUD_LOCATION || env.VERTEX_LOCATION || 'global').trim() || 'global';
  const accessToken = String(env.SMOKE_VERTEX_ACCESS_TOKEN || env.VERTEX_ACCESS_TOKEN || '').trim();
  const model = String(env.SMOKE_VERTEX_MODEL || env.VERTEX_MODEL || env.AI_MODEL || MODEL_DEFAULTS.google).trim();
  return SUPPORTED_PROVIDERS.map(provider => ({
    provider,
    project,
    location,
    accessToken,
    model
  }));
}

async function checkProvider({ provider, project, location, accessToken, model }, { fetchImpl }) {
  const config = {
    ai: {
      provider: 'google',
      project,
      location,
      accessToken: accessToken || null,
      model,
      modelId: `google:${model}`,
      models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
      effort: 'low'
    },
    limits: LIMITS,
    providerConcurrency: {}
  };
  const checks = [];
  const started = Date.now();

  let answer = null;
  try {
    answer = await callModel([
      { role: 'system', content: 'You are a connectivity check. Follow the instruction exactly.' },
      { role: 'user', content: 'Reply with the single word: ready' }
    ], { config, fetchImpl, retries: 0, modelId: `google:${model}`, effort: 'low' });
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

  const classification = await classifyGoal('Explain how photosynthesis works.', {
    config, fetchImpl, allowed: true, modelId: `google:${model}`
  });
  checks.push({
    name: 'classifier-contract',
    ok: classification.source === 'model' && classification.hints.actions.includes('answer'),
    detail: classification.source === 'model' ? classification.hints.actions.join(',') : classification.reason
  });

  return {
    provider,
    model,
    ok: checks.every(check => check.ok),
    elapsedMs: Date.now() - started,
    checks
  };
}

export async function runProviderSmoke({ env = process.env, fetchImpl = fetch } = {}) {
  const results = [];
  for (const entry of configuredProviders(env)) {
    if (!entry.project) {
      results.push({ provider: entry.provider, skipped: true, reason: 'no Vertex AI project' });
      continue;
    }
    results.push(await checkProvider(entry, { fetchImpl }));
  }
  const ran = results.filter(result => !result.skipped);
  return { results, ran: ran.length, ok: ran.every(result => result.ok) };
}
