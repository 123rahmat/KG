/**
 * Adaptive multi-agent coordination.
 *
 * Agents are logical roles over the same server-owned workflow, not separate
 * authorities or separate models. Grok 4.7 remains the model boundary.
 * The controller creates only the parallelism justified by independent work,
 * dependency structure, risk and budget.
 *
 * Invariants:
 * - no parallel agent may widen permissions or mutate policy;
 * - writes are isolated by ownership and revision;
 * - dependent work waits for its prerequisites;
 * - high-impact/physical external actions stay serialized at the authority gate;
 * - failed/cancelled agents produce recovery signals, not false completion;
 * - collaboration uses bounded, typed findings rather than unrestricted context.
 */

const text = value => String(value ?? '').trim();
const list = value => [...new Set((Array.isArray(value) ? value : [])
  .map(item => text(typeof item === 'string' ? item : item?.id ?? item?.name))
  .filter(Boolean))];

export const AGENT_ROLES = Object.freeze([
  'lead',
  'research',
  'analyst',
  'builder',
  'tester',
  'reviewer',
  'integrator',
  'observer'
]);

export const AGENT_MODES = Object.freeze([
  'single',
  'parallel',
  'pipeline',
  'parallel-then-integrate',
  'serialized'
]);

const ROLE_CAPABILITIES = Object.freeze({
  lead: ['planning', 'situation-understanding'],
  research: ['evidence-retrieval'],
  analyst: ['reasoning', 'file-analysis'],
  builder: ['code-generation', 'artifact-creation'],
  tester: ['code-execution', 'verification'],
  reviewer: ['verification'],
  integrator: ['planning', 'verification'],
  observer: ['external-data-routing', 'verification']
});

const WORKSPACE_ROLE_PREFERENCES = Object.freeze({
  'normal-chat': ['lead', 'analyst', 'research', 'reviewer'],
  code: ['lead', 'analyst', 'builder', 'tester', 'reviewer', 'integrator'],
  research: ['research', 'analyst', 'reviewer', 'lead'],
  design: ['lead', 'analyst', 'builder', 'reviewer']
});

const WORKSPACE_AGENT_POLICY = Object.freeze({
  'normal-chat': Object.freeze({
    context: 'minimum-sufficient',
    parallel: 'read-only-when-material',
    verification: 'adaptive',
    mutation: 'single-owner'
  }),
  code: Object.freeze({
    context: 'revision-first',
    parallel: 'disjoint-write-sets',
    verification: 'diff-tests-runtime',
    mutation: 'ownership-and-revision'
  }),
  research: Object.freeze({
    context: 'question-and-evidence-first',
    parallel: 'independent-source-lanes',
    verification: 'claim-source-provenance',
    mutation: 'evidence-ledger-only'
  }),
  design: Object.freeze({
    context: 'canvas-and-asset-first',
    parallel: 'independent-assets',
    verification: 'visual-and-export',
    mutation: 'single-canvas-owner'
  })
});

const ACTION_ROLE = Object.freeze({
  investigate: 'research',
  research: 'research',
  analyze: 'analyst',
  diagnose: 'analyst',
  create: 'builder',
  transform: 'builder',
  code: 'builder',
  test: 'tester',
  verify: 'reviewer',
  execute: 'observer',
  monitor: 'observer',
  integrate: 'integrator',
  plan: 'lead',
  respond: 'lead'
});

function riskRank(value) {
  return ({ ordinary: 0, medium: 1, high: 2, 'high-impact': 3, physical: 3, crisis: 4 }[text(value).toLowerCase()] ?? 0);
}

