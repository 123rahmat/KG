/**
 * Read-only capture of the engineering deliverables a user explicitly asked for.
 *
 * This is NOT a classifier, an authorization decision, or an LLM-generated
 * checklist. It extracts bounded original text from an already-admitted
 * Coding request so multi-part work cannot quietly end after only one part.
 * Ambiguous aspirations never become invented, supposedly measurable goals.
 */
const rawText = value => typeof value === 'string' ? value : '';
const clean = (value, max = 240) => rawText(value).replace(/\s+/g, ' ')
  .replace(/^[\s,;]+|[\s,;.]+$/g, '').trim().slice(0, max);
const ACTION = /^(?:(?:please|could you|can you|also|then|and)\s+)*(?:build|create|develop|implement|add|make|fix|debug|repair|refactor|change|update|modify|integrate|migrate|optimi[sz]e|improve|remove|delete|clean|replace|write|generate|design|test|verify|validate|run|deploy|support|handle|cover|complete|review|audit)\b/i;
const NEGATIVE = /\b(?:without|do not|don't|never|avoid|preserve|keep|must not|should not|only change|only modify|no breaking|no deleting)\b/i;
const START_ACTION = '(?:build|create|develop|implement|add|make|fix|debug|repair|refactor|change|update|modify|integrate|migrate|optimi[sz]e|improve|remove|delete|clean|replace|write|generate|design|test|verify|validate|run|deploy|support|handle|cover|complete|review|audit)';
const CLAUSE_SPLIT = new RegExp('(?:[;\\n]+|,\\s*(?=(?:and\\s+)?' + START_ACTION + '\\b)|\\s+and\\s+(?=' + START_ACTION + '\\b))', 'i');
const MAX = 12;

function unique(values, limit = MAX) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = clean(value);
    const key = item.toLocaleLowerCase('en');
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length === limit) break;
  }
  return result;
}
function list(value) {
  return Array.isArray(value) ? unique(value.filter(item => typeof item === 'string')) : [];
}
function userClauses(value) {
  const source = rawText(value).slice(0, 12000);
  // Do not split at periods in file names (.js), version numbers or code.
  const lines = source.split(CLAUSE_SPLIT).map(value => clean(value)).filter(Boolean);
  return lines;
}
function explicitGuardrail(clause) {
  const match = NEGATIVE.exec(clause);
  return match ? clean(clause.slice(match.index)) : '';
}

/**
 * A bounded, non-authoritative ledger of explicit user intent.
 * Only explicit subrequests/constraints enter mandatory coverage. One vague
 * request stays one outcome handled by the existing goal-verification gate.
 */
export function captureCodingUserNeeds({ request = '', constraints = [], successCriteria = [], outputs = [] } = {}) {
  const clauses = userClauses(request);
  const rawRequest = rawText(request);
  const fullClauseCount = clauses.length;
  const actions = unique(clauses.filter(clause => ACTION.test(clause)));
  const guardrails = unique([
    ...clauses.map(explicitGuardrail),
    ...list(constraints)
  ]);
  const specified = list(successCriteria);
  const artifacts = list(outputs);
  // A single action is already represented by the run's original outcome.
  // Add separate criteria only for independent, explicit action clauses.
  const deliverables = actions.length > 1 ? actions : [];
  // Preserve negative constraints and explicit acceptance conditions first;
  // a long feature list must not silently push "do not delete data" out.
  const candidates = unique([...guardrails, ...specified, ...artifacts, ...deliverables], MAX + 1);
  const coverageLimited = rawRequest.length > 12000 || fullClauseCount > MAX
    || candidates.length > MAX
    || (Array.isArray(constraints) && constraints.length > MAX)
    || (Array.isArray(successCriteria) && successCriteria.length > MAX)
    || (Array.isArray(outputs) && outputs.length > MAX);
  const explicitCriteria = coverageLimited
    ? [...candidates.slice(0, MAX - 1),
      'Review remaining requested changes not listed individually in this bounded checklist']
    : candidates;
  const aspirational = /\b(?:best|perfect|flawless|every possible|everything|100\s*%|extreme|world[- ]class)\b/i.test(rawText(request));
  return Object.freeze({
    version: 1,
    source: 'explicit-user-request',
    authoritative: false,
    request: clean(request, 12000),
    actionClauses: Object.freeze(actions),
    deliverables: Object.freeze(deliverables),
    guardrails: Object.freeze(guardrails),
    explicitCriteria: Object.freeze(explicitCriteria),
    qualityUnspecified: aspirational && !specified.length,
    coverageLimited,
    verificationPolicy: 'Each explicit criterion requires a named positive verification; a blanket pass is not coverage.',
    maxItems: MAX
  });
}
