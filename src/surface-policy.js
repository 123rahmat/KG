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
const DEEP_RESEARCH_ACTION = /\b(?:research|investigat(?:e|ion)|literature review|systematic review|survey|fact[- ]check|find and compare|compare sources|source-backed|with citations|cite sources)\b/i;
const DEEP_CODE_ACTION = /\b(?:debug|fix|refactor|implement|build|develop|modify|edit|run|test|compile|deploy|commit|push|pull request|change the code|write the code|create the code|update the repo|review the repository|analy[sz]e the repository|review the code|analy[sz]e the code)\b/i;
const EXPLICIT_MODE_SWITCH = Object.freeze({
  code: /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?(?:code|coding)(?:\s+workspace)?\b|\b(?:code|coding)\s+workspace\b/i,
  research: /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?research(?:\s+workspace)?\b|\b(?:research|deep research)\s+workspace\b/i
});
const SURFACE_ALIASES = Object.freeze({
  chat: 'normal-chat',
  'normal-chat': 'normal-chat',
  code: 'code',
  research: 'research'
});
function normalizeSurfaceId(value = '') {
  return SURFACE_ALIASES[String(value ?? '').trim().toLowerCase()] ?? 'normal-chat';
}
const MEDIUM_ANALYSIS = /\b(?:explain|compare|analy[sz]e|solve|calculate|derive|show|teach|why|how|which|evaluate|recommend|suggest|summari[sz]e|interpret)\b/i;

export const SURFACE_POLICY_VERSION = '1';

export const SURFACE_WORKSPACE_CONTRACTS = Object.freeze({
  'normal-chat': Object.freeze({
    id: 'normal-chat',
    label: 'Normal Chat',
    mode: 'conversation-first',
    objective: 'Resolve the user need with the smallest reliable amount of reasoning, context and tooling.',
    contextPolicy: 'Use the active conversation and only the files, memory and external context that materially improve this request.',
    toolPolicy: 'Just-in-time tools only. Never open deep research or code execution merely because they are available.',
    agentPolicy: 'Single executor by default; add advisory roles only when uncertainty or complexity justifies them.',
    verificationPolicy: 'Verify claims or produced content when stakes, uncertainty or user intent justify a check; do not add a redundant verification pass to pure conversation.',
    creationPolicy: 'Lightweight writing, visual ideas, diagrams, canvas concepts and presentation structures stay in the conversation.',
    escalationPolicy: 'Escalate to Code for repository/software changes and to Research for source-heavy, current or evidence-gathering work.',
    uiPolicy: 'Keep the composer central; reveal only the controls and adaptive surfaces relevant to the current situation.'
  }),
  code: Object.freeze({
    id: 'code',
    label: 'Code Workspace',
    mode: 'repository-engineering',
    objective: 'Change software safely against an exact project revision and prove the resulting state.',
    contextPolicy: 'Start from the selected GitHub snapshot; retrieve affected files and dependencies first, then expand context only when evidence shows it is needed.',
    toolPolicy: 'Use terminal, tests, repository inspection and write-back only when the current coding step requires them and the server authorizes them.',
    agentPolicy: 'Use specialized coding roles only when their independent value exceeds their coordination cost; parallel writers require the same immutable revision and disjoint write sets.',
    verificationPolicy: 'Treat tests, diffs, build output and repository state as evidence; re-check only the affected regression surface after each material change.',
    creationPolicy: 'Edits are scoped to the approved plan and exact workspace state; no hidden files or unapproved write paths.',
    escalationPolicy: 'Escalate when the revision is stale, scope changes, permissions are missing, evidence conflicts, or a new capability is required.',
    uiPolicy: 'Keep project source, current revision, change scope, terminal state, tests, diff and write-back approval visible in the workspace.'
  }),
  research: Object.freeze({
    id: 'research',
    label: 'Research Workspace',
    mode: 'evidence-first-investigation',
    objective: 'Reduce the highest-impact unknowns and produce traceable claims from real sources.',
    contextPolicy: 'Maintain a bounded source set, prefer the smallest useful evidence collection, and expand only when claims remain unsupported or sources conflict.',
    toolPolicy: 'Search and fetch only the sources justified by the current questions; preserve URLs, titles, timestamps and provenance for retrieved evidence.',
    agentPolicy: 'Add independent researchers or analysts only when parallel source discovery or disagreement resolution materially improves confidence.',
    verificationPolicy: 'Check important claims against source evidence, distinguish observed facts from inference, and surface conflicts instead of silently choosing a side.',
    creationPolicy: 'Synthesis, comparisons, briefs and source-backed explanations are native outputs; code execution is not a default research capability.',
    escalationPolicy: 'Escalate when evidence is contradictory, current information is unavailable, a domain specialist is required, or the question turns into software modification.',
    uiPolicy: 'Keep the research question, active source set, evidence quality, unresolved claims and citations visible without exposing hidden model reasoning.'
  })
});

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
      lightweightCreation: true,
      design: true,
      visualCanvas: true,
      presentationCreation: true,
      contract: SURFACE_WORKSPACE_CONTRACTS['normal-chat'],
      principle: 'Same adaptive intelligence, bounded to simple and medium user-facing work, including lightweight design and Canva-style creation.'
    },
    code: {
      id: 'code',
      maxDepth: 'deep',
      heavyAutonomy: true,
      deepCode: true,
      deepResearch: false,
      richMultimodal: true,
      contract: SURFACE_WORKSPACE_CONTRACTS.code,
      principle: 'Adaptive software engineering with repository-aware execution and verification.'
    },
    research: {
      id: 'research',
      maxDepth: 'deep',
      heavyAutonomy: true,
      deepCode: false,
      deepResearch: true,
      richMultimodal: true,
      contract: SURFACE_WORKSPACE_CONTRACTS.research,
      principle: 'Adaptive evidence gathering, analysis, cross-checking and synthesis.'
    }
  })
});

