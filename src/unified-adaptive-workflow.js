/**
 * Unified situation-adaptive workflow kernel.
 *
 * This is the common contract for every subsystem. Subsystems are workers
 * inside one server-owned workflow; none owns a private lifecycle.
 *
 * Contract:
 *   observe -> assess -> choose minimum sufficient work -> act -> verify ->
 *   reassess -> continue/escalate/de-escalate/stop
 *
 * The kernel is deliberately pure. It does not call models/tools or mutate
 * state. The RunStore is the enforcement boundary.
 */
import { adaptiveEffortProfile, adaptiveBehaviorContract, adaptiveExecutionStrategy } from './adaptive-efficiency.js';
import { realWorldExecutionPolicy } from './real-world-adaptation.js';
import { buildRealWorldOutcomeContract } from './real-world-outcome.js';
import { controllerForSurface, buildModeControllerContract } from './mode-controllers.js';
import {
  adaptiveDecisionAuthority,
  buildAcceptanceContract,
  recoveryDecision,
  summarizeEvidence
} from './adaptive-decision-authority.js';
import { composeOpenWorldDecision, validateOpenWorldGraph } from './open-world-task-graph.js';

const text = value => String(value ?? '').trim();
const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const list = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];

/**
 * Universal work coverage model.
 *
 * Domains do not choose a private lifecycle. The situation determines which
 * kinds of work are justified: understand, obtain missing context/evidence,
 * reason, challenge, decide, act, observe, verify, or deliver. Coding,
 * research, files, design and ordinary tasks differ in required capabilities,
 * not in the control loop.
 */
export function adaptiveCoverage({
  situation = {},
  acceptance = {},
  executionRequired = false,
  needsInvestigation = false,
  observationAvailable = false,
  verificationEvidenceAvailable = false,
  failed = false
} = {}) {
  const uncertainty = clamp01(situation.uncertainty);
  const evidenceGap = situation.evidenceGap === true
    || needsInvestigation
    || (Array.isArray(situation.unresolvedQuestions) && situation.unresolvedQuestions.length > 0)
    || (Array.isArray(situation.conflicts) && situation.conflicts.length > 0);
  const challengeNeeded = uncertainty >= 0.45
    || situation.materialChange === true
    || situation.assumptionRisk === true
    || (Array.isArray(situation.conflicts) && situation.conflicts.length > 0);
  const verifyNeeded = situation.verificationRequired === true
    || situation.evidenceRequired === true
    || Array.isArray(acceptance.criteria) && acceptance.criteria.length > 0
    || Array.isArray(acceptance.evidenceRequired) && acceptance.evidenceRequired.length > 0
    || executionRequired
    || observationAvailable
    || verificationEvidenceAvailable;
  return Object.freeze({
    evidenceGap,
    challengeNeeded,
    executionRequired: executionRequired === true,
    observationNeeded: executionRequired === true || observationAvailable === true,
    verificationNeeded: verifyNeeded,
    failed: failed === true
  });
}

/**
 * Select the next justified stage from the same universal loop for every
 * surface. Surface/domain code supplies capabilities; this function supplies
 * lifecycle semantics.
 */
