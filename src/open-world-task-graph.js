/**
 * Open-world incremental task graph. Pure, bounded projection; it never
 * executes tools or grants permissions. The run store remains authoritative.
 * A model can propose work, but callers must validate and authorize proposals.
 */
import { readyTasks, parallelWaves } from './parallel-orchestrator.js';
import { invalidateDependents } from './adaptive-decision-authority.js';

const value = x => String(x ?? '').trim();
const list = x => [...new Set((Array.isArray(x) ? x : []).map(value).filter(Boolean))];
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const clamp = n => Math.max(0, Math.min(1, finite(n)));
const VALID = new Set(['pending', 'running', 'complete', 'skipped', 'blocked', 'failed', 'stale']);
const MAX_NODES = 48;
const HIGH_RISK = new Set(['high', 'critical', 'regulated', 'physical', 'high-impact']);

export function validateOpenWorldGraph(graph = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (nodes.length > MAX_NODES) throw new Error('adaptive-graph-cap-exceeded');
  const byId = new Map();
  for (const item of nodes) {
    const id = value(item?.id);
    if (!id || id.length > 100 || byId.has(id)) throw new Error('adaptive-graph-invalid-id');
    if (!VALID.has(item.status ?? 'pending')) throw new Error('adaptive-graph-invalid-status');
    byId.set(id, item);
  }
  const colors = new Map();
  function visit(id) {
    if (colors.get(id) === 1) throw new Error('adaptive-graph-cycle');
    if (colors.get(id) === 2) return;
    colors.set(id, 1);
    for (const dep of list(byId.get(id)?.dependsOn)) {
      if (!byId.has(dep)) throw new Error('adaptive-graph-missing-dependency');
      visit(dep);
    }
    colors.set(id, 2);
  }
  for (const id of byId.keys()) visit(id);
  return { version: 1, revision: Math.max(0, Math.floor(finite(graph?.revision))), nodes: nodes.map(item => ({
    ...item, id: value(item.id), type: value(item.type) || 'work',
    status: item.status ?? 'pending', dependsOn: list(item.dependsOn),
    requires: list(item.requires), metadata: { ...(item.metadata ?? {}) }
  })) };
}

export function appendOpenWorldWork(graph, proposal, { expectedRevision, authorizedCapabilities = [] } = {}) {
  const current = validateOpenWorldGraph(graph);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('adaptive-graph-stale-revision');
  const id = value(proposal?.id);
  if (!id || id.length > 100 || current.nodes.some(item => item.id === id)) throw new Error('adaptive-graph-invalid-id');
  // An unknown capability is never permission. Empty allow-list means no tools.
  const required = list(proposal?.requires);
  const allowed = new Set(list(authorizedCapabilities));
  if (required.some(capability => !allowed.has(capability))) throw new Error('adaptive-graph-unauthorized-capability');
  const next = {
    id, type: value(proposal.type) || 'work', status: 'pending',
    purpose: value(proposal.purpose).slice(0, 400),
    dependsOn: list(proposal.dependsOn), requires: required,
    metadata: { ...(proposal.metadata ?? {}) }
  };
  return validateOpenWorldGraph({ revision: current.revision + 1, nodes: [...current.nodes, next] });
}

/** Change one step and invalidate only its downstream dependents on a revision change. */
export function recordOpenWorldOutcome(graph, id, {
  status = 'complete', evidence = null, changed = false, expectedRevision
} = {}) {
  const current = validateOpenWorldGraph(graph);
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('adaptive-graph-stale-revision');
  if (!VALID.has(status)) throw new Error('adaptive-graph-invalid-status');
  if (!current.nodes.some(item => item.id === id)) throw new Error('adaptive-graph-unknown-node');
  const dependencies = Object.fromEntries(current.nodes.map(item => [item.id, item.dependsOn]));
  const invalid = changed ? new Set(invalidateDependents(id, dependencies).filter(item => item !== id)) : new Set();
  return validateOpenWorldGraph({
    revision: current.revision + 1,
    nodes: current.nodes.map(item => item.id === id
      ? { ...item, status, ...(evidence === null ? {} : { evidence }) }
      : invalid.has(item.id) ? { ...item, status: 'stale', evidence: null } : item)
  });
}

/** Only tasks whose prerequisites are settled are eligible for concurrent work. */
export function openWorldFrontier(graph, { maxParallel = 3, risk = 'ordinary' } = {}) {
  const valid = validateOpenWorldGraph(graph);
  const highRisk = HIGH_RISK.has(value(risk).toLowerCase());
  // A stale result must become eligible for re-execution once prerequisites
  // are valid, or a changed requirement could deadlock the run permanently.
  const scheduled = valid.nodes.map(node => node.status === 'stale'
    ? { ...node, status: 'pending' } : node);
  const selected = readyTasks(scheduled);
  return {
    revision: valid.revision,
    ready: selected.map(item => item.id),
    waves: parallelWaves(selected, { maxParallel: highRisk ? 1 : Math.max(1, Math.min(8, Math.floor(finite(maxParallel, 1)))) })
      .map(group => group.map(item => item.id)),
    blocked: scheduled.filter(item => item.status === 'pending' && !selected.includes(item)).map(item => item.id)
  };
}

