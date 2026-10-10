/**
 * A role becomes specialized for the user's current goal, not a permanent domain silo.
 * User content remains task data, never a source of new authority.
 */
import { DOMAIN_SPECIALISTS } from './domain-specialists.js';
import { taskSpecialistForRole } from './task-specialist-factory.js';

const clean = (value, limit = 320) => String(value ?? '').trim().slice(0, limit);
const unique = (items, limit) => [...new Set((Array.isArray(items) ? items : [])
  .map(item => clean(item, 220)).filter(Boolean))].slice(0, limit);
const ROLE_FOCUS = Object.freeze({
  'idea-explorer': ['Distinct possibilities', 'Provide meaningfully different options and their assumptions.'],
  'feasibility-reviewer': ['Feasibility and trade-offs', 'Identify dependencies, practical constraints and reversible alternatives.'],
  strategist: ['Priorities and dependencies', 'Identify the next smallest useful decision, its prerequisites and a fallback.'],
  researcher: ['Evidence gaps', 'Separate verified findings, needed sources, and unresolved claims.'],
  analyst: ['Reasoning and comparison', 'Evaluate competing explanations or options against stated criteria.'],
  architect: ['System boundaries', 'Assess interface contracts, dependencies and architectural trade-offs.'],
  implementer: ['Implementation scope', 'Propose only changes justified by the supplied source and approved scope.'],
  critic: ['Independent challenge', 'Find concrete failure modes, contradictions and unsupported assumptions.'],
  communicator: ['Audience and communication', 'Improve clarity without changing the underlying facts.'],
  diagnostician: ['Failure diagnosis', 'Distinguish symptoms, causes and the next discriminating check.'],
  debugger: ['Code failure diagnosis', 'Identify likely root causes and minimal reproducible checks.'],
  'test-engineer': ['Acceptance and regression', 'Identify tests demonstrating requested behavior and preventing regressions.'],
  'security-reviewer': ['Trust boundaries', 'Assess authorization, data handling, injection and least privilege.'],
  'frontend-engineer': ['Frontend and interaction', 'Assess accessibility, responsive behavior, client state and UI integration.'],
  'ux-designer': ['Usability and accessibility', 'Check user journeys, interaction errors, affordances, responsive behavior and accessibility against observed requirements.'],
  'literature-reviewer': ['Literature quality and coverage', 'Separate retrieved primary sources from missing evidence and never invent references.'],
  'methodology-reviewer': ['Methodological validity', 'Check study design, bias, sampling, hypotheses and reproducibility using actual evidence.'],
  'quantitative-analyst': ['Statistical validity', 'Assess assumptions, data, metrics and uncertainty without inventing numbers.'],
  'citation-auditor': ['Citation and claim traceability', 'Check claim-to-source provenance, flag unverifiable references and source conflicts.'],
  'academic-writer': ['Thesis and paper writing', 'Synthesize verified evidence with clear structure, transparent limitations and no fabricated results.'],
  'backend-engineer': ['Backend and service contracts', 'Assess API behavior, persistence, concurrency and failure recovery.'],
  'performance-reviewer': ['Efficiency and scale', 'Identify evidence-backed latency, capacity and cost bottlenecks.'],
  'art-director': ['Visual direction', 'Evaluate hierarchy, visual concept and user-facing intent.'],
  'visual-designer': ['Visual implementation', 'Assess component design, composition and accessibility.'],
  'image-editor': ['Image treatment', 'Evaluate assets and editing requirements without claiming edits occurred.'],
  'layout-designer': ['Layout constraints', 'Assess geometry, responsive behavior and output dimensions.'],
  'visual-reviewer': ['Visual verification', 'Find legibility, overlap and consistency defects using available evidence.'],
  ...Object.fromEntries(Object.entries(DOMAIN_SPECIALISTS).map(([role, item]) =>
    [role, [item.specialty, item.assignment]]))
});

export function taskSpecialization(role, payload = {}) {
  const discovered = taskSpecialistForRole(role,{
    surface:payload.specialistSurface??payload.surface??'normal-chat',
    goal:payload.goal??'',task:payload.task??{},
    situation:payload.situation??{},observedFindings:payload.observedFindings??[]
  });
  const focus = ROLE_FOCUS[role] ?? (discovered
    ? ['Observed task-specific gap', discovered.purpose]
    : ['Domain-specific review', 'Apply assigned expertise to the current task only.']);
  const task = payload.task ?? {};
  const panel = payload.workspacePanel ?? {};
  const subsystem = (payload.subsystemPlan?.subsystems ?? [])[0] ?? null;
  const scope = unique(panel.ownedFiles ?? subsystem?.files ?? [], 20);
  const criteria = unique(payload.situation?.successCriteria ?? [], 8);
  return Object.freeze({
    kind: 'task-bound-advisory-specialist',
    role, specialty: focus[0],
    task: clean(task.purpose || task.metadata?.title || task.id || task.type || 'Current user goal', 240),
    userGoal: clean(payload.goal, 800), assignment: focus[1],
    expectedEvidence: criteria,
    scope: scope.length ? { ownedFiles: scope, subsystem: clean(subsystem?.id, 100) } : { advisoryOnly: true },
    successCheck: criteria.length
      ? 'Assess relevant success criteria using only evidence actually present.'
      : 'Provide one concrete, evidence-grounded conclusion that advances the user goal.',
    independence: 'Do not assume other agents agree; provide an independently derived finding.',
    authority: 'Advisory only. The parent run owns approvals, tools, writes and final delivery.',
    stopRule: 'Recommend stopping when evidence is sufficient; do not expand scope without cause.'
  });
}
