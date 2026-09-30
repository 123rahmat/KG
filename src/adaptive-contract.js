/**
 * System-wide adaptive contract.
 *
 * Every user-visible workflow decision is anchored to a reproducible situation
 * snapshot. The snapshot is descriptive metadata, not authority: execution
 * still requires the real runner, policy and evidence gates.
 */
import crypto from 'node:crypto';

export const ADAPTIVE_CONTRACT_VERSION = '9';
export const ADAPTATION_INVARIANT =
  'situation → capabilities → governed implementation → execution → evidence → next situation';

const text = value => String(value ?? '').trim();

function stable(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function situationFingerprint(snapshot = {}) {
  const canonical = JSON.stringify(stable(snapshot && typeof snapshot === 'object' ? snapshot : {}));
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function buildAdaptiveSnapshot({
  situation = {},
  requirements = [],
  implementationPlan = null,
  resourcePlan = null,
  workflowBlueprint = null,
  primarySurface = 'chat',
  presentation = {},
  runtime = {},
  privacy = {},
  governance = {},
  verification = {},
  provenance = {}
} = {}) {
  const required = [...new Set((Array.isArray(requirements) ? requirements : [])
    .map(item => text(typeof item === 'string' ? item : item?.id))
    .filter(Boolean))];
  const plan = implementationPlan && typeof implementationPlan === 'object'
    ? implementationPlan
    : {};
  const snapshot = {
    contractVersion: ADAPTIVE_CONTRACT_VERSION,
    invariant: ADAPTATION_INVARIANT,
    situation,
    requirements: required,
    implementation: {
      state: text(plan.state) || 'unknown',
      ready: plan.ready === true,
      executionReady: plan.executionReady === true,
      missing: Array.isArray(plan.missing) ? [...new Set(plan.missing.map(text).filter(Boolean))] : [],
      blocked: Array.isArray(plan.blocked) ? [...new Set(plan.blocked.map(text).filter(Boolean))] : []
    },
    resourcePlan: resourcePlan && typeof resourcePlan === 'object' ? resourcePlan : {},
    workflowBlueprint: workflowBlueprint && typeof workflowBlueprint === 'object' ? workflowBlueprint : {},
    presentation: {
      primarySurface: text(primarySurface) || 'chat',
      ...(presentation && typeof presentation === 'object' ? presentation : {})
    },
    runtime: runtime && typeof runtime === 'object' ? runtime : {},
    privacy: privacy && typeof privacy === 'object' ? privacy : {},
    governance: governance && typeof governance === 'object' ? governance : {},
    verification: verification && typeof verification === 'object' ? verification : {},
    provenance: provenance && typeof provenance === 'object' ? provenance : {}
  };
  return Object.freeze({
    ...snapshot,
    fingerprint: situationFingerprint(snapshot)
  });
}

export function validateAdaptiveSnapshot(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const errors = [];
  if (value.contractVersion !== ADAPTIVE_CONTRACT_VERSION) errors.push('invalid-contract-version');
  if (value.invariant !== ADAPTATION_INVARIANT) errors.push('invariant-mismatch');
  if (!value.situation || typeof value.situation !== 'object') errors.push('missing-situation');
  if (!Array.isArray(value.requirements)) errors.push('missing-requirements');
  if (!value.implementation || typeof value.implementation !== 'object') errors.push('missing-implementation-state');
  if (!text(value.fingerprint)) errors.push('missing-fingerprint');
  else {
    const { fingerprint, ...withoutFingerprint } = value;
    if (situationFingerprint(withoutFingerprint) !== fingerprint) errors.push('fingerprint-mismatch');
  }
  return { valid: errors.length === 0, errors };
}
