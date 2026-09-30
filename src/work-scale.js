/**
 * How big the work is, so the plan fits it: small, standard or complex.
 *
 * Small: one familiar kind of work (code or a draft), nothing
 * to research, no files, no ambiguity, no high stakes, not asked for in
 * depth, and not a whole system (an app, an API, a website...). It skips
 * tool discovery (the built-in tools cover it) and the checkpoint between
 * writing code and testing it (the test is the check).
 * Its tests, approvals and final check stay. If understanding finds more
 * (research, discovery), the plan grows at that point.
 *
 * Complex: an unfamiliar situation, three or more kinds of work, or two or
 * more asked for in depth. Everything else is standard.
 */

// The system's own machinery: present in every run, never a task tool.
export const BUILT_IN = Object.freeze([
  'reasoning', 'situation-understanding', 'adaptive-safety-governance', 'capability-compilation', 'planning', 'verification',
  'adaptive-composition'
]);
const BUILT_IN_SET = new Set(BUILT_IN);

// Kinds of work; tools of one kind count once.
const KINDS = {
  'code-generation': 'code', 'code-execution': 'code',
  design: 'draft', invention: 'invention', 'hypothesis-generation': 'invention', 'concept-evaluation': 'invention', 'experiment-design': 'invention',
  'evidence-retrieval': 'research', 'external-data-routing': 'research',
  'file-analysis': 'files',
  'capability-discovery': 'discovery', 'adaptive-execution': 'tools'
};
// Kinds a small plan may be made of (one of them).
const SMALL_KINDS = new Set(['code', 'draft']);

/** Task tools only: what the work uses beyond the system's own machinery. */
export const taskTools = ids => [...new Set((ids ?? []).map(String))].filter(id => !BUILT_IN_SET.has(id));

/** The kinds of work these tools make up. */
export function workKinds(ids) {
  return [...new Set(taskTools(ids).map(id => KINDS[id] ?? 'other'))];
}

export function workScale({
  capabilities = [], unknownSituation = false, clarification = false, investigation = false,
  depth = '', attachments = 0, highImpact = false, physical = false, broad = false
} = {}) {
  const kinds = workKinds(capabilities);
  if (unknownSituation || kinds.length >= 3 || (depth === 'thorough' && kinds.length >= 2) || kinds.includes('other')) return 'complex';
  const small = kinds.length === 1 && SMALL_KINDS.has(kinds[0])
    && !clarification && !investigation && depth !== 'thorough' && !attachments && !highImpact && !broad
    // Code that computes something physical acts on nothing: still small.
    && (!physical || kinds[0] === 'code');
  return small ? 'small' : 'standard';
}
