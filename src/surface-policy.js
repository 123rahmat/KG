/**
 * Product surface policy.
 *
 * One adaptive intelligence core, four user-facing workspaces:
 *   normal-chat -> general adaptive work
 *   code        -> software engineering context
 *   research    -> evidence/research context
 *   design      -> editable visual design context
 *
 * Workspaces change context, tools and continuity; they do not create
 * separate intelligence levels or separate agentic brains.
 */
import { classifyAttachmentSet } from './documents.js';

const text = value => String(value ?? '').trim();

const CODE = /\b(?:code|coding|program|programming|debug|debugging|refactor|repository|repo|pull request|branch|commit|function|class|variable|bug|stack trace|compile|compiler|test suite|unit test|typescript|javascript|python|rust|golang|java|sql|api|backend|frontend|software|app|application|website|web app|github)\b|\b[\w-]+\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh|html|css|json)\b/i;
const RESEARCH_DEEP = /\b(?:research|deep research|investigate|literature review|systematic review|survey|academic papers?|papers?|sources?|citations?|references?|evidence|state of the art|comprehensive(?:ly)?|in[- ]depth|fact[- ]check|find current|latest|today(?:'s)?|currently|right now|search the web|web search|browse|compare .*sources)\b/i;
const CURRENT_FACTS = /\b(?:latest|today|current|currently|right now|this week|live|recent|news|price|prices|rate|rates|weather|scores?)\b/i;
const DEEP_RESEARCH_ACTION = /\b(?:research|investigat(?:e|ion)|literature review|systematic review|survey|fact[- ]check|find and compare|compare sources|source-backed|with citations|cite sources)\b/i;
const CODE_PROJECT_SCOPE = /\b(?:repository|repo|codebase|project|code workspace|github|pull request|branch|commit|multi[- ]file|multiple files|whole app|whole application|whole website|full app|full application|full website|service|backend|frontend|api|deployment|deploy)\b/i;
const CODE_SINGLE_SCOPE = /\b(?:function|method|class|variable|snippet|script|single file|this file|one file|small fix|small change|edit this file|fix this file|explain this code|review this code|run this script|test this file|small program|utility script)\b/i;

function attachmentNames(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map(item => text(typeof item === 'string' ? item : item?.name))
    .filter(Boolean);
}

function attachmentKinds(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map(item => typeof item === 'object' ? text(item?.archiveKind) : '')
    .filter(Boolean);
}

function attachmentWorkProfile(attachments) {
  return classifyAttachmentSet(attachments);
}

function hasProjectCodeContext(value, attachments, profile = attachmentWorkProfile(attachments)) {
  return CODE_PROJECT_SCOPE.test(value)
    || profile.kind === 'code'
    || profile.codeFiles.some(name => /(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Dockerfile|Makefile|requirements\.txt)$/i.test(name));
}

function hasResearchArchiveContext(attachments, profile = attachmentWorkProfile(attachments)) {
  return attachmentKinds(attachments).includes('research-bundle') || profile.kind === 'research';
}

function shouldUseCodeWorkspace(value, attachments, { actions = [], explicitCodeSwitch = false } = {}) {
  if (explicitCodeSwitch) return true;
  const profile = attachmentWorkProfile(attachments);
  if (profile.kind === 'code' || attachmentKinds(attachments).includes('code-project')) return true;
  if (!CODE.test(value)) return false;
  if (hasProjectCodeContext(value, attachments, profile)) return true;
  const names = attachmentNames(attachments);
  if (names.length === 1 || CODE_SINGLE_SCOPE.test(value)) return false;
  return Array.isArray(actions)
    && actions.some(action => ['create', 'transform', 'execute'].includes(String(action).toLowerCase()));
}
const EXPLICIT_MODE_SWITCH = Object.freeze({
  design: /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?(?:design|image design|visual)\s+(?:workspace|studio)?\b|\b(?:design|image design|visual)\s+workspace\b/i,
  code: /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?(?:code|coding)(?:\s+workspace)?\b|\b(?:code|coding)\s+workspace\b/i,
  research: /\b(?:switch|move|open|use|take me to|continue in|work in)\s+(?:the\s+)?research(?:\s+workspace)?\b|\b(?:research|deep research)\s+workspace\b/i
});
const SURFACE_ALIASES = Object.freeze({
  chat: 'normal-chat',
  design: 'design',
  visual: 'design',
  'normal-chat': 'normal-chat',
  code: 'code',
  research: 'research'
});
function normalizeSurfaceId(value = '') {
  return SURFACE_ALIASES[String(value ?? '').trim().toLowerCase()] ?? 'normal-chat';
}
const MEDIUM_ANALYSIS = /\b(?:explain|compare|analy[sz]e|solve|calculate|derive|show|teach|why|how|which|evaluate|recommend|suggest|summari[sz]e|interpret)\b/i;

export const SURFACE_INTELLIGENCE_PROFILES = Object.freeze({
  design: Object.freeze({
    id: 'design-intelligence',
    maturity: 'deep-visual',
    priority: 'visual quality, editability and output correctness, with adaptive critical-path speed',
    contextStrategy: 'canvas-first; include selected assets, dimensions, constraints and visual references; expand only when composition or output requirements need it',
    planningStrategy: 'adaptive visual next-step driven by composition gaps and artifact state',
    agentStrategy: 'use art direction, layout, image editing/generation or visual review roles only when their marginal value is material',
    parallelStrategy: 'parallelize independent asset analysis or alternatives; serialize shared canvas mutations',
    verificationStrategy: 'visual layout, legibility, asset integrity and export checks scaled to the deliverable',
    continuityStrategy: 'sticky canvas, asset and design-decision continuity across follow-ups',
    costStrategy: 'start with one visual pass; add alternatives or specialist roles only when they can change the result materially',
    qualityStrategy: 'clear visual intent, coherent composition, editable artifacts, accurate previews and correct export',
    preferredRoles: Object.freeze(['art-director', 'visual-designer', 'image-editor', 'layout-designer', 'visual-reviewer'])
  }),
  'normal-chat': Object.freeze({
    id: 'normal-chat-intelligence',
    maturity: 'adaptive-general',
    priority: 'speed-first, then depth',
    contextStrategy: 'minimum-sufficient-context',
    planningStrategy: 'single-next-step',
    agentStrategy: 'direct-first; one focused specialist when it materially improves the result; broader panels only for genuine uncertainty or stakes',
    parallelStrategy: 'parallelize independent read-only work only when latency benefit exceeds coordination cost',
    verificationStrategy: 'verify when claims, transformations, tools, files, or stakes justify it; skip redundant checks for pure conversation',
    continuityStrategy: 'preserve conversation and artifact context without forcing workspace escalation',
    costStrategy: 'prefer one strong model call and bounded context; spend additional calls only when they can change the outcome',
    qualityStrategy: 'clarity, usefulness, correct context selection, and honest uncertainty',
    preferredRoles: Object.freeze(['communicator', 'analyst', 'researcher', 'critic'])
  }),
  code: Object.freeze({
    id: 'code-intelligence',
    maturity: 'deep-engineering',
    priority: 'correctness and safe change, with critical-path speed',
    contextStrategy: 'revision-first; inspect affected files, dependencies, tests and runtime evidence before widening scope',
    planningStrategy: 'adaptive dependency-aware next step; never prebuild unnecessary work',
    agentStrategy: 'specialize by engineering risk: architect, implementer, diagnostician, debugger, test-engineer, security/performance reviewers as justified',
    parallelStrategy: 'parallelize independent analysis and disjoint immutable-revision lanes; serialize shared mutations and stale revisions',
    verificationStrategy: 'diff + targeted tests/build/runtime evidence; expand regression coverage when changed surface or risk demands it',
    continuityStrategy: 'sticky project/revision continuity with explicit scope and write isolation',
    costStrategy: 'keep small fixes single-agent/single-wave; add specialists or parallel waves only when marginal evidence or critical-path reduction is material',
    qualityStrategy: 'working software, scoped changes, reproducibility, regression safety, and verified repository state',
    preferredRoles: Object.freeze(['architect', 'implementer', 'test-engineer', 'diagnostician', 'debugger', 'security-reviewer', 'performance-reviewer'])
  }),
  research: Object.freeze({
    id: 'research-intelligence',
    maturity: 'deep-evidence',
    priority: 'evidence quality and uncertainty reduction, with bounded search cost',
    contextStrategy: 'question-first; collect the smallest useful source set, then expand only for evidence gaps, conflicts, freshness, or scope',
    planningStrategy: 'adaptive evidence-gap-driven next step',
    agentStrategy: 'researcher for discovery, analyst for synthesis, critic for challenge; independent panels only when disagreement or source diversity materially matters',
    parallelStrategy: 'parallelize independent source discovery and independent analyses; avoid duplicate searches and redundant evidence',
    verificationStrategy: 'provenance + claim-to-source checks; challenge conflicts and re-investigate unresolved high-impact claims',
    continuityStrategy: 'sticky question, source ledger, evidence ledger, conflicts, and unresolved questions',
    costStrategy: 'stop when the answer is sufficiently supported; spend more calls only when new evidence can change a material conclusion',
    qualityStrategy: 'traceable claims, source diversity, calibrated uncertainty, conflict visibility, and current evidence when required',
    preferredRoles: Object.freeze(['researcher', 'analyst', 'critic', 'communicator'])
  })
});

export function surfaceIntelligenceProfile(surface = 'normal-chat') {
  const id = normalizeSurfaceId(surface);
  return SURFACE_INTELLIGENCE_PROFILES[id] ?? SURFACE_INTELLIGENCE_PROFILES['normal-chat'];
}

export const SURFACE_POLICY_VERSION = '4';

export const SURFACE_WORKSPACE_CONTRACTS = Object.freeze({
  design: Object.freeze({
    id: 'design',
    label: 'Design Workspace',
    mode: 'editable-visual-design',
    objective: 'Create and refine visual artifacts with a real canvas, asset set, layout controls, previews and governed export without creating a separate intelligence stack.',
    contextPolicy: 'Keep the canvas, selected objects, dimensions, assets and active design constraints authoritative; pull additional context only when it changes the visual result.',
    toolPolicy: 'Use image generation/editing, artifact tools and visual transformations only for the current design step; keep mutations scoped to the active artifact.',
    agentPolicy: 'Use one primary visual executor by default; add art direction, layout, image or review roles only when their independent value is justified.',
    verificationPolicy: 'Check composition, overlaps, legibility, asset integrity, requested dimensions and export/preview correctness before finalization.',
    creationPolicy: 'Design artifacts are editable and previewable; no hidden mutation is allowed outside the active design scope.',
    escalationPolicy: 'Escalate to Research for source-heavy visual investigation and to Code for implementation of a design into software.',
    uiPolicy: 'Expose canvas, tools, layers/objects, assets, inspector and preview/export in one focused visual workspace.',
    selectionPolicy: 'Sticky while selected; preserve canvas and visual-artifact continuity across design follow-ups.'
  }),
  'normal-chat': Object.freeze({
    id: 'normal-chat',
    label: 'Normal Chat',
    mode: 'conversation-first',
    objective: 'Act as the general adaptive operating mode for work that does not belong to the dedicated Code or Research workspace, using the minimum sufficient effort and expanding as the situation genuinely requires.',
    contextPolicy: 'Use the active conversation plus only the files, memory, images and external context that materially improve the current request; allow the adaptive controller to deepen context when evidence requires it.',
    toolPolicy: 'Just-in-time tools only. Any capability may be selected when the situation justifies it; specialized Code or Research work moves into its corresponding workspace rather than losing capability.',
    agentPolicy: 'Use the same server-owned adaptive agent policy as the other workspaces: one executor by default, with advisory or specialized roles added only when their independent value exceeds coordination cost.',
    verificationPolicy: 'Verify claims or produced content when stakes, uncertainty or user intent justify a check; do not add a redundant verification pass to pure conversation.',
    creationPolicy: 'Writing, translation, explanation, planning, analysis, file and image understanding, design, visuals, canvas concepts and presentations stay here; micro code work and single-file edits/tests stay here too unless a project/multi-file Code boundary is genuinely present.',
    escalationPolicy: 'Escalate to Code for repository, project, multi-file or full software-engineering work and to Research for source-heavy/current evidence work; otherwise continue adapting in Normal Chat, keeping bounded single-file/micro work here.',
    uiPolicy: 'Keep the composer central; reveal only the controls and adaptive surfaces relevant to the current situation.',
    selectionPolicy: 'Default general workspace. Keep bounded single-file, micro-artifact and lightweight visual work here; switch to Design for durable visual composition, Code for durable software engineering, and Research for durable source/evidence work.'
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
    uiPolicy: 'Keep project source, current revision, change scope, terminal state, tests, diff and write-back approval visible in the workspace.',
    selectionPolicy: 'Sticky while selected. Keep repository continuity across follow-ups; switch only for explicit or strongly evidenced Research/Normal Chat intent.'
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
    uiPolicy: 'Keep the research question, active source set, evidence quality, unresolved claims and citations visible without exposing hidden model reasoning.',
    selectionPolicy: 'Sticky while selected. Keep question/source continuity across follow-ups; switch only for explicit or strongly evidenced Code/Normal Chat intent.'
  })
});

export const SURFACE_POLICY = Object.freeze({
  version: SURFACE_POLICY_VERSION,
  surfaces: Object.freeze({
    design: {
      id: 'design',
      maxDepth: 'deep',
      heavyAutonomy: true,
      deepCode: false,
      deepResearch: false,
      richMultimodal: true,
      adaptiveAgents: true,
      adaptiveTools: true,
      adaptiveVerification: true,
      design: true,
      visualCanvas: true,
      presentationCreation: true,
      contract: SURFACE_WORKSPACE_CONTRACTS.design,
      intelligenceProfile: SURFACE_INTELLIGENCE_PROFILES.design,
      principle: 'Adaptive visual design with an editable canvas, governed asset operations, preview and export verification.'
    },
    'normal-chat': {
      id: 'normal-chat',
      maxDepth: 'adaptive',
      heavyAutonomy: 'adaptive',
      deepCode: false,
      deepResearch: false,
      sharedIntelligence: true,
      adaptiveAgents: true,
      adaptiveTools: true,
      adaptiveVerification: true,
      richMultimodal: true,
      lightweightCreation: true,
      design: true,
      visualCanvas: true,
      presentationCreation: true,
      contract: SURFACE_WORKSPACE_CONTRACTS['normal-chat'],
      intelligenceProfile: SURFACE_INTELLIGENCE_PROFILES['normal-chat'],
      principle: 'General workspace over the same adaptive intelligence: depth, agents, tools, context, verification and iteration all expand or contract with the situation.'
    },
    code: {
      id: 'code',
      maxDepth: 'deep',
      heavyAutonomy: true,
      deepCode: true,
      deepResearch: false,
      richMultimodal: true,
      contract: SURFACE_WORKSPACE_CONTRACTS.code,
      intelligenceProfile: SURFACE_INTELLIGENCE_PROFILES.code,
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
      intelligenceProfile: SURFACE_INTELLIGENCE_PROFILES.research,
      principle: 'Adaptive evidence gathering, analysis, cross-checking and synthesis.'
    }
  })
});

export function classifySurfaceBoundary(goal, { activeSurface = '', attachments = [], flags = {}, actions = [] } = {}) {
  const value = text(goal);
  const active = normalizeSurfaceId(activeSurface);
  const attachmentProfile = attachmentWorkProfile(attachments);
  const explicitCodeSwitch = EXPLICIT_MODE_SWITCH.code.test(value);
  const codeAction = Array.isArray(actions) && actions.some(action => ['create', 'transform', 'execute'].includes(String(action).toLowerCase()));
  const explicitCode = shouldUseCodeWorkspace(value, attachments, {
    actions,
    explicitCodeSwitch
  }) || flags.code === true && codeAction && hasProjectCodeContext(value, attachments, attachmentProfile);
  const explicitResearch = hasResearchArchiveContext(attachments, attachmentProfile)
    || EXPLICIT_MODE_SWITCH.research.test(value)
    || DEEP_RESEARCH_ACTION.test(value)
    || (CURRENT_FACTS.test(value) && /\b(?:search|find|check|verify|compare|source|price|rate|news|weather|score|latest|current)\b/i.test(value))
    || (RESEARCH_DEEP.test(value) && /\b(?:research|investigat|paper|source|evidence|citation|literature|latest|current|browse|search)\w*\b/i.test(value))
    || flags.research === true && /\b(?:source|evidence|latest|current|paper|literature|research|investigat)\w*\b/i.test(value);
  const visualOrFile = Array.isArray(attachments) && attachments.length > 0;
  const requested = activeSurface || 'normal-chat';
    const explicitDesignSwitch = EXPLICIT_MODE_SWITCH.design.test(value);
  const visualDesign = /\b(?:image design|visual design|graphic design|poster|logo|branding|brand board|illustration|layout|composition|art direction|canvas|mood ?board|wireframe|mockup|visual identity)\b/i.test(value)
    || (Array.isArray(attachments) && attachments.some(item => /^image\//i.test(String(item?.contentType ?? item?.type ?? '')))
       && /\b(?:edit|transform|compose|arrange|design|layout|make|create|generate|visual)\b/i.test(value));

  if (explicitCode) {
    return {
      requested,
      surface: 'code',
      redirect: active !== 'code',
      transition: active === 'code' ? 'stay' : 'switch',
      reason: 'coding-work-requires-code-surface',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.code,
      attachmentProfile
    };
  }

  if ((explicitDesignSwitch || visualDesign) && active !== 'code' && active !== 'research') {
    return {
      requested,
      surface: 'design',
      redirect: active !== 'design',
      transition: active === 'design' ? 'stay' : 'switch',
      reason: 'visual-design-work-requires-design-surface',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.design,
      attachmentProfile
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
      workspace: SURFACE_WORKSPACE_CONTRACTS.research,
      attachmentProfile
    };
  }

  // Deep workspaces are sticky across ordinary follow-ups. This preserves
  // project/evidence continuity without changing the underlying intelligence.
  if (active === 'design') {
    return {
      requested,
      surface: 'design',
      redirect: false,
      transition: 'stay',
      reason: 'selected-design-workspace-stays-authoritative',
      complexity: 'deep-eligible',
      workspace: SURFACE_WORKSPACE_CONTRACTS.design
    };
  }

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
    reason: visualOrFile ? 'adaptive-file-or-image-context' : MEDIUM_ANALYSIS.test(value) ? 'adaptive-analysis' : 'adaptive-general-chat',
    complexity: 'adaptive',
    workspace: SURFACE_WORKSPACE_CONTRACTS['normal-chat'],
    attachmentProfile
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
    maxDepth: 'adaptive',
    lightweightCreation: true,
    design: true,
    visualCanvas: true,
    presentationCreation: true,
    agents: 'shared-adaptive-and-justified'
  };
}
