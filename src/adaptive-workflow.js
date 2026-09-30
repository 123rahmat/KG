/**
 * Choose how to work for this situation: the workflow blueprint every step
 * follows (see reasoning-context.js). Nothing is picked from a domain list;
 * the choice follows what the situation actually needs: an answer, evidence,
 * working code, an invention, a design, or discovery first when the
 * situation itself is not yet understood.
 *
 * The blueprint says which way of working leads (mode) and which others the
 * work also needs (secondary), its phases, how much evidence is enough (from
 * the person's resource budget), when to stop, and what would justify asking
 * to expand the scope. Deterministic, so the same situation always gets the
 * same blueprint and the adaptive snapshot's fingerprint stays stable.
 */

const text = value => String(value ?? '').trim();

// Ways of working, strongest first: when several apply, the first leads.
const MODES = [
  {
    mode: 'crisis-response',
    applies: ({ situation }) => situation?.crisis === true,
    phases: ['respond-now', 'point-to-help'],
    stop: ['the person has immediate, caring guidance and where to get help']
  },
  {
    mode: 'adaptive-discovery',
    applies: ({ ids, situation }) => situation?.unknownSituation === true || ids.has('capability-discovery'),
    phases: ['understand-and-bound', 'investigate-unknowns', 'discover-capabilities', 'plan', 'execute', 'verify', 'deliver'],
    stop: ['the unknowns that block the deliverable are resolved or stated as limits']
  },
  {
    mode: 'invent-and-test',
    applies: ({ ids }) => ids.has('invention'),
    phases: ['understand-need', 'prior-art', 'generate-concepts', 'compare', 'choose', 'decisive-experiment', 'verify', 'deliver'],
    stop: ['a chosen concept with a decisive experiment and what counts as success']
  },
  {
    mode: 'build-and-test',
    applies: ({ ids, need }) => ids.has('code-generation') || ids.has('code-execution') || need?.form === 'code',
    phases: ['understand-need', 'write-with-tests', 'syntax-check', 'run-tests', 'fix-from-errors', 'verify', 'deliver'],
    stop: ['the code does what was asked and its tests pass']
  },
  {
    mode: 'evidence-first',
    applies: ({ ids, situation }) => ids.has('evidence-retrieval') || ids.has('external-data-routing') || situation?.externalData?.hasExternalDataNeed === true,
    phases: ['understand-need', 'gather-minimum-evidence', 'reason', 'verify', 'deliver'],
    stop: ['every claim the deliverable depends on is backed by a source']
  },
  {
    mode: 'design-and-compose',
    // Files read for code work are part of building it, not a composition.
    applies: ({ ids, need }) => ids.has('design')
      || (ids.has('file-analysis') && !ids.has('code-generation'))
      || ['plan', 'document', 'design'].includes(need?.form),
    phases: ['understand-need', 'gather-inputs', 'compose', 'verify', 'deliver'],
    stop: ['the requested artifact is complete and fits the constraints']
  },
  {
    mode: 'answer',
    applies: () => true,
    phases: ['understand-need', 'answer', 'check'],
    stop: []
  }
];

/** How much evidence is enough: a floor the mode needs, a ceiling the budget sets. */
function evidenceBounds(mode, situation, resourcePlan) {
  const ceiling = Number(resourcePlan?.contextPolicy?.maxItems) > 0 ? Number(resourcePlan.contextPolicy.maxItems) : 16;
  const highStakes = situation?.highImpact === true || situation?.risk === 'high-impact';
  const floor = mode === 'evidence-first' ? (highStakes ? 2 : 1)
    : mode === 'invent-and-test' ? 1
      : 0;
  return { minimum: Math.min(floor, ceiling), maximum: ceiling };
}

/**
 * The blueprint for one situation. `capabilities` are the selected
 * requirements (objects with an id, or ids); `need` is the exact-need reading.
 */
export function selectAdaptiveWorkflow({ goal = '', need = null, capabilities = [], situation = null, resourcePlan = null } = {}) {
  const ids = new Set((Array.isArray(capabilities) ? capabilities : []).map(item => text(typeof item === 'string' ? item : item?.id)).filter(Boolean));
  const input = { ids, need, situation };
  const applying = MODES.filter(item => item.applies(input));
  const lead = applying[0];
  const secondary = applying.slice(1).map(item => item.mode).filter(mode => mode !== 'answer');
  const budget = resourcePlan?.executionPolicy ?? {};
  // Every non-crisis workflow is a closed-loop adaptive process: observe what
  // happened, reassess the situation, and re-plan before verification/delivery.
  // The executor can skip an unnecessary loop, but the contract always exposes
  // the checkpoint so new evidence can never silently leave the original plan
  // in control.
  const closedLoop = lead.mode === 'crisis-response' ? {
    enabled: false,
    checkpoint: null,
    replanTriggers: []
  } : {
    enabled: true,
    checkpoint: 'after-each-material-step',
    replanTriggers: [
      'new evidence changes a requirement, constraint or confidence',
      'a tool/runtime/capability fails or becomes unavailable',
      'an output no longer satisfies the exact need or success criteria',
      'the user changes scope, depth, constraints or requested deliverable',
      'a safety, privacy, authorization or jurisdiction condition changes'
    ],
    maxReplans: Number(budget.maxExecutionStages) > 0
      ? Math.max(1, Math.min(Number(budget.maxExecutionStages), 8))
      : 1
  };
  const phases = [...lead.phases];
  if (closedLoop.enabled) {
    const verifyIndex = phases.lastIndexOf('verify');
    const insertAt = verifyIndex >= 0 ? verifyIndex : Math.max(0, phases.length - 1);
    phases.splice(insertAt, 0, 'observe', 'reassess', 'replan-if-needed');
  }
  return {
    mode: lead.mode,
    ...(secondary.length ? { secondary } : {}),
    phases,
    closedLoop,
    ...(need?.deliverable ? { deliverable: text(need.deliverable).slice(0, 200) } : {}),
    evidence: evidenceBounds(lead.mode, situation, resourcePlan),
    stopConditions: [
      need?.deliverable ? `the deliverable is given: ${text(need.deliverable).slice(0, 160)}` : 'the person\'s stated outcome is met',
      'the success criteria are met with evidence',
      ...lead.stop
    ],
    expansionTriggers: [
      'the selected scope cannot produce the deliverable',
      'new evidence contradicts the plan or the situation',
      'a stakes, safety or jurisdiction question appears that the plan did not cover',
      ...(Number(budget.maxToolCalls) > 0 ? [`more than ${Number(budget.maxToolCalls)} tool calls would be needed`] : [])
    ],
    ...(text(goal) ? {} : { note: 'no goal text' })
  };
}
