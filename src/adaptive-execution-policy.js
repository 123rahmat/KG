/**
 * Adaptive execution policy: one small decision boundary for context, skills,
 * web research, effort and verification. It never grants permissions; it only
 * recommends the minimum sufficient execution envelope.
 */
const text = value => String(value ?? '').trim();
const list = value => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];

const CURRENT = /\b(?:today|now|currently|current|latest|recent|recently|this week|this month|as of|updated|breaking|live|real[- ]?time)\b/i;
const RESEARCH = /\b(?:research|investigate|compare|sources?|citations?|evidence|literature|papers?|benchmark|market|news|verify|fact[- ]?check|look up|search the web|search online)\b/i;
const WEB_EXPLICIT = /\b(?:search (?:the )?(?:web|internet|online)|browse|look (?:it|this|that) up|find (?:online|on the web)|use web search)\b/i;
const FRESHNESS_SENSITIVE = /\b(?:price|pricing|stock|weather|availability|schedule|release|version|documentation|regulation|law|policy|score|ranking|election|outage|status)\b/i;

export const EXECUTION_POLICY_VERSION = '1';

export function classifyInformationNeed(goal = '', context = {}) {
  const value = text(goal);
  const explicit = context.webSearchRequested === true || WEB_EXPLICIT.test(value);
  const freshness = context.requiresFreshData === true || CURRENT.test(value) || FRESHNESS_SENSITIVE.test(value);
  const research = context.research === true || RESEARCH.test(value);
  const evidence = context.evidenceRequired === true || context.verificationRequired === true;
  const external = context.externalDataRequired === true;
  return {
    explicit,
    freshness,
    research,
    evidence,
    external,
    needed: explicit || freshness || research || evidence || external
  };
}

export function decideWebSearch({
  goal = '',
  requested = 'auto',
  research = false,
  requiresFreshData = false,
  evidenceRequired = false,
  externalDataRequired = false,
  risk = 'ordinary',
  budget = null,
  priorSources = [],
  allowedDomains = [],
  excludedDomains = []
} = {}) {
  const need = classifyInformationNeed(goal, {
    webSearchRequested: requested === true || requested === 'required',
    research,
    requiresFreshData,
    evidenceRequired,
    externalDataRequired,
    verificationRequired: evidenceRequired
  });
  const explicit = requested === true || requested === 'required' || need.explicit;
  const autoNeed = need.needed;
  const maxSearches = Number.isFinite(Number(budget?.maxSearches))
    ? Math.max(0, Math.min(12, Number(budget.maxSearches)))
    : need.research || need.evidence ? 4 : 2;
  const sourceCount = Array.isArray(priorSources) ? priorSources.length : 0;
  const alreadySourced = sourceCount >= (need.research || need.evidence ? 3 : 1);
  const highImpact = ['high', 'high-impact', 'physical'].includes(text(risk).toLowerCase());
  const budgetAllowsSearch = maxSearches > 0;
  const shouldSearch = requested === false || requested === 'disabled'
    ? false
    : budgetAllowsSearch && (explicit || (autoNeed && !(alreadySourced && !need.freshness)));
  return {
    version: EXECUTION_POLICY_VERSION,
    shouldSearch,
    mode: explicit ? 'required' : shouldSearch ? 'adaptive' : 'disabled',
    reason: shouldSearch
      ? (need.freshness ? 'fresh-information-can-change-the-answer' : need.research ? 'evidence-gathering-is-material' : 'external-evidence-is-material')
      : requested === false || requested === 'disabled'
        ? 'caller-disabled-search'
        : !budgetAllowsSearch
          ? 'search-budget-exhausted'
          : alreadySourced
          ? 'sufficient-existing-evidence'
          : 'search-not-material-to-the-current-situation',
    informationNeed: need,
    budget: {
      maxSearches,
      stopWhenSufficientEvidence: true,
      stopWhenNoMaterialNewInformation: true,
      avoidDuplicateQueries: true,
      highImpactRequiresEvidence: highImpact
    },
    filters: {
      allowedDomains: list(allowedDomains).slice(0, 5),
      excludedDomains: list(excludedDomains).slice(0, 5)
    },
    provenance: {
      citationsRequired: shouldSearch || evidenceRequired,
      preservePriorSources: true,
      sourceCount
    },
    principle: 'Use the smallest reliable evidence-gathering path; web search is a capability, not a default behavior.'
  };
}

export function adaptiveExecutionEnvelope({
  goal = '',
  complexity = 0,
  uncertainty = 0,
  risk = 'ordinary',
  requestedWebSearch = 'auto',
  research = false,
  evidenceRequired = false,
  budget = null
} = {}) {
  const pressure = Math.max(0, Math.min(1, Math.max(Number(complexity) || 0, Number(uncertainty) || 0)));
  const web = decideWebSearch({ goal, requested: requestedWebSearch, research, evidenceRequired, risk, budget });
  const effort = pressure >= 0.8 || web.shouldSearch && (research || evidenceRequired) ? 'deep' : pressure >= 0.3 ? 'standard' : 'minimal';
  return {
    version: EXECUTION_POLICY_VERSION,
    effort,
    pressure,
    webSearch: web,
    context: {
      mode: pressure >= 0.8 ? 'broad' : pressure >= 0.3 ? 'targeted' : 'minimal',
      expandOnlyOn: ['missing-evidence', 'material-change', 'verification-gap', 'failure']
    },
    skills: {
      principle: 'select the minimum sufficient skill set',
      maxCost: pressure >= 0.8 ? 12 : pressure >= 0.3 ? 8 : 4
    },
    verification: {
      required: true,
      strength: pressure >= 0.8 || evidenceRequired || ['high','high-impact','physical'].includes(text(risk).toLowerCase()) ? 'strong' : 'targeted'
    }
  };
}
