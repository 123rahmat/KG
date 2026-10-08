/**
 * Unified adaptive decision authority.
 *
 * Pure, server-side policy for deciding the smallest justified next action.
 * It does not execute tools, mutate files, grant permissions, or promote
 * agent authority. Callers must still enforce server-owned gates.
 */

const text = value => String(value ?? '').trim();
const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const uniq = values => [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];

export function evidenceState(value) {
  if (value && typeof value === 'object') {
    const kind = text(value.kind || value.state).toLowerCase();
    if (['observed', 'verified', 'assumption', 'inference', 'unknown', 'stale'].includes(kind)) return kind;
  }
  const kind = text(value).toLowerCase();
  if (['observed', 'verified', 'assumption', 'inference', 'unknown', 'stale'].includes(kind)) return kind;
  return 'unknown';
}

export function summarizeEvidence(evidence = []) {
  const items = Array.isArray(evidence) ? evidence : [];
  const counts = { verified: 0, observed: 0, inference: 0, assumption: 0, stale: 0, unknown: 0 };
  for (const item of items) counts[evidenceState(item)] += 1;
  return {
    counts,
    total: items.length,
    verifiedRatio: items.length ? counts.verified / items.length : 0,
    unresolved: counts.unknown + counts.assumption + counts.stale
  };
}

export function buildAcceptanceContract({
  goal = '',
  criteria = [],
  evidenceRequired = [],
  evidence = [],
  authorizationRequired = false,
  authorizationSatisfied = true,
  verificationRequired = false,
  verificationSatisfied = false,
  finalizationRequired = false
} = {}) {
  const normalizedCriteria = uniq(criteria);
  const requiredEvidence = uniq(evidenceRequired);
  const summary = summarizeEvidence(evidence);
  const gaps = [
    ...(normalizedCriteria.length ? [] : ['acceptance-criteria-missing']),
    ...requiredEvidence.filter(item => !itemsContainEvidence(evidence, item)),
    ...(authorizationRequired && !authorizationSatisfied ? ['authorization-missing'] : []),
    ...(verificationRequired && !verificationSatisfied ? ['verification-missing'] : [])
  ];
  return {
    version: 1,
    goal: text(goal),
    criteria: normalizedCriteria,
    evidenceRequired: requiredEvidence,
    evidenceSummary: summary,
    authorizationRequired: authorizationRequired === true,
    authorizationSatisfied: authorizationSatisfied !== false,
    verificationRequired: verificationRequired === true,
    verificationSatisfied: verificationSatisfied === true,
    finalizationRequired: finalizationRequired === true,
    gaps,
    satisfied: gaps.length === 0
  };
}

function itemsContainEvidence(evidence, required) {
  const needle = text(required).toLowerCase();
  if (!needle) return true;
  return (Array.isArray(evidence) ? evidence : []).some(item => {
    const state = evidenceState(item);
    if (state !== 'verified' && state !== 'observed') return false;
    const hay = typeof item === 'object' ? JSON.stringify(item).toLowerCase() : text(item).toLowerCase();
    return hay.includes(needle);
  });
}

