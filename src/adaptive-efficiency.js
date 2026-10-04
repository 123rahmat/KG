/**
 * Adaptive efficiency and real-world maturity policy.
 *
 * Effort is adaptive: simple work stays cheap; uncertainty, failure, risk and
 * consequential side effects increase evidence, recovery and human-control
 * requirements. This module is provider/model agnostic.
 */

const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const RISK = Object.freeze({ low: 0.15, medium: 0.45, high: 0.75, critical: 1 });

import { adaptiveDecisionAuthority, buildAcceptanceContract } from './adaptive-decision-authority.js';

export function normalizeAdaptiveRisk(value = 'medium') {
  const key = String(value ?? '').trim().toLowerCase();
  return RISK[key] === undefined ? 'medium' : key;
}

export function realWorldMaturity({
  riskScore = 0, irreversible = false, externalSideEffect = false,
  physical = false, regulated = false, peopleDecision = false,
  uncertainty = 0, verificationGap = 0, failureCount = 0
} = {}) {
  const consequence = Math.max(
    clamp01(riskScore), irreversible ? 1 : 0, externalSideEffect ? 0.85 : 0,
    physical ? 1 : 0, regulated ? 0.9 : 0, peopleDecision ? 1 : 0
  );
  const uncertaintyScore = clamp01(uncertainty);
  const verificationScore = clamp01(verificationGap);
  const failures = clamp01(Number(failureCount) / 3);
  const pressure = Math.max(consequence, uncertaintyScore, verificationScore, failures);
  const level = pressure >= 0.9 ? 'maximum' : pressure >= 0.65 ? 'high'
    : pressure >= 0.35 ? 'standard' : 'light';

  return {
    level, pressure,
    humanControlRequired: peopleDecision || physical || regulated || consequence >= 0.9,
    independentVerificationRequired: consequence >= 0.65 || verificationScore >= 0.5 || failures > 0,
    provenanceRequired: consequence >= 0.35 || uncertaintyScore >= 0.35,
    rollbackRequired: irreversible || externalSideEffect || consequence >= 0.75,
    recoveryMode: failures >= 0.67 ? 'diagnose-before-retry' : failures > 0 ? 'targeted-retry' : 'normal',
    escalationTriggers: [
      ...(uncertaintyScore >= 0.65 ? ['uncertainty'] : []),
      ...(verificationScore >= 0.5 ? ['verification-gap'] : []),
      ...(failures > 0 ? ['failure'] : []),
      ...(externalSideEffect ? ['side-effect'] : []),
      ...(physical ? ['physical-world-impact'] : []),
      ...(regulated ? ['regulated-domain'] : []),
      ...(peopleDecision ? ['consequential-human-decision'] : [])
    ]
  };
}

export function adaptiveEffortProfile({
  complexity = 0, uncertainty = 0, risk = 'medium', verificationGap = 0,
  failureCount = 0, irreversible = false, acceptanceCriteriaMissing = false,
  externalSideEffect = false, physical = false, regulated = false, peopleDecision = false
} = {}) {
  const riskScore = RISK[normalizeAdaptiveRisk(risk)];
  const complexityScore = clamp01(complexity);
  const uncertaintyScore = clamp01(uncertainty);
  const verificationScore = clamp01(verificationGap);
  const failures = clamp01(Number(failureCount) / 3);
  const irreversibleScore = irreversible ? 1 : 0;
  const criteriaScore = acceptanceCriteriaMissing ? 0.35 : 0;
  const maturity = realWorldMaturity({
    riskScore, irreversible, externalSideEffect, physical, regulated, peopleDecision,
    uncertainty: uncertaintyScore, verificationGap: verificationScore, failureCount
  });

  const pressure = Math.max(
    complexityScore, uncertaintyScore, riskScore, verificationScore,
    failures, irreversibleScore, criteriaScore, maturity.pressure
  );
  const level = pressure >= 0.9 ? 'critical' : pressure >= 0.65 ? 'deep'
    : pressure >= 0.35 ? 'standard' : 'minimal';

  const verificationDepth = maturity.independentVerificationRequired || riskScore >= 0.75
    || verificationScore >= 0.5 || failures > 0
    ? 'deep' : pressure >= 0.35 ? 'standard' : 'light';

  const contextDepth = uncertaintyScore >= 0.65 || complexityScore >= 0.8
    ? 'broad' : uncertaintyScore >= 0.3 || complexityScore >= 0.35 ? 'targeted' : 'minimal';

  const expansionAllowed = pressure >= 0.65 || acceptanceCriteriaMissing
    || maturity.escalationTriggers.length > 0;
  const stopRule = pressure < 0.35 && verificationScore <= 0
    && !maturity.independentVerificationRequired
    ? 'pass-then-stop' : 'continue-until-acceptance-evidence';

  return {
    level, pressure,
    scores: {
      complexity: complexityScore, uncertainty: uncertaintyScore, risk: riskScore,
      verificationGap: verificationScore, failures, irreversible: irreversibleScore,
      consequence: maturity.pressure
    },
    contextDepth, verificationDepth, expansionAllowed, stopRule, maturity,
    adaptation: {
      escalateOn: maturity.escalationTriggers,
      recoverBy: maturity.recoveryMode,
      deescalateAfter: ['verified-success', 'stable-observation', 'acceptance-evidence-satisfied'],
      neverAutoPromoteAuthority: true
    },
    principle: 'Use the least effort that can produce sufficient evidence for the current acceptance criteria.',
    realWorldPrinciple: 'Increase control intensity for consequential work; model output is not professional certification.'
  };
}


