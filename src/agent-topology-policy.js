/**
 * A single bounded decision policy for optional advisory specialists.
 * The parent workflow retains authority over tools, approvals, mutations and completion.
 */
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));
const positiveInt = (value, fallback) => Number.isFinite(Number(value))
  ? Math.max(1, Math.floor(Number(value))) : fallback;
const HIGH_RISK = new Set(['high', 'critical', 'high-impact', 'physical', 'regulated']);

const budgetNumber = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Unknown readings are distinct from a measured zero remaining budget. */
export function specialistBudgetRatio(value) {
  const number = budgetNumber(value);
  return number === null ? null : clamp(number);
}

export function remainingSpecialistBudget(run = {}) {
  const allocation = run?.adaptiveBudget ?? {};
  const budget = allocation.budget ?? {};
  const remaining = allocation.remaining ?? {};
  const ratios = Object.entries(budget).flatMap(([resource, ceiling]) => {
    const maximum = budgetNumber(ceiling);
    const available = budgetNumber(remaining[resource]);
    return maximum !== null && maximum > 0 && available !== null
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
  const ratio = specialistBudgetRatio(remainingBudgetRatio);
  const budgetKnown = ratio !== null;
  const budget = ratio ?? 1;
  // maxAgents is a trusted task/provider compute allowance, not a predefined
  // team size. The work itself determines how much of it to recruit.
  const ceiling = positiveInt(maxAgents, 6);
  const independent = clamp(independentWork);
  let target = Math.min(ceiling, positiveInt(proposedAgents, 1));
  if (normalizedMode === 'auto' && clamp(pressure) < 0.25
      && independent < 0.2 && !advancedBuild) target = 1;
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
  if (budgetKnown && budget < 0.45) {
    agents = budget < 0.25 ? Math.min(agents,1)
      : Math.max(1,Math.min(agents,Math.floor(agents * budget / 0.45)));
    reason = budget < 0.25 ? 'conserve-scarce-budget' : 'bounded-by-remaining-budget';
  }
  const canParallelize = !highRisk && agents > 1 && budget >= 0.25
    && (normalizedMode === 'always' || explicitParallel || independent >= 0.2);
  const parallelDemand = normalizedMode === 'always' || explicitParallel
    ? 0.35 + independent * 0.65 : independent;
  const maxParallel = canParallelize
    ? Math.min(agents, Math.max(normalizedMode === 'always' ? 2 : 1,
      Math.ceil(agents * parallelDemand))) : 1;
  return Object.freeze({
    mode: maxParallel > 1 ? 'parallel' : 'specialists',
    agents, maxParallel,
    reason: agents < target ? reason : maxParallel > 1 ? 'independent-work' : 'smallest-justified-team',
    workspace, budgetKnown, budgetRatio: budgetKnown ? budget : null,
    qualityGate, pressure: clamp(pressure)
  });
}
