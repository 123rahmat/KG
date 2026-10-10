/**
 * Requirement state for situation-adaptive runs.
 *
 * Requirements are separate from the work graph:
 * - requirements describe what must ultimately be true;
 * - tasks describe only the next justified action.
 *
 * A model may discover or refine requirements, but it cannot declare them
 * satisfied merely by saying so. Final satisfaction is evidence-driven and,
 * for verification requirements, comes from an actual verifier result.
 */

export const REQUIREMENT_STATUSES = Object.freeze([
  'unknown','identified','confirmed','ready','in-progress','partially-satisfied',
  'blocked','waiting-for-user','waiting-for-resource','verified','satisfied','failed','superseded'
]);

const STATUS_PROGRESS = Object.freeze({
  unknown: 0, identified: 15, confirmed: 25, ready: 35,
  'waiting-for-user': 35, 'waiting-for-resource': 30,
  'in-progress': 55, 'partially-satisfied': 70, blocked: 40, failed: 30,
  verified: 100, satisfied: 100, superseded: 100
});
const TERMINAL_REQUIREMENT = new Set(['satisfied','superseded']);
const text = value => String(value ?? '').trim();

const REQUIREMENT_ID = /^req-[0-9a-z]{4,12}$/i;

// A model that echoes a requirement's id means that requirement; the id is
// never a new requirement of its own to show.
const newItems = value => cleanList(value).filter(item => !REQUIREMENT_ID.test(item));