export function nextAdaptiveStage(current, options = {}) {
  const {
    coverage = adaptiveCoverage(options),
    depth = 'full',
    verified = false,
    blocked = false,
    verificationFailed = false,
    materialChange = false
  } = options;
  if (blocked) return null;
  if (verificationFailed || materialChange || coverage.failed) return 'replan';
  if (verified) return 'deliver';
  const verificationNeeded = coverage.verificationNeeded || depth === 'focused';

  if (current === 'understand') return 'model-situation';
  if (current === 'model-situation') {
    if (coverage.evidenceGap) return 'investigate';
    return 'reason';
  }
  if (current === 'investigate') {
    return coverage.evidenceGap ? 'investigate' : 'reason';
  }
  if (current === 'reason') {
    if (coverage.challengeNeeded && depth !== 'focused') return 'challenge';
    if (coverage.executionRequired) return 'decide';
    return verificationNeeded ? 'verify' : 'deliver';
  }
  if (current === 'challenge') {
    if (coverage.evidenceGap) return 'investigate';
    if (coverage.executionRequired) return 'decide';
    return coverage.verificationNeeded ? 'verify' : 'deliver';
  }
  if (current === 'decide') return 'plan';
  if (current === 'plan') return coverage.executionRequired ? 'execute' : (coverage.verificationNeeded ? 'verify' : 'deliver');
  if (current === 'execute') return 'observe';
  if (current === 'observe') return 'verify';
  if (current === 'verify') {
    const hasVerificationEvidence = options.verificationEvidenceAvailable === true
      || options.situation?.verificationEvidenceAvailable === true
      || options.situation?.evidence?.verification != null;
    if (!hasVerificationEvidence) return 'replan';
    if (coverage.evidenceGap) return 'investigate';
    return 'deliver';
  }
  if (current === 'replan') {
    return coverage.evidenceGap ? 'investigate' : 'reason';
  }
  if (current === 'deliver') return null;
  return 'understand';
}

const SUBSYSTEMS = Object.freeze([
  'situation-interpreter',
  'step-manager',
  'resource-data-manager',
  'main-executor',
  'researcher',
  'analyst',
  'architect',
  'coder',
  'debugger',
  'test-engineer',
  'security-reviewer',
  'recovery',
  'verification',
  'memory',
  'parallel-orchestrator',
  'observability'
]);

function consequenceOf(situation = {}) {
  return clamp01(Math.max(
    Number(situation.consequence) || 0,
    Number(situation.riskScore) || 0,
    situation.irreversible ? 1 : 0,
    situation.externalSideEffect ? 0.85 : 0,
    situation.physical ? 1 : 0,
    situation.regulated ? 0.9 : 0,
    situation.peopleDecision ? 1 : 0
  ));
}

function acceptanceFrom(situation = {}, acceptance = {}, profile = {}) {
  return buildAcceptanceContract({
    goal: situation.goal ?? '',
    criteria: list(acceptance.criteria ?? situation.successCriteria),
    evidenceRequired: list(acceptance.evidenceRequired ?? situation.evidenceRequired),
    evidence: Array.isArray(acceptance.evidence) ? acceptance.evidence : [],
    authorizationRequired: acceptance.authorizationRequired === true || situation.authorizationRequired === true,
    authorizationSatisfied: acceptance.authorizationSatisfied !== false && situation.authorizationSatisfied !== false,
    verificationRequired: acceptance.verificationRequired === true || profile.maturity?.independentVerificationRequired === true,
    verificationSatisfied: acceptance.verificationSatisfied === true,
    finalizationRequired: acceptance.finalizationRequired === true
  });
}

/**
 * Build the single operating contract passed to subsystems.
 */