export function adaptiveBehaviorContract(profile = adaptiveEffortProfile({}), { situation = {}, acceptance = {}, candidates = [] } = {}) {
  const p = profile ?? adaptiveEffortProfile({});
  const maturity = p.maturity ?? realWorldMaturity({});
  const level = String(p.level ?? 'standard');
  const rounds = level === 'minimal' ? 2 : level === 'standard' ? 4 : level === 'deep' ? 6 : 8;
  const contract = buildAcceptanceContract({
    goal: situation.goal ?? '',
    criteria: acceptance.criteria ?? [],
    evidenceRequired: acceptance.evidenceRequired ?? [],
    evidence: acceptance.evidence ?? [],
    authorizationRequired: acceptance.authorizationRequired === true,
    authorizationSatisfied: acceptance.authorizationSatisfied !== false,
    verificationRequired: acceptance.verificationRequired ?? maturity.independentVerificationRequired,
    verificationSatisfied: acceptance.verificationSatisfied === true
  });
  const authority = adaptiveDecisionAuthority({
    situation: { ...situation,
      uncertainty: situation.uncertainty ?? p.scores?.uncertainty ?? 0,
      riskScore: situation.riskScore ?? p.scores?.risk ?? 0,
      verificationGap: situation.verificationGap ?? p.scores?.verificationGap ?? 0,
      consequence: situation.consequence ?? p.scores?.consequence ?? 0
    },
    profile: p,
    acceptance: contract,
    candidates,
    failedAttempts: situation.failedAttempts ?? 0
  });
  return {
    version: 3,
    authority: 'server-owned',
    principle: 'Adapt every behavior to the current situation; do not maximize intelligence, tools, agents, context, verification, or parallelism unless justified by need and evidence.',
    maturity: level,
    pressure: p.pressure ?? 0,
    behavior: {
      understand: p.contextDepth,
      plan: p.contextDepth === 'broad' ? 'deep' : p.contextDepth === 'targeted' ? 'targeted' : 'minimal',
      resources: p.expansionAllowed ? 'expand-when-justified' : 'minimum-necessary',
      tools: 'minimum-necessary',
      agents: p.expansionAllowed ? 'adaptive-specialists' : 'single-agent-when-sufficient',
      parallelism: p.expansionAllowed ? 'independent-work-only' : 'off-unless-necessary',
      context: p.contextDepth,
      execution: maturity.rollbackRequired ? 'guarded-with-rollback' : 'normal',
      verification: p.verificationDepth,
      recovery: maturity.recoveryMode,
      humanControl: maturity.humanControlRequired ? 'required' : 'situational',
      provenance: maturity.provenanceRequired ? 'required' : 'normal',
      stopping: p.stopRule,
      applicationHandling: maturity.level === 'light' ? 'answer-or-act-with-minimum-necessary-scope' : maturity.level === 'standard' ? 'act-in-scoped-steps-with-checkpoints' : 'act-with-explicit-evidence-and-recovery',
      agenticBehavior: p.expansionAllowed ? 'recruit-specialists-only-for-identified-gaps' : 'keep-agentic-work-minimal',
      authority: 'server-owned',
      uncertaintyHandling: maturity.escalationTriggers.includes('uncertainty') ? 'investigate-before-commitment' : 'proceed-and-observe'
    },
    toolRoundsCeiling: rounds,
    independentVerificationRequired: maturity.independentVerificationRequired,
    rollbackRequired: maturity.rollbackRequired,
    humanControlRequired: maturity.humanControlRequired,
    provenanceRequired: maturity.provenanceRequired,
    escalationTriggers: maturity.escalationTriggers,
    deescalateAfter: p.adaptation?.deescalateAfter ?? ['verified-success', 'stable-observation', 'acceptance-evidence-satisfied'],
    neverAutoPromoteAuthority: true,
    authorityDecision: authority,
    acceptanceContract: contract
  };
}

export function adaptiveResourceDecision({
  profile, estimatedCost = 0, expectedBenefit = 0,
  requiredConfidence = 0.9, currentConfidence = 0, consequence = 0
} = {}) {
  const p = profile ?? adaptiveEffortProfile({});
  const cost = Math.max(0, Number(estimatedCost) || 0);
  const benefit = Math.max(0, Number(expectedBenefit) || 0);
  const confidenceGap = clamp01(requiredConfidence - currentConfidence);
  const consequenceScore = clamp01(consequence);

  if (p.maturity?.independentVerificationRequired && confidenceGap > 0) {
    return {
      decision: 'continue',
      reason: 'Independent verification is required before confidence can satisfy this real-world maturity level.',
      confidenceGap
    };
  }
  if (confidenceGap <= 0 && benefit <= cost && consequenceScore < 0.75) {
    return { decision: 'stop', reason: 'Acceptance confidence is met and additional work has no positive expected value.' };
  }
  if (cost > 0 && benefit / cost < 1 && confidenceGap < 0.15
      && p.level !== 'critical' && consequenceScore < 0.75) {
    return { decision: 'defer', reason: 'Additional resource use has low expected value at the current confidence gap.' };
  }
  return {
    decision: 'continue',
    reason: confidenceGap > 0
      ? 'Additional evidence is justified by the remaining confidence gap.'
      : 'Additional work has positive expected value or is required by the situation maturity contract.',
    confidenceGap
  };
}
