import { DEFAULT_MODEL, LIGHT_MODEL } from './model-catalog.js';
import { workspaceComputePolicy } from './mode-controllers.js';

/**
 * Advisory agent topology planning.
 *
 * Agents are logical roles over the same server-owned workflow, not separate
 * authorities or provider boundaries. The Gemini family remains the model boundary.
 * This pure planner proposes only the parallelism justified by independent work,
 * dependency structure, risk and budget.
 *
 * Dispatch belongs to multi-agent.js and agent-lane-executor.js under RunStore.
 * This module never calls agents or tools and never advances tasks.
 *
 * Planning invariants:
 * - no parallel agent may widen permissions or mutate policy;
 * - writes are isolated by ownership and revision;
 * - dependent work waits for its prerequisites;
 * - high-impact/physical external actions stay serialized at the authority gate;
 * - failed/cancelled agents produce recovery signals, not false completion;
 * - collaboration uses bounded, typed findings rather than unrestricted context.
 */

const text = value => String(value ?? '').trim();
const frontierAgentModel = `google:${DEFAULT_MODEL}`;
const efficientAgentModel = `google:${LIGHT_MODEL}`;
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
  research: ['research', 'analyst', 'reviewer', 'lead']
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

export function agentModelFor({
  workspace = 'normal-chat',
  role = 'lead',
  complexity = 0,
  uncertainty = 0,
  risk = 'ordinary',
  retrying = false
} = {}) {
  const workspaceId = text(workspace).toLowerCase() || 'normal-chat';
  const agentRole = text(role).toLowerCase() || 'lead';
  const highPressure = riskRank(risk) >= 2
    || retrying
    || Number(complexity) >= 0.72
    || Number(uncertainty) >= 0.65;
  const criticalByWorkspace = {
    'normal-chat': new Set(['research', 'builder', 'tester', 'reviewer', 'integrator']),
    code: new Set(['builder', 'tester', 'reviewer', 'integrator']),
    research: new Set(['research', 'reviewer', 'integrator'])
  };
  const criticalRole = (criticalByWorkspace[workspaceId] ?? criticalByWorkspace['normal-chat']).has(agentRole);
  const specialistPressure = workspaceId === 'code' && agentRole === 'analyst'
    ? Number(complexity) >= 0.55 || Number(uncertainty) >= 0.45
    : workspaceId === 'research' && agentRole === 'analyst'
      ? Number(complexity) >= 0.62 || Number(uncertainty) >= 0.5
      : false;
  return highPressure || criticalRole || specialistPressure ? frontierAgentModel : efficientAgentModel;
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
 * Decompose a medium-or-larger unit into the smallest useful, workspace-specific
 * advisory work units. These units are orchestration work, not new authoritative
 * workflow nodes; the parent workflow step remains server-owned.
 */
export function decomposeAgentTasks(tasks = [], {
  workspace = 'normal-chat',
  scale = 'single',
  complexity = 0,
  uncertainty = 0,
  risk = 'ordinary',
  maxSubtasks = 4
} = {}) {
  const workspaceId = text(workspace).toLowerCase() || 'normal-chat';
  const scaleId = text(scale);
  const medium = ['medium', 'large', 'very-large', 'adaptive-open-world'].includes(scaleId);
  const large = ['large', 'very-large', 'adaptive-open-world'].includes(scaleId);
  const pressure = Number(complexity) >= 0.55 || Number(uncertainty) >= 0.35;
  const risky = riskRank(risk) >= 2;
  if (!medium && !pressure) return uniqueTasks(tasks);
  if (risky) return uniqueTasks(tasks);
  const source = uniqueTasks(tasks);
  if (source.length !== 1) return source;
  const decompositionJustified = large
    || (workspaceId === 'normal-chat'
      ? Number(complexity) >= 0.65 || Number(uncertainty) >= 0.5
      : workspaceId === 'code'
        ? Number(complexity) >= 0.5 || Number(uncertainty) >= 0.35
        : Number(complexity) >= 0.4 || Number(uncertainty) >= 0.25);
  if (!decompositionJustified) return source;
  const parent = source[0];
  if (parent?.metadata?.agentDecomposed === true || parent?.agentDecomposed === true) return source;
  const id = text(parent.id);
  const specs = {
    'normal-chat': [
      ['chat-analysis', 'analyze', 'Analyze the request, constraints and success criteria.', []],
      ['chat-evidence', 'research', 'Identify only the evidence, files or facts needed to answer confidently.', ['chat-analysis']],
      ['chat-review', 'verify', 'Independently check the proposed reasoning, omissions and uncertainty.', ['chat-analysis']]
    ],
    code: [
      ['code-repo-analysis', 'analyze', 'Inspect affected architecture, dependencies, interfaces and current implementation.', []],
      ['code-change-analysis', 'analyze', 'Derive the smallest safe change set and identify dependency/write-set boundaries.', ['code-repo-analysis']],
      ['code-test-analysis', 'test', 'Determine the focused tests and runtime checks needed to prove the change.', ['code-repo-analysis']]
    ],
    research: [
      ['research-question', 'analyze', 'Decompose the question into the smallest material evidence gaps.', []],
      ['research-source-lane-a', 'research', 'Investigate one independent evidence lane for the highest-value unresolved gap.', ['research-question']],
      ['research-source-lane-b', 'research', 'Investigate a second independent evidence lane without duplicating the first.', ['research-question']],
      ['research-critique', 'verify', 'Check source quality, conflicts, provenance and remaining uncertainty.', ['research-source-lane-a', 'research-source-lane-b']]
    ]
  };
  const selected = specs[workspaceId] ?? specs['normal-chat'];
  const limit = Math.max(2, Math.min(selected.length, Number(maxSubtasks) || selected.length));
  return selected.slice(0, limit).map(([suffix, type, purpose, dependencies]) => ({
    id: id + ':' + suffix,
    type,
    purpose,
    dependencies: dependencies.map(dep => id + ':' + dep),
    parentTaskId: id,
    derivedFrom: id,
    agentDecomposed: true,
    metadata: {
      ...(parent.metadata && typeof parent.metadata === 'object' ? parent.metadata : {}),
      agentDecomposed: true,
      parentTaskId: id,
      advisory: true,
      authoritativeParent: id,
      workspace: workspaceId
    },
    resourceKeys: parent.resourceKeys ?? [],
    writePaths: type === 'builder' ? (parent.writePaths ?? []) : [],
    status: 'pending'
  }));
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
  const sourceTasks = uniqueTasks(tasks).filter(task => text(task.type) !== 'respond' || tasks.length > 1);
  const independentWork = sourceTasks.length > 1 ? Math.min(1, 0.45 + sourceTasks.length * 0.12) : 0;
  const computePolicy = workspaceComputePolicy({
    surface: workspaceId,
    complexity,
    uncertainty,
    risk,
    previousFailure: retrying,
    remainingBudgetRatio: budget.remainingBudgetRatio,
    independentWork,
    verificationRequired: sourceTasks.some(task => ['verify','test'].includes(text(task.type)))
  });
  const requestedAgents = Math.max(1, Math.min(12, Number(budget.maxAgents ?? budget.maxCapabilities ?? computePolicy.maxAgents) || computePolicy.maxAgents));
  const requestedParallel = Math.max(1, Math.min(requestedAgents, Number(budget.maxParallelAgents ?? computePolicy.maxParallel) || computePolicy.maxParallel));
  const parallelBudget = Math.max(1, Math.min(requestedParallel, computePolicy.maxParallel || 1));
  const work = decomposeAgentTasks(sourceTasks, {
    workspace: workspaceId,
    scale,
    complexity,
    uncertainty,
    risk,
    maxSubtasks: Math.max(1, Math.min(requestedAgents, computePolicy.recommendedAgents || requestedAgents))
  });
  const budgetAgents = Math.max(1, Math.min(12, Math.max(requestedAgents, work.length)));
  const countable = work.length;
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
      agents: [{
        id: 'lead-1',
        role: 'lead',
        authority: 'advisory-only',
        taskIds: countable ? [work[0].id] : [],
        model: agentModelFor({ workspace: workspaceId, role: 'lead', complexity, uncertainty, risk, retrying })
      }],
      waves: countable ? [[ 'lead-1' ]] : [],
      integrationRequired: false,
      workspace: workspaceId,
      workspacePolicy,
      computePolicy,
      modelPolicy: 'adaptive-per-role',
      humanGovernance: humanGovernance ?? null,
      authority: { serverOwned: true, proposalOnly: true, modelCannotAuthorize: true }
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
      model: agentModelFor({ workspace: workspaceId, role, complexity, uncertainty, risk, retrying }),
      authority: 'advisory-only'
    };
    agents.push(agent);
    taskAgent.set(task.id, id);
  }

  const topo = topologicalWaves(work.slice(0, budgetAgents));
  const waves = topo.waves.map(wave => wave.map(taskId => taskAgent.get(taskId)).filter(Boolean));
  const width = shouldParallelize ? Math.floor(parallelBudget) : 1;
  const effectiveWaves = waves.flatMap(wave => {
    const chunks = [];
    for (let index = 0; index < wave.length; index += width) chunks.push(wave.slice(index, index + width));
    return chunks;
  });
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
      model: agentModelFor({ workspace: workspaceId, role: 'integrator', complexity, uncertainty, risk, retrying }),
      requiresAllInputs: false,
      rule: 'Integrate only completed, authorized, revision-compatible agent outputs; unresolved conflicts become blockers.'
    } : null,
    workspace: workspaceId,
    workspacePolicy,
    computePolicy,
    modelPolicy: 'adaptive-per-role',
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
      proposalOnly: true,
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
      maxParallel: 1,
      waves: current.waves.flatMap(wave => wave.filter(Boolean).map(id => [id]))
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
