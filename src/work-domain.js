/**
 * The two supported NEW-WORK domains. Tenant workspaces and historical
 * surface labels are never authorization to admit unrelated requests.
 *
 * This is a conservative pre-retrieval decision helper, not an execution
 * permission or a substitute for server-side route enforcement.
 */
const value = item => String(item ?? '').trim();
/** Common input misspellings, not a model-powered permission grant. */
export function normalizeDomainSpelling(input = '') {
  return value(input)
    .replace(/\b(?:codong|codnig|codig|codding|codingg|cooding)\b/gi, 'coding')
    .replace(/\b(?:reasch|reasrch|reasech|reasearch|reserch|reserach|researchh)\b/gi, 'research')
    .replace(/\b(?:thsis|thessis|thesiss|dissertaion)\b/gi, 'thesis');
}

const CODE = /\b(?:cod(?:e|ing)|program(?:ming)?|software|application|app|website|webapp|frontend|backend|full[- ]stack|api|endpoint|database|sql|postgres(?:ql)?|script|javascript|typescript|python|java|rust|react|node(?:js)?|git(?:hub)?|repository|repo|commit|pull request|compiler|algorithm|parser|linter|runtime|test suite|unit tests|cli|sdk|debug(?:ging)?|software bugs?|refactor|deploy(?:ment)?|docker|kubernetes|microservices|package|dependency|ui|ux|css|html)\b/i;
const RESEARCH = /\b(?:research|thes(?:is|es)|thsis|dissertation|academi\w*|scholarly|journal|peer[- ]review|literature review|systematic review|meta[- ]analysis|study design|experimental design|experiment|methodology|qualitative|quantitative|mixed[- ]methods?|theoretical framework|conceptual framework|hypothes(?:is|es)|bibliograph\w*|citation\w*|doi|manuscript|abstract|introduction|discussion|results section|scientific paper|research paper|research question|data analys\w*|statistical analys\w*|statistical model|causal inference|fieldwork|ethnograph\w*|interviews? (?:study|coding|analysis)|mathematical proof|formal proof|equations? for (?:a |the )?(?:study|paper|model))\b/i;
const SCHOLARLY_OUTPUT = /\b(?:research paper|academic paper|scholarly (?:paper|article)|journal (?:article|manuscript)|thesis|thsis|dissertation|literature review|systematic review|research proposal|study protocol)\b/i;
const RESEARCH_CONTEXT = /\b(?:for (?:my|our|the) (?:study|research|experiment|thesis|paper)|analy[sz]e (?:experimental|clinical|qualitative) (?:data|results))\b/i;
/**
 * The user's requested artifact wins over incidental academic subject nouns.
 * A repository parser for journal articles is software; the journal article
 * itself is research. Prefer concrete engineering output over keyword matches.
 */
const SOFTWARE_DELIVERABLE = /\b(?:build|implement|fix|repair|debug|refactor|deploy|develop|create|design|write|update|test|review)\b.{0,100}\b(?:software|(?:web|mobile|desktop|react|node|python|java|typescript|javascript)\s*(?:app|application)|app|application|website|frontend|backend|api|endpoint|service|repository|repo|code|script|parser|compiler|linter|sdk|cli|plugin|package|library|unit tests?|test suite)\b/i;
const SCHOLARLY_ARTIFACT = /^(?:please\s+)?(?:write|draft|prepare|produce|create|complete|submit|revise|format|outline|edit)\b.{0,65}\b(?:research paper|academic paper|scholarly (?:paper|article)|journal (?:article|manuscript)|thesis|dissertation|literature review|systematic review|manuscript)\b/i;
const CODE_ACTION = /\b(?:build|create|develop|write|implement|design|review|repair|fix|debug|test|explain|optimise|optimize|deploy|refactor|integrate|migrate|execute|compare|plan|architect|inspect|update|change|how|why)\b/i;
const ACADEMIC_ACTION = /\b(?:draft|write|develop|design|analyse|analyze|compare|review|investigate|study|explain|translate|edit|format|verify|summari[sz]e|derive|prove|calculate|plan|prepare|check|evaluate|visuali[sz]e|plot|find|formulate)\b/i;
const UNRELATED = /\b(?:holiday|vacation|itinerary|tourist|travel (?:plans?|tips?)|book a restaurant|dinner reservation|weather forecast|horoscope|birthday wishes|romantic poem|remind me|set (?:an? )?alarm|daily (?:news|routine)|football score|match score|personal advice|health advice|recipe|cooking|pizza places)\b/i;
const STRONG_CODING = /\b(?:software|app|application|api|website|webapp|program|script|code|coding|repository|repo|git|debug|bug|endpoint|database|compiler|algorithm|parser|linter|cli|sdk|frontend|backend|ui|ux|test suite|unit tests|pull request|deployment)\b/i;
const GREETING = /^(?:hi|hello|hey|good (?:morning|evening|afternoon)|thanks?|thank you|salaam|assalam(?:u alaikum)?)\s*[!.?]*$/i;
const SHORT_CONTINUATION = /^(?:(?:now|then|also|next|okay|ok|and|please)\s+)?(?:plan|build|fix|review|compare|continue|try|do|update|change|revise|explain|test|write|check|expand|translate)\s+(?:this|that|it|these|the same|the above)(?:\s+.+)?[.!?]*$/i;
const MIXED_TAIL = /\s+(?:and|plus|also)\s+(?=(?:remind me|set an? alarm|plan my (?:holiday|vacation|trip)|give me (?:weather|football|match)|write (?:a )?birthday wish))/i;
const DECLINE = "Sorry, I’m designed to help with coding and research work, including papers and theses. I can help with a task in those areas.";
const CLARIFY = 'Is this for a software project or for a research paper/thesis?';
const allowedDomain = domain => domain === 'coding' || domain === 'research';
const recentAuthorizedDomain = ({ projectContext, conversation }) => {
  if (allowedDomain(projectContext?.verifiedDomain) && projectContext?.lastInScope === true) return projectContext.verifiedDomain;
  const items = Array.isArray(conversation) ? conversation : [];
  for (const item of items.slice(-3).reverse()) {
    if (item?.scopeDecision?.status === 'in-scope' && allowedDomain(item?.scopeDecision?.domain)) {
      return item.scopeDecision.domain;
    }
  }
  return null;
};
const decision = (status, domain, supportedRequest, rationaleCode, extras = {}) =>
  Object.freeze({
    status, domain, supportedRequest, unsupportedSummary: null,
    reply: null, rationaleCode, ...extras
  });

