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
  retrying = false
} = {}) {
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
      authority: { serverOwned: true, modelCannotAuthorize: true }
    };
  }

  const roleFor = task => ACTION_ROLE[text(task.type)] ?? 'analyst';
  const agents = [];
  const taskAgent = new Map();
  for (const task of work.slice(0, budgetAgents)) {
    const role = roleFor(task);
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
      externalActionsSerialized: highRisk || externalAction || physical
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
      budget: { maxAgents: current.agentCount, maxParallelAgents: current.maxParallel }
    });
    return { ...next, replanned: true, replanReason: 'material-new-work-discovered' };
  }
  return { ...current, replanned: true, replanReason: 'wave-completed-and-reassessed', lastEvent: eventType || 'completed', lastTaskId: text(taskId) || null };
}
