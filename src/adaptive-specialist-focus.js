import { EXTRA_SPECIALIST_FAMILIES, EXTRA_SPECIALIST_KEYWORDS } from './expanded-family-catalog.js';
/**
 * Kindgleam task-scoped sub-specialty guidance.
 * This is advisory metadata, not an agent scheduler or authorization service.
 * No entry here can invoke a model, access a tool, or expand a run budget.
 */
const DEFINITIONS = {
  'normal-chat': {
    'everyday-life':'daily-decisions|routines|errands|household|meal-plans|events|time-use|personal-organization',
    'conversation':'everyday-conversation|explanations|brainstorming-dialogue|tone-adjustment|difficult-conversations|interpersonal-support|social-etiquette|roleplay-practice',
    'communication':'emails|messages|letters|meetings|interviews|presentations|negotiation|translation',
    'education':'personal-tutoring|concept-explanation|exam-preparation|study-plans|practice-problems|curriculum|language-learning|skill-training',
    'creative-work':'stories|scripts|ideas|content-strategy|visual-briefs|naming|creative-editing|design-critique',
    'planning-productivity':'goals|prioritization|project-planning|weekly-planning|habit-design|decision-matrices|checklists|time-management',
    'thinking-reasoning':'logical-reasoning|math-help|critical-thinking|comparisons|problem-solving|decision-support|argument-analysis|uncertainty-assessment',
    'documents-writing':'drafting|editing|summarization|document-review|report-writing|forms|templates|proofreading',
    'files-data':'pdf-understanding|spreadsheets|chart-reading|data-cleanup|data-summary|file-organization|information-extraction|document-comparison',
    'career-work':'career-guidance|resume-writing|job-application|interview-prep|workplace-communication|professional-growth|portfolio|freelancing',
    'business-operations':'business-strategy|marketing|sales|customer-care|business-operations|business-plans|entrepreneurship|productivity-systems',
    'personal-money':'budget-guidance|expense-planning|saving-basics|financial-literacy|purchase-comparisons|cost-estimates|tax-information|fraud-awareness',
    'travel-local':'travel-planning|itinerary|transport|accommodation|local-discovery|packing|accessibility-travel|trip-budget',
    'shopping-products':'product-comparison|buying-guides|specs|value-assessment|gift-ideas|home-products|tech-products|purchase-planning',
    'health-wellbeing-info':'health-information|fitness-education|nutrition-information|sleep-habits|stress-support|care-preparation|wellbeing-routines|safety-information',
    'relationships-family':'relationship-communication|family-planning|parenting-information|conflict-resolution|shared-activities|caregiving-information|boundaries|celebration-planning',
    'technology-help':'device-help|app-howto|privacy-literacy|account-guidance|online-safety|automation-ideas|software-comparison|digital-literacy',
    'science-general-knowledge':'science-explanations|history-explanations|geography|current-knowledge|concept-comparisons|reading-help|fact-questions|technical-explanations',
    'public-services-info':'legal-information|civic-information|administrative-forms|education-options|consumer-rights|public-benefits-info|policy-explanations|process-guides',
    'media-entertainment':'books|movies|music|games|hobbies|culture|recommendations|activity-ideas'
  },
  code: {
    'ui-engineering':'ui-components|design-systems|ui-layout|responsive-ui|visual-polish|ui-state|animation|ui-testing',
    'ux-engineering':'user-journeys|interaction-design|information-architecture|usability|ux-research|user-feedback|onboarding|prototyping',
    'frontend-engineering':'react|web-platform|frontend-state|css|performance-ui|forms|routing|frontend-integration',
    'backend-engineering':'service-design|business-logic|queues|caching|background-jobs|error-handling|integrations|scalability',
    'api-engineering':'rest-api|graphql|api-contracts|api-auth|api-versioning|webhooks|rate-limits|api-testing',
    'database-engineering':'postgresql|schema-design|sql-queries|migrations|transactions|query-performance|data-integrity|backups',
    'security-engineering':'threat-modeling|authentication|authorization|secret-management|security-audits|secure-coding|privacy-controls|vulnerability-review',
    'accessibility-engineering':'screen-reader|keyboard-navigation|contrast|semantic-ui|focus-management|inclusive-design|accessibility-testing|wcag',
    architecture:'system-design|service-boundaries|component-architecture|tradeoffs|scalability-plan|architecture-review|patterns|documentation-design',
    'testing-quality':'unit-tests|integration-tests|end-to-end-tests|regression-tests|contract-tests|test-strategy|coverage|quality-gates',
    'debugging-reliability':'bug-investigation|logs|reproduction|root-cause|fix-verification|incident-response|recovery|error-observability',
    'devops-infrastructure':'ci-cd|containers|cloud|deployment|monitoring|build-pipelines|environment-config|reliability-ops',
    'performance-cost':'profiling|latency|memory|throughput|bundle-size|load-testing|cost-optimization|benchmarking',
    'code-maintenance':'refactoring|code-review|dependencies|legacy-cleanup|type-safety|linting|repository-organization|documentation',
    'desktop-apps':'electron|desktop-ui|desktop-security|native-integration|offline-mode|packaging|updates|filesystem',
    'mobile-apps':'ios|android|cross-platform|mobile-ui|push-notifications|offline-sync|mobile-testing|app-store',
    'tools-repository':'git|github|pull-requests|merge-conflicts|local-folders|cli|code-search|developer-tools',
    'automation-integration':'scripts|workflow-automation|third-party-apis|tool-adapters|web-scraping|event-processing|job-scheduling|connectors',
    'ai-engineering':'model-integration|llm-orchestration|agent-systems|retrieval|prompt-design|evaluations|model-budgeting|inference',
    'external-simulation-files':'matlab-files|autocad-files|simulation-config|file-conversion|tool-interop|model-export|validation|external-runner'
  },
  research: {
    'research-framing':'question-formulation|scope|hypothesis|assumptions|study-plan|variables|constraints|research-design',
    'source-discovery':'web-search|primary-sources|academic-search|datasets|archives|patents|source-tracking|bibliography',
    'academic-review':'literature-review|paper-reading|systematic-screening|citation-chains|research-gaps|method-comparison|review-structure|author-tracking',
    'evidence-verification':'fact-checking|source-quality|triangulation|claim-audit|bias-assessment|conflict-evidence|uncertainty|reproducibility',
    'quantitative-analysis':'statistics|data-cleaning|descriptive-analysis|quant-models|visualization|sampling|measurement|sensitivity-analysis',
    'qualitative-analysis':'interviews|thematic-analysis|coding|case-studies|surveys|field-notes|research-ethics|interpretation',
    'experiments-methods':'experiment-design|ab-testing|controls|randomization|power-assessment|causal-reasoning|protocols|evaluation-design',
    'comparative-research':'comparisons|tradeoff-analysis|benchmarking|decision-matrices|frameworks|option-screening|criteria|competitive-evidence',
    'market-industry':'market-sizing|competitor-analysis|pricing-research|customer-insights|industry-trends|business-models|opportunity-assessment|go-to-market',
    'technology-research':'technical-evaluation|architecture-review|software-landscape|ai-models|standards|security-research|performance-evidence|innovation',
    'science-education':'scientific-literature|physics|biology|chemistry|mathematics|learning-science|environment|methodology',
    'social-policy':'public-policy|economics|social-research|education-policy|legal-research|governance|history-sources|impact-analysis',
    'evidence-synthesis':'synthesis|evidence-map|meta-analysis-screening|argument-map|confidence-assessment|contradictions|limitations|key-findings',
    'reporting-citations':'citations|reference-management|executive-summary|research-report|slides|tables|charts|audit-trail',
    'data-source-engineering':'data-collection|data-provenance|data-quality|schema|dataset-joining|extraction|data-governance|reproducible-pipelines'
  }
};
export const SPECIALIST_FAMILIES = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([workspace, entries]) => [
    workspace, Object.freeze(Object.fromEntries(Object.entries({...entries,...(EXTRA_SPECIALIST_FAMILIES[workspace] ?? {})}).map(
      ([family, values]) => [family, Object.freeze(Array.isArray(values) ? values : values.split('|'))]
    )))
  ])
));
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ROLE_HINTS = Object.freeze({
  'subject-tutor':'education', 'math-verifier':'thinking-reasoning', 'business-planner':'business-operations',
  'financial-analyst':'personal-money', 'document-specialist':'documents-writing',
  communicator:'communication', 'language-specialist':'communication', strategist:'planning-productivity',
  'frontend-engineer':'frontend-engineering', 'ux-designer':'ux-engineering',
  'security-reviewer':'security-engineering', 'test-engineer':'testing-quality',
  debugger:'debugging-reliability', 'backend-engineer':'backend-engineering',
  'api-engineer':'api-engineering', 'database-engineer':'database-engineering',
  'devops-engineer':'devops-infrastructure', 'accessibility-auditor':'accessibility-engineering',
  'citation-auditor':'reporting-citations', 'literature-reviewer':'academic-review',
  'methodology-reviewer':'experiments-methods', 'quantitative-analyst':'quantitative-analysis'
});
const KEYWORDS = Object.freeze({
  'everyday-life':/\b(routine|errand|household|daily life|chores)\b/,
  conversation:/\b(conversation|chat|talk|small talk|difficult conversation)\b/,
  communication:/\b(email|letter|message|translate|meeting|presentation|speech|negotiat)\w*/,
  education:/\b(learn|teach|tutor|lesson|study|exam|homework|student|language learning)\w*/,
  'creative-work':/\b(story|poem|script|fiction|creative|brainstorm|naming)\w*/,
  'planning-productivity':/\b(plan|schedule|routine|priorit|organize|roadmap|habit)\w*/,
  'thinking-reasoning':/\b(reason|logic|equation|math|calculate|compare|solve|proof)\w*/,
  'documents-writing':/\b(document|pdf|draft|write|rewrite|summar|proofread|report)\w*/,
  'files-data':/\b(spreadsheet|excel|csv|file|data|chart|table)\w*/,
  'career-work':/\b(resume|cv|interview|career|job|portfolio|freelanc)\w*/,
  'business-operations':/\b(business|startup|sales|marketing|customer|entrepren)\w*/,
  'personal-money':/\b(budget|saving|expense|personal finance|cash flow|tax)\w*/,
  'travel-local':/\b(travel|trip|itinerary|hotel|flight|destination)\w*/,
  'shopping-products':/\b(shop|buy|purchase|product|gift|deal)\w*/,
  'health-wellbeing-info':/\b(health|fitness|nutrition|sleep|stress|exercise)\w*/,
  'relationships-family':/\b(family|parent|relationship|friend|partner|caregiv)\w*/,
  'technology-help':/\b(device|phone|computer|app|software|digital|account)\w*/,
  'science-general-knowledge':/\b(science|history|geography|physics|chemistry|biology)\w*/,
  'public-services-info':/\b(legal|law|civic|government|benefits|consumer rights)\w*/,
  'media-entertainment':/\b(movie|music|book|game|hobby|entertainment)\w*/,
  'ui-engineering':/\b(ui|user interface|component|responsive|layout|design system)\b/,
  'ux-engineering':/\b(ux|user experience|usability|user journey|onboarding|interaction design)\b/,
  'security-engineering':/\b(security|authentication|authorization|vulnerability|threat|password|secret|privacy)\w*/,
  'api-engineering':/\b(api|endpoint|rest|graphql|webhook)\b/,
  'database-engineering':/\b(database|postgres|sql|schema|migration|query)\w*/,
  'testing-quality':/\b(test|regression|e2e|coverage|qa|spec)\w*/,
  'debugging-reliability':/\b(debug|bug|crash|error|failure|incident|outage)\w*/,
  'frontend-engineering':/\b(frontend|react|css|javascript|browser)\b/,
  'backend-engineering':/\b(backend|server|service|queue|worker)\b/,
  'devops-infrastructure':/\b(devops|deployment|docker|kubernetes|ci cd|cloud infrastructure)\b/,
  'research-framing':/\b(research question|hypothesis|research scope|study design)\b/,
  'source-discovery':/\b(find sources|primary sources|bibliography|search literature|retrieve sources)\b/,
  'academic-review':/\b(literature review|academic paper|journal|thesis|dissertation|systematic review)\b/,
  'evidence-verification':/\b(fact check|verify|validate claim|source quality|credibility|bias)\w*/,
  'quantitative-analysis':/\b(statistics|quantitative|regression|numeric|dataset|data analysis)\w*/,
  'qualitative-analysis':/\b(qualitative|interview|thematic|field notes|case study)\w*/,
  'experiments-methods':/\b(experiment|a b test|randomization|sampling|methodology)\w*/,
  'market-industry':/\b(market research|competitor|market size|industry trend)\w*/,
  'reporting-citations':/\b(citation|references|footnote|bibliography|research report)\w*/
});
const FALLBACK = Object.freeze({ 'normal-chat':'thinking-reasoning', code:'architecture', research:'research-framing' });
export function specialistCatalogStats() {
  return Object.freeze(Object.fromEntries(Object.entries(SPECIALIST_FAMILIES).map(([workspace, entries]) => [
    workspace, { families:Object.keys(entries).length, subskills:Object.values(entries).reduce((sum, subs) => sum + subs.length, 0) }
  ])));
}
export function specialistFocusFor({surface='normal-chat',goal='',role='',maxSubskills=2}={}) {
  const workspace = SPECIALIST_FAMILIES[surface] ? surface : 'normal-chat';
  const entries = SPECIALIST_FAMILIES[workspace];
  const request = normalize(goal).slice(0,2000);
  const roleId = String(role ?? '').toLowerCase();
  const roleFamilyMatch = roleId.match(/^(?:chat|code|research)-(.+)-lead$/);
  const hintedFamily = roleFamilyMatch?.[1] && Object.hasOwn(entries,roleFamilyMatch[1])
    ? roleFamilyMatch[1] : null;
  const scored = Object.entries(entries).map(([family, children]) => {
    const phrase = normalize(family);
    const keywordHits = children.reduce((count, sub) => count + (request.includes(normalize(sub)) ? 1 : 0), 0);
    const matched = KEYWORDS[family]?.test(request) || EXTRA_SPECIALIST_KEYWORDS[family]?.test(request) ? 3 : 0;
    const roleMatch = ROLE_HINTS[roleId] === family || hintedFamily === family ? 12 : 0;
    return {family,children,score:roleMatch + matched + keywordHits * 2 + (request.includes(phrase) ? 2 : 0)};
  }).sort((a,b)=>b.score-a.score || a.family.localeCompare(b.family));
  const choice = scored[0]?.score > 0 ? scored[0] : scored.find(item=>item.family===FALLBACK[workspace]);
  const ranked = choice.children.map(subskill=>({
    subskill, score:request.includes(normalize(subskill)) ? 2 : 0
  })).sort((a,b)=>b.score-a.score || choice.children.indexOf(a.subskill)-choice.children.indexOf(b.subskill));
  return Object.freeze({
    workspace, family:choice.family, matched:choice.score > 0,
    subskills:Object.freeze(ranked.slice(0,Math.max(1,Math.min(3,Math.floor(Number(maxSubskills)||2)))).map(x=>x.subskill)),
    role:roleId || null, authority:'advisory-only', scope:'current-task-only',
    delegation:'parent-controller-only', verification:'evidence-required',
    note:'The specialist is a bounded focus inside the current authorized agent call. No new agents or tools are spawned.'
  });
}
