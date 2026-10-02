/**
 * AI usage: a ledger of model calls, rolling usage windows, and limits.
 *
 * Every model call records who spent how many tokens, where and on what.
 * Two rolling windows are read from that ledger, the last 4 hours and the
 * last 7 days, and compared with the deployment's limits (0 = no limit).
 * A context meter reads the prompt size of the latest call in a chat.
 */

import crypto from 'node:crypto';
import { catalogEntry } from './model-catalog.js';
import { currentDbScope, transaction } from './db.js';
import { MODEL_DEFAULTS } from './runtime.js';
import { modelIdsForPlan } from './model-catalog.js';

const HOUR = 3_600_000;
export const WINDOWS = Object.freeze([
  { id: 'session', label: '4-hour window', ms: 4 * HOUR, limitKey: 'fourHourTokens' },
  { id: 'week', label: 'Weekly', ms: 7 * 24 * HOUR, limitKey: 'weeklyTokens' }
]);
const SOURCES = new Set(['chat', 'classifier', 'multi-agent', 'web-search', 'chat-retry', 'verification-review']);

const count = value => Math.max(0, Math.round(Number(value) || 0));

function mergeEntitledLimit(current, candidate) {
  if (current === null) return candidate;
  if (current === 0 || candidate === 0) return 0; // 0 means unlimited.
  return Math.max(current, candidate);
}

async function accountEntitledLimits(pool, config, principalId, defaults) {
  if (!config.stripe || !principalId) return null;
  const { rows } = await pool.query(
    'SELECT plan_id FROM kg_account_active_billing_plans($1)',
    [principalId]
  );
  const plansById = new Map((config.stripe.plans ?? []).map(plan => [plan.id, plan]));
  const plans = [...new Set(rows.map(row => row.plan_id))]
    .map(planId => plansById.get(planId))
    .filter(Boolean);
  if (!plans.length) return defaults;

  let fourHourTokens = null;
  let weeklyTokens = null;
  const modelIds = new Set();
  for (const plan of plans) {
    fourHourTokens = mergeEntitledLimit(fourHourTokens, Number(plan.fourHourTokens || 0));
    weeklyTokens = mergeEntitledLimit(weeklyTokens, Number(plan.weeklyTokens || 0));
    for (const modelId of modelIdsForPlan(plan, config)) modelIds.add(modelId);
  }

  return {
    fourHourTokens: fourHourTokens ?? defaults.fourHourTokens,
    weeklyTokens: weeklyTokens ?? defaults.weeklyTokens,
    modelIds: [...modelIds],
    planId: plans.length === 1 ? plans[0].id : null,
    planName: plans.length === 1 ? plans[0].name : 'Account-wide entitlement',
    planScope: 'principal'
  };
}

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
 * Resolve the AI entitlement for the person, never from the active workspace.
 * Active subscriptions on any workspace the person belongs to contribute to
 * one account-wide allowance; each window takes the most permissive limit and
 * model access is the union of those active plans. If no paid subscription is
 * active, the deployment's free/default limits apply.
 *
 * workspaceId is retained for legacy callers, but paid quota resolution requires
 * principalId so a workspace switch can never select another allowance.
 */
export async function limitsFor(pool, config, workspaceId, principalId = null) {
  // With Stripe, no subscription means the free plan.
  const defaults = {
    fourHourTokens: config.usage?.fourHourTokens || 0,
    weeklyTokens: config.usage?.weeklyTokens || 0,
    modelIds: modelIdsForPlan(null, config),
    planId: config.stripe ? 'free' : null,
    planName: config.stripe ? config.billing?.free?.name ?? 'Free' : config.billing?.planName ?? null
  };
  if (!config.stripe) return defaults;
  if (principalId) return accountEntitledLimits(pool, config, principalId, defaults);
  // Fail closed for Stripe-enabled callers that do not provide the person.
  // Usage admission always has a principal; without one, paid entitlement
  // must not be selected from an arbitrary workspace.
  return defaults;
}

/**
 * Usage for one person: each rolling window with its limit and when it
 * frees up, the last 7 days by day, what the tokens went to, and (for a
 * chat) how full the model's context was on the latest call.
 */
