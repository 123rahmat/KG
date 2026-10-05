/**
 * Universal context contract.
 *
 * Skills are universally available capabilities; they are never automatically
 * granted authority. Memory is universally addressable only through explicit
 * scope boundaries. The adaptive controller selects the minimum useful context
 * for the current chat/project situation and expands it only when evidence
 * justifies the cost.
 */

const text = value => String(value ?? '').trim();

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

const uniq = value => [...new Set((Array.isArray(value) ? value : [])
  .map(text)
  .filter(Boolean))];

export const UNIVERSAL_CONTEXT_VERSION = '1';

export const MEMORY_LAYERS = Object.freeze([
  'session',
  'project',
  'user',
  'workspace',
  'organization'
]);

export const SKILL_SCOPE = Object.freeze({
  availability: 'universal',
  authority: 'scoped',
  activation: 'adaptive',
  execution: 'server-owned',
  verification: 'evidence-driven'
});

export function normalizeContextScope({
  conversationId = null,
  projectId = null,
  workspaceId = null,
  principalId = null,
  organizationId = null
} = {}) {
  const principal = text(principalId);
  const workspace = text(workspaceId);
  const project = text(projectId);
  const conversation = text(conversationId);
  const organization = text(organizationId);

  if (!principal || !workspace) {
    return {
      valid: false,
      reason: 'principal-and-workspace-required',
      principalId: principal || null,
      workspaceId: workspace || null
    };
  }

  return {
    valid: true,
    principalId: principal,
    workspaceId: workspace,
    organizationId: organization || null,
    projectId: project || null,
    conversationId: conversation || null
  };
}

/**
 * Decide which memory layers may be considered. This is a scope decision, not
 * a relevance decision: recall must still rank the selected layers against the
 * current goal and budget.
 */
export function memoryScopePolicy({
  scope = {},
  crossChatMemory = false,
  includeProjectMemory = true,
  includeWorkspaceMemory = false,
  includeOrganizationMemory = false
} = {}) {
  const normalized = normalizeContextScope(scope);
  if (!normalized.valid) return { valid: false, layers: [], reason: normalized.reason };

  const layers = ['session'];
  if (normalized.projectId && includeProjectMemory) layers.push('project');
  if (crossChatMemory) layers.push('user');
  if (includeWorkspaceMemory) layers.push('workspace');
  if (includeOrganizationMemory && normalized.organizationId) layers.push('organization');

  return {
    valid: true,
    layers: [...new Set(layers)],
    rule: 'session first; broader memory requires explicit scope and permission',
    crossChatMemory: Boolean(crossChatMemory)
  };
}

/**
 * Universal Skills are discoverable for every user. Selection is still
 * constrained by task relevance, policy, budget and verification.
 */
export function skillActivationPolicy({
  requestedSkills = [],
  candidateSkills = [],
  allowedSkills = [],
  deniedSkills = [],
  maxSkills = 4,
  maxCost = 12,
  taskRisk = 'ordinary',
  verificationRequired = false
} = {}) {
  const requested = uniq(requestedSkills).map(v => v.toLowerCase());
  const candidates = uniq(candidateSkills).map(v => v.toLowerCase());
  const allowedSpecified = Array.isArray(allowedSkills) && allowedSkills.length > 0;
  const allowed = new Set(uniq(allowedSkills).map(v => v.toLowerCase()));
  const denied = new Set(uniq(deniedSkills).map(v => v.toLowerCase()));

  const selected = [];
  const omitted = [];
  for (const name of [...requested, ...candidates]) {
    if (selected.includes(name)) continue;
    if (denied.has(name) || (allowedSpecified && !allowed.has(name))) {
      omitted.push({ name, reason: 'scope-or-policy' });
      continue;
    }
    if (selected.length >= clamp(maxSkills, 1, 8)) {
      omitted.push({ name, reason: 'skill-count-budget' });
      continue;
    }
    selected.push(name);
  }

  const risk = text(taskRisk).toLowerCase();
  const evidenceMode = verificationRequired || risk === 'high' || risk === 'critical'
    ? 'required'
    : risk === 'medium' ? 'targeted' : 'light';

  return {
    availability: 'universal',
    selected,
    omitted,
    maxSkills: clamp(maxSkills, 1, 8),
    maxCost: clamp(maxCost, 1, 32),
    evidenceMode,
    authority: 'skills cannot grant permissions or completion authority',
    principle: 'select the minimum sufficient capability set'
  };
}

/**
 * Build one contract shared by Normal Chat, Code, Research and Design. The
 * surfaces remain presentation/workspace boundaries, not separate brains.
 */
export function buildUniversalContextContract({
  goal = '',
  conversationId = null,
  projectId = null,
  workspaceId = null,
  principalId = null,
  organizationId = null,
  crossChatMemory = false,
  includeProjectMemory = true,
  includeWorkspaceMemory = false,
  includeOrganizationMemory = false,
  requestedSkills = [],
  candidateSkills = [],
  allowedSkills = [],
  deniedSkills = [],
  maxSkills = 4,
  maxSkillCost = 12,
  risk = 'ordinary',
  verificationRequired = false,
  complexity = 0,
  uncertainty = 0
} = {}) {
  const scope = normalizeContextScope({
    conversationId, projectId, workspaceId, principalId, organizationId
  });
  const memory = memoryScopePolicy({
    scope,
    crossChatMemory,
    includeProjectMemory,
    includeWorkspaceMemory,
    includeOrganizationMemory
  });
  const skills = skillActivationPolicy({
    requestedSkills,
    candidateSkills,
    allowedSkills,
    deniedSkills,
    maxSkills,
    maxCost: maxSkillCost,
    taskRisk: risk,
    verificationRequired
  });

  const pressure = Math.max(clamp(complexity, 0, 1), clamp(uncertainty, 0, 1));
  const contextDepth = pressure >= 0.75 ? 'broad'
    : pressure >= 0.35 ? 'targeted'
    : 'minimal';

  return {
    version: UNIVERSAL_CONTEXT_VERSION,
    valid: scope.valid && memory.valid,
    scope,
    memory,
    skills,
    contextDepth,
    continuity: {
      session: Boolean(scope.conversationId),
      project: Boolean(scope.projectId),
      workspace: Boolean(scope.workspaceId),
      preserveVerifiedState: true,
      doNotRestartUnnecessarily: true
    },
    efficiency: {
      principle: 'minimum sufficient context and capability',
      expandWhen: ['missing-evidence', 'material-change', 'verification-gap', 'failure'],
      contract: 'never trade required verification for lower cost or latency'
    },
    safety: {
      memoryBoundary: 'never cross principal or workspace authorization boundaries',
      skillBoundary: 'skill selection never grants tool, data or execution authority',
      completionBoundary: 'model output never establishes authoritative completion'
    },
    goal: text(goal).slice(0, 500)
  };
}
