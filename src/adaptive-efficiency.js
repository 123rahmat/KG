/**
 * Adaptive efficiency policy.
 *
 * Converts situation signals into a conservative effort profile. This is
 * deliberately model/provider agnostic: the orchestrator can use the profile
 * to decide context depth, verification depth, tool allowance and compute.
 *
 * Core rule:
 *   minimize unnecessary resource use subject to the task's acceptance
 *   criteria, uncertainty and risk requirements.
 */

const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

const RISK = Object.freeze({ low: 0.15, medium: 0.45, high: 0.75, critical: 1 });


export function normalizeAdaptiveRisk(value = 'medium') {
  const key = String(value ?? '').trim().toLowerCase();
  return RISK[key] === undefined ? 'medium' : key;
}

export function adaptiveEffortProfile({
  complexity = 0,
  uncertainty = 0,
  risk = 'medium',
  verificationGap = 0,
  failureCount = 0,
  irreversible = false,
  acceptanceCriteriaMissing = false
} = {}) {
  const riskScore = RISK[normalizeAdaptiveRisk(risk)];
  const complexityScore = clamp01(complexity);
  const uncertaintyScore = clamp01(uncertainty);
  const verificationScore = clamp01(verificationGap);
  const failures = clamp01(Number(failureCount) / 3);
  const irreversibleScore = irreversible ? 1 : 0;
  const criteriaScore = acceptanceCriteriaMissing ? 0.35 : 0;

  const pressure = Math.max(
    complexityScore,
    uncertaintyScore,
    riskScore,
    verificationScore,
    failures,
    irreversibleScore,
    criteriaScore
  );

  const level = pressure >= 0.9 ? 'critical'
    : pressure >= 0.65 ? 'deep'
      : pressure >= 0.35 ? 'standard'
        : 'minimal';

  // Extra effort is justified by uncertainty/risk/verification need, not by
  // task size alone. This keeps large but deterministic work inexpensive.
  const verificationDepth = riskScore >= 0.75 || verificationScore >= 0.5 || failures > 0
    ? 'deep'
    : pressure >= 0.35 ? 'standard' : 'light';

  const contextDepth = uncertaintyScore >= 0.65 || complexityScore >= 0.8
    ? 'broad'
    : uncertaintyScore >= 0.3 || complexityScore >= 0.35
      ? 'targeted'
      : 'minimal';

  const expansionAllowed = pressure >= 0.65 || acceptanceCriteriaMissing;
  const stopRule = pressure < 0.35 && verificationScore <= 0
    ? 'pass-then-stop'
    : 'continue-until-acceptance-evidence';

  return {
    level,
    pressure,
    scores: {
      complexity: complexityScore,
      uncertainty: uncertaintyScore,
      risk: riskScore,
      verificationGap: verificationScore,
      failures,
      irreversible: irreversibleScore
    },
    contextDepth,
    verificationDepth,
    expansionAllowed,
    stopRule,
    principle: 'Use the least effort that can produce sufficient evidence for the current acceptance criteria.'
  };
}

export function adaptiveResourceDecision({
  profile,
  estimatedCost = 0,
  expectedBenefit = 0,
  requiredConfidence = 0.9,
  currentConfidence = 0
} = {}) {
  const p = profile ?? adaptiveEffortProfile({});
  const cost = Math.max(0, Number(estimatedCost) || 0);
  const benefit = Math.max(0, Number(expectedBenefit) || 0);
  const confidenceGap = clamp01(requiredConfidence - currentConfidence);

  if (confidenceGap <= 0 && benefit <= cost) {
    return { decision: 'stop', reason: 'Acceptance confidence is met and additional work has no positive expected value.' };
  }

  if (cost > 0 && benefit / cost < 1 && confidenceGap < 0.15 && p.level !== 'critical') {
    return { decision: 'defer', reason: 'Additional resource use has low expected value at the current confidence gap.' };
  }

  return {
    decision: 'continue',
    reason: confidenceGap > 0 ? 'Additional evidence is justified by the remaining confidence gap.' : 'Additional work has positive expected value.',
    confidenceGap
  };
}
