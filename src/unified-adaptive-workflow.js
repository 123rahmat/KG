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
import { adaptiveEffortProfile, adaptiveBehaviorContract } from './adaptive-efficiency.js';
import {
  adaptiveDecisionAuthority,
  buildAcceptanceContract,
  recoveryDecision,
  evidenceState,
  summarizeEvidence
} from './adaptive-decision-authority.js';

const text = value => String(value ?? '').trim();
const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const list = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];

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
    verificationSatisfied: acceptance.verificationSatisfied === true
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
  profile = null
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
  const behavior = adaptiveBehaviorContract(p, {
    situation: { ...s, consequence: consequenceOf(s) },
    acceptance: a,
    candidates
  });

  return {
    version: 1,
    principle: 'One adaptive workflow, many specialized capabilities. Every subsystem follows the same situation, evidence, authority, execution, verification and stopping contract.',
    goal: s.goal,
    situation: s,
    profile: p,
    acceptance: a,
    authority,
    behavior,
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
  authorizedCapabilities = []
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
    situation: mergedSituation,
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
    previousAction: prior.authority?.action ?? null
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
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const summary = summarizeEvidence(evidenceList);
  const hasVerifiedEvidence = summary.counts.verified > 0 || Boolean(verification?.verdict === 'pass');
  const verificationRequired = workflow.authority?.controls?.independentVerificationRequired === true
    || acceptance.verificationRequired === true;
  const verificationPassed = verification?.verdict === 'pass'
    || verification?.verification?.verdict === 'pass'
    || acceptance.verificationSatisfied === true;
  const acceptanceHasExplicitGate = Boolean(
    (Array.isArray(acceptance.criteria) && acceptance.criteria.length)
    || (Array.isArray(acceptance.evidenceRequired) && acceptance.evidenceRequired.length)
    || acceptance.authorizationRequired === true
    || acceptance.verificationRequired === true
  );
  const gaps = [
    ...(acceptanceHasExplicitGate ? (Array.isArray(acceptance.gaps) ? acceptance.gaps : []) : []),
    ...(!authorizationSatisfied ? ['authorization-missing'] : []),
    ...(verificationRequired && !verificationPassed ? ['verification-missing'] : []),
    ...(status === 'complete' && acceptanceHasExplicitGate && !acceptance.satisfied ? ['acceptance-unsatisfied'] : []),
    ...(status === 'complete' && !hasVerifiedEvidence && taskType !== 'respond' && verificationRequired ? ['evidence-insufficient'] : [])
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

export { SUBSYSTEMS };