function cleanList(value, max = 20) {
  if (!Array.isArray(value)) return [];
  const values = value.map(item => typeof item === 'string'
    ? text(item)
    : text(item?.requirement ?? item?.label ?? item?.title)).filter(Boolean);
  return [...new Set(values)].slice(0, max);
}
function normalizeLabel(value) { return text(value).replace(/\s+/g, ' ').trim(); }
function stableId(value) {
  let hash = 2166136261;
  for (const char of normalizeLabel(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 'req-' + (hash >>> 0).toString(36).padStart(7, '0');
}
function uniqueId(items, base) {
  if (!items.some(item => item.id === base)) return base;
  let n = 2;
  while (items.some(item => item.id === base + '-' + n)) n += 1;
  return base + '-' + n;
}
function progressFor(status) { return STATUS_PROGRESS[status] ?? 0; }
function importanceValue(value) {
  const normalized = text(value).toLowerCase();
  if (['critical','must','required'].includes(normalized)) return 4;
  if (['high','important'].includes(normalized)) return 3;
  if (['low','optional'].includes(normalized)) return 1;
  return 2;
}
function normalizeItem(input, existing = null) {
  const label = normalizeLabel(input?.requirement ?? input?.label ?? input?.title ?? input);
  if (!label) return null;
  const status = REQUIREMENT_STATUSES.includes(existing?.status)
    ? existing.status
    : REQUIREMENT_STATUSES.includes(input?.status) ? input.status : 'identified';
  return {
    id: text(existing?.id) || text(input?.id) || stableId(label),
    requirement: label.slice(0, 800),
    kind: text(existing?.kind) || text(input?.kind) || 'requirement',
    required: existing?.required !== undefined ? existing.required !== false : input?.required !== false,
    // Explicit KG Code user needs must be individually acknowledged by a
    // named verification result. A blanket 'pass' is not coverage evidence.
    explicitCoverage: existing?.explicitCoverage === true || input?.explicitCoverage === true,
    priority: Math.max(0, Math.min(100, Number(existing?.priority ?? input?.priority ?? 50) || 50)),
    importance: text(existing?.importance) || text(input?.importance) || 'important',
    dependencies: cleanList(existing?.dependencies ?? input?.dependencies),
    status,
    evidence: Array.isArray(existing?.evidence) ? existing.evidence.slice(-12) : [],
    confidence: Math.max(0, Math.min(1, Number(existing?.confidence ?? input?.confidence ?? 0.5) || 0)),
    constraints: cleanList(existing?.constraints ?? input?.constraints),
    requiredResources: cleanList(existing?.requiredResources ?? input?.requiredResources),
    responsibleStep: text(existing?.responsibleStep ?? input?.responsibleStep) || null,
    verificationCriteria: cleanList(existing?.verificationCriteria ?? input?.verificationCriteria, 12),
    blockers: cleanList(existing?.blockers ?? input?.blockers),
    progress: progressFor(status),
    lastUpdated: text(existing?.lastUpdated) || new Date().toISOString()
  };
}
function ensureItem(items, input, defaults = {}) {
  const label = normalizeLabel(input?.requirement ?? input?.label ?? input?.title ?? input);
  if (!label) return null;
  const existing = items.find(item => item.requirement.toLowerCase() === label.toLowerCase());
  if (existing) return existing;
  const created = normalizeItem({
    ...defaults,
    ...(typeof input === 'object' ? input : { requirement: label }),
    requirement: label
  });
  if (!created) return null;
  created.id = uniqueId(items, created.id);
  items.push(created);
  return created;
}
function sourceEvidence(task, result = {}) {
  return {
    taskId: text(task?.id),
    taskType: text(task?.type),
    summary: normalizeLabel(result?.summary).slice(0, 500),
    hasEvidence: result?.evidence !== null && result?.evidence !== undefined,
    at: new Date().toISOString()
  };
}
function matchCriterion(item, criterion) {
  const key = normalizeLabel(criterion).toLowerCase();
  if (!key) return false;
  return item.requirement.toLowerCase() === key
    || item.verificationCriteria.some(value => value.toLowerCase() === key)
    || item.verificationCriteria.some(value => key.includes(value.toLowerCase()) || value.toLowerCase().includes(key));
}
function weightedProgress(items) {
  const required = items.filter(item => item.required !== false && item.status !== 'superseded');
  if (!required.length) return 100;
  const totalWeight = required.reduce((sum, item) => sum + importanceValue(item.importance) * Math.max(1, Number(item.priority) || 1), 0);
  const weighted = required.reduce((sum, item) =>
    sum + progressFor(item.status) * importanceValue(item.importance) * Math.max(1, Number(item.priority) || 1), 0);
  return Math.round(weighted / totalWeight);
}
function finalizeModel(model) {
  const items = model.items.filter(Boolean).map(item => ({ ...item, progress: progressFor(item.status) })).slice(0, 40);
  const unresolved = items.filter(item => item.required !== false && !TERMINAL_REQUIREMENT.has(item.status));
  const blockers = unresolved.filter(item => ['blocked','waiting-for-user','waiting-for-resource','failed'].includes(item.status));
  const next = [...unresolved].sort((a,b) => {
    const aBlock = blockers.includes(a) ? 1 : 0, bBlock = blockers.includes(b) ? 1 : 0;
    return bBlock - aBlock
      || importanceValue(b.importance) - importanceValue(a.importance)
      || Number(b.priority) - Number(a.priority);
  })[0] ?? null;
  return {
    version: 1, items, overallProgress: weightedProgress(items),
    completedCount: items.filter(item => item.required !== false && item.status === 'satisfied').length,
    requiredCount: items.filter(item => item.required !== false && item.status !== 'superseded').length,
    unresolvedCount: unresolved.length, blockedCount: blockers.length,
    completionReady: unresolved.length === 0, nextRequirementId: next?.id ?? null,
    updatedAt: new Date().toISOString()
  };
}
export function emptyRequirementModel() { return finalizeModel({ version: 1, items: [] }); }
export function normalizeRequirementModel(value, goal = '') {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return buildRequirementModel({ goal });
  const items = value.items.map(item => normalizeItem(item)).filter(Boolean);
  const model = finalizeModel({ version: 1, items });
  return model.items.length || !text(goal) ? model : buildRequirementModel({ goal });
}
export function buildRequirementModel({ goal = '', requirements = [], successCriteria = [], outputs = [], constraints = [], codingNeeds = null } = {}) {
  const items = [];
  if (text(goal)) {
    ensureItem(items, {
      requirement: 'Achieve the requested outcome: ' + normalizeLabel(goal),
      kind: 'outcome', required: true, priority: 100, importance: 'critical',
      status: 'identified', verificationCriteria: cleanList(successCriteria)
    });
  }
  for (const value of requirements) ensureItem(items, value, { kind:'requirement', status:'confirmed', required:true, priority:90, importance:'high' });
  for (const value of successCriteria) {
    const item = ensureItem(items, value, { kind:'criterion', status:'confirmed', required:true, priority:95, importance:'critical', verificationCriteria:[normalizeLabel(value)] });
    if (item && !item.verificationCriteria.some(c => c.toLowerCase() === item.requirement.toLowerCase())) item.verificationCriteria.push(item.requirement);
  }
  for (const value of outputs) ensureItem(items, value, { kind:'output', status:'identified', required:true, priority:80, importance:'high' });
  // Capture only explicit user clauses from the server-side Coding contract;
  // never invent goals from a model-generated plan or an aspiration like best.
  for (const value of cleanList(codingNeeds?.explicitCriteria, 12)) {
    const item = ensureItem(items, value, { kind:'criterion', required:true, priority:95,
      importance:'critical', status:'confirmed', verificationCriteria:[value], explicitCoverage:true });
    if (item) item.explicitCoverage = true;
  }
  if (constraints.length && items[0]) items[0].constraints = cleanList(constraints);
  return finalizeModel({ version: 1, items });
}
export function reconcileRequirements(current, {
  goal = '', task = {}, structured = {}, summary = '', evidence = null, requirementIds = []
} = {}) {
  const base = normalizeRequirementModel(current, goal);
  const items = base.items.map(item => ({ ...item, evidence: [...item.evidence] }));
  const add = (value, defaults) => ensureItem(items, value, defaults);

  for (const value of newItems(structured?.requirements)) add(value, { kind:'requirement', status:'identified', required:true, priority:80, importance:'high' });
  for (const value of newItems(structured?.successCriteria)) {
    const item = add(value, { kind:'criterion', status:'identified', required:true, priority:90, importance:'critical', verificationCriteria:[normalizeLabel(value)] });
    if (item && !item.verificationCriteria.some(c => c.toLowerCase() === item.requirement.toLowerCase())) item.verificationCriteria.push(item.requirement);
  }
  for (const value of newItems(structured?.outputs)) add(value, { kind:'output', status:'identified', required:true, priority:75, importance:'high' });
  for (const value of newItems(structured?.requiredEvidence)) add('Evidence required: ' + value, { kind:'evidence', status:'identified', required:true, priority:85, importance:'high', verificationCriteria:[value] });
  for (const value of newItems(structured?.questions)) add('Resolve the material question: ' + value, { kind:'question', status:'waiting-for-user', required:true, priority:100, importance:'critical' });
  for (const value of newItems(structured?.unknowns)) add('Resolve the identified uncertainty: ' + value, { kind:'uncertainty', status:'unknown', required:true, priority:80, importance:'high' });

  // Requirements can become invalid as the situation changes. Preserve that
  // history explicitly instead of silently deleting or mutating the record.
  const superseded = cleanList(structured?.supersededRequirements);
  if (superseded.length) {
    const now = new Date().toISOString();
    for (const target of items) {
      const idMatch = superseded.includes(target.id);
      const labelMatch = superseded.some(value => normalizeLabel(value).toLowerCase() === target.requirement.toLowerCase());
      if (!idMatch && !labelMatch) continue;
      target.status = 'superseded';
      target.required = false;
      target.lastUpdated = now;
      target.evidence = [...target.evidence, sourceEvidence(task, {
        summary: summary || 'Requirement superseded by a changed situation.',
        evidence
      })].slice(-12);
    }
  }

  // A code repair invalidates earlier verification of user-specific changes.
  // Passing a previous revision must never satisfy criteria for new code.
  if (task?.type === 'build-code' || task?.id === 'build-code') {
    for (const item of items) {
      if (item.explicitCoverage && item.status === 'satisfied') item.status = 'in-progress';
    }
  }

  const linkedIds = cleanList(requirementIds);
  const linked = items.filter(item => linkedIds.includes(item.id));
  if (linked.length) {
    const record = sourceEvidence(task, { summary, evidence });
    for (const item of linked) {
      item.evidence = [...item.evidence, record].slice(-12);
      item.responsibleStep = text(task?.id) || item.responsibleStep;
      if (!TERMINAL_REQUIREMENT.has(item.status)) {
        item.status = task?.type === 'clarify' && item.kind === 'question'
          ? 'satisfied'
          : structured?.enough === true && task?.type !== 'verify' ? 'partially-satisfied' : 'in-progress';
      }
      item.lastUpdated = record.at;
    }
  }

  if (task?.type === 'verify') {
    // The checked verdict is recorded as evidence.verdict (by the verifier and
    // by a person alike); a structured one is taken when that is where it is.
    const recorded = Array.isArray(structured?.criteria) || text(structured?.verdict)
      ? structured
      : (evidence?.verdict && typeof evidence.verdict === 'object' ? evidence.verdict : {});
    const criteria = Array.isArray(recorded?.criteria) ? recorded.criteria : [];
    const verdict = text(recorded?.verdict).toLowerCase();
    for (const criterion of criteria) {
      const label = normalizeLabel(criterion?.criterion);
      if (!label) continue;
      const verificationTargets = items.some(candidate => candidate.kind !== 'outcome' && candidate.required !== false)
        ? items.filter(candidate => candidate.kind !== 'outcome')
        : items;
      const item = verificationTargets.find(candidate => matchCriterion(candidate, label));
      if (!item) continue;
      const met = criterion?.met === true;
      item.status = met && verdict === 'pass' ? 'satisfied' : met ? 'verified' : 'failed';
      item.evidence = [...item.evidence, sourceEvidence(task, { summary, evidence })].slice(-12);
      item.lastUpdated = new Date().toISOString();
      if (!met) item.blockers = [...new Set([...item.blockers, normalizeLabel(criterion?.reason) || 'Verification found an unmet criterion.'])].filter(Boolean).slice(-8);
    }
    // A clean pass covers everything the check was given, including outputs
    // and requirements it did not name one by one. Leaving those open made
    // the run keep adding steps after its result had passed.
    if (verdict === 'pass' && !criteria.some(criterion => criterion?.met === false)) {
      const at = new Date().toISOString();
      for (const item of items) {
        if (item.kind === 'outcome' || item.required === false || TERMINAL_REQUIREMENT.has(item.status)
          || ['failed', 'waiting-for-user'].includes(item.status) || item.explicitCoverage) continue;
        if (linkedIds.length && !linkedIds.includes(item.id)) continue;
        item.status = 'satisfied';
        item.lastUpdated = at;
        item.evidence = [...item.evidence, sourceEvidence(task, { summary, evidence })].slice(-12);
      }
    }
  }

  const outcome = items.find(item => item.kind === 'outcome');
  const children = items.filter(item => item.kind !== 'outcome' && item.required !== false && item.status !== 'superseded');
  if (outcome && children.length && children.every(item => item.status === 'satisfied')) {
    outcome.status = 'satisfied';
    outcome.lastUpdated = new Date().toISOString();
    outcome.evidence = [...outcome.evidence, sourceEvidence(task, { summary, evidence })].slice(-12);
  } else if (outcome && !TERMINAL_REQUIREMENT.has(outcome.status) && linkedIds.includes(outcome.id)) {
    outcome.status = 'in-progress';
  }
  return finalizeModel({ version: 1, items });
}
export function nextRequirement(model, { includeBlocked = true } = {}) {
  const normalized = normalizeRequirementModel(model);
  const unresolvedConcrete = normalized.items.some(item =>
    item.kind !== 'outcome'
    && item.kind !== 'criterion'
    && item.required !== false
    && !TERMINAL_REQUIREMENT.has(item.status)
  );
  const candidates = normalized.items
    .filter(item => item.required !== false && !TERMINAL_REQUIREMENT.has(item.status))
    // The aggregate outcome is a completion condition, not work in itself.
    // Never select it while a concrete child requirement is still unresolved.
    .filter(item => !(item.kind === 'outcome' && unresolvedConcrete))
    // Success criteria describe how completed work is verified; they are not
    // independent build work while another concrete requirement is unresolved.
    .filter(item => !(item.kind === 'criterion' && unresolvedConcrete))
    .filter(item => includeBlocked || !['blocked','waiting-for-resource'].includes(item.status))
    .sort((a,b) => {
      const aBlock = ['blocked','waiting-for-user','waiting-for-resource','failed'].includes(a.status) ? 1 : 0;
      const bBlock = ['blocked','waiting-for-user','waiting-for-resource','failed'].includes(b.status) ? 1 : 0;
      return bBlock - aBlock
        || importanceValue(b.importance) - importanceValue(a.importance)
        || Number(b.priority) - Number(a.priority);
    });
  return candidates[0] ?? null;
}
export function requirementAction(model) {
  const item = nextRequirement(model);
  if (!item) return null;
  if (item.status === 'waiting-for-user' || item.kind === 'question') {
    return { type:'clarify', title:'Resolve the required question', purpose:item.requirement, humanInput:true };
  }
  if (item.status === 'unknown' || item.status === 'waiting-for-resource' || item.kind === 'uncertainty' || item.kind === 'evidence') {
    return { type:'investigate', title:'Gather only the required evidence', purpose:item.requirement };
  }
  if (item.status === 'blocked' || item.status === 'failed') {
    return { type:'step', title:'Resolve the blocking requirement', purpose:item.blockers[0] || item.requirement };
  }
  return { type:'step', title:'Advance the current requirement', purpose:item.requirement };
}
/**
 * The points a verification is graded on: the requirements' criteria, or the
 * situation's success criteria when there are none. One definition, so what
 * a person is shown to check is exactly what the check must cover.
 */
export function gradedCriteria(requirements, situation) {
  const fromRequirements = verificationCriteriaFor(requirements ?? null);
  if (fromRequirements.length) return fromRequirements;
  return Array.isArray(situation?.successCriteria) ? situation.successCriteria.map(text).filter(Boolean) : [];
}

export function verificationCriteriaFor(model) {
  const normalized = normalizeRequirementModel(model);
  const candidates = normalized.items.filter(item =>
    item.required !== false && item.status !== 'superseded' && item.kind !== 'outcome'
  );
  const source = candidates.length
    ? candidates
    : normalized.items.filter(item => item.required !== false && item.status !== 'superseded');
  return [...new Set(source.map(item => item.verificationCriteria[0] || item.requirement).map(text).filter(Boolean))].slice(0, 40);
}

