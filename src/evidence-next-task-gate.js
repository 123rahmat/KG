/**
 * A cheap, deterministic admission check for NEW task proposals made after
 * the run has observed work. Plans are never permission to execute.
 *
 * This is not a proof of success; the run store still owns capability,
 * approval, budget, dependency, and final-verification gates.
 */
const text = v => String(v ?? '').trim();
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => (Array.isArray(v) ? v.length > 0
  : isObject(v) ? Object.keys(v).length > 0
    : text(v).length > 0);
const MATERIAL_TYPES = new Set(['code', 'tool', 'investigate', 'prototype', 'verify']);
const VALID_STATUS = new Set(['complete', 'failed']);
const ACTIVE_REASONS = new Set(['reassess', 'step', 'investigate', 'tool', 'code', 'prototype']);

/** Evidence must describe an observed source, execution, or saved file result. */
export function observedTaskEvidence(task) {
  if (!task || !MATERIAL_TYPES.has(text(task.type))
      || !VALID_STATUS.has(text(task.status))) return false;
  const evidence = task.evidence;
  if (!isObject(evidence)) return false;
  // Unverified model narrative and model confidence never count by themselves.
  if (nonempty(evidence.executionReceipt) || nonempty(evidence.receipt)) return true;
  if (nonempty(evidence.sources) || nonempty(evidence.sourceRecords)) return true;
  if (nonempty(evidence.result) && ['code', 'tool'].includes(task.type)) return true;
  if (nonempty(evidence.verdict?.verdict) && task.type === 'verify') return true;
  if (task.type === 'investigate' && evidence.humanProvided === true
      && nonempty(evidence.findings)) return true;
  if (task.type === 'prototype' && nonempty(evidence.artifactReceipts)) return true;
  return false;
}

const incompleteRequirements = requirements =>
  Array.isArray(requirements?.items) && requirements.items.some(item =>
    item?.required !== false && !['satisfied', 'superseded'].includes(text(item.status)));

/**
 * Decide whether to accept an extra model-proposed next step on this turn.
 * This deliberately does not govern the root plan or the mandatory
 * verify/deliver stages.
 */
export function evidenceNextTaskGate({
  sourceTask = null, tasks = [], proposal = null, requirements = null,
  explicitlyRequired = false, budgetAllows = true
} = {}) {
  const sourceType = text(sourceTask?.type);
  if (!proposal) return Object.freeze({ allowed: false, reason: 'no-proposal' });
  if (!ACTIVE_REASONS.has(sourceType)) {
    return Object.freeze({ allowed: true, reason: 'initial-or-user-planned-work' });
  }
  if (['verify', 'deliver', 'approval'].includes(text(proposal.type))) {
    return Object.freeze({ allowed: true, reason: 'required-control-boundary' });
  }
  if (budgetAllows === false) return Object.freeze({ allowed: false, reason: 'workflow-budget-exhausted' });
  const logged = Array.isArray(tasks) ? tasks : [];
  const observed = logged.filter(observedTaskEvidence);
  const gap = incompleteRequirements(requirements);
  if (!observed.length) {
    return Object.freeze({ allowed: false, reason: 'material-evidence-missing' });
  }
  if (!gap && explicitlyRequired !== true) {
    return Object.freeze({ allowed: false, reason: 'no-unmet-task-requirement' });
  }
  return Object.freeze({
    allowed: true, reason: 'observed-evidence-and-unmet-requirement',
    evidenceTaskId: text(observed.at(-1)?.id) || null
  });
}
