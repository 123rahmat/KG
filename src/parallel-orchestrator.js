import { adaptiveDecisionAuthority } from './adaptive-decision-authority.js';
/**
 * Unified parallel orchestration.
 *
 * Parallelism is a scheduling property of the server-owned workflow, not a
 * second workflow. Independent work shares a wave; dependencies and shared
 * mutations are serialized. The same scheduler is used for agents, chat lanes
 * and code-workspace lanes.
 */

const text = value => String(value ?? '').trim();

export const PARALLEL_MODES = Object.freeze(['auto', 'always', 'off']);
export const DEFAULT_MAX_PARALLEL = 4;
export const ABSOLUTE_MAX_PARALLEL = 16;

const HIGH_STAKES = new Set(['high-impact', 'physical', 'regulated']);

const list = value => Array.isArray(value)
  ? [...new Set(value.map(text).filter(Boolean))]
  : [];

const boundedInt = (value, fallback, max = ABSOLUTE_MAX_PARALLEL) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
};

/**
 * Resource paths are hierarchical. Treat a directory writer and any descendant
 * reader/writer as conflicting; unrelated path segments do not conflict.
 * Non-path locks are exact identifiers, never substring matches.
 */
export function resourceScopesOverlap(left, right) {
  const normalize = value => text(value).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')));
}

const writeResourcesOf = item => {
  const metadata = item?.metadata ?? item ?? {};
  return new Set([...list(metadata.writeSet), ...list(metadata.mutates)]);
};
const readResourcesOf = item => {
  const metadata = item?.metadata ?? item ?? {};
  return new Set([...list(metadata.readSet), ...list(metadata.reads)]);
};
const lockResourcesOf = item => {
  const metadata = item?.metadata ?? item ?? {};
  return new Set([...list(metadata.resourceLocks), ...list(metadata.resources)]);
};

export function dependencySatisfied(dependency) {
  if (!dependency) return false;
  if (dependency.status === 'complete') {
    // An explicitly acceptance-gated task cannot unlock dependents from
    // model assertions or completion status alone.
    if (dependency.metadata?.acceptanceRequired === true) {
      return dependency.acceptance?.status === 'accepted'
        || dependency.evidence?.acceptance?.status === 'accepted';
    }
    return true;
  }
  // A skipped mandatory check is NEVER the equivalent of a passed check.
  // Explicit optional waivers require a recorded approval, not a model hint.
  return dependency.status === 'skipped'
    && dependency.metadata?.required === false
    && dependency.metadata?.waiverApproved === true;
}

export function taskCanRunInParallel(task = {}) {
  const metadata = task?.metadata ?? {};
  return metadata.parallel !== false
    && metadata.parallelEligible !== false
    && metadata.sharedState !== true
    && metadata.exclusive !== true;
}

export function tasksConflict(a = {}, b = {}) {
  if (!taskCanRunInParallel(a) || !taskCanRunInParallel(b)) return true;

  const leftWrites = writeResourcesOf(a);
  const rightWrites = writeResourcesOf(b);
  const leftReads = readResourcesOf(a);
  const rightReads = readResourcesOf(b);
  const leftLocks = lockResourcesOf(a);
  const rightLocks = lockResourcesOf(b);

  // Named locks serialize exact matches; file and directory resources use
  // prefix-aware overlap so src/ conflicts with src/routes/run.js.
  for (const value of leftLocks) if ([...rightLocks].some(other => resourceScopesOverlap(value, other))) return true;
  for (const value of leftWrites) {
    if ([...rightWrites, ...rightReads].some(other => resourceScopesOverlap(value, other))) return true;
  }
  for (const value of rightWrites) {
    if ([...leftReads].some(other => resourceScopesOverlap(value, other))) return true;
  }
  return false;
}

export function readyTasks(tasks = []) {
  const listTasks = Array.isArray(tasks) ? tasks : [];
  const byId = new Map(listTasks.map(item => [item.id, item]));
  return listTasks.filter(task =>
    task?.status === 'pending'
    && (task.dependsOn ?? []).every(id => {
      const dependency = byId.get(id);
      return dependencySatisfied(dependency);
    })
  );
}

