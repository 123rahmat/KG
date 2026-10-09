/**
 * Advisory specialist elasticity at safe wave boundaries.
 * This policy is pure: it never cancels in-flight work, authorizes a model,
 * verifies an outcome, or replaces the server-owned acceptance contract.
 */
import { specialistBudgetRatio } from './agent-topology-policy.js';

const clamp = value => Math.max(0, Math.min(1,
  Number.isFinite(Number(value)) ? Number(value) : 0));
const positive = (value, fallback = 1) => Number.isFinite(Number(value))
  ? Math.max(0, Math.floor(Number(value))) : fallback;
const highStakes = risk => ['high', 'critical', 'high-impact', 'regulated', 'physical']
  .includes(String(risk ?? '').toLowerCase());
const riskyFinding = item =>
  ['stop', 'revise', 'investigate'].includes(String(item?.recommendation ?? '').toLowerCase())
  || (Array.isArray(item?.unknowns) && item.unknowns.length > 0)
  || (Array.isArray(item?.risks) && item.risks.length > 0);

export function specialistWaveDecision({
  workspace = 'normal-chat', mode = 'auto',
  plannedAgents = 1, maxAgents = 5, completedRoles = [],
  failedRoles = [], findings = [], remainingBudgetRatio = null,
  risk = 'ordinary', pressure = 0, independence = 0,
  acceptanceSatisfied = false
} = {}) {
  const surface = ['normal-chat', 'code', 'research'].includes(workspace)
    ? workspace : 'normal-chat';
  const normalizedMode = ['auto', 'always', 'off'].includes(mode) ? mode : 'auto';
  const ceiling = Math.max(1,positive(maxAgents, 5));
  const planned = Math.max(1, Math.min(ceiling, positive(plannedAgents)));
  const completed = Array.isArray(completedRoles) ? completedRoles.length : 0;
  const failed = Array.isArray(failedRoles) ? failedRoles.length : 0;
  const observed = Array.isArray(findings) ? findings.filter(Boolean) : [];
  const ratio = specialistBudgetRatio(remainingBudgetRatio);
  const budget = ratio ?? 1;
  const elevated = highStakes(risk);
  const confidences = observed.map(item =>
    Number.isFinite(Number(item.confidence)) ? clamp(item.confidence) : 0.5);
  const meanConfidence = confidences.length
    ? confidences.reduce((sum, n) => sum + n, 0) / confidences.length : 0;
  const opinions = observed.map(item =>
    String(item.recommendation ?? '').trim().toLowerCase()).filter(Boolean);
  const disagreed = new Set(opinions).size > 1
    || (confidences.length >= 2 && Math.max(...confidences) - Math.min(...confidences) >= 0.35);
  const materialGaps = observed.some(riskyFinding);
  const independent = clamp(independence);
  let target = planned;
  let action = 'hold';
  let reason = 'planned-independent-evidence';
  let stopRecruitment = false;

  if (normalizedMode === 'off' || acceptanceSatisfied) {
    stopRecruitment = true;
    target = completed;
    action = 'stop';
    reason = normalizedMode === 'off' ? 'specialists-disabled' : 'acceptance-already-satisfied';
  } else if (budget < 0.08) {
    target = completed;
    stopRecruitment = true;
    action = 'stop';
    reason = 'optional-specialist-budget-exhausted';
  } else if (budget < 0.25 && normalizedMode === 'auto') {
    target = completed > 0 ? completed : 1;
    stopRecruitment = completed > 0;
    action = 'contract';
    reason = 'conserve-budget-and-preserve-primary-verification';
  } else if (normalizedMode === 'auto' && observed.length >= 2
    && !disagreed && !materialGaps && meanConfidence >= 0.86 && failed === 0 && !elevated) {
    target = completed;
    stopRecruitment = true;
    action = 'contract';
    reason = 'independent-findings-converged';
  } else if (normalizedMode === 'auto' && budget >= 0.45 && !failed
    && ((disagreed && observed.length >= 2)
      || (materialGaps && observed.length >= 1 && clamp(pressure) >= 0.55))) {
    target = Math.min(ceiling, Math.max(planned, completed + 1));
    action = target > planned ? 'recruit' : 'hold';
    reason = disagreed ? 'observed-disagreement-needs-review' : 'unresolved-evidence-gap';
  } else if (failed > 0 && normalizedMode === 'auto') {
    target = Math.min(ceiling, Math.max(completed + 1, planned));
    action = 'hold';
    reason = 'failure-requires-serialized-reassessment';
  }
  // Never construe optional specialist confidence as parent-workflow verification.
  // The active wave must settle before this contract is consulted again.
  // Independence and the provider's configured allowance determine
  // concurrency; the catalog never imposes a per-workspace team width.
  const concurrencyDemand = normalizedMode === 'always'
    ? 0.35 + independent*0.65 : independent;
  const concurrencyCeiling = elevated || failed || budget < 0.25 ? 1
    : normalizedMode !== 'always' && independent < 0.35 ? 1
      : Math.max(1,Math.ceil(Math.max(1,target)*concurrencyDemand));
  const maxParallel = Math.max(1, Math.min(Math.max(1, target), ceiling, concurrencyCeiling));
  return Object.freeze({
    action, reason, workspace: surface,
    targetAgents: target, maxParallel, stopRecruitment,
    observedFindings: observed.length, completed, failed, disagreed,
    budgetKnown: ratio !== null, budgetRatio: ratio,
    verificationAuthority: 'parent-workflow-only'
  });
}
