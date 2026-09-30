/**
 * AI usage: a ledger of model calls, rolling usage windows, and limits.
 *
 * Every model call records who spent how many tokens, where and on what.
 * Two rolling windows are read from that ledger, the last 4 hours and the
 * last 7 days, and compared with the deployment's limits (0 = no limit).
 * A context meter reads the prompt size of the latest call in a chat.
 */

import { catalogEntry } from './model-catalog.js';
import { currentDbScope } from './db.js';
import { MODEL_DEFAULTS } from './runtime.js';
import { modelIdsForPlan } from './model-catalog.js';
import { ACTIVE_STATUSES } from './stripe.js';

const HOUR = 3_600_000;
export const WINDOWS = Object.freeze([
  { id: 'session', label: '4-hour window', ms: 4 * HOUR, limitKey: 'fourHourTokens' },
  { id: 'week', label: 'Weekly', ms: 7 * 24 * HOUR, limitKey: 'weeklyTokens' }
]);
const SOURCES = new Set(['chat', 'classifier']);

const count = value => Math.max(0, Math.round(Number(value) || 0));

/**
 * Record one model call for the person in the current database scope. A call
 * outside a scope (none should exist) is not recorded rather than misfiled.
 */
export async function recordUsage(pool, { runId = null, conversationId = null, source = 'chat', provider = '', model = '', inputTokens = 0, outputTokens = 0 } = {}) {
  const scope = currentDbScope();
  const input = count(inputTokens);
  const output = count(outputTokens);
  if (!scope?.principalId || !scope.workspaceId || input + output === 0) return false;
  await pool.query(
    `INSERT INTO usage_events (principal_id, workspace_id, run_id, conversation_id, source, provider, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [scope.principalId, scope.workspaceId, runId, conversationId, SOURCES.has(source) ? source : 'chat',
      String(provider ?? '').slice(0, 40), String(model ?? '').slice(0, 120), input, output]
  );
  return true;
}

/** Tokens a model can read at once. Deployment setting first, then the provider's usual size. */
export function contextWindowFor(config, modelId = null) {
  if (config.usage?.contextWindowTokens) return config.usage.contextWindowTokens;
  // The model catalogue knows each offered model's context window.
  return catalogEntry(modelId || config.ai?.modelId, config)?.contextWindow ?? null;
}

/**
 * The limits that apply in a workspace: its paid plan's while the
 * subscription is active, otherwise the deployment's defaults.
 */
export async function limitsFor(pool, config, workspaceId) {
  // With Stripe, no subscription means the free plan.
  const defaults = {
    fourHourTokens: config.usage?.fourHourTokens || 0,
    weeklyTokens: config.usage?.weeklyTokens || 0,
    modelIds: modelIdsForPlan(null, config),
    planId: config.stripe ? 'free' : null,
    planName: config.stripe ? config.billing?.free?.name ?? 'Free' : config.billing?.planName ?? null
  };
  if (!config.stripe || !workspaceId) return defaults;
  const { rows: [row] } = await pool.query(
    'SELECT plan_id, subscription_status FROM workspace_billing WHERE workspace_id = $1',
    [workspaceId]
  );
  const plan = row && ACTIVE_STATUSES.includes(row.subscription_status) ? config.stripe.plans.find(item => item.id === row.plan_id) : null;
  return plan ? { fourHourTokens: plan.fourHourTokens, weeklyTokens: plan.weeklyTokens, modelIds: modelIdsForPlan(plan, config), planId: plan.id, planName: plan.name } : defaults;
}

/**
 * Usage for one person: each rolling window with its limit and when it
 * frees up, the last 7 days by day, what the tokens went to, and (for a
 * chat) how full the model's context was on the latest call.
 */
export async function usageSummary(pool, { principalId, workspaceId = null, config, conversationId = null, now = new Date(), limits = null }) {
  const applied = limits ?? { fourHourTokens: config.usage?.fourHourTokens || 0, weeklyTokens: config.usage?.weeklyTokens || 0, modelIds: modelIdsForPlan(null, config), planName: config.billing?.planName ?? null };
  const since = new Date(now.getTime() - WINDOWS.at(-1).ms);
  const { rows } = await pool.query(
    `SELECT source, input_tokens, output_tokens, created_at
       FROM usage_events
      WHERE principal_id = $1
        AND ($2::text IS NULL OR workspace_id = $2)
        AND created_at > $3
      ORDER BY created_at ASC`,
    [principalId, workspaceId || null, since]
  );
  const windows = WINDOWS.map(window => {
    const start = now.getTime() - window.ms;
    const inside = rows.filter(row => new Date(row.created_at).getTime() > start);
    const input = inside.reduce((sum, row) => sum + row.input_tokens, 0);
    const output = inside.reduce((sum, row) => sum + row.output_tokens, 0);
    const limit = applied[window.limitKey] || 0;
    const used = input + output;
    // A rolling window frees tokens as its oldest calls age out. When over the
    // limit, it opens again once enough has aged out to go under it.
    let resetsAt = inside.length ? new Date(new Date(inside[0].created_at).getTime() + window.ms) : null;
    if (limit && used >= limit) {
      let remaining = used;
      for (const row of inside) {
        remaining -= row.input_tokens + row.output_tokens;
        if (remaining < limit) { resetsAt = new Date(new Date(row.created_at).getTime() + window.ms); break; }
      }
    }
    return {
      id: window.id,
      label: window.label,
      hours: window.ms / HOUR,
      used,
      input,
      output,
      calls: inside.length,
      limit: limit || null,
      percent: limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null,
      exceeded: Boolean(limit && used >= limit),
      resetsAt: resetsAt?.toISOString() ?? null
    };
  });

  const days = [];
  for (let back = 6; back >= 0; back -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    const next = day.getTime() + 24 * HOUR;
    const inside = rows.filter(row => { const at = new Date(row.created_at).getTime(); return at >= day.getTime() && at < next; });
    days.push({ date: day.toISOString().slice(0, 10), tokens: inside.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0) });
  }
  const bySource = {};
  for (const row of rows) bySource[row.source] = (bySource[row.source] ?? 0) + row.input_tokens + row.output_tokens;

  let context = null;
  const contextWindow = contextWindowFor(config);
  if (conversationId) {
    const { rows: [latest] } = await pool.query(
      `SELECT input_tokens, created_at FROM usage_events
        WHERE principal_id = $1
          AND ($2::text IS NULL OR workspace_id = $2)
          AND conversation_id = $3
          AND source = 'chat'
        ORDER BY created_at DESC LIMIT 1`,
      [principalId, workspaceId || null, conversationId]
    );
    context = {
      used: latest?.input_tokens ?? 0,
      limit: contextWindow,
      percent: latest && contextWindow ? Math.min(100, Math.round((latest.input_tokens / contextWindow) * 1000) / 10) : 0,
      at: latest?.created_at ?? null
    };
  }

  return {
    plan: applied.planName ?? null,
    model: config.ai ? { provider: config.ai.provider, model: config.ai.model || MODEL_DEFAULTS[config.ai.provider] || null, contextWindow } : null,
    modelIds: applied.modelIds ?? modelIdsForPlan(null, config),
    windows,
    days,
    bySource,
    context
  };
}

export class UsageLimitError extends Error {
  constructor(window, { canUpgrade = false } = {}) {
    const when = window.resetsAt ? new Date(window.resetsAt) : null;
    super(`You have reached your ${window.id === 'week' ? 'weekly' : '4-hour'} AI usage limit.${when ? ` It opens again at ${when.toISOString().slice(11, 16)} UTC${window.id === 'week' ? ` on ${when.toISOString().slice(0, 10)}` : ''}.` : ''}${canUpgrade ? ' A bigger plan in Settings → Billing raises it.' : ''} Work that does not use the AI still works.`);
    this.code = 'usage-limit-reached';
    this.status = 429;
    this.window = window;
  }
}

/** Throws UsageLimitError when a limited window is used up. No limits: no query. */
export async function assertUsageAllowed(pool, { principalId, config, workspaceId = null }) {
  const limits = await limitsFor(pool, config, workspaceId);
  if (!limits.fourHourTokens && !limits.weeklyTokens) return;
  const { windows } = await usageSummary(pool, { principalId, workspaceId, config, limits });
  const exceeded = windows.find(window => window.exceeded);
  if (exceeded) throw new UsageLimitError(exceeded, { canUpgrade: Boolean(config.stripe) });
}