export function buildUnifiedAdaptiveWorkflow({
  goal = '',
  situation = {},
  acceptance = {},
  evidence = [],
  failedAttempts = 0,
  availableCapabilities = [],
  authorizedCapabilities = [],
  candidates = [],
  previousAction = null,
  taskGraph = null,
  profile = null,
  surface = 'normal-chat'
} = {}) {
  const s = { ...(situation && typeof situation === 'object' ? situation : {}), goal: text(situation.goal ?? goal) };
  const p = profile ?? adaptiveEffortProfile({
    complexity: Number(s.complexity) || 0,
    uncertainty: Number(s.uncertainty) || 0,
    risk: s.risk ?? 'medium',
    verificationGap: Number(s.verificationGap) || 0,
    failureCount: failedAttempts,
    irreversible: s.irreversible === true,
    externalSideEffect: s.externalSideEffect === true,
    physical: s.physical === true,
    regulated: s.regulated === true,
    peopleDecision: s.peopleDecision === true
  });
  const a = acceptanceFrom(s, acceptance, p);
  const requestedSurface = text(surface) || text(s.surface);
  const operatingSurface = requestedSurface === 'code'
    ? 'code'
    : requestedSurface === 'research'
      ? 'research'
      : 'normal-chat';
  const realWorld = s.realWorld ?? {};
  const outcomeContract = s.outcomeContract ?? buildRealWorldOutcomeContract({
    goal: s.goal,
    realWorld,
    successCriteria: Array.isArray(s.successCriteria) ? s.successCriteria : [],
    execution: s.execution ?? {},
    authorizationSatisfied: s.authorizationSatisfied !== false,
    evidence
  });
  const realWorldPolicy = realWorldExecutionPolicy(realWorld);
  const executionStrategy = adaptiveExecutionStrategy({
    pressure: p.pressure,
    uncertainty: p.scores?.uncertainty,
    complexity: p.scores?.complexity,
    risk: p.maturity?.level === 'maximum' ? 'critical' : p.scores?.risk >= 0.75 ? 'high' : 'medium',
    verificationRequired: p.maturity?.independentVerificationRequired,
    verificationSatisfied: a.verificationSatisfied === true,
    independentWork: Number(s.independentWork ?? s.parallelOpportunity ?? 0),
    cacheHit: s.verifiedStateReusable === true,
    previousFailure: failedAttempts > 0,
    remainingBudgetRatio: Number(s.remainingBudgetRatio ?? 1)
  });
  const authority = adaptiveDecisionAuthority({
    situation: {
      ...s,
      consequence: consequenceOf(s),
      riskScore: Number(s.riskScore) || 0
    },
    profile: p,
    acceptance: a,
    candidates,
    availableCapabilities,
    authorizedCapabilities,
    failedAttempts,
    previousAction
  });
  const modeController = buildModeControllerContract({
    surface: operatingSurface,
    situation: { ...s, surface: operatingSurface },
    acceptance: a,
    pressure: p.pressure,
    uncertainty: p.scores?.uncertainty,
    complexity: p.scores?.complexity,
    risk: p.maturity?.level === 'maximum' ? 'critical' : p.scores?.risk >= 0.75 ? 'high' : 'medium',
    previousFailure: failedAttempts > 0,
    remainingBudgetRatio: Number(s.remainingBudgetRatio ?? 1)
  });
  const durableGraph = validateOpenWorldGraph(taskGraph ?? {});
  const openWorld = composeOpenWorldDecision({
    goal: s.goal, situation: s, graph: durableGraph, candidates, acceptance: a,
    availableCapabilities, authorizedCapabilities,
    remainingBudgetRatio: s.remainingBudgetRatio ?? null
  });
  const behavior = adaptiveBehaviorContract(p, {
    situation: { ...s, consequence: consequenceOf(s) },
    acceptance: a,
    candidates,
    authorityDecision: authority
  });

  return {
    version: 1,
    principle: 'One adaptive workflow, many specialized capabilities. Every subsystem follows the same situation, evidence, authority, execution, verification and stopping contract.',
    goal: s.goal,
    situation: s,
    realWorld,
    outcomeContract,
    realWorldPolicy,
    profile: p,
    acceptance: a,
    authority,
    taskGraph: durableGraph,
    openWorld,
    behavior,
    surface: operatingSurface,
    modeController,
    execution: executionStrategy,
    controllerCatalog: modeControllerCatalogSafe(),
    subsystems: SUBSYSTEMS.map(name => ({
      name,
      authority: 'server-owned',
      role: name === 'main-executor' ? 'execute-user-facing-work' : 'advisory-or-specialized',
      lifecycle: 'shared-workflow',
      mayExpandScope: false,
      mayGrantAuthority: false,
      mayDeclareCompletion: false,
      mustReassessAfterMaterialChange: true
    })),
    evidence: {
      summary: summarizeEvidence(evidence),
      states: ['verified', 'observed', 'inference', 'assumption', 'unknown', 'stale'],
      confidenceIsNotCompletion: true
    },
    stopping: {
      allowedWhen: [
        'acceptance-satisfied',
        'evidence-sufficient',
        'authorization-missing',
        'human-decision-required',
        'risk-exceeds-authority',
        'unresolved-contradiction',
        'repeated-failure',
        'no-meaningful-benefit'
      ],
      noArtificialMinimumSteps: true,
      noMaximumEffortByDefault: true
    }
  };
}

