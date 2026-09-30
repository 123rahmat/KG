/**
 * Governed capability lifecycle.
 *
 * This closes the architectural gap between discovering a capability and
 * executing it. It creates deterministic implementation proposals, validates
 * the implementation contract, and defines the promotion boundary. It never
 * fabricates an executable runner.
 */

import crypto from 'node:crypto';

const text = value => String(value ?? '').trim();

const ALLOWED_STATES = Object.freeze([
  'discovered','specified','candidate','verified','registered',
  'approved','rejected','rolled-back'
]);
const ALLOWED_KINDS = Object.freeze([
  'native','composite','runtime','connector','hardware','external'
]);

const hash = value => crypto.createHash('sha256')
  .update(JSON.stringify(value), 'utf8')
  .digest('hex');

export function normalizeCapabilityRequirement(requirement = {}) {
  const source = typeof requirement === 'string' ? { id: requirement } : requirement;
  return {
    id: text(source?.id || source?.name),
    category: text(source?.category) || 'unknown',
    source: text(source?.source) || 'unknown',
    risk: text(source?.risk) || 'medium',
    dynamic: source?.dynamic === true,
    description: text(source?.description),
    objective: text(source?.objective),
    inputs: Array.isArray(source?.inputs) ? source.inputs : [],
    outputs: Array.isArray(source?.outputs) ? source.outputs : [],
    dependencies: Array.isArray(source?.dependencies)
      ? [...new Set(source.dependencies.map(text).filter(Boolean))] : [],
    constraints: Array.isArray(source?.constraints) ? source.constraints : [],
    evidence: Array.isArray(source?.evidence) ? source.evidence : [],
    version: text(source?.version) || 'candidate'
  };
}

export function capabilityImplementationProposal(requirement, {
  situationId = '',
  implementationKind = 'external',
  runner = null,
  verification = null
} = {}) {
  const normalized = normalizeCapabilityRequirement(requirement);
  if (!normalized.id) throw new Error('Capability id is required.');
  if (!ALLOWED_KINDS.includes(implementationKind)) {
    throw new Error('Unsupported capability implementation kind.');
  }

  const proposal = {
    schemaVersion: '1',
    proposalId: '',
    capabilityId: normalized.id,
    capabilityVersion: normalized.version,
    situationId: text(situationId) || null,
    state: 'candidate',
    implementation: {
      kind: implementationKind,
      runner: runner && typeof runner === 'object' ? { ...runner } : runner ? text(runner) : null,
      executable: false,
      sideEffects: normalized.risk === 'high' || normalized.risk === 'critical'
    },
    contract: {
      category: normalized.category,
      description: normalized.description || 'Implementation contract for ' + normalized.id + '.',
      objective: normalized.objective,
      inputs: normalized.inputs,
      outputs: normalized.outputs,
      dependencies: normalized.dependencies,
      constraints: normalized.constraints
    },
    verification: verification && typeof verification === 'object'
      ? { ...verification }
      : { required: true, executionEvidence: true, independentCheck: true, rollback: true },
    provenance: {
      source: normalized.source,
      dynamic: normalized.dynamic,
      requirementHash: hash(normalized)
    },
    lifecycle: [
      'discover','specify','candidate','verify','register',
      'approve','execute','observe','promote-or-rollback'
    ]
  };

  proposal.proposalId = 'cap-' + hash({
    capabilityId: proposal.capabilityId,
    capabilityVersion: proposal.capabilityVersion,
    situationId: proposal.situationId,
    requirementHash: proposal.provenance.requirementHash
  }).slice(0, 24);

  return proposal;
}

export function validateCapabilityImplementation(proposal = {}) {
  const errors = [];
  if (!text(proposal.capabilityId)) errors.push('capabilityId is required');
  if (!text(proposal.capabilityVersion)) errors.push('capabilityVersion is required');
  if (!ALLOWED_STATES.includes(text(proposal.state))) errors.push('invalid lifecycle state');
  if (!ALLOWED_KINDS.includes(text(proposal.implementation?.kind))) errors.push('invalid implementation kind');
  if (!proposal.contract || !Array.isArray(proposal.contract.outputs)) {
    errors.push('implementation outputs contract is required');
  }
  if (proposal.implementation?.executable === true && !proposal.implementation?.runner) {
    errors.push('an executable implementation requires a concrete runner');
  }
  if (proposal.implementation?.sideEffects === true && proposal.verification?.required !== true) {
    errors.push('side-effecting implementations require verification');
  }
  return { valid: errors.length === 0, errors };
}

export function promoteCapabilityImplementation(proposal, {
  verified = false,
  approved = false,
  executionEvidence = null
} = {}) {
  const validation = validateCapabilityImplementation(proposal);
  if (!validation.valid) return { ...validation, promoted: false, proposal };

  if (!verified) {
    return {
      valid: true, promoted: false, state: 'candidate',
      reason: 'Independent verification is required before registration.', proposal
    };
  }

  if (!proposal.implementation?.runner) {
    return {
      valid: true, promoted: false, state: 'verified',
      reason: 'A concrete runner must be registered before execution.', proposal
    };
  }

  if (proposal.implementation.sideEffects && !approved) {
    return {
      valid: true, promoted: false, state: 'registered',
      reason: 'Explicit approval is required before side-effecting execution.',
      proposal: { ...proposal, state: 'registered' }
    };
  }

  if (!executionEvidence) {
    return {
      valid: true, promoted: false, state: approved ? 'approved' : 'registered',
      reason: 'Observed execution evidence is required before promotion.',
      proposal: { ...proposal, state: approved ? 'approved' : 'registered' }
    };
  }

  return {
    valid: true,
    promoted: true,
    state: 'registered',
    reason: 'Implementation has concrete execution evidence and may be promoted by the governing registry.',
    proposal: {
      ...proposal,
      state: 'registered',
      implementation: { ...proposal.implementation, executable: true },
      evidence: { execution: executionEvidence }
    }
  };
}


export { ALLOWED_STATES, ALLOWED_KINDS };
