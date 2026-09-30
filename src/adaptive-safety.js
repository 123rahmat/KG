/**
 * Safety as an adaptive-system invariant.
 *
 * Safety is not only prompt guidance. The adaptive planner, capability
 * discovery and execution boundary all consume the same server-side safety
 * decision. Model hints are advisory and can only make a decision stricter;
 * they can never reopen a deterministic refusal.
 */

import {
  screenRequest,
  combineDecisions,
  normalizePolicyHint
} from './safety.js';

export const ADAPTIVE_SAFETY_CONTRACT_VERSION = '1';

const text = value => String(value ?? '').trim();

function normalizePolicy(value, blockedTopics) {
  return normalizePolicyHint(value, { blockedTopics }) ?? null;
}

/**
 * Evaluate one situation for the adaptive workflow.
 *
 * The returned decision is intentionally plain data so it can be persisted
 * with a run and re-checked later without trusting browser state.
 */
export function evaluateAdaptiveSafety(goal, {
  blockedTopics = [],
  classifierHints = null,
  candidateCapabilities = [],
  candidateTools = [],
  candidateSideEffects = []
} = {}) {
  const rules = screenRequest(goal, { blockedTopics });
  const modelHint = normalizePolicy(classifierHints?.policy ?? classifierHints, blockedTopics);
  const decision = combineDecisions(rules, modelHint);
  const refused = decision.decision === 'refuse';

  return {
    contractVersion: ADAPTIVE_SAFETY_CONTRACT_VERSION,
    decision: decision.decision,
    category: decision.category ?? null,
    source: decision.source ?? 'rules',
    message: decision.message ?? null,
    alternatives: [...(decision.alternatives ?? [])],
    care: [...new Set(decision.care ?? [])],
    allowed: !refused,
    executionAllowed: !refused,
    capabilityDiscoveryAllowed: !refused,
    toolUseAllowed: !refused,
    sideEffectsAllowed: !refused,
    requiresHumanDecision: decision.decision === 'care' && decision.care?.includes('people-decisions') === true,
    blockedCapabilities: refused ? [...new Set(candidateCapabilities.map(text).filter(Boolean))] : [],
    blockedTools: refused ? [...new Set(candidateTools.map(text).filter(Boolean))] : [],
    blockedSideEffects: refused ? [...new Set(candidateSideEffects.map(text).filter(Boolean))] : [],
    constraints: {
      deterministicRefusalCannotBeOverridden: true,
      safetyCheckedBeforeCapabilityDiscovery: true,
      safetyCheckedBeforeExecution: true,
      safetyCheckedBeforeSideEffects: true,
      modelSafetyHintsAreUntrusted: true,
      executionRequiresIndependentSafetyGate: true
    },
    principle: 'Adapt to legitimate goals, but never adapt safety boundaries away.'
  };
}

/**
 * Independent execution-time safety gate.
 *
 * This intentionally does not call a model. It re-evaluates the persisted
 * adaptive decision plus the task/capability description at the moment an
 * executable action is requested.
 */
export function executionSafetyGate(run, task, {
  blockedTopics = [],
  payload = null
} = {}) {
  const persisted = run?.adaptation?.safety;
  // A declined request understood adaptively gets one reasoning-only reply
  // to the person's real need, and its check: no tools, payloads or execution.
  const adaptiveReply = persisted?.decision === 'refuse' && run?.adaptation?.safetyAdaptive === true
    && ((task?.type === 'respond' && task?.metadata?.declined === true) || task?.type === 'verify')
    && !payload;
  if (adaptiveReply) return { allowed: true, adaptiveReply: true, category: persisted.category ?? null, care: [], source: 'adaptive-decline' };
  if (persisted?.decision === 'refuse') {
    return {
      allowed: false,
      reason: 'The adaptive safety policy blocked this workflow before execution.',
      category: persisted.category ?? null,
      source: persisted.source ?? 'persisted-adaptive-safety'
    };
  }

  const taskParts = [
    run?.goal,
    task?.purpose,
    JSON.stringify(task?.metadata?.capabilitySpecs ?? []),
    payload && typeof payload === 'object' ? JSON.stringify(payload) : text(payload)
  ].filter(Boolean).join('\n');

  const fresh = screenRequest(taskParts, { blockedTopics });
  if (fresh.decision === 'refuse') {
    return {
      allowed: false,
      reason: fresh.message,
      category: fresh.category,
      source: fresh.source
    };
  }

  return {
    allowed: true,
    care: [...new Set([
      ...(persisted?.care ?? []),
      ...(fresh.care ?? [])
    ])],
    source: 'independent-rules'
  };
}