/**
 * Recompute the workflow after an event. The caller should persist the
 * returned projection before selecting or executing the next step.
 */
export function reassessUnifiedWorkflow(previous = {}, {
  event = {},
  situation = {},
  acceptance = {},
  evidence = [],
  failedAttempts = 0,
  candidates = [],
  availableCapabilities = [],
  authorizedCapabilities = [],
  taskGraph = null,
  surface = null
} = {}) {
  const prior = previous && typeof previous === 'object' ? previous : {};

  const eventType = text(event.type || event.eventType) || 'unknown';
  const material = event.material !== false && [
    'user-message','user-correction','tool-result','file-change','code-change',
    'test-result','execution-result','failure','new-evidence','agent-finding',
    'verification','external-change','authorization-change'
  ].includes(eventType);
  const mergedSituation = {
    ...(prior.situation ?? {}),
    ...(situation ?? {}),
    ...(event.situationPatch ?? {})
  };
  const priorEvidence = Array.isArray(prior.evidence?.items) ? prior.evidence.items : [];
  const mergedEvidence = [...priorEvidence, ...(Array.isArray(evidence) ? evidence : [])].slice(-128);
  const next = buildUnifiedAdaptiveWorkflow({
    goal: mergedSituation.goal ?? prior.goal ?? '',
    situation: { ...mergedSituation, surface: text(surface) || text(prior.surface) || text(mergedSituation.surface) || 'normal-chat' },
    acceptance: {
      ...(prior.acceptance ?? {}),
      ...(acceptance ?? {}),
      evidence: mergedEvidence
    },
    evidence: mergedEvidence,
    failedAttempts,
    candidates,
    availableCapabilities,
    authorizedCapabilities,
    previousAction: prior.authority?.action ?? null,
    taskGraph: taskGraph ?? prior.taskGraph ?? {},
    surface: text(surface) || text(prior.surface) || text(mergedSituation.surface) || 'normal-chat'
  });
  return {
    ...next,
    reassessment: {
      eventType,
      material,
      count: Number(prior.reassessment?.count || 0) + (material ? 1 : 0),
      at: new Date().toISOString(),
      previousAction: prior.authority?.action ?? null,
      actionChanged: prior.authority?.action !== next.authority.action,
      openWorldActionChanged: prior.openWorld?.action !== next.openWorld.action,
      graphRevisionChanged: prior.taskGraph?.revision !== next.taskGraph.revision,
      deescalated: Number(next.authority.pressure) < Number(prior.authority?.pressure ?? 2),
      reason: next.authority.reason
    }
  };
}

/**
 * Completion is an evidence gate, not a model/status claim.
 */
