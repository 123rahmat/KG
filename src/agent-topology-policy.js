/**
 * A single bounded decision policy for optional advisory specialists.
 * The parent workflow retains authority over tools, approvals, mutations and completion.
 */
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));
const positiveInt = (value, fallback) => Number.isFinite(Number(value))
  ? Math.max(1, Math.floor(Number(value))) : fallback;
const HIGH_RISK = new Set(['high', 'critical', 'high-impact', 'physical', 'regulated']);

export function remainingSpecialistBudget(run = {}) {
  const allocation = run?.adaptiveBudget ?? {};
  const budget = allocation.budget ?? {};
  const remaining = allocation.remaining ?? {};
  const ratios = Object.entries(budget).flatMap(([resource, ceiling]) => {
    const maximum = Number(ceiling);
    const available = Number(remaining[resource]);
    return Number.isFinite(maximum) && maximum > 0 && remaining[resource] !== undefined && Number.isFinite(available)
      ? [clamp(available / maximum)] : [];
  });
  return ratios.length ? Math.min(...ratios) : null;
}

export function specialistTopology({
  surface = 'normal-chat', mode = 'auto', pressure = 0,
  proposedAgents = 1, maxAgents = 6, remainingBudgetRatio = null,
  independentWork = 0, risk = 'ordinary', explicitParallel = false,
  advancedBuild = false
} = {}) {
  const normalizedMode = ['auto', 'always', 'off'].includes(mode) ? mode : 'auto';
  const workspace = ['normal-chat', 'code', 'research'].includes(surface) ? surface : 'normal-chat';
  const highRisk = HIGH_RISK.has(String(risk).toLowerCase());
  const budgetKnown = remainingBudgetRatio !== null && remainingBudgetRatio !== undefined && Number.isFinite(Number(remainingBudgetRatio));
  const budget = budgetKnown ? clamp(remainingBudgetRatio) : 1;
  const workspaceCeiling = workspace === 'normal-chat' ? 3
    : workspace === 'code' && highRisk && advancedBuild ? 6 : 5;
  const ceiling = Math.min(11, positiveInt(maxAgents, 6), workspaceCeiling);
  const target = Math.min(ceiling, positiveInt(proposedAgents, 1));
  const qualityGate = highRisk ? 'independent-verification-required' : 'task-acceptance-required';

  if (normalizedMode === 'off') return Object.freeze({
    mode: 'single', agents: 0, maxParallel: 1, reason: 'user-disabled-specialists',
    workspace, budgetKnown, budgetRatio: budgetKnown ? budget : null, qualityGate
  });
  // Scarce compute must not be consumed by optional speculative specialists.
  // Mandatory verification remains owned by the parent workflow.
  if (budgetKnown && budget < 0.08) return Object.freeze({
    mode: 'single', agents: 0, maxParallel: 1, reason: 'specialist-budget-exhausted',
    workspace, budgetKnown, budgetRatio: budget, qualityGate
  });
  let agents = target;
  let reason = 'task-value-justified';
  if (budgetKnown && budget < 0.25) {
    agents = Math.min(agents, 1);
    reason = 'conserve-scarce-budget';
  } else if (budgetKnown && budget < 0.45) {
    agents = Math.min(agents, 2);
    reason = 'bounded-by-remaining-budget';
  }
  const independent = clamp(independentWork);
  const canParallelize = !highRisk && agents > 1 && budget >= 0.25
    && ((normalizedMode === 'always' && explicitParallel) || independent >= 0.2);
  const maxParallel = canParallelize ? Math.min(agents, workspace === 'normal-chat' ? 2 : workspace === 'code' ? 3 : 4) : 1;
  return Object.freeze({
    mode: maxParallel > 1 ? 'parallel' : 'specialists',
    agents, maxParallel,
    reason: agents < target ? reason : maxParallel > 1 ? 'independent-work' : 'smallest-justified-team',
    workspace, budgetKnown, budgetRatio: budgetKnown ? budget : null,
    qualityGate, pressure: clamp(pressure)
  });
}