export function classifySurfaceBoundary(goal, { activeSurface = '', attachments = [], flags = {}, actions = [] } = {}) {
  const value = text(goal);
  const active = normalizeSurfaceId(activeSurface);
  const codeAction = Array.isArray(actions) && actions.some(action => ['create', 'transform', 'execute'].includes(String(action).toLowerCase()));
  const explicitCode = EXPLICIT_MODE_SWITCH.code.test(value)
    || DEEP_CODE_ACTION.test(value)
    || (CODE.test(value) && codeAction)
    || flags.code === true && codeAction;
  const explicitResearch = EXPLICIT_MODE_SWITCH.research.test(value)
    || DEEP_RESEARCH_ACTION.test(value)
    || (CURRENT_FACTS.test(value) && /\b(?:search|find|check|verify|compare|source|price|rate|news|weather|score|latest|current)\b/i.test(value))
    || (RESEARCH_DEEP.test(value) && /\b(?:research|investigat|paper|source|evidence|citation|literature|latest|current|browse|search)\w*\b/i.test(value))
    || flags.research === true && /\b(?:source|evidence|latest|current|paper|literature|research|investigat)\w*\b/i.test(value);
  const visualOrFile = Array.isArray(attachments) && attachments.length > 0;
  const requested = activeSurface || 'normal-chat';

  if (explicitCode) {
    return {
      requested,
      surface: 'code',
      redirect: active !== 'code',
      transition: active === 'code' ? 'stay' : 'switch',
      reason: 'coding-work-requires-code-surface',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.code
    };
  }

  if (explicitResearch) {
    return {
      requested,
      surface: 'research',
      redirect: active !== 'research',
      transition: active === 'research' ? 'stay' : 'switch',
      reason: 'deep-research-work-requires-research-surface',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.research
    };
  }

  // Deep workspaces are sticky across ordinary follow-ups. This preserves
  // repository/source-set continuity without requiring the user to restate
  // the mode on every turn. Explicit signals above can still switch modes.
  if (active === 'code') {
    return {
      requested,
      surface: 'code',
      redirect: false,
      transition: 'stay',
      reason: 'selected-code-workspace-stays-authoritative',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.code
    };
  }

  if (active === 'research') {
    return {
      requested,
      surface: 'research',
      redirect: false,
      transition: 'stay',
      reason: 'selected-research-workspace-stays-authoritative',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.research
    };
  }

  return {
    requested,
    surface: 'normal-chat',
    redirect: false,
    transition: active === 'normal-chat' ? 'stay' : 'switch',
    reason: visualOrFile ? 'rich-normal-chat-understanding' : MEDIUM_ANALYSIS.test(value) ? 'adaptive-medium-chat' : 'direct-chat',
    complexity: MEDIUM_ANALYSIS.test(value) ? 'medium' : 'simple',
    workspace: SURFACE_WORKSPACE_CONTRACTS['normal-chat']
  };
}
export function workspaceContract(surface = 'normal-chat') {
  const id = normalizeSurfaceId(surface);
  return SURFACE_WORKSPACE_CONTRACTS[id] ?? SURFACE_WORKSPACE_CONTRACTS['normal-chat'];
}

export function surfaceRuntimePolicy(surface = 'normal-chat') {
  const id = normalizeSurfaceId(surface);
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
    lightweightCreation: true,
    design: true,
    visualCanvas: true,
    presentationCreation: true,
    agents: 'minimal-and-justified'
  };
}
