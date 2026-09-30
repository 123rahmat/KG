/**
 * Universal capability contracts.
 *
 * A capability is a runtime contract, not a domain engine. Native capabilities
 * are bootstraps; discovered capabilities remain candidates until an authorized
 * implementation exists and produces evidence.
 */

import { isBuiltInCapability } from './capability-compiler.js';

const text = value => String(value ?? '').trim();

export const CAPABILITY_SCHEMA_VERSION = '1';
export const RISK_CLASSES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const VERIFICATION_LEVELS = Object.freeze([
  'evidence-backed',
  'reproducible',
  'empirical',
  'human-certified'
]);
export const EXECUTION_MODES = Object.freeze([
  'model',
  'local',
  'remote',
  'tool',
  'human',
  'manual'
]);

const MAX_DISCOVERED_CAPABILITIES = 24;

function safeId(value, fallback = 'discovered-capability') {
  const raw = text(value).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return raw || fallback;
}

function list(value, { max = 40 } = {}) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => {
    if (typeof item === 'string') return text(item);
    if (item && typeof item === 'object') return text(item.name || item.id || item.label);
    return '';
  }).filter(Boolean))].slice(0, max);
}

function enumValue(value, allowed, fallback) {
  const candidate = text(value).toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}

function normalizeVerification(value = {}, fallbackHumanReview = false) {
  const verification = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    level: enumValue(verification.level, VERIFICATION_LEVELS, 'evidence-backed'),
    method: text(verification.method) || 'Compare observed evidence with predeclared success criteria.',
    humanReviewRequired: verification.humanReviewRequired === true || fallbackHumanReview,
    criteria: list(verification.criteria, { max: 20 })
  };
}

export function normalizeCapabilitySpec(raw = {}, {
  source = 'discovery',
  dynamic = true
} = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const risk = enumValue(value.risk, RISK_CLASSES, dynamic ? 'medium' : 'low');
  const physical = value.physical === true || /physical|hardware|machine|device|vehicle|building/i.test(text(value.category));
  const highImpact = value.highImpact === true;

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    id: safeId(value.id || value.name),
    name: text(value.name) || safeId(value.id || value.name),
    category: text(value.category) || 'dynamic',
    source: text(value.source) || source,
    dynamic: Boolean(dynamic),
    status: dynamic ? 'candidate' : 'bootstrap',
    purpose: text(value.purpose || value.reason) || 'Capability required to satisfy the current goal.',
    inputs: list(value.inputs),
    outputs: list(value.outputs),
    executionModes: list(value.executionMode ?? value.executionModes, { max: EXECUTION_MODES.length })
      .filter(item => EXECUTION_MODES.includes(item.toLowerCase()))
      .map(item => item.toLowerCase()),
    tools: list(value.tools),
    prerequisites: list(value.prerequisites),
    constraints: list(value.constraints),
    dataClasses: list(value.dataClasses),
    risk,
    physical,
    highImpact,
    sideEffects: value.sideEffects === true
      || ['high', 'critical'].includes(risk)
      || physical,
    verification: normalizeVerification(value.verification, highImpact || physical || risk === 'critical'),
    implementation: {
      kind: text(value.implementation?.kind) || 'external-or-discovered',
      provider: text(value.implementation?.provider),
      reference: text(value.implementation?.reference)
    }
  };
}

export function normalizeCapabilityDiscovery(payload = {}) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const raw = Array.isArray(value.capabilities) ? value.capabilities : [];
  const capabilities = [];
  const seen = new Set();

  for (const item of raw.slice(0, MAX_DISCOVERED_CAPABILITIES)) {
    // Model output is untrusted: a null or scalar entry names nothing.
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const spec = normalizeCapabilitySpec(item, { source: 'discovery', dynamic: true });
    // A capability the server already provides (writing code, running it in
    // the sandbox…) is not new: it needs no registration and no
    // administrator approval, which would otherwise hold the work forever.
    if (seen.has(spec.id) || isBuiltInCapability(spec.id)) continue;
    seen.add(spec.id);
    capabilities.push(spec);
  }

  const executionRequirements = {};
  for (const kind of ['code']) {
    const candidate = value.executionRequirements?.[kind];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    executionRequirements[kind] = {
      cpuCores: positive(candidate.cpuCores),
      memoryBytes: positive(candidate.memoryBytes),
      storageBytes: positive(candidate.storageBytes),
      gpu: {
        required: candidate.gpu?.required === true,
        memoryBytes: positive(candidate.gpu?.memoryBytes)
      },
      software: Object.fromEntries(
        Object.entries(candidate.software ?? {})
          .filter(([name, version]) => /^[A-Za-z0-9._-]{1,80}$/.test(text(name)) && text(version))
          .slice(0, 24)
          .map(([name, version]) => [text(name), text(version)])
      )
    };
  }

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capabilities,
    executionRequirements
  };
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function capabilityRequiresApproval(spec = {}) {
  const value = normalizeCapabilitySpec(spec);
  return value.sideEffects || ['high', 'critical'].includes(value.risk) || value.verification.humanReviewRequired;
}

export function verificationContract({
  physical = false,
  highImpact = false,
  capabilitySpecs = []
} = {}) {
  const normalized = Array.isArray(capabilitySpecs)
    ? capabilitySpecs.map(spec => normalizeCapabilitySpec(spec))
    : [];
  const humanReviewRequired = Boolean(
    physical
      || highImpact
      || normalized.some(spec => capabilityRequiresApproval(spec) && spec.verification.humanReviewRequired)
  );

  return {
    minimumLevel: humanReviewRequired ? 'human-certified' : 'evidence-backed',
    humanReviewRequired,
    rule: humanReviewRequired
      ? 'Execution evidence must be reviewed by an authorized human before the run is considered verified.'
      : 'Observed evidence must be checked against the success criteria fixed during planning.'
  };
}

export function approvalReasons({
  governanceRequired = false,
  execution = false,
  highImpact = false,
  physical = false,
  capabilitySpecs = []
} = {}) {
  const reasons = [];
  if (governanceRequired) reasons.push('A governance policy requires human approval.');
  if (execution) reasons.push('External code or tool execution is about to occur.');
  if (highImpact) reasons.push('The goal has a potentially high-impact context.');
  if (physical) reasons.push('The goal can affect physical systems or real-world resources.');
  if (Array.isArray(capabilitySpecs)) {
    for (const spec of capabilitySpecs.map(item => normalizeCapabilitySpec(item))) {
      if (capabilityRequiresApproval(spec)) reasons.push(`Capability "${spec.name}" requires approval.`);
    }
  }
  return [...new Set(reasons)];
}
