/**
 * Real-world outcome contract.
 *
 * A prompt solver can produce a plausible response without changing or
 * verifying anything outside the response. This contract makes the distinction
 * explicit: a real-world task has an intended outcome, an authority boundary,
 * an observable transition, and a proof state. The model may propose; only
 * server-authorized execution and observed evidence can advance world state.
 */

const text = value => String(value ?? '').trim();
const uniq = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];

const OUTCOME_STATES = Object.freeze([
  'proposed', 'prepared', 'authorized', 'executing', 'observed',
  'verified', 'delivered', 'blocked', 'unknown'
]);

const REAL_WORLD_INTENTS = new Set([
  'action', 'coordination', 'monitoring', 'routine', 'decision'
]);

export function buildRealWorldOutcomeContract({
  goal = '',
  realWorld = {},
  successCriteria = [],
  execution = {},
  authorizationSatisfied = true,
  evidence = []
} = {}) {
  const rw = realWorld && typeof realWorld === 'object' ? realWorld : {};
  const intent = text(rw.intent).toLowerCase() || 'information';
  const signals = rw.signals && typeof rw.signals === 'object' ? rw.signals : {};
  const externalEffect = signals.externalAction === true
    || rw.externalAction === true
    || execution.external === true;
  const physical = signals.physical === true || rw.physical === true;
  const consequential = ['consequential', 'high-impact', 'physical', 'crisis'].includes(text(rw.risk).toLowerCase());
  const realWorldTask = rw.realWorld === true || REAL_WORLD_INTENTS.has(intent) || externalEffect || physical;

  const requiresObservation = realWorldTask && (
    externalEffect || physical || intent === 'monitoring' || intent === 'coordination' || intent === 'routine'
  );
  const requiresVerification = realWorldTask && (
    requiresObservation || consequential || successCriteria.length > 0
  );
  const requiresHumanControl = externalEffect || physical || consequential
    || rw.userBehavior?.confirmation === 'every-external-action'
    || rw.controls?.includes?.('external-action-boundary') === true;

  const evidenceItems = Array.isArray(evidence) ? evidence : [];
  const observed = evidenceItems.some(item => {
    const state = text(item?.state ?? item?.kind).toLowerCase();
    return state === 'observed' || state === 'verified'
      || item?.provenance?.executed === true
      || item?.executionReceipt?.executed === true;
  });
  const verified = evidenceItems.some(item => {
    const state = text(item?.state ?? item?.kind).toLowerCase();
    return state === 'verified' || item?.verification?.verdict === 'pass'
      || item?.verdict?.verdict === 'pass';
  });

  const gaps = [];
  if (requiresHumanControl && authorizationSatisfied !== true) gaps.push('authorization-required');
  if (requiresObservation && !observed) gaps.push('world-observation-required');
  if (requiresVerification && !verified) gaps.push('outcome-verification-required');
  if (realWorldTask && !successCriteria.length) gaps.push('success-criteria-required');

  let state = 'proposed';
  if (gaps.includes('authorization-required')) state = 'prepared';
  else if (requiresObservation && !observed) state = 'authorized';
  else if (requiresVerification && !verified) state = observed ? 'observed' : 'executing';
  else if (verified) state = 'verified';
  else if (realWorldTask) state = 'prepared';

  return {
    version: 1,
    realWorldTask,
    intent,
    goal: text(goal),
    state,
    states: OUTCOME_STATES,
    externalEffect,
    physical,
    consequential,
    controls: {
      authorizationRequired: requiresHumanControl,
      authorizationSatisfied: authorizationSatisfied === true,
      observationRequired: requiresObservation,
      verificationRequired: requiresVerification,
      modelCannotDeclareOutcome: true,
      serverOwnsWorldMutation: true
    },
    successCriteria: uniq(successCriteria).slice(0, 20),
    evidence: {
      observed,
      verified,
      count: evidenceItems.length,
      acceptedSources: [
        'authorized-tool-result',
        'execution-receipt',
        'observed-environment-state',
        'verified-artifact',
        'authorized-human-report'
      ]
    },
    gaps,
    completion: {
      eligible: gaps.length === 0,
      rule: realWorldTask
        ? 'A real-world outcome is complete only after required authority, observation and verification evidence exist.'
        : 'Informational work may complete when its ordinary acceptance contract is satisfied.'
    }
  };
}

export function nextRealWorldOutcomeState(contract = {}, event = {}) {
  const current = text(contract.state) || 'proposed';
  const type = text(event.type).toLowerCase();
  if (type === 'authorization' && event.satisfied === true) return 'authorized';
  if (type === 'execution-started') return 'executing';
  if (type === 'observation' && event.observed === true) return 'observed';
  if (type === 'verification' && event.verified === true) return 'verified';
  if (type === 'delivery' && contract.completion?.eligible === true) return 'delivered';
  if (type === 'blocked') return 'blocked';
  return current;
}

export const REAL_WORLD_OUTCOME_STATES = OUTCOME_STATES;