export function parallelWaves(items = [], {
  maxParallel = DEFAULT_MAX_PARALLEL,
  conflict = tasksConflict,
  eligible = taskCanRunInParallel
} = {}) {
  const limit = boundedInt(maxParallel, DEFAULT_MAX_PARALLEL);
  const remaining = items.filter(Boolean);
  const waves = [];

  while (remaining.length) {
    const wave = [];
    for (let i = 0; i < remaining.length && wave.length < limit; ) {
      const candidate = remaining[i];
      if (eligible(candidate) && !wave.some(existing => conflict(existing, candidate))) {
        wave.push(candidate);
        remaining.splice(i, 1);
      } else {
        i += 1;
      }
    }
    if (!wave.length) waves.push([remaining.shift()]);
    else waves.push(wave);
  }
  return waves;
}

export function parallelDecision({
  mode = 'auto',
  pressure = 0,
  concurrencyOpportunity = 0,
  risk = 'ordinary',
  maxParallel = DEFAULT_MAX_PARALLEL,
  itemCount = 0,
  explicit = false
} = {}) {
  const selectedMode = PARALLEL_MODES.includes(text(mode)) ? text(mode) : 'auto';
  const limit = boundedInt(maxParallel, DEFAULT_MAX_PARALLEL);
  const p = Math.max(0, Math.min(1, Number(pressure) || 0));
  const opportunity = Math.max(0, Math.min(1, Number(concurrencyOpportunity) || 0));
  const highStakes = HIGH_STAKES.has(text(risk).toLowerCase());

  if (selectedMode === 'off') return { enabled: false, maxParallel: 1, reason: 'disabled' };
  if (itemCount <= 1) return { enabled: false, maxParallel: 1, reason: 'one-ready-item' };
  if (highStakes && selectedMode === 'auto' && !explicit && opportunity < 0.65) {
    return { enabled: false, maxParallel: 1, reason: 'high-stakes-conservative' };
  }

  const enabled = selectedMode === 'always'
    || explicit
    || opportunity >= 0.2
    || p >= 0.55;

  return {
    enabled,
    maxParallel: enabled ? Math.min(limit, itemCount) : 1,
    reason: enabled
      ? (selectedMode === 'always' ? 'forced' : 'independent-work-is-worth-parallelism')
      : 'parallelism-not-worth-cost',
    pressure: Number(p.toFixed(3)),
    opportunity: Number(opportunity.toFixed(3))
  };
}

export function adaptConcurrency({
  current = DEFAULT_MAX_PARALLEL,
  min = 1,
  max = DEFAULT_MAX_PARALLEL,
  averageLatencyMs = 0,
  errorRate = 0,
  remainingBudgetRatio = 1,
  risk = 'ordinary',
  benefit = 0
} = {}) {
  let next = Math.max(Number(min) || 1, Math.min(Number(max) || DEFAULT_MAX_PARALLEL, Number(current) || DEFAULT_MAX_PARALLEL));
  const latency = Math.max(0, Number(averageLatencyMs) || 0);
  const errors = Math.max(0, Math.min(1, Number(errorRate) || 0));
  const budget = Math.max(0, Math.min(1, Number(remainingBudgetRatio) || 0));
  const highRisk = HIGH_STAKES.has(text(risk).toLowerCase());

  // Latency alone is not a reason to shrink concurrency: doing that can
  // increase total wall-clock time when the provider is simply slow but
  // healthy. Contract on actual load/failure pressure, and expand when the
  // additional independent work can improve the critical path.
  if (errors >= 0.25 || (latency >= 8000 && errors >= 0.20) || budget < 0.25) next -= 1;
  else if (errors <= 0.05 && benefit >= 0.45 && budget >= 0.5) next += 1;

  // High-risk work keeps concurrency narrow, while low remaining budget
  // becomes a hard resource signal rather than a soft preference.
  if (highRisk) next = Math.min(next, 2);
  if (budget < 0.12) next = 1;
  else if (budget < 0.25) next = Math.min(next, 2);
  next = Math.max(Number(min) || 1, Math.min(Number(max) || DEFAULT_MAX_PARALLEL, next));
  return {
    current: Math.max(1, Math.min(ABSOLUTE_MAX_PARALLEL, Number(current) || DEFAULT_MAX_PARALLEL)),
    next,
    averageLatencyMs: Math.round(latency),
    errorRate: Number(errors.toFixed(3)),
    remainingBudgetRatio: Number(budget.toFixed(3)),
    risk: text(risk) || 'ordinary',
    reason: next < current ? 'reduce-concurrency-on-load-or-failure'
      : next > current ? 'increase-concurrency-when-healthy-and-beneficial'
      : 'hold-concurrency'
  };
}