export function completionGate({
  workflow = {},
  status = 'complete',
  taskType = '',
  evidence = null,
  verification = null,
  authorizationSatisfied = true
} = {}) {
  const acceptance = workflow.acceptance ?? {};
  const outcomeContract = workflow.outcomeContract ?? {};
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const summary = summarizeEvidence(evidenceList);
  const persistedVerifierPass = evidenceList.some(item =>
    item?.kind === 'verified'
      && (item?.verdict?.verdict === 'pass' || item?.verification?.verdict === 'pass')
  );
  const verificationPassed = verification?.verdict === 'pass'
    || verification?.verification?.verdict === 'pass'
    || acceptance.verificationSatisfied === true
    || persistedVerifierPass;
  const hasVerifiedEvidence = summary.counts.verified > 0 || verificationPassed;
  // Independent verification is a completion requirement for the
  // verification/finalization boundary, not for every intermediate step. A
  // high-uncertainty run may therefore gather, reason, build or observe before
  // it reaches its explicit verification task. This keeps the gate rigorous
  // without turning the whole workflow into repeated premature verification.
  const verificationGate = taskType === 'verify'
    || taskType === 'deliver'
    || acceptance.finalizationRequired === true;
  const verificationRequired = verificationGate && (
    workflow.authority?.controls?.independentVerificationRequired === true
      || acceptance.verificationRequired === true
  );
  const acceptanceHasExplicitGate = Boolean(
    (Array.isArray(acceptance.criteria) && acceptance.criteria.length)
    || (Array.isArray(acceptance.evidenceRequired) && acceptance.evidenceRequired.length)
    || acceptance.authorizationRequired === true
    || acceptance.verificationRequired === true
  );
  const finalizationGate = taskType === 'verify'
    || taskType === 'deliver'
    || acceptance.finalizationRequired === true;
  // The real-world outcome gate is for proving an external/world-state
  // transition, not for re-verifying ordinary informational or advisory work.
  // Normal acceptance + verification already covers answers, analysis,
  // decision support, memory/tool results, code review, and design/invention
  // artifacts. World-state proof remains mandatory when observation of an
  // external or physical effect is actually required.
  const outcomeGate = finalizationGate && outcomeContract.realWorldTask === true && (
    outcomeContract.externalEffect === true
    || outcomeContract.physical === true
    || outcomeContract.controls?.observationRequired === true
  );
  // A verify verdict is already normalized against every required success
  // criterion before it reaches this gate. Do not reject that same verified
  // pass again because the pre-verification acceptance projection has not yet
  // been persisted as satisfied. Deliver/finalization still uses the persisted
  // acceptance contract.
  // A normalized verify pass satisfies the acceptance criteria at the verify
  // boundary and remains authoritative for the following delivery boundary.
  // Authorization and real-world outcome controls are still evaluated below.
  // Without this persistence, already-verified work can be stranded because
  // the pre-verification acceptance projection still contains historical
  // evidence/criteria gaps.
  const verifiedBoundarySatisfied = (taskType === 'verify' && verificationPassed)
    || (taskType === 'deliver' && acceptance.verificationSatisfied === true);
  const gaps = [
    ...(finalizationGate && acceptanceHasExplicitGate && !verifiedBoundarySatisfied
      ? (Array.isArray(acceptance.gaps) ? acceptance.gaps : [])
      : []),
    ...(finalizationGate && !authorizationSatisfied ? ['authorization-missing'] : []),
    ...(verificationRequired && !verificationPassed ? ['verification-missing'] : []),
    ...(status === 'complete' && finalizationGate && acceptanceHasExplicitGate
      && !verifiedBoundarySatisfied && !acceptance.satisfied ? ['acceptance-unsatisfied'] : []),
    ...(status === 'complete' && !hasVerifiedEvidence && taskType !== 'respond' && verificationRequired ? ['evidence-insufficient'] : []),
    ...(status === 'complete' && outcomeGate && outcomeContract.completion?.eligible !== true ? (outcomeContract.gaps ?? ['outcome-evidence-required']) : [])
  ];
  return {
    allowed: status !== 'complete' || gaps.length === 0,
    gaps: [...new Set(gaps)],
    evidence: summary,
    verificationRequired,
    verificationPassed,
    reason: gaps.length ? 'completion-gate-not-satisfied' : 'completion-evidence-sufficient'
  };
}

/**
 * Recovery is part of the same workflow, never a separate retry loop.
 */
export function unifiedRecoveryDecision({
  reason = '',
  attempts = 0,
  maxAttempts = 3,
  consequence = 0,
  humanControlRequired = false,
  governanceStatus = 'ready'
} = {}) {
  const base = recoveryDecision({ reason, attempts, maxAttempts, consequence, humanControlRequired });
  if (governanceStatus === 'blocked') {
    return { ...base, action: 'stop', reason: 'governance-blocked' };
  }
  return {
    ...base,
    lifecycle: 'reassess-before-next-action',
    blindRetryForbidden: true
  };
}