export async function usageSummary(pool, { principalId, workspaceId = null, config, conversationId = null, now = new Date(), limits = null }) {
  const applied = limits ?? await limitsFor(pool, config, workspaceId, principalId);
  const since = new Date(now.getTime() - WINDOWS.at(-1).ms);
  const { rows: globalRows } = await pool.query(
    `SELECT source, input_tokens, output_tokens, created_at
       FROM usage_events
      WHERE principal_id = $1
        AND created_at > $2
      ORDER BY created_at ASC`,
    [principalId, since]
  );
  const windows = WINDOWS.map(window => {
    // Both AI quota windows are one user-wide budget. Chat context remains
    // conversation-specific below, and workspace membership never creates a
    // second quota pool that could be used to bypass the account limit.
    const sourceRows = globalRows;
    const start = now.getTime() - window.ms;
    const inside = sourceRows.filter(row => new Date(row.created_at).getTime() > start);
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
      scope: 'principal',
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
    const inside = globalRows.filter(row => { const at = new Date(row.created_at).getTime(); return at >= day.getTime() && at < next; });
    days.push({ date: day.toISOString().slice(0, 10), tokens: inside.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0) });
  }
  const bySource = {};
  for (const row of globalRows) bySource[row.source] = (bySource[row.source] ?? 0) + row.input_tokens + row.output_tokens;

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
    quotaScope: {
      fourHour: 'principal',
      weekly: 'principal',
      entitlement: 'principal',
      context: 'conversation'
    },
    days,
    bySource,
    context
  };
}


const RESERVATION_TTL_MS = 5 * 60_000;
const MIN_ADMISSION_TOKENS = 32;
const MAX_RESERVATION_TOKENS = 500_000;

function usageWindowStats(rows, windowMs, nowMs = Date.now()) {
  const start = nowMs - windowMs;
  const inside = rows.filter(row => new Date(row.created_at).getTime() > start)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const used = inside.reduce((sum, row) => sum + Number(row.input_tokens || 0) + Number(row.output_tokens || 0), 0);
  return { inside, used };
}