export function adaptiveParallelLimit({
  mode = 'auto',
  current = DEFAULT_MAX_PARALLEL,
  min = 1,
  max = DEFAULT_MAX_PARALLEL,
  pressure = 0,
  concurrencyOpportunity = 0,
  risk = 'ordinary',
  itemCount = 0,
  remainingBudgetRatio = 1,
  explicit = false
} = {}) {
  const budget = Math.max(0, Math.min(1, Number(remainingBudgetRatio) || 0));
  const authority = adaptiveDecisionAuthority({
    situation: {
      uncertainty: Number(pressure) || 0,
      riskScore: HIGH_STAKES.has(text(risk).toLowerCase()) ? 0.75 : Number(pressure) || 0
    },
    profile: { pressure, expansionAllowed: concurrencyOpportunity >= 0.2 },
    acceptance: { satisfied: true, evidenceSummary: { unresolved: 0 }, authorizationSatisfied: true },
    previousAction: 'execute'
  });
  const decision = parallelDecision({
    mode,
    pressure,
    concurrencyOpportunity,
    risk,
    maxParallel: max,
    itemCount,
    explicit
  });
  const budgetCap = budget < 0.12
    ? 1
    : budget < 0.25
      ? Math.min(2, decision.maxParallel)
      : decision.maxParallel;
  const adapted = adaptConcurrency({
    current: Math.min(Math.max(1, Number(current) || 1), Math.max(1, budgetCap)),
    min,
    max: Math.max(1, budgetCap),
    averageLatencyMs: 0,
    errorRate: 0,
    remainingBudgetRatio: budget,
    risk,
    benefit: concurrencyOpportunity
  });
  const next = Math.max(
    Number(min) || 1,
    Math.min(Number(max) || DEFAULT_MAX_PARALLEL, budgetCap, adapted.next)
  );
  return {
    ...decision,
    authorityDecision: authority,
    maxParallel: next,
    budgetCap,
    remainingBudgetRatio: Number(budget.toFixed(3)),
    reason: next < decision.maxParallel
      ? 'budget-or-adaptive-cap'
      : decision.reason
  };
}

export function buildParallelExecutionPlan({
  mode = 'auto',
  maxParallel = DEFAULT_MAX_PARALLEL,
  pressure = 0,
  concurrencyOpportunity = 0,
  risk = 'ordinary',
  stages = [],
  explicit = false
} = {}) {
  const selected = Array.isArray(stages) ? stages.filter(Boolean) : [];
  const decision = parallelDecision({
    mode,
    maxParallel,
    pressure,
    concurrencyOpportunity,
    risk,
    itemCount: selected.length,
    explicit
  });
  const waves = parallelWaves(selected, { maxParallel: decision.maxParallel });
  return {
    version: '1',
    decision,
    waveCount: waves.length,
    waves: waves.map((wave, index) => ({
      index,
      parallel: wave.length > 1,
      items: wave.map(item => text(item?.id ?? item?.role ?? item?.name))
    })),
    rule: 'Parallelize independent, non-conflicting work; serialize dependencies and shared mutations.'
  };
}

export function conversationLane({
  conversationId = null,
  workspaceId = null,
  principalId = null,
  maxInFlight = 2
} = {}) {
  return {
    kind: 'conversation',
    id: text(conversationId) || null,
    workspaceId: text(workspaceId) || null,
    principalId: text(principalId) || null,
    maxInFlight: boundedInt(maxInFlight, 2, 8),
    isolatedContext: true,
    parallelSafe: true,
    sharedProjectWritesRequireRevisionLock: true
  };
}