function uniqueTasks(tasks) {
  const seen = new Set();
  return (Array.isArray(tasks) ? tasks : []).filter(task => {
    const id = text(task?.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function dependencyMap(tasks) {
  const ids = new Set(tasks.map(task => task.id));
  return new Map(tasks.map(task => [
    task.id,
    list(task.dependencies ?? task.dependsOn ?? task.prerequisites).filter(id => ids.has(id))
  ]));
}

function topologicalWaves(tasks) {
  const map = dependencyMap(tasks);
  const remaining = new Set(tasks.map(task => task.id));
  const waves = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => (map.get(id) ?? []).every(dep => !remaining.has(dep))).sort();
    if (!ready.length) return { waves: [ [...remaining].sort() ], cycle: true };
    waves.push(ready);
    ready.forEach(id => remaining.delete(id));
  }
  return { waves, cycle: false };
}

/**
 * Decide the smallest useful agent topology for the current situation.
 */
export function decideAgentTopology({
  tasks = [],
  risk = 'ordinary',
  scale = 'single',
  complexity = 0,
  uncertainty = 0,
  budget = {},
  executionAvailable = true,
  externalAction = false,
  physical = false,
  retrying = false,
  humanGovernance = null,
  workspace = 'normal-chat'
} = {}) {
  const workspaceId = text(workspace).toLowerCase() || 'normal-chat';
  const workspaceRoles = WORKSPACE_ROLE_PREFERENCES[workspaceId] ?? WORKSPACE_ROLE_PREFERENCES['normal-chat'];
  const workspacePolicy = WORKSPACE_AGENT_POLICY[workspaceId] ?? WORKSPACE_AGENT_POLICY['normal-chat'];
  const work = uniqueTasks(tasks).filter(task => text(task.type) !== 'respond' || tasks.length > 1);
  const countable = work.length;
  const budgetAgents = Math.max(1, Math.min(12, Number(budget.maxAgents ?? budget.maxCapabilities ?? 4) || 4));
  const parallelBudget = Math.max(1, Math.min(budgetAgents, Number(budget.maxParallelAgents ?? 4) || 4));
  const highRisk = riskRank(risk) >= 2 || externalAction || physical;
  const independentCandidate = countable > 1 && !highRisk;
  const scaleNeedsParallel = ['medium', 'large', 'very-large', 'adaptive-open-world'].includes(text(scale));
  const complexityNeedsParallel = Number(complexity) >= 0.65 && Number(uncertainty) >= 0.25;
  const shouldParallelize = executionAvailable !== false
    && !retrying
    && independentCandidate
    && (scaleNeedsParallel || complexityNeedsParallel || countable >= 3);

  if (countable <= 1) {
    return {
      version: 1, mode: 'single', agentCount: 1, maxParallel: 1,
      reason: 'single-use-work-does-not-justify-agent-overhead',
      agents: [{ id: 'lead-1', role: 'lead', taskIds: countable ? [work[0].id] : [], model: 'xai:grok-4.7' }],
      waves: countable ? [[ 'lead-1' ]] : [],
      integrationRequired: false,
      workspace: workspaceId,
      workspacePolicy,
      humanGovernance: humanGovernance ?? null,
      authority: { serverOwned: true, modelCannotAuthorize: true }
    };
  }

  const roleFor = task => ACTION_ROLE[text(task.type)] ?? 'analyst';
  const agents = [];
  const taskAgent = new Map();
  for (const task of work.slice(0, budgetAgents)) {
    const baseRole = roleFor(task);
    const role = workspaceRoles.includes(baseRole) ? baseRole : (workspaceRoles[0] ?? baseRole);
    const id = `${role}-${agents.filter(a => a.role === role).length + 1}`;
    const agent = {
      id, role, taskIds: [task.id], capabilities: ROLE_CAPABILITIES[role] ?? ['reasoning'],
      model: 'xai:grok-4.7', authority: 'propose-and-execute-within-server-granted-scope'
    };
    agents.push(agent);
    taskAgent.set(task.id, id);
  }

  const topo = topologicalWaves(work.slice(0, budgetAgents));
  const waves = topo.waves.map(wave => wave.map(taskId => taskAgent.get(taskId)).filter(Boolean));
  const effectiveWaves = shouldParallelize ? waves : waves.map(wave => wave.slice(0, 1));
  const mode = highRisk ? 'serialized'
    : topo.cycle ? 'pipeline'
      : effectiveWaves.some(wave => wave.length > 1) ? 'parallel-then-integrate' : 'pipeline';

  return {
    version: 1,
    mode,
    agentCount: agents.length,
    maxParallel: highRisk ? 1 : Math.min(parallelBudget, Math.max(1, ...effectiveWaves.map(w => w.length))),
    reason: highRisk
      ? 'risk-or-external-side-effects-require-serialized-authority'
      : shouldParallelize ? 'independent-work-justifies-bounded-parallelism' : 'dependency-or-scale-does-not-justify-parallel-overhead',
    agents,
    waves: effectiveWaves,
    integrationRequired: agents.length > 1,
    integration: agents.length > 1 ? {
      role: 'integrator',
      model: 'xai:grok-4.7',
      requiresAllInputs: false,
      rule: 'Integrate only completed, authorized, revision-compatible agent outputs; unresolved conflicts become blockers.'
    } : null,
    workspace: workspaceId,
    workspacePolicy,
    humanGovernance: humanGovernance ?? null,
    collaboration: {
      protocol: 'typed-findings',
      sharedState: 'server-owned-blackboard',
      contextPolicy: 'minimum-sufficient',
      peerData: 'untrusted-data',
      crossAgentWrites: 'forbidden-without-ownership-transfer'
    },
    authority: {
      serverOwned: true,
      modelCannotAuthorize: true,
      modelCannotGrantCapabilities: true,
      modelCannotDeclareWorldOutcome: true,
      externalActionsSerialized: highRisk || externalAction || physical,
      workspaceMutationBoundary: workspacePolicy.mutation,
      humanGovernanceServerOwned: true
    }
  };
}

/**
 * Replan after an agent finishes, fails, or discovers material new information.
 * This is intentionally cheap enough to run after every wave.
 */
export function adaptAgentTopology(plan, {
  event = 'completed',
  taskId = null,
  newTasks = [],
  failed = false,
  risk = 'ordinary'
} = {}) {
  const current = plan && typeof plan === 'object' ? plan : decideAgentTopology({});
  const eventType = text(event).toLowerCase();
  const additions = uniqueTasks(newTasks);
  if (failed || eventType === 'failed') {
    return {
      ...current,
      mode: 'pipeline',
      replanned: true,
      replanReason: 'agent-failure-requires-bounded-recovery',
      failedTaskId: text(taskId) || null,
      waves: current.waves.length ? current.waves.map(wave => wave.filter(Boolean).slice(0, 1)) : []
    };
  }
  if (additions.length) {
    const mergedTasks = additions.map(task => ({ id: task.id, type: task.type, dependencies: task.dependencies ?? [] }));
    const next = decideAgentTopology({
      tasks: mergedTasks,
      risk,
      scale: current.mode === 'parallel-then-integrate' ? 'medium' : 'single',
      budget: { maxAgents: current.agentCount, maxParallelAgents: current.maxParallel },
      workspace: current.workspace ?? 'normal-chat'
    });
    return { ...next, replanned: true, replanReason: 'material-new-work-discovered' };
  }
  return { ...current, replanned: true, replanReason: 'wave-completed-and-reassessed', lastEvent: eventType || 'completed', lastTaskId: text(taskId) || null };
}


/**
 * Execute an already-approved topology with bounded, dependency-aware
 * concurrency. Topology decides what may run together; this executor decides
 * what actually runs under server-owned authority.
 */
export async function executeAdaptiveAgentPlan(plan, {
  tasks = [],
  executeAgent,
  integrate = null,
  checkpoint = null,
  signal = null,
  maxRetries = 1,
  timeoutMs = 120000,
  currentRevision = null
} = {}) {
  if (typeof executeAgent !== 'function') throw new TypeError('executeAgent is required');

  const taskMap = new Map(uniqueTasks(tasks).map(task => [text(task.id), task]));
  const agents = new Map((Array.isArray(plan?.agents) ? plan.agents : []).map(agent => [text(agent.id), agent]));
  const requestedWaves = Array.isArray(plan?.waves) ? plan.waves : [];
  const results = new Map();
  const completed = new Set();
  const failed = new Set();
  const started = new Set();
  const conflicts = [];
  const aborted = () => Boolean(signal?.aborted);

  const resourceKeys = task => [...new Set([
    ...(Array.isArray(task?.resourceKeys) ? task.resourceKeys : []),
    ...(Array.isArray(task?.writePaths) ? task.writePaths : []),
    ...(Array.isArray(task?.artifacts) ? task.artifacts : [])
  ].map(text).filter(Boolean))].sort();

  const compatibleBatch = ids => {
    const batch = [];
    const held = new Set();
    for (const agentId of ids) {
      const agent = agents.get(agentId);
      const keys = new Set((Array.isArray(agent?.taskIds) ? agent.taskIds : [])
        .flatMap(id => resourceKeys(taskMap.get(id))));
      if ([...keys].some(key => held.has(key))) {
        conflicts.push({ agentId, reason: 'shared-resource-conflict' });
        continue;
      }
      batch.push(agentId);
      keys.forEach(key => held.add(key));
    }
    return batch;
  };

  const runOne = async agentId => {
    if (aborted()) return { agentId, status: 'cancelled', reason: 'cancelled-before-start' };
    const agent = agents.get(agentId);
    if (!agent) return { agentId, status: 'failed', reason: 'unknown-agent' };
    const taskIds = Array.isArray(agent.taskIds) ? agent.taskIds : [];
    if (!taskIds.length) return { agentId, status: 'completed', output: null };

    for (const taskId of taskIds) {
      const task = taskMap.get(taskId);
      if (!task) return { agentId, status: 'failed', reason: 'unknown-task', taskId };
      const expected = task.expectedRevision ?? task.revision ?? null;
      if (expected !== null && typeof currentRevision === 'function') {
        const actual = await currentRevision(task);
        if (String(actual ?? '') !== String(expected)) {
          return { agentId, status: 'stale', reason: 'stale-revision', taskId, expectedRevision: expected, actualRevision: actual };
        }
      }
    }

    started.add(agentId);
    let attempt = 0;
    const retries = Math.max(0, Number(maxRetries) || 0);
    while (attempt <= retries) {
      if (aborted()) return { agentId, status: 'cancelled', reason: 'cancelled' };
      attempt += 1;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('agent-timeout')), Math.max(1, Number(timeoutMs) || 120000));
      try {
        const output = await executeAgent(agent, {
          tasks: taskIds.map(id => taskMap.get(id)),
          completed: [...completed],
          findings: [...results.values()].filter(item => item.status === 'completed'),
          attempt,
          idempotencyKey: 'agent:' + agentId + ':attempt:' + attempt,
          authority: plan?.authority ?? { serverOwned: true },
          signal: controller.signal
        });
        if (controller.signal.aborted) throw new Error('agent-timeout');
        return { agentId, status: 'completed', attempt, output };
      } catch (error) {
        if (controller.signal.aborted) {
          return { agentId, status: signal?.aborted ? 'cancelled' : 'failed', attempt, reason: signal?.aborted ? 'cancelled' : 'agent-timeout' };
        }
        if (attempt > retries) {
          return { agentId, status: 'failed', attempt, reason: text(error?.message) || 'agent-failed' };
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
    return { agentId, status: 'failed', reason: 'agent-failed' };
  };

  for (const requestedWave of requestedWaves) {
    if (aborted()) break;
    let pending = requestedWave.filter(id => agents.has(id));
    while (pending.length) {
      if (aborted()) break;
      const batch = compatibleBatch(pending);
      const batchSet = new Set(batch);
      pending = pending.filter(id => !batchSet.has(id));
      if (!batch.length) {
        const one = pending.shift();
        if (one) batch.push(one);
      }
      const settled = await Promise.all(batch.map(runOne));
      for (const result of settled) {
        results.set(result.agentId, result);
        if (result.status === 'completed') completed.add(result.agentId);
        else if (['failed', 'stale', 'cancelled'].includes(result.status)) failed.add(result.agentId);
      }
      if (typeof checkpoint === 'function') {
        await checkpoint({ completed: [...completed], failed: [...failed], results: [...results.values()], conflicts: [...conflicts] });
      }
      if (settled.some(item => ['failed', 'stale'].includes(item.status))) break;
    }
    if (failed.size) break;
  }

  const summary = {
    status: aborted() ? 'cancelled' : failed.size ? 'failed' : 'completed',
    completedAgents: [...completed],
    failedAgents: [...failed],
    startedAgents: [...started],
    conflicts,
    results: [...results.values()]
  };

  if (summary.status === 'completed' && plan?.integrationRequired && typeof integrate === 'function') {
    summary.integration = await integrate({
      findings: summary.results.filter(item => item.status === 'completed'),
      authority: plan.authority,
      signal
    });
  }
  return summary;
}