export async function reserveUsage(pool, {
  principalId, workspaceId, runId = null, estimatedTokens = 0, config, ttlMs = RESERVATION_TTL_MS
} = {}) {
  if (!principalId || !workspaceId) return null;
  const rawEstimate = Math.min(MAX_RESERVATION_TOKENS, count(estimatedTokens));
  if (!rawEstimate) return null;
  const limits = await limitsFor(pool, config, workspaceId, principalId);
  const safeTtl = Math.max(30_000, Math.min(900_000, Number(ttlMs) || RESERVATION_TTL_MS));

  return transaction(pool, async client => {
    // Both quota windows are user-wide, so all workspaces for this person share
    // one atomic reservation lock. This prevents cross-workspace races from
    // bypassing either the 4-hour or weekly account limit.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['kindgleam:usage:principal:' + principalId]
    );
    await client.query(
      "UPDATE usage_reservations SET state='released', updated_at=now() WHERE principal_id=$1 AND state='active' AND expires_at<=now()",
      [principalId]
    );

    let runUsed = 0;
    let runMax = null;
    if (runId) {
      const { rows: [run] } = await client.query(
        'SELECT tokens_used, max_tokens FROM runs WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 FOR UPDATE',
        [runId, workspaceId, principalId]
      );
      if (!run) throw new Error('Run not found for usage reservation');
      runUsed = Number(run.tokens_used || 0);
      runMax = run.max_tokens == null ? null : Number(run.max_tokens);
    }

    const { rows: globalUsageRows } = await client.query(
      "SELECT input_tokens, output_tokens, created_at FROM usage_events WHERE principal_id=$1 AND created_at>now()-interval '7 days'",
      [principalId]
    );
    const { rows: globalReservationRows } = await client.query(
      "SELECT estimated_tokens, expires_at, run_id, workspace_id FROM usage_reservations WHERE principal_id=$1 AND state='active' AND expires_at>now()",
      [principalId]
    );
    const globalReserved = globalReservationRows.reduce((sum, row) => sum + Number(row.estimated_tokens || 0), 0);
    const runReserved = runId
      ? globalReservationRows.filter(row => row.run_id === runId && row.workspace_id === workspaceId).reduce((sum, row) => sum + Number(row.estimated_tokens || 0), 0)
      : 0;

    const available = [];
    for (const window of WINDOWS) {
      const limit = Number(limits[window.limitKey] || 0);
      if (!limit) continue;
      const sourceRows = globalUsageRows;
      const reservedForWindow = globalReserved;
      const stats = usageWindowStats(sourceRows, window.ms);
      available.push({
        window,
        limit,
        used: stats.used + reservedForWindow,
        rows: stats.inside,
        remaining: Math.max(0, limit - stats.used - reservedForWindow)
      });
    }
    if (runMax !== null) {
      available.push({
        window: { id: 'run', label: 'Run token budget', ms: 0 },
        limit: runMax,
        used: runUsed + runReserved,
        rows: [],
        remaining: Math.max(0, runMax - runUsed - runReserved)
      });
    }
    if (!available.length) return null;

    const exhausted = available.find(item => item.remaining <= 0);
    if (exhausted) {
      throw new UsageLimitError({
        id: exhausted.window.id,
        label: exhausted.window.label,
        hours: exhausted.window.ms ? exhausted.window.ms / HOUR : 0,
        used: exhausted.used,
        input: exhausted.rows.reduce((sum, row) => sum + Number(row.input_tokens || 0), 0),
        output: exhausted.rows.reduce((sum, row) => sum + Number(row.output_tokens || 0), 0),
        calls: exhausted.rows.length,
        limit: exhausted.limit,
        percent: 100,
        exceeded: true,
        resetsAt: exhausted.rows.length && exhausted.window.ms
          ? new Date(new Date(exhausted.rows[0].created_at).getTime() + exhausted.window.ms).toISOString()
          : null,
        reserved: exhausted.window.id === 'session' || exhausted.window.id === 'week' ? globalReserved : 0
      }, { canUpgrade: exhausted.window.id !== 'run' && Boolean(config.stripe) });
    }

    const smallestRemaining = Math.min(...available.map(item => item.remaining));
    if (smallestRemaining < MIN_ADMISSION_TOKENS) {
      const constrained = available.reduce((best, item) => item.remaining < best.remaining ? item : best, available[0]);
      throw new UsageLimitError({
        id: constrained.window.id,
        label: constrained.window.label,
        hours: constrained.window.ms ? constrained.window.ms / HOUR : 0,
        used: constrained.used,
        input: constrained.rows.reduce((sum, row) => sum + Number(row.input_tokens || 0), 0),
        output: constrained.rows.reduce((sum, row) => sum + Number(row.output_tokens || 0), 0),
        calls: constrained.rows.length,
        limit: constrained.limit,
        percent: Math.min(100, Math.round((constrained.used / Math.max(1, constrained.limit)) * 1000) / 10),
        exceeded: true,
        resetsAt: constrained.rows.length && constrained.window.ms
          ? new Date(new Date(constrained.rows[0].created_at).getTime() + constrained.window.ms).toISOString()
          : null,
        reserved: constrained.window.id === 'session' || constrained.window.id === 'week' ? globalReserved : 0
      }, { canUpgrade: constrained.window.id !== 'run' && Boolean(config.stripe) });
    }

    const estimate = Math.min(rawEstimate, ...available.map(item => item.remaining));
    if (estimate < MIN_ADMISSION_TOKENS) return null;

    const id = crypto.randomUUID();
    await client.query(
      "INSERT INTO usage_reservations (id, principal_id, workspace_id, run_id, estimated_tokens, state, expires_at) VALUES ($1,$2,$3,$4,$5,'active',now()+($6::int * interval '1 millisecond'))",
      [id, principalId, workspaceId, runId, estimate, safeTtl]
    );
    return { id, estimatedTokens: estimate };
  });
}

