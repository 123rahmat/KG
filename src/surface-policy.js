/**
 * Product surface policy.
 *
 * One adaptive intelligence core, three user-facing operating envelopes:
 *   normal-chat -> simple/medium adaptive help
 *   code        -> deep software engineering
 *   research    -> deep evidence gathering/investigation
 *
 * Surface policy is a routing boundary, not a weaker intelligence model.
 */
const text = value => String(value ?? '').trim();

const CODE = /\b(?:code|coding|program|programming|debug|debugging|refactor|repository|repo|pull request|branch|commit|function|class|variable|bug|stack trace|compile|compiler|test suite|unit test|typescript|javascript|python|rust|golang|java|sql|api|backend|frontend|software|app|application|website|web app|github)\b|\b[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh|html|css|json)\b/i;
const RESEARCH_DEEP = /\b(?:research|deep research|investigate|literature review|systematic review|survey|academic papers?|papers?|sources?|citations?|references?|evidence|state of the art|comprehensive(?:ly)?|in[- ]depth|fact[- ]check|find current|latest|today(?:'s)?|currently|right now|search the web|web search|browse|compare .*sources)\b/i;
const CURRENT_FACTS = /\b(?:latest|today|current|currently|right now|this week|live|recent|news|price|prices|rate|rates|weather|scores?)\b/i;
const MEDIUM_ANALYSIS = /\b(?:explain|compare|analy[sz]e|solve|calculate|derive|show|teach|why|how|which|evaluate|recommend|suggest|summari[sz]e|interpret)\b/i;

export const SURFACE_POLICY_VERSION = '1';

export const SURFACE_POLICY = Object.freeze({
  version: SURFACE_POLICY_VERSION,
  surfaces: Object.freeze({
    'normal-chat': {
      id: 'normal-chat',
      maxDepth: 'medium',
      heavyAutonomy: false,
      deepCode: false,
      deepResearch: false,
      richMultimodal: true,
      principle: 'Same adaptive intelligence, bounded to simple and medium user-facing work.'
    },
    code: {
      id: 'code',
      maxDepth: 'deep',
      heavyAutonomy: true,
      deepCode: true,
      deepResearch: false,
      richMultimodal: true,
      principle: 'Adaptive software engineering with repository-aware execution and verification.'
    },
    research: {
      id: 'research',
      maxDepth: 'deep',
      heavyAutonomy: true,
      deepCode: false,
      deepResearch: true,
      richMultimodal: true,
      principle: 'Adaptive evidence gathering, analysis, cross-checking and synthesis.'
    }
  })
});

export function classifySurfaceBoundary(goal, { activeSurface = '', attachments = [], flags = {}, actions = [] } = {}) {
  const value = text(goal);
  const explicitCode = CODE.test(value) || flags.code === true;
  const explicitResearch = RESEARCH_DEEP.test(value)
    || CURRENT_FACTS.test(value)
    || flags.research === true && /\b(?:source|evidence|latest|current|paper|literature|research|investigat)\w*\b/i.test(value);
  const visualOrFile = Array.isArray(attachments) && attachments.length > 0;

  if (explicitCode) {
    return {
      requested: activeSurface || 'normal-chat',
      surface: 'code',
      redirect: activeSurface === 'chat' || activeSurface === 'normal-chat',
      reason: 'coding-work-requires-code-surface',
      complexity: 'deep-eligible'
    };
  }

  if (explicitResearch) {
    return {
      requested: activeSurface || 'normal-chat',
      surface: 'research',
      redirect: activeSurface === 'chat' || activeSurface === 'normal-chat',
      reason: 'deep-research-work-requires-research-surface',
      complexity: 'deep-eligible'
    };
  }

  return {
    requested: activeSurface || 'normal-chat',
    surface: 'normal-chat',
    redirect: false,
    reason: visualOrFile ? 'rich-normal-chat-understanding' : MEDIUM_ANALYSIS.test(value) ? 'adaptive-medium-chat' : 'direct-chat',
    complexity: MEDIUM_ANALYSIS.test(value) ? 'medium' : 'simple'
  };
}

export function surfaceRuntimePolicy(surface = 'normal-chat') {
  const id = surface === 'chat' ? 'normal-chat' : text(surface) || 'normal-chat';
  return SURFACE_POLICY.surfaces[id] ?? SURFACE_POLICY.surfaces['normal-chat'];
}

export function normalChatAllowsTask({ goal = '', taskType = '', flags = {}, attachments = [] } = {}) {
  const boundary = classifySurfaceBoundary(goal, { flags, attachments });
  if (boundary.surface !== 'normal-chat') {
    return { allowed: false, boundary, reason: boundary.reason };
  }
  return {
    allowed: true,
    boundary,
    taskType: text(taskType) || 'respond',
    richMultimodal: true,
    maxDepth: 'medium',
    agents: 'minimal-and-justified'
  };
}
