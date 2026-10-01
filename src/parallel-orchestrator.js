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
export const ABSOLUTE_MAX_PARALLEL = 8;

const HIGH_STAKES = new Set(['high-impact', 'physical', 'regulated']);

const list = value => Array.isArray(value)
  ? [...new Set(value.map(text).filter(Boolean))]
  : [];

const boundedInt = (value, fallback, max = ABSOLUTE_MAX_PARALLEL) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
};

const resourcesOf = item => {
  const metadata = item?.metadata ?? item ?? {};
  return new Set([
    ...list(metadata.writeSet),
    ...list(metadata.resourceLocks),
    ...list(metadata.resources),
    ...list(metadata.mutates)
  ]);
};

export function taskCanRunInParallel(task = {}) {
  const metadata = task?.metadata ?? {};
  return metadata.parallel !== false
    && metadata.parallelEligible !== false
    && metadata.sharedState !== true
    && metadata.exclusive !== true;
}

export function tasksConflict(a = {}, b = {}) {
  if (!taskCanRunInParallel(a) || !taskCanRunInParallel(b)) return true;
  const left = resourcesOf(a);
  const right = resourcesOf(b);
  for (const value of left) if (right.has(value)) return true;
  return false;
}

export function readyTasks(tasks = []) {
  const listTasks = Array.isArray(tasks) ? tasks : [];
  const byId = new Map(listTasks.map(item => [item.id, item]));
  return listTasks.filter(task =>
    task?.status === 'pending'
    && (task.dependsOn ?? []).every(id => {
      const dependency = byId.get(id);
      return dependency?.status === 'complete' || dependency?.status === 'skipped';
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
  if (!text(a.projectId) || !text(b.projectId)) return false;
  if (text(a.projectId) !== text(b.projectId)) return false;
  if (text(a.branch) && text(b.branch) && text(a.branch) !== text(b.branch)) return false;
  if (text(a.revisionId) && text(b.revisionId) && text(a.revisionId) !== text(b.revisionId)) return true;

  const left = new Set(list(a.writeSet));
  const right = new Set(list(b.writeSet));
  for (const path of left) if (right.has(path)) return true;
  return !left.size || !right.size;
}