export function workspaceLane({
  workspaceSessionId = null,
  projectId = null,
  branch = null,
  revisionId = null,
  writeSet = [],
  readSet = [],
  conversationId = null
} = {}) {
  return {
    kind: 'code-workspace',
    id: text(workspaceSessionId) || null,
    projectId: text(projectId) || null,
    branch: text(branch) || null,
    revisionId: text(revisionId) || null,
    conversationId: text(conversationId) || null,
    writeSet: list(writeSet),
    readSet: list(readSet),
    parallelSafe: true,
    writeIsolation: 'exact-revision-plus-disjoint-paths'
  };
}

export function workspaceLanesConflict(a = {}, b = {}) {
  const leftProject = text(a.projectId);
  const rightProject = text(b.projectId);
  const leftWrites = new Set(list(a.writeSet));
  const rightWrites = new Set(list(b.writeSet));
  const leftMutates = leftWrites.size > 0;
  const rightMutates = rightWrites.size > 0;

  if (leftProject && rightProject && leftProject !== rightProject) return false;
  if ((!leftProject || !rightProject) && (leftMutates || rightMutates)) return true;
  if (leftProject !== rightProject) return false;
  if (text(a.branch) && text(b.branch) && text(a.branch) !== text(b.branch)) return false;

  const leftReads = new Set(list(a.readSet));
  const rightReads = new Set(list(b.readSet));
  // Two read-only lanes can always share a stable project snapshot.
  if (!leftMutates && !rightMutates) return false;

  // A mutation is only parallel-safe against a lane anchored to the same
  // immutable revision. Unknown revisions fail closed rather than racing.
  const leftRevision = text(a.revisionId);
  const rightRevision = text(b.revisionId);
  if (!leftRevision || !rightRevision || leftRevision !== rightRevision) return true;

  // Writes conflict with writes and with reads of the same path. This keeps
  // analysis lanes from observing a partially integrated mutation.
  for (const path of leftWrites) {
    if ([...rightWrites, ...rightReads].some(other => resourceScopesOverlap(path, other))) return true;
  }
  for (const path of rightWrites) {
    if ([...leftReads].some(other => resourceScopesOverlap(path, other))) return true;
  }

  // A writer with no explicit read set is still safe against disjoint writers;
  // the exact write set is the isolation boundary. Empty writer sets are not.
  return false;
}

/** Explicit lane contract used by server-owned coding orchestration. */
export function agentWorkspaceLane({
  agentId = null,
  role = null,
  authority = 'advisory',
  projectId = null,
  branch = null,
  revisionId = null,
  readSet = [],
  writeSet = [],
  conversationId = null
} = {}) {
  const writes = list(writeSet);
  const reads = list(readSet);
  const mode = text(authority) === 'mutation' ? 'mutation' : 'advisory';
  const valid = mode === 'advisory' || (text(projectId) && text(revisionId) && writes.length > 0);
  return {
    ...workspaceLane({
      workspaceSessionId: agentId,
      projectId,
      branch,
      revisionId,
      writeSet: writes,
      readSet: reads,
      conversationId
    }),
    agentId: text(agentId) || null,
    role: text(role) || null,
    authority: mode,
    valid,
    mutation: mode === 'mutation'
  };
}

/**
 * Build deterministic waves for coding lanes. The server may run disjoint
 * writers concurrently, while readers serialize around mutations and stale
 * revisions are rejected rather than guessed at.
 */
export function buildWorkspaceParallelPlan({
  lanes = [],
  maxParallel = DEFAULT_MAX_PARALLEL
} = {}) {
  const selected = Array.isArray(lanes) ? lanes.filter(Boolean) : [];
  const waves = parallelWaves(selected, {
    maxParallel,
    eligible: lane => lane.valid !== false,
    conflict: workspaceLanesConflict
  });
  return {
    version: '1',
    maxParallel: boundedInt(maxParallel, DEFAULT_MAX_PARALLEL),
    waveCount: waves.length,
    waves: waves.map((wave, index) => ({
      index,
      parallel: wave.length > 1,
      lanes: wave.map(lane => ({
        agentId: lane.agentId ?? lane.id ?? null,
        role: lane.role ?? null,
        projectId: lane.projectId ?? null,
        revisionId: lane.revisionId ?? null,
        authority: lane.authority ?? 'advisory',
        readSet: list(lane.readSet),
        writeSet: list(lane.writeSet)
      }))
    })),
    rule: 'Run only independent lanes from the same immutable revision; serialize read/write and conflicting mutations.'
  };
}