export function subsystemCanAct(workflow = {}, subsystem = '', {
  action = 'execute',
  requiresCapability = null,
  authorized = true
} = {}) {
  const authority = workflow.authority ?? {};
  const known = SUBSYSTEMS.includes(text(subsystem));
  const candidate = authority.candidate?.id ?? authority.candidate?.role ?? null;
  return {
    allowed: known
      && authorized
      && authority.action !== 'stop'
      && authority.action !== 'human-control'
      && (!requiresCapability || !candidate || candidate === requiresCapability),
    reason: !known ? 'unknown-subsystem'
      : !authorized ? 'authorization-missing'
      : authority.action === 'stop' ? 'workflow-stopped'
      : authority.action === 'human-control' ? 'human-control-required'
      : 'server-authorized',
    authority: 'server-owned',
    action
  };
}

function modeControllerCatalogSafe() {
  return ['normal-chat', 'code', 'research'].map(mode => {
    const c = controllerForSurface(mode);
    return { id: c.id, mode: c.mode, objective: c.objective, roles: [...c.roles] };
  });
}

export { SUBSYSTEMS };


/**
 * Compatibility projection for callers that still require workflowBlueprint.
 * One situation-adaptive decision, not a hard-coded domain mode/phase list.
 * It describes potential scope and triggers; only the run controller creates work.
 */
export function selectAdaptiveWorkflow({ goal = '', need = null, capabilities = [], situation = null, resourcePlan = null } = {}) {
  const s = situation ?? {};
  const available = list((Array.isArray(capabilities) ? capabilities : []).map(item =>
    typeof item === 'string' ? item : item?.id));
  const executionRequired = s.executionRequired === true ||
    ['code', 'execution', 'file', 'image', 'artifact'].includes(text(need?.form).toLowerCase()) ||
    available.some(id => ['code-execution', 'code-generation', 'file-editing', 'external-action'].includes(id));
  const evidenceGap = s.evidenceGap === true || s.unknownSituation === true ||
    s.externalData?.hasExternalDataNeed === true ||
    available.some(id => ['evidence-retrieval', 'capability-discovery'].includes(id));
  const immediate = s.crisis === true;
  const budget = resourcePlan?.executionPolicy ?? {};
  const proposed = composeOpenWorldDecision({
    goal, situation: {
      ...s, evidenceGap, executionRequired,
      uncertainty: s.unknownSituation === true ? 1 : s.uncertainty,
      authorizationRequired: s.authorizationRequired === true,
      authorizationSatisfied: s.authorizationSatisfied !== false
    },
    remainingBudgetRatio: s.remainingBudgetRatio ?? null
  });
  const evidenceLimit = Math.max(1, Math.min(64,
    Number(resourcePlan?.contextPolicy?.maxItems) || 16));
  const chosenAction = immediate ? 'direct' : proposed.action;
  const closedLoop = {
    enabled: !immediate,
    checkpoint: immediate ? null : 'after-each-material-step',
    replanTriggers: immediate ? [] : [
      'new relevant evidence or a changed requirement',
      'missing or failing capability',
      'failed verification or inconsistent evidence',
      'user changes task scope',
      'permission, cost, or safety boundary changes'
    ],
    maxReplans: Number(budget.maxExecutionStages) > 0
      ? Math.max(1, Math.min(Number(budget.maxExecutionStages), 8)) : 1
  };
  return {
    version: 2,
    mode: immediate || chosenAction === 'direct' ? 'direct' : 'adaptive',
    strategy: 'incremental-open-world',
    nextAction: chosenAction,
    // Intentionally no generated future phase list: actions are created when useful.
    phases: [],
    closedLoop,
    ...(need?.deliverable ? { deliverable: text(need.deliverable).slice(0, 200) } : {}),
    evidence: { minimum: 0, maximum: evidenceLimit },
    stopConditions: [
      need?.deliverable ? 'deliver: ' + text(need.deliverable).slice(0, 160)
        : 'the requested outcome is met',
      'required evidence and acceptance checks are satisfied',
      'report a genuine blocker rather than inventing work'
    ],
    expansionTriggers: closedLoop.replanTriggers,
    ...(Number(budget.maxToolCalls) > 0 ? { maxToolCalls: Number(budget.maxToolCalls) } : {}),
    ...(text(goal) ? {} : { note: 'no goal text' })
  };
}