export function adaptiveDecisionAuthority({
  situation = {},
  profile = {},
  acceptance = {},
  candidates = [],
  availableCapabilities = [],
  authorizedCapabilities = [],
  failedAttempts = 0,
  previousAction = null
} = {}) {
  const s = situation && typeof situation === 'object' ? situation : {};
  const p = profile && typeof profile === 'object' ? profile : {};
  const a = acceptance && typeof acceptance === 'object' ? acceptance : {};
  const maturity = p.maturity ?? {};
  const pressure = clamp01(Math.max(
    Number(p.pressure) || 0,
    Number(maturity.pressure) || 0,
    Number(s.uncertainty) || 0,
    Number(s.riskScore) || 0,
    Number(s.verificationGap) || 0,
    Number(failedAttempts || 0) / 3
  ));
  const consequence = clamp01(Math.max(
    Number(s.consequence) || 0,
    Number(s.riskScore) || 0,
    s.irreversible ? 1 : 0,
    s.externalSideEffect ? 0.85 : 0,
    s.physical ? 1 : 0,
    s.regulated ? 0.9 : 0,
    s.peopleDecision ? 1 : 0
  ));

  const missingEvidence = Array.isArray(a.gaps) ? a.gaps : [];
  const unresolved = Number(a.evidenceSummary?.unresolved) || 0;
  const humanGate = Boolean(maturity.humanControlRequired || s.authorizationRequired || consequence >= 0.9);
  const independentVerification = Boolean(
    maturity.independentVerificationRequired || consequence >= 0.65 || unresolved > 0 || missingEvidence.includes('verification-missing')
  );

  const usableCapabilities = uniq(authorizedCapabilities.length ? authorizedCapabilities : availableCapabilities);
  const requestedCandidates = Array.isArray(candidates) ? candidates : [];
  // Never fall back to a candidate excluded by the explicit capability
  // allow-list. Discovery/selection is not execution authorization.
  const candidate = requestedCandidates.find(item => {
    const id = text(typeof item === 'string' ? item : item?.id);
    return id && (!usableCapabilities.length || usableCapabilities.includes(id));
  }) ?? null;

  let action = 'stop';
  let reason = 'No justified next action is available.';
  if (humanGate && !a.authorizationSatisfied && (a.authorizationRequired || consequence >= 0.9)) {
    action = 'human-control';
    reason = 'The situation requires human authority before commitment.';
  } else if (!a.satisfied) {
    action = independentVerification ? 'gather-evidence' : 'continue';
    reason = 'Acceptance evidence or a required control gate is still missing.';
  } else if (candidate) {
    action = 'execute';
    reason = pressure >= 0.65 ? 'Execute the smallest justified capability with elevated controls.' : 'Execute the smallest justified capability.';
  } else if (previousAction && /execute|continue|gather-evidence/.test(previousAction) && pressure < 0.35) {
    action = 'stop';
    reason = 'The situation is stable and further work is not justified.';
  }

  const scope = {
    effort: p.level ?? maturity.level ?? 'standard',
    context: p.contextDepth ?? 'minimal',
    tools: p.expansionAllowed ? 'minimum-necessary' : 'already-authorized-only',
    agents: p.expansionAllowed ? 'recruit-for-identified-gaps' : 'single-agent-when-sufficient',
    verification: independentVerification ? 'independent-when-feasible' : (p.verificationDepth ?? 'light'),
    recovery: maturity.recoveryMode ?? 'normal',
    humanControl: humanGate ? 'required' : 'situational',
    provenance: maturity.provenanceRequired ? 'required' : 'normal'
  };

  return {
    version: 1,
    authority: 'server-owned',
    action,
    reason,
    pressure,
    consequence,
    candidate: candidate ? (typeof candidate === 'string' ? { id: candidate } : candidate) : null,
    scope,
    controls: {
      independentVerificationRequired: independentVerification,
      humanControlRequired: humanGate,
      rollbackRequired: Boolean(maturity.rollbackRequired || consequence >= 0.75),
      provenanceRequired: Boolean(maturity.provenanceRequired || consequence >= 0.35),
      neverAutoPromoteAuthority: true
    },
    stopping: {
      eligible: action === 'stop',
      reasons: action === 'stop' ? [reason] : [],
      diminishingReturns: pressure < 0.25 && unresolved === 0
    },
    evidence: {
      sufficient: a.satisfied === true,
      gaps: missingEvidence,
      unresolved
    },
    failures: {
      count: Number(failedAttempts) || 0,
      diagnoseBeforeRetry: failedAttempts >= 2
    }
  };
}

export function classifyAdaptiveFailure(reason = '') {
  const value = text(reason).toLowerCase();
  if (!value) return 'unknown';
  if (/permission|forbidden|unauthori[sz]ed|approval|consent/.test(value)) return 'authorization';
  if (/stale|revision|conflict|concurrency|changed since/.test(value)) return 'stale-state';
  if (/timeout|timed.?out|network|temporary|unavailable/.test(value)) return 'transient';
  if (/test|assert|regression|failed check/.test(value)) return 'verification';
  if (/syntax|parse|compile/.test(value)) return 'implementation';
  if (/security|secret|injection|privacy/.test(value)) return 'security';
  if (/missing|unsupported|capability|tool/.test(value)) return 'missing-capability';
  if (/assumption|wrong premise|incorrect context/.test(value)) return 'wrong-assumption';
  return 'fundamental';
}

export function recoveryDecision({ reason = '', attempts = 0, maxAttempts = 3, consequence = 0, humanControlRequired = false } = {}) {
  const failureClass = classifyAdaptiveFailure(reason);
  if (humanControlRequired || failureClass === 'authorization' || failureClass === 'security') {
    return { action: 'stop', failureClass, reason: 'authority-or-safety-boundary' };
  }
  if (failureClass === 'stale-state') return { action: 'reassess', failureClass, reason: 'state-changed-before-commit' };
  if (failureClass === 'wrong-assumption') return { action: 'reassess', failureClass, reason: 'assumption-invalidated' };
  if (failureClass === 'missing-capability') return { action: 'expand', failureClass, reason: 'required-capability-is-missing' };
  if (attempts >= maxAttempts) return { action: 'stop', failureClass, reason: 'bounded-recovery-exhausted' };
  if (failureClass === 'transient') return { action: 'retry', failureClass, reason: 'transient-failure' };
  if (failureClass === 'verification' || failureClass === 'implementation' || failureClass === 'fundamental') {
    return { action: consequence >= 0.75 ? 'replan-and-verify' : 'replan', failureClass, reason: 'failure-changes-the-plan-or-evidence-gap' };
  }
  return { action: 'diagnose', failureClass, reason: 'failure-cause-not-yet-established' };
}

export function invalidateDependents(changedId, dependencies = {}) {
  const root = text(changedId);
  if (!root) return [];
  const graph = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const invalid = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of Object.entries(graph)) {
      const list = Array.isArray(deps) ? deps.map(text) : [];
      if (!invalid.has(id) && list.some(dep => invalid.has(dep))) {
        invalid.add(id);
        changed = true;
      }
    }
  }
  return [...invalid];
}

export function idempotencyKey({ runId = '', taskId = '', action = '', targetRevision = '' } = {}) {
  return [text(runId), text(taskId), text(action), text(targetRevision)].join(':');
}