/**
 * A bounded next-action projection. This does not generate a fixed graph or
 * pretend that a missing tool exists. Ranking uses supplied, grounded values.
 */
export function composeOpenWorldDecision({
  goal = '', situation = {}, graph = {}, candidates = [], authorizedCapabilities = [],
  availableCapabilities = [], remainingBudgetRatio = null, acceptance = {}
} = {}) {
  const current = validateOpenWorldGraph(graph);
  const questions = list(situation?.unresolvedQuestions).slice(0, 12);
  const contradictions = list(situation?.conflicts).slice(0, 8);
  const unknown = questions.length > 0 || contradictions.length > 0 || situation?.evidenceGap === true;
  const direct = !unknown && clamp(situation?.uncertainty) < .3
    && clamp(situation?.complexity) < .3 && !situation?.executionRequired;
  const headroom = remainingBudgetRatio === null || remainingBudgetRatio === undefined
    ? null : clamp(remainingBudgetRatio);
  const capabilityIds = items => list((Array.isArray(items) ? items : []).map(item =>
    typeof item === 'string' ? item : item?.id ?? item?.name));
  const authorized = new Set(capabilityIds(authorizedCapabilities));
  const available = new Set(capabilityIds(availableCapabilities));
  const byId = new Map(current.nodes.map(item => [item.id, item]));
  const options = (Array.isArray(candidates) ? candidates : []).map(raw =>
    typeof raw === 'string' ? { id: raw, purpose: raw } : raw
  ).filter(item => item && value(item.id) && !byId.has(value(item.id)));
  const admissible = options.filter(item => list(item.dependsOn).every(dep =>
    ['complete', 'skipped'].includes(byId.get(dep)?.status)
  ) && list(item.requires).every(cap => authorized.has(cap) && available.has(cap)));
  const gated = situation?.authorizationRequired === true && situation.authorizationSatisfied === false;
  const frontier = openWorldFrontier(current, { risk: situation?.risk });
  const waiting = current.nodes.some(node => node.status === 'running');
  const failed = current.nodes.some(node => ['failed', 'blocked'].includes(node.status));
  const scored = admissible.map(item => ({
    item, score: 3 * clamp(item?.expectedQualityGain ?? item?.value ?? .5)
      + 2 * clamp(item?.evidenceGain ?? (unknown ? .5 : .1))
      - clamp(item?.cost ?? .2) - clamp(item?.latency ?? .2) - 2 * clamp(item?.risk ?? 0)
  })).sort((a, b) => b.score - a.score || value(a.item.id).localeCompare(value(b.item.id)));
  let action = direct ? 'direct' : unknown ? 'investigate' : 'reason';
  let reason = direct ? 'small-sufficient-response' : unknown ? 'reduce-uncertainty' : 'determine-next-useful-work';
  // Existing work always takes precedence over inventing more work.
  if (frontier.ready.length) { action = 'continue-work'; reason = 'existing-ready-work'; }
  else if (waiting) { action = 'await-work'; reason = 'existing-work-running'; }
  else if (failed) { action = 'recover'; reason = 'existing-failed-or-blocked-work'; }
  else if (current.nodes.length && current.nodes.every(node => ['complete', 'skipped'].includes(node.status))
      && acceptance?.satisfied === true) { action = 'ready-to-deliver'; reason = 'server-must-check-completion'; }
  else if (scored.length && !direct) { action = 'propose-work'; reason = 'justified-registered-capability'; }
  if (!['ready-to-deliver', 'continue-work', 'await-work', 'recover'].includes(action)
      && options.length && !scored.length && !direct) {
    action = 'capability-gap'; reason = 'candidate-dependencies-or-authorization-unmet';
  }
  if (headroom !== null && headroom < .08 && !['direct', 'ready-to-deliver', 'await-work'].includes(action)) {
    action = 'budget-gate'; reason = 'insufficient-budget-for-optional-expansion';
  }
  if (gated) { action = 'approval-required'; reason = 'human-control-required'; }
  const next = action === 'propose-work' ? scored[0].item
    : action === 'continue-work' ? current.nodes.find(node => node.id === frontier.ready[0]) : null;
  return Object.freeze({
    version: 1, authority: 'proposal-only', revision: current.revision,
    goal: value(goal).slice(0, 500), action, reason,
    next: next ? { id: value(next.id), purpose: value(next.purpose).slice(0, 240),
      requires: list(next.requires), dependsOn: list(next.dependsOn) } : null,
    unknowns: questions, contradictions,
    frontier,
    acceptanceSatisfied: acceptance?.satisfied === true,
    headroom, unauthorizedExecutionForbidden: true
  });
}
