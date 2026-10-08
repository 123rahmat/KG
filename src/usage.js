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
    'SELECT DISTINCT plan_id FROM principal_ai_entitlements WHERE principal_id = $1',
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
  const weekStart = new Date(now.getTime() - WINDOWS[1].ms);
  const sessionStart = new Date(now.getTime() - WINDOWS[0].ms);

  const { rows: [totals] } = await pool.query(
    `SELECT
       COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at > $2),0)::bigint AS session_used,
       COALESCE(SUM(input_tokens) FILTER (WHERE created_at > $2),0)::bigint AS session_input,
       COALESCE(SUM(output_tokens) FILTER (WHERE created_at > $2),0)::bigint AS session_output,
       COUNT(*) FILTER (WHERE created_at > $2)::bigint AS session_calls,
       MIN(created_at) FILTER (WHERE created_at > $2) AS session_oldest,
       COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE source <> 'multi-agent'),0)::bigint AS week_used,
       COALESCE(SUM(input_tokens) FILTER (WHERE source <> 'multi-agent'),0)::bigint AS week_input,
       COALESCE(SUM(output_tokens) FILTER (WHERE source <> 'multi-agent'),0)::bigint AS week_output,
       COUNT(*) FILTER (WHERE source <> 'multi-agent')::bigint AS week_calls,
       MIN(created_at) FILTER (WHERE source <> 'multi-agent') AS week_oldest
       FROM usage_events
      WHERE principal_id = $1
        AND created_at > $3`,
    [principalId, sessionStart, weekStart]
  );

  const windows = [];
  for (const [index, window] of WINDOWS.entries()) {
    const prefix = index === 0 ? 'session' : 'week';
    const used = Number(totals?.[`${prefix}_used`] || 0);
    const input = Number(totals?.[`${prefix}_input`] || 0);
    const output = Number(totals?.[`${prefix}_output`] || 0);
    const calls = Number(totals?.[`${prefix}_calls`] || 0);
    const limit = Number(applied[window.limitKey] || 0);
    const oldest = totals?.[`${prefix}_oldest`] ? new Date(totals[`${prefix}_oldest`]) : null;
    let resetsAt = oldest ? new Date(oldest.getTime() + window.ms) : null;

    if (limit && used >= limit && calls) {
      const startAt = index === 0 ? sessionStart : weekStart;
      const { rows: [boundary] } = await pool.query(
        `SELECT created_at
           FROM (
             SELECT created_at,
                    COALESCE(SUM(input_tokens + output_tokens) OVER (
                      ORDER BY created_at ASC
                      ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
                    ),0) AS remaining_after
               FROM usage_events
              WHERE principal_id = $1
                AND source <> 'multi-agent'
                AND created_at > $2
           ) q
          WHERE remaining_after < $3
          ORDER BY created_at ASC
          LIMIT 1`,
        [principalId, startAt, limit]
      );
      if (boundary?.created_at) resetsAt = new Date(new Date(boundary.created_at).getTime() + window.ms);
    }

    windows.push({
      id: window.id,
      label: window.label,
      scope: 'principal',
      hours: window.ms / HOUR,
      used,
      input,
      output,
      calls,
      limit: limit || null,
      percent: limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null,
      exceeded: Boolean(limit && used >= limit),
      resetsAt: resetsAt?.toISOString() ?? null
    });
  }

  const { rows: dayRows } = await pool.query(
    `SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
            COALESCE(SUM(input_tokens + output_tokens),0)::bigint AS tokens
       FROM usage_events
      WHERE principal_id = $1
        AND source <> 'multi-agent'
        AND created_at > $2
      GROUP BY day
      ORDER BY day ASC`,
    [principalId, weekStart]
  );
  const dayMap = new Map(dayRows.map(row => {
    const key = row.day instanceof Date
      ? row.day.toISOString().slice(0, 10)
      : String(row.day ?? '').slice(0, 10);
    return [key, Number(row.tokens || 0)];
  }));
  const days = [];
  for (let back = 6; back >= 0; back -= 1) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));
    days.push({ date: day.toISOString().slice(0, 10), tokens: dayMap.get(day.toISOString().slice(0, 10)) ?? 0 });
  }

  const { rows: sourceRows } = await pool.query(
    `SELECT source, COALESCE(SUM(input_tokens + output_tokens),0)::bigint AS tokens
       FROM usage_events
      WHERE principal_id = $1
        AND created_at > $2
      GROUP BY source`,
    [principalId, weekStart]
  );
  const bySource = Object.fromEntries(sourceRows.map(row => [row.source, Number(row.tokens || 0)]));

  let context = null;
  const contextWindow = contextWindowFor(config);
  if (conversationId) {
    const { rows: [latest] } = await pool.query(
      `SELECT input_tokens, created_at
         FROM usage_events
        WHERE principal_id = $1
          AND ($2::text IS NULL OR workspace_id = $2)
          AND conversation_id = $3
          AND source = 'chat'
        ORDER BY created_at DESC
        LIMIT 1`,
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
      weeklyExemptSources: ['multi-agent'],
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

export async function reserveUsage(pool, {
  principalId, workspaceId, runId = null, estimatedTokens = 0, config,
  usageSource = 'chat', ttlMs = RESERVATION_TTL_MS, reservationId = null
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
    if (reservationId) {
      const { rows: [existing] } = await client.query(
        "SELECT id FROM usage_reservations WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND run_id IS NOT DISTINCT FROM $4 AND state='active' FOR UPDATE",
        [reservationId, principalId, workspaceId, runId]
      );
      if (!existing) throw new UsageLimitError({ id: 'run', label: 'Expired reservation', exceeded: true });
    }

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

    // Multi-agent specialists share the 4-hour account budget, but their
  // advisory work is intentionally exempt from the user's weekly quota.
  // This keeps background/coding-agent recruitment bounded in the short
  // window without letting agent expansion consume the human-facing weekly
  // allowance.
  const { rows: [usage] } = await client.query(
      `SELECT
         COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE created_at > now()-interval '4 hours'),0)::bigint AS session_used,
         COALESCE(SUM(input_tokens + output_tokens) FILTER (WHERE source <> 'multi-agent'),0)::bigint AS week_used,
         MIN(created_at) FILTER (WHERE created_at > now()-interval '4 hours') AS session_oldest,
         MIN(created_at) FILTER (WHERE source <> 'multi-agent') AS week_oldest,
         COUNT(*) FILTER (WHERE created_at > now()-interval '4 hours')::bigint AS session_calls,
         COUNT(*) FILTER (WHERE source <> 'multi-agent')::bigint AS week_calls
       FROM usage_events
      WHERE principal_id=$1
        AND created_at>now()-interval '7 days'`,
      [principalId]
    );
    const { rows: [reservations] } = await client.query(
      `SELECT
         COALESCE(SUM(estimated_tokens),0)::bigint AS global_reserved,
         COALESCE(SUM(estimated_tokens) FILTER (WHERE run_id=$2 AND workspace_id=$3),0)::bigint AS run_reserved
       FROM usage_reservations
      WHERE principal_id=$1 AND state='active' AND expires_at>now() AND ($4::text IS NULL OR id <> $4)`,
      [principalId, runId, workspaceId, reservationId]
    );
    const globalReserved = Number(reservations?.global_reserved || 0);
    const runReserved = Number(reservations?.run_reserved || 0);

    const available = [];
    for (const [index, window] of WINDOWS.entries()) {
      // The weekly quota is for user-facing/model work. Multi-agent
      // specialists remain governed by the 4-hour window (and any run cap),
      // but do not consume or hit the weekly allowance.
      if (window.id === 'week' && usageSource === 'multi-agent') continue;
      const limit = Number(limits[window.limitKey] || 0);
      if (!limit) continue;
      const used = Number(index === 0 ? usage?.session_used : usage?.week_used) + globalReserved;
      available.push({
        window,
        limit,
        used,
        calls: Number(index === 0 ? usage?.session_calls : usage?.week_calls),
        oldest: index === 0 ? usage?.session_oldest : usage?.week_oldest,
        remaining: Math.max(0, limit - used)
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
    if (!available.length) return reservationId ? { id: reservationId, estimatedTokens: rawEstimate } : null;

    const exhausted = available.find(item => item.remaining <= 0);
    if (exhausted) {
      throw new UsageLimitError({
        id: exhausted.window.id,
        label: exhausted.window.label,
        hours: exhausted.window.ms ? exhausted.window.ms / HOUR : 0,
        used: exhausted.used,
        input: 0,
        output: 0,
        calls: exhausted.calls ?? 0,
        limit: exhausted.limit,
        percent: 100,
        exceeded: true,
        resetsAt: exhausted.oldest && exhausted.window.ms
          ? new Date(new Date(exhausted.oldest).getTime() + exhausted.window.ms).toISOString()
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
        input: 0,
        output: 0,
        calls: constrained.calls ?? 0,
        limit: constrained.limit,
        percent: Math.min(100, Math.round((constrained.used / Math.max(1, constrained.limit)) * 1000) / 10),
        exceeded: true,
        resetsAt: constrained.oldest && constrained.window.ms
          ? new Date(new Date(constrained.oldest).getTime() + constrained.window.ms).toISOString()
          : null,
        reserved: constrained.window.id === 'session' || constrained.window.id === 'week' ? globalReserved : 0
      }, { canUpgrade: constrained.window.id !== 'run' && Boolean(config.stripe) });
    }

    const estimate = Math.min(rawEstimate, ...available.map(item => item.remaining));
    if (estimate < MIN_ADMISSION_TOKENS) return null;

    const id = reservationId || crypto.randomUUID();
    if (reservationId) {
      await client.query(
        "UPDATE usage_reservations SET estimated_tokens=$4, expires_at=now()+($5::int * interval '1 millisecond'), updated_at=now() WHERE id=$1 AND principal_id=$2 AND workspace_id=$3",
        [id, principalId, workspaceId, estimate, safeTtl]
      );
      return { id, estimatedTokens: estimate };
    }
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
      estimatedTokens: args?.estimatedTokens,
      usageSource: args?.usageSource ?? 'chat'
    }),
    revalidate: (reservation, args) => reserveUsage(pool, {
      principalId, workspaceId, runId, config,
      reservationId: reservation?.id ?? null,
      estimatedTokens: reservation?.estimatedTokens ?? args?.estimatedTokens,
      usageSource: args?.usageSource ?? 'chat'
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
