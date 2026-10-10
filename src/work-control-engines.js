/**
 * Domain control-engine contract for the ONE shared KG execution runtime.
 *
 * Control engines own decisions, scoped agentic DAGs and acceptance; they do
 * not instantiate a second RunStore, worker framework, tool registry, model
 * gateway, database or budget ledger. This module is policy/scope data, not a
 * second task lifecycle or a shortcut around server authorization.
 */
const value = input => String(input ?? '').trim();

const PROFILES = Object.freeze({
  coding: Object.freeze({
    id: 'coding',
    surface: 'code',
    controller: 'CodingControlEngine',
    workKind: 'software-engineering',
    context: 'repository-revision-and-tests',
    agents: Object.freeze(['architect', 'implementer', 'debugger', 'test-engineer', 'security-reviewer']),
    verification: 'diff-build-executed-tests',
    acceptance: 'verified-code-delivery'
  }),
  research: Object.freeze({
    id: 'research',
    surface: 'research',
    controller: 'ResearchControlEngine',
    workKind: 'scholarly-investigation',
    context: 'question-sources-claims-and-methods',
    agents: Object.freeze(['researcher', 'methods-analyst', 'statistician', 'figure-specialist', 'critic', 'academic-writer']),
    verification: 'claim-source-method-figure-audit',
    acceptance: 'evidence-grounded-manuscript'
  })
});

export const CONTROL_ENGINE_IDS = Object.freeze(Object.keys(PROFILES));

/** Legacy Normal Chat is readable history, never an active controller. */
export function controlEngineForSurface(surface) {
  const surfaceId = value(surface).toLowerCase();
  const id = surfaceId === 'code' || surfaceId === 'coding' ? 'coding'
    : surfaceId === 'research' ? 'research' : null;
  if (!id) {
    const error = new Error('New work requires Coding or Research control engine');
    error.code = 'unsupported-control-engine';
    throw error;
  }
  return id;
}

export function controlEngineProfile(engineOrSurface) {
  return PROFILES[controlEngineForSurface(engineOrSurface)];
}

const FIELDS = Object.freeze([
  'principalId', 'workspaceId', 'projectId', 'runId', 'controlEngineId'
]);

/**
 * A controller-scoped run/agent context is not a permission grant.
 * The shared runtime must resolve the project/run from authorized storage and
 * compare the stored immutable owner to this scope before tools and data reads.
 */
export function makeControlWorkScope(input = {}) {
  const work = {
    principalId: value(input.principalId),
    workspaceId: value(input.workspaceId),
    projectId: value(input.projectId),
    runId: value(input.runId),
    controlEngineId: value(input.controlEngineId).toLowerCase()
  };
  if (!CONTROL_ENGINE_IDS.includes(work.controlEngineId)
    || FIELDS.some(field => !work[field])) {
    const error = new Error('Control-engine work requires complete verified run and project identity');
    error.code = 'invalid-control-work-scope';
    throw error;
  }
  return Object.freeze({
    ...work,
    projectRevision: value(input.projectRevision) || null,
    policyRevision: value(input.policyRevision) || null
  });
}

/**
 * No cross-engine, cross-project, cross-tenant or cross-run reads/writes.
 * UI-selected surface, similar names and loose conversation IDs are never
 * substitute identities. Cross-engine artifact handoff is a separate explicit
 * authorized operation against versioned snapshots, not this operation.
 */
export function assertControlWorkScope(expected, candidate, { requireRevision = false } = {}) {
  const owned = makeControlWorkScope(expected);
  const attempted = makeControlWorkScope(candidate);
  for (const field of FIELDS) {
    if (owned[field] !== attempted[field]) {
      const error = new Error('Controller-scoped work identity mismatch: ' + field);
      error.code = 'control-scope-mismatch';
      throw error;
    }
  }
  if (requireRevision && (owned.projectRevision !== attempted.projectRevision
    || !owned.projectRevision || owned.policyRevision !== attempted.policyRevision)) {
    const error = new Error('Controller work input revision is stale');
    error.code = 'control-revision-mismatch';
    throw error;
  }
  return true;
}

/** Agents inherit the parent controller authority; they cannot switch owners. */
export function scopedAgentWork(parent, { agentId, taskId, controlEngineId } = {}) {
  const scope = makeControlWorkScope(parent);
  if (controlEngineId && controlEngineId !== scope.controlEngineId) {
    const error = new Error('An agent cannot change the controlling engine of its run');
    error.code = 'control-scope-mismatch';
    throw error;
  }
  if (!value(agentId) || !value(taskId)) {
    const error = new Error('Agent invocation requires agent and task identity');
    error.code = 'invalid-agent-control-scope';
    throw error;
  }
  return Object.freeze({ ...scope, agentId: value(agentId), taskId: value(taskId) });
}

/** Shared infrastructure, partitioned identities. No duplicated runtime. */
export const SHARED_RUNTIME_CONTRACT = Object.freeze({
  authority: 'server-owned',
  runStore: 'shared-single-source-of-truth',
  jobWorkers: 'shared-with-controller-lanes',
  modelGateway: 'shared-with-per-call-policy',
  toolRegistry: 'shared-with-scoped-admission',
  persistence: 'shared-with-controller-project-rls',
  budgets: 'shared-account-ceiling',
  agenticWork: 'controller-project-run-isolated'
});