export async function settleUsageReservation(pool, {
  reservationId, principalId, workspaceId, runId = null, conversationId = null,
  source = 'chat', provider = '', model = '', inputTokens = 0, outputTokens = 0
} = {}) {
  if (!reservationId) return { recorded: false, tokens: 0 };
  const input = count(inputTokens);
  const output = count(outputTokens);
  const tokens = input + output;
  return transaction(pool, async client => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['kindgleam:usage:principal:' + principalId]
    );
    const { rows: [reservation] } = await client.query(
      'SELECT id, estimated_tokens, state FROM usage_reservations WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 FOR UPDATE',
      [reservationId, principalId, workspaceId]
    );
    if (!reservation || reservation.state !== 'active') return { recorded: false, tokens: 0 };
    await client.query(
      "UPDATE usage_reservations SET state='consumed', actual_tokens=$4, updated_at=now() WHERE id=$1 AND principal_id=$2 AND workspace_id=$3",
      [reservationId, principalId, workspaceId, tokens]
    );
    let run = null;
    if (runId) {
      const { rows: [updatedRun] } = await client.query(
        'UPDATE runs SET tokens_used=tokens_used+$4, updated_at=now() WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 RETURNING tokens_used,max_tokens,conversation_id',
        [runId, workspaceId, principalId, tokens]
      );
      run = updatedRun ?? null;
    }
    if (tokens > 0) {
      await client.query(
        'INSERT INTO usage_events (principal_id,workspace_id,run_id,conversation_id,source,provider,model,input_tokens,output_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [principalId, workspaceId, runId, conversationId ?? run?.conversation_id ?? null,
          SOURCES.has(source) ? source : 'chat',
          String(provider ?? '').slice(0,40), String(model ?? '').slice(0,120), input, output]
      );
    }
    const actual = run ? Number(run.tokens_used) : null;
    const maxTokens = run?.max_tokens == null ? null : Number(run.max_tokens);
    return {
      recorded: true,
      tokens,
      estimatedTokens: Number(reservation.estimated_tokens),
      overrun: tokens > Number(reservation.estimated_tokens),
      tokensUsed: actual,
      maxTokens,
      exceeded: maxTokens !== null && actual !== null && actual > maxTokens
    };
  });
}

export async function releaseUsageReservation(pool, { reservationId, principalId, workspaceId } = {}) {
  if (!reservationId) return false;
  const { rowCount } = await pool.query(
    "UPDATE usage_reservations SET state='released', updated_at=now() WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND state='active'",
    [reservationId, principalId, workspaceId]
  );
  return rowCount > 0;
}

export function createUsageGate(pool, { principalId, workspaceId, runId = null, conversationId = null, config } = {}) {
  return Object.freeze({
    reserve: args => reserveUsage(pool, {
      principalId, workspaceId, runId, config,
      estimatedTokens: args?.estimatedTokens
    }),
    settle: args => settleUsageReservation(pool, {
      principalId, workspaceId, runId, conversationId,
      ...(args ?? {})
    }),
    release: args => releaseUsageReservation(pool, {
      principalId, workspaceId,
      reservationId: typeof args === 'string' ? args : args?.id
    })
  });
}

export class UsageLimitError extends Error {
  constructor(window, { canUpgrade = false } = {}) {
    const when = window.resetsAt ? new Date(window.resetsAt) : null;
    super(`You have reached your ${window.id === 'run' ? 'run' : window.id === 'week' ? 'weekly' : '4-hour'} AI usage limit.${when ? ` It opens again at ${when.toISOString().slice(11, 16)} UTC${window.id === 'week' ? ` on ${when.toISOString().slice(0, 10)}` : ''}.` : ''}${canUpgrade ? ' A bigger plan in Settings → Billing raises it.' : ''} Work that does not use the AI still works.`);
    this.code = 'usage-limit-reached';
    this.status = 429;
    this.window = window;
  }
}

/** Throws UsageLimitError when a limited window is used up. No limits: no query. */
export async function assertUsageAllowed(pool, { principalId, config, workspaceId = null }) {
  const limits = await limitsFor(pool, config, workspaceId, principalId);
  if (!limits.fourHourTokens && !limits.weeklyTokens) return;
  const { windows } = await usageSummary(pool, { principalId, workspaceId, config, limits });
  const exceeded = windows.find(window => window.exceeded);
  if (exceeded) throw new UsageLimitError(exceeded, { canUpgrade: Boolean(config.stripe) });
}