/**
 * Assess a new request, independent of the selected UI workspace.
 * Model assessment is only an advisory for genuinely ambiguous situations;
 * it may not turn a clearly unrelated task into admitted work.
 */
export function assessWorkDomain({
  request = '', projectContext = {}, conversation = [], modelAssessment = null
} = {}) {
  const rawText = value(request).slice(0, 12000);
  const text = normalizeDomainSpelling(rawText);
  if (!text) return decision('needs-clarification', null, '', 'missing-request', { reply: CLARIFY });
  if (GREETING.test(text)) return decision('needs-clarification', null, '', 'greeting', {
    reply: 'Welcome. I can help with a coding project or research paper/thesis.'
  });
  const previous = recentAuthorizedDomain({ projectContext, conversation });
  if (SHORT_CONTINUATION.test(text) && previous) {
    return decision('in-scope', previous, rawText, 'authorized-project-follow-up');
  }

  const explicitSoftware = STRONG_CODING.test(text);
  const hasCode = CODE.test(text) && (CODE_ACTION.test(text) || explicitSoftware);
  const hasResearch = RESEARCH.test(text) && (ACADEMIC_ACTION.test(text) || /\b(?:thesis|dissertation|paper|study|research)\b/i.test(text));
  const unrelated = UNRELATED.test(text);
  const mixedMatch = rawText.match(MIXED_TAIL);
  if (mixedMatch && (hasCode || hasResearch)) {
    const supportedRequest = rawText.slice(0, mixedMatch.index).trim();
    const normalizedSupported = normalizeDomainSpelling(supportedRequest);
    const domain = RESEARCH.test(normalizedSupported) && !STRONG_CODING.test(normalizedSupported) ? 'research' : 'coding';
    return decision('mixed', domain, supportedRequest, 'separable-unrelated-request', {
      unsupportedSummary: rawText.slice(mixedMatch.index).trim(),
      reply: 'I can help with the ' + (domain === 'coding' ? 'coding' : 'research') + ' part, but not the unrelated daily task.'
    });
  }

  // The actual deliverable wins over subject words: a paper on an API is
  // Research, while an API that processes papers is software engineering.
  const softwareDeliverable = hasCode && SOFTWARE_DELIVERABLE.test(text)
    && !SCHOLARLY_ARTIFACT.test(text);
  if (hasResearch && !softwareDeliverable && (SCHOLARLY_OUTPUT.test(text)
    || (RESEARCH_CONTEXT.test(text)
      && !/\b(?:build|implement|deploy)\b.{0,90}\b(?:application|app|software|api|website)\b/i.test(text)))) {
    return decision('in-scope', 'research', rawText, 'scholarly-deliverable');
  }
  if (hasCode && (!hasResearch || explicitSoftware)) {
    return decision('in-scope', 'coding', rawText, 'software-deliverable');
  }
  if (hasResearch) return decision('in-scope', 'research', rawText, 'scholarly-deliverable');
  if (unrelated) return decision('out-of-scope', null, '', 'unrelated-everyday-task', { reply: DECLINE });

  // Project labels by themselves never authorize a new unrelated query.
  // Only an explicitly trusted, previously admitted conversation permits a
  // context-dependent short follow-up.
  if (previous && /^(?:please\s+)?(?:continue|go on|next|what next|why|how|expand|explain|revise|add more)[.!?\s]*$/i.test(text)) {
    return decision('in-scope', previous, rawText, 'authorized-conversation-continuation');
  }
  // Missing project specifics should be clarified once, not misclassified by
  // a model or turned into a costly search/agent wave.
  if (modelAssessment?.domain && allowedDomain(modelAssessment.domain)
    && modelAssessment?.status === 'in-scope' && previous
    && modelAssessment.domain === previous && text.length < 60 && !unrelated) {
    return decision('in-scope', previous, rawText, 'validated-contextual-assessment');
  }
  if (text.length <= 30 || /\b(?:plan|help|do|make|work on)\s+(?:this|it|something|a project)\b/i.test(text)) {
    return decision('needs-clarification', null, '', 'unclear-purpose', { reply: CLARIFY });
  }
  return decision('out-of-scope', null, '', 'no-supported-work-intent', { reply: DECLINE });
}

export const WORK_DOMAIN_DECLINE = DECLINE;
