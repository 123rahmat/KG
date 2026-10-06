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
  const operatingSurface = ['code', 'research', 'design'].includes(text(surface))
    ? text(surface)
    : text(s.surface) === 'code' ? 'code'
      : text(s.surface) === 'research' ? 'research'
        : text(s.surface) === 'design' ? 'design'
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
  const hasVerifiedEvidence = summary.counts.verified > 0 || Boolean(verification?.verdict === 'pass');
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
  const verificationPassed = verification?.verdict === 'pass'
    || verification?.verification?.verdict === 'pass'
    || acceptance.verificationSatisfied === true;
  const acceptanceHasExplicitGate = Boolean(
    (Array.isArray(acceptance.criteria) && acceptance.criteria.length)
    || (Array.isArray(acceptance.evidenceRequired) && acceptance.evidenceRequired.length)
    || acceptance.authorizationRequired === true
    || acceptance.verificationRequired === true
  );
  const finalizationGate = taskType === 'verify'
    || taskType === 'deliver'
    || acceptance.finalizationRequired === true;
  const outcomeGate = finalizationGate && outcomeContract.realWorldTask === true && (
    outcomeContract.controls?.observationRequired === true
    || outcomeContract.controls?.verificationRequired === true
  );
    const gaps = [
    ...(finalizationGate && acceptanceHasExplicitGate ? (Array.isArray(acceptance.gaps) ? acceptance.gaps : []) : []),
    ...(finalizationGate && !authorizationSatisfied ? ['authorization-missing'] : []),
    ...(verificationRequired && !verificationPassed ? ['verification-missing'] : []),
    ...(status === 'complete' && finalizationGate && acceptanceHasExplicitGate && !acceptance.satisfied ? ['acceptance-unsatisfied'] : []),
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
  return ['normal-chat', 'code', 'research', 'design'].map(mode => {
    const c = controllerForSurface(mode);
    return { id: c.id, mode: c.mode, objective: c.objective, roles: [...c.roles] };
  });
}

export { SUBSYSTEMS };


// Legacy-compatible workflow selection facade. The public selector remains
// available, but the decision is implemented by this canonical workflow kernel
// so there is only one place that defines workflow selection semantics.
const LEGACY_MODES = Object.freeze([
  {
    mode: 'crisis-response',
    applies: ({ situation }) => situation?.crisis === true,
    phases: ['respond-now', 'point-to-help'],
    stop: ['the person has immediate, caring guidance and where to get help']
  },
  {
    mode: 'adaptive-discovery',
    applies: ({ ids, situation }) => situation?.unknownSituation === true || ids.has('capability-discovery'),
    phases: ['understand-and-bound', 'investigate-unknowns', 'discover-capabilities', 'plan', 'execute', 'verify', 'deliver'],
    stop: ['the unknowns that block the deliverable are resolved or stated as limits']
  },
  {
    mode: 'invent-and-test',
    applies: ({ ids }) => ids.has('invention'),
    phases: ['understand-need', 'prior-art', 'generate-concepts', 'compare', 'choose', 'decisive-experiment', 'verify', 'deliver'],
    stop: ['a chosen concept with a decisive experiment and what counts as success']
  },
  {
    mode: 'build-and-test',
    applies: ({ ids, need }) => ids.has('code-generation') || ids.has('code-execution') || need?.form === 'code',
    phases: ['understand-need', 'write-with-tests', 'syntax-check', 'run-tests', 'fix-from-errors', 'verify', 'deliver'],
    stop: ['the code does what was asked and its tests pass']
  },
  {
    mode: 'evidence-first',
    applies: ({ ids, situation }) => ids.has('evidence-retrieval') || ids.has('external-data-routing') || situation?.externalData?.hasExternalDataNeed === true,
    phases: ['understand-need', 'gather-minimum-evidence', 'reason', 'verify', 'deliver'],
    stop: ['every claim the deliverable depends on is backed by a source']
  },
  {
    mode: 'design-and-compose',
    applies: ({ ids, need }) => ids.has('design')
      || (ids.has('file-analysis') && !ids.has('code-generation'))
      || ['plan', 'document', 'design'].includes(need?.form),
    phases: ['understand-need', 'gather-inputs', 'compose', 'verify', 'deliver'],
    stop: ['the requested artifact is complete and fits the constraints']
  },
  {
    mode: 'answer',
    applies: () => true,
    phases: ['understand-need', 'answer', 'check'],
    stop: []
  }
]);

function legacyEvidenceBounds(mode, situation, resourcePlan) {
  const ceiling = Number(resourcePlan?.contextPolicy?.maxItems) > 0 ? Number(resourcePlan.contextPolicy.maxItems) : 16;
  const highStakes = situation?.highImpact === true || situation?.risk === 'high-impact';
  const floor = mode === 'evidence-first' ? (highStakes ? 2 : 1)
    : mode === 'invent-and-test' ? 1
      : 0;
  return { minimum: Math.min(floor, ceiling), maximum: ceiling };
}

export function selectAdaptiveWorkflow({ goal = '', need = null, capabilities = [], situation = null, resourcePlan = null } = {}) {
  const ids = new Set((Array.isArray(capabilities) ? capabilities : [])
    .map(item => text(typeof item === 'string' ? item : item?.id))
    .filter(Boolean));
  const applying = LEGACY_MODES.filter(item => item.applies({ ids, need, situation }));
  const lead = applying[0];
  const secondary = applying.slice(1).map(item => item.mode).filter(mode => mode !== 'answer');
  const budget = resourcePlan?.executionPolicy ?? {};
  const closedLoop = lead.mode === 'crisis-response'
    ? { enabled: false, checkpoint: null, replanTriggers: [] }
    : {
        enabled: true,
        checkpoint: 'after-each-material-step',
        replanTriggers: [
          'new evidence changes a requirement, constraint or confidence',
          'a tool/runtime/capability fails or becomes unavailable',
          'an output no longer satisfies the exact need or success criteria',
          'the user changes scope, depth, constraints or requested deliverable',
          'a safety, privacy, authorization or jurisdiction condition changes'
        ],
        maxReplans: Number(budget.maxExecutionStages) > 0
          ? Math.max(1, Math.min(Number(budget.maxExecutionStages), 8))
          : 1
      };
  const phases = [...lead.phases];
  if (closedLoop.enabled) {
    const verifyIndex = phases.lastIndexOf('verify');
    const insertAt = verifyIndex >= 0 ? verifyIndex : Math.max(0, phases.length - 1);
    phases.splice(insertAt, 0, 'observe', 'reassess', 'replan-if-needed');
  }
  return {
    mode: lead.mode,
    ...(secondary.length ? { secondary } : {}),
    phases,
    closedLoop,
    ...(need?.deliverable ? { deliverable: text(need.deliverable).slice(0, 200) } : {}),
    evidence: legacyEvidenceBounds(lead.mode, situation, resourcePlan),
    stopConditions: [
      need?.deliverable ? `the deliverable is given: ${text(need.deliverable).slice(0, 160)}` : "the person's stated outcome is met",
      'the success criteria are met with evidence',
      ...lead.stop
    ],
    expansionTriggers: [
      'the selected scope cannot produce the deliverable',
      'new evidence contradicts the plan or the situation',
      'a stakes, safety or jurisdiction question appears that the plan did not cover',
      ...(Number(budget.maxToolCalls) > 0 ? [`more than ${Number(budget.maxToolCalls)} tool calls would be needed`] : [])
    ],
    ...(text(goal) ? {} : { note: 'no goal text' })
  };
}
