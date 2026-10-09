/**
 * Task-bound domain expertise for the existing adaptive agent scheduler.
 * This is a catalog of optional ADVISORY specialties, not permanent agents.
 * Matching a domain never authorizes tools, file writes, source retrieval,
 * execution, budget expansion or completion.
 */
const entry = (specialty, assignment, purpose, workspaces, pattern, bestFor = []) =>
  Object.freeze({ specialty, assignment, purpose, workspaces: Object.freeze(workspaces),
    pattern, bestFor: Object.freeze(bestFor) });

export const DOMAIN_SPECIALISTS = Object.freeze({
  'subject-tutor': entry('Adaptive subject tutoring',
    'Teach the stated topic at the learner’s level; include worked examples only when useful.',
    'Assess explanations, learning gaps, examples and conceptual accuracy without inventing learner progress.',
    ['normal-chat'], /\b(tutor|teach|lesson|student|learning|homework|curriculum|exam prep|pedagogy)\b/i, ['respond','analyze']),
  'math-verifier': entry('Mathematics and quantitative reasoning',
    'Check derivations, units, assumptions and numerical reasoning; distinguish calculated results from estimates.',
    'Independently check advanced mathematical reasoning and calculations without claiming unperformed computation.',
    ['normal-chat','research'], /\b(math|mathematics|algebra|calculus|equation|proof|geometry|differential|probability)\b/i, ['analyze','verify']),
  'business-planner': entry('Business planning and strategy',
    'Evaluate business objectives, stakeholders, execution choices, risks and measurable next steps.',
    'Compare commercial strategy, operations, market position and practical business constraints.',
    ['normal-chat','research'], /\b(business plan|business model|go.to.market|startup|business strategy|operations plan|pricing strategy)\b/i, ['plan','analyze']),
  'financial-analyst': entry('Financial and budget analysis',
    'Examine provided financial figures, assumptions, scenarios, arithmetic and trade-offs without inventing financial data.',
    'Review budgets, cash flow, profitability and financial scenarios as advisory analysis, not financial authorization.',
    ['normal-chat','research'], /\b(budget|cash.?flow|revenue|profitability|balance sheet|income statement|financial forecast|cost model)\b/i, ['analyze','plan']),
  'document-specialist': entry('Document and file transformation',
    'Identify the precise sections and formats to edit while preserving source content, scope and user intent.',
    'Review document transformation plans, supported formatting and file-consistency risks.',
    ['normal-chat'], /\b(document|pdf|spreadsheet|word file|presentation|slides|edit (?:my |the )?file|multiple files)\b/i, ['edit','transform','respond']),
  'language-specialist': entry('Translation and language fidelity',
    'Check translation fidelity, register, idioms and audience requirements without adding unstated meaning.',
    'Review multilingual text and translations for faithful content and natural communication.',
    ['normal-chat','research'], /\b(translat|localiz|multilingual|interpret.*language|grammar revision)\b/i, ['translate','write','edit']),
  'planning-analyst': entry('Practical planning and decisions',
    'Compare schedules, constraints and dependencies; surface only the decisions required by the user.',
    'Check practical plans for missing prerequisites and achievable steps.',
    ['normal-chat'], /\b(itinerary|schedule|daily routine|project plan|milestones|roadmap|organize my|decision matrix)\b/i, ['plan','analyze']),
  'spreadsheet-analyst': entry('Tabular and spreadsheet reasoning',
    'Check table structure, formulas, missing values and numerical consistency using the provided data.',
    'Analyze spreadsheet and tabular work without inventing calculations or altering files independently.',
    ['normal-chat','research'], /\b(spreadsheet|workbook|excel|csv|pivot table|formula|dashboard data)\b/i, ['analyze','edit']),
  'api-engineer': entry('API contracts and integration',
    'Review endpoint behavior, schema compatibility, authentication and error contracts in assigned files.',
    'Design and review API contracts, versioning and integration behavior under scoped engineering authority.',
    ['code'], /\b(api|rest endpoint|graphql|openapi|webhook|http endpoint|rpc)\b/i, ['code','build-code']),
  'database-engineer': entry('Database and persistence',
    'Inspect query, migration, schema, transaction and data-integrity requirements before proposing edits.',
    'Review schema changes, SQL, consistency, migration and performance effects.',
    ['code'], /\b(database|postgres|sql|migration|schema|query optimizer|transaction|indexing)\b/i, ['code','build-code']),
  'devops-engineer': entry('Infrastructure and deployment',
    'Examine deployment reproducibility, environment isolation, configuration and rollback paths.',
    'Review CI/CD, containers and infrastructure changes with explicit execution and permission boundaries.',
    ['code'], /\b(devops|deployment|docker|kubernetes|ci\/cd|github actions|terraform|infrastructure)\b/i, ['code','build-code']),
  'integration-tester': entry('Cross-component testing',
    'Find the minimal integration and contract tests needed after dependent code changes.',
    'Review integration seams and suggest executable tests; only parent-run receipts prove they passed.',
    ['code'], /\b(integration test|end.to.end|e2e|contract test|cross.service|regression suite)\b/i, ['test-code','verify-code','code']),
  'accessibility-auditor': entry('Interface accessibility',
    'Check keyboard navigation, semantics, focus, contrast and assistive technology compatibility.',
    'Review actual interface requirements for accessibility risks without claiming a browser audit occurred.',
    ['code'], /\b(accessibility|screen reader|keyboard navigation|aria.label|wcag|focus trap)\b/i, ['design','code','verify']),
  'dependency-auditor': entry('Dependency and supply-chain review',
    'Identify dependency changes, license exposure, version conflicts and provenance gaps.',
    'Review observed package manifests and dependency boundaries without claiming a scan occurred.',
    ['code'], /\b(dependenc|package.json|npm audit|supply.chain|lockfile|version conflict)\b/i, ['code','review-code']),
  'reliability-engineer': entry('Reliability and failure recovery',
    'Assess observed outages, timeouts, race conditions, fallback and recovery evidence.',
    'Review resilience, error recovery and service reliability without executing infrastructure commands.',
    ['code'], /\b(reliability|incident|outage|retry|timeout|race condition|resilien|recovery)\b/i, ['code','reassess']),
  'technical-writer': entry('Technical documentation',
    'Propose accurate developer documentation, examples and migration notes from the project state.',
    'Review README, docs, usage examples and compatibility documentation without claiming edits occurred.',
    ['code'], /\b(readme|documentation|api docs|developer guide|changelog|migration guide)\b/i, ['write','code']),
  'systematic-reviewer': entry('Systematic evidence review',
    'Evaluate search coverage, inclusion criteria, evidence selection and risk of bias.',
    'Review systematic/scoping literature evidence only from real provided or retrieved studies.',
    ['research'], /\b(systematic review|meta.analysis|scoping review|evidence synthesis|prisma)\b/i, ['investigate','research']),
  'fact-checker': entry('Claims and source verification',
    'Cross-check material claims against recorded primary sources; identify unsupported or outdated statements.',
    'Review provenance and factual accuracy without claiming to have searched for or verified missing sources.',
    ['research'], /\b(fact.check|verify claims?|misinformation|source credibility|check sources|primary sources)\b/i, ['verify','investigate']),
  'experimental-designer': entry('Experiment and study design',
    'Assess measurable hypotheses, controls, sampling, bias and reproducibility.',
    'Review experiment design and methodology against stated questions and available evidence.',
    ['research'], /\b(experiment|controlled trial|randomi[sz]ed|sampling design|hypothesis test|study protocol)\b/i, ['plan','investigate']),
  'survey-analyst': entry('Survey and qualitative research',
    'Examine coding, sampling, questionnaire bias and interpretation of provided survey responses.',
    'Review survey methods and qualitative evidence without fabricating participants or observations.',
    ['research'], /\b(survey|questionnaire|interview study|thematic analysis|qualitative research)\b/i, ['analyze','investigate']),
  'source-comparator': entry('Conflicting evidence analysis',
    'Compare source quality, publication dates, methodological differences and competing claims.',
    'Resolve source disagreements where possible and make unresolved uncertainty explicit.',
    ['research'], /\b(conflicting sources|sources disagree|contradictory studies|compare sources|evidence conflict)\b/i, ['analyze','verify'])
});

const validWorkspace = value => ['normal-chat','code','research'].includes(value) ? value : 'normal-chat';
export function domainSpecialistMatch(role, { surface = 'normal-chat', goal = '', task = {} } = {}) {
  const item = DOMAIN_SPECIALISTS[role];
  if (!item || !item.workspaces.includes(validWorkspace(surface))) return 0;
  const text = String(goal ?? '').slice(0, 2200);
  if (!item.pattern.test(text)) return 0;
  // Domain matches are explicit, bounded preferences. Do not treat the name
  // of a workspace or an unsupported request as sufficient evidence.
  return item.bestFor.includes(String(task?.type ?? '').toLowerCase())
    || item.bestFor.includes(String(task?.id ?? '').toLowerCase()) ? 0.99 : 0.90;
}
