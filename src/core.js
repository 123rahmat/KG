/**
 * Open-world adaptive workflow.
 *
 * One lifecycle serves known, unknown and future goals:
 * goal → situation → choose the next justified work → execute/observe →
 * reassess → verify → deliver/iterate.
 * The graph grows one server-owned step at a time; later work is not pre-created.
 */

import { declinedPurpose } from './safety.js';
import {
  CAPABILITY_DEFINITIONS,
  CAPABILITIES,
  SURFACES,
  inspectGoal,
  compileGoalModel,
  discoverCapabilityRequirements,
  resolveAdaptiveContext
} from './adaptive.js';
import { workScale, BUILT_IN } from './work-scale.js';
import { approvalReasons, verificationContract } from './capabilities.js';
import { buildUnifiedAdaptiveIntelligence } from './unified-adaptive-intelligence.js';
import { nextAdaptiveStage } from './unified-adaptive-workflow.js';
import { buildUnifiedWorkContext } from './unified-work-context.js';
import { selectSkillDescriptors, summarizeSkillLearning, skillContextSignature, skillPlanForSelectedSkills } from './skills.js';
import { parallelDecision } from './parallel-orchestrator.js';
import { classifySurfaceBoundary, surfaceRuntimePolicy, surfaceIntelligenceProfile } from './surface-policy.js';
import { buildUniversalContextContract } from './universal-context.js';

export const CONTRACT = 'kindgleam-open-world-situation-adaptive-v9';
export { CAPABILITIES, SURFACES };


export const POLICY_LAYERS = Object.freeze([
  'platform', 'jurisdiction', 'organization', 'workspace', 'user', 'task'
]);

const REQUIRED_LAYERS = Object.freeze(['platform']);
const text = value => String(value ?? '').trim();
const list = value => Array.isArray(value)
  ? [...new Set(value.map(text).filter(Boolean))]
  : [];

export function classifyIntent(goal, context = {}) {
  const value = text(goal);
  if (!value) return { kind: 'empty', confidence: 1, signals: [] };

  const analysis = inspectGoal(value, {
    ...context
  });
  const model = analysis.goalModel ?? compileGoalModel(value);
  const signals = model.actions ?? [];
  if (signals.includes('invent') || analysis.unknownSituation) {
    return {
      kind: signals.includes('invent') ? 'invention' : 'adaptive',
      confidence: model.confidence,
      signals
    };
  }
  const acts = signals.includes('create') || signals.includes('execute') || signals.includes('transform');
  if (analysis.flags?.code && acts) {
    return { kind: 'coding', confidence: model.confidence, signals };
  }
  if (signals.includes('investigate')) return { kind: 'discovery', confidence: model.confidence, signals };
  if (signals.includes('create') || signals.includes('transform')) return { kind: 'creation', confidence: model.confidence, signals };
  // A what-if or over-time question is reasoned out in the chat.
  if (signals.includes('answer') || signals.includes('model')) return { kind: 'chat', confidence: model.confidence, signals };
  return { kind: 'adaptive', confidence: model.confidence, signals };
}


export function requiredCapabilities(goal) {
  // No goal, no work: an empty request needs a question, not capabilities.
  if (!text(goal)) return [];
  return discoverCapabilityRequirements(goal, inspectGoal(goal)).map(item => item.id);
}

export function capabilityCatalog() {
  return CAPABILITY_DEFINITIONS.map(item => ({
    name: item.name,
    category: item.category,
    source: item.source,
    risk: item.risk,
    openWorld: true
  }));
}

/* ---------------------------------------------------------------- policy */

export function normalizePolicy(policy = {}, layer = 'task') {
  return {
    layer,
    id: text(policy.id) || layer + '-default',
    version: text(policy.version) || '1',
    allowedCapabilities: list(policy.allowedCapabilities),
    allowedCapabilitiesSpecified: Object.hasOwn(policy, 'allowedCapabilities'),
    deniedCapabilities: list(policy.deniedCapabilities),
    allowedTools: list(policy.allowedTools),
    allowedToolsSpecified: Object.hasOwn(policy, 'allowedTools'),
    deniedTools: list(policy.deniedTools),
    allowedModels: list(policy.allowedModels),
    allowedModelsSpecified: Object.hasOwn(policy, 'allowedModels'),
    deniedModels: list(policy.deniedModels),
    allowedDataClasses: list(policy.allowedDataClasses),
    allowedDataClassesSpecified: Object.hasOwn(policy, 'allowedDataClasses'),
    allowedRiskClasses: list(policy.allowedRiskClasses),
    allowedRiskClassesSpecified: Object.hasOwn(policy, 'allowedRiskClasses'),
    deniedRiskClasses: list(policy.deniedRiskClasses),
    deniedDataClasses: list(policy.deniedDataClasses),
    requireHumanApproval: Boolean(policy.requireHumanApproval),
    maxTokens: Number.isFinite(policy.maxTokens) ? policy.maxTokens : null
  };
}

const matches = (rule, value) => {
  if (!value || typeof rule !== 'string') return false;
  if (rule === '*' || rule === value) return true;
  if (rule.endsWith('*')) return value.startsWith(rule.slice(0, -1));
  if (rule.startsWith('*')) return value.endsWith(rule.slice(1));
  return false;
};
const anyMatch = (rules, value) => rules.some(rule => matches(rule, value));

export function evaluatePolicy(policies = {}) {
  const sources = POLICY_LAYERS
    .filter(layer => policies?.[layer])
    .map(layer => normalizePolicy(policies[layer], layer));

  const merge = key => [...new Set(sources.flatMap(source => source[key]))];
  const intersect = key => {
    const specifiedKey = key + 'Specified';
    const declared = sources.filter(source => source[specifiedKey] === true);
    if (!declared.length) return [];
    if (declared.some(source => source[key].length === 0)) return [];
    return declared.slice(1).reduce(
      (allowed, source) => allowed.filter(value => source[key].includes(value)),
      [...declared[0][key]]
    );
  };
  const budgets = sources.map(source => source.maxTokens).filter(value => value !== null);
  const approvals = sources
    .filter(source => source.requireHumanApproval)
    .map(({ layer, id, version }) => ({ layer, id, version }));

  const missingRequired = sources.length
    ? REQUIRED_LAYERS.filter(layer => !sources.some(source => source.layer === layer))
    : [];

  return {
    status: !sources.length ? 'unconfigured' : missingRequired.length ? 'incomplete' : 'evaluated',
    missingRequired,
    sources,
    approvals,
    constraints: {
      allowedCapabilities: intersect('allowedCapabilities'),
      allowedCapabilitiesSpecified: sources.some(source => source.allowedCapabilitiesSpecified === true),
      allowedTools: intersect('allowedTools'),
      allowedToolsSpecified: sources.some(source => source.allowedToolsSpecified === true),
      allowedModels: intersect('allowedModels'),
      allowedModelsSpecified: sources.some(source => source.allowedModelsSpecified === true),
      allowedDataClasses: intersect('allowedDataClasses'),
      allowedDataClassesSpecified: sources.some(source => source.allowedDataClassesSpecified === true),
      allowedRiskClasses: intersect('allowedRiskClasses'),
      allowedRiskClassesSpecified: sources.some(source => source.allowedRiskClassesSpecified === true),
      deniedCapabilities: merge('deniedCapabilities'),
      deniedTools: merge('deniedTools'),
      deniedModels: merge('deniedModels'),
      deniedRiskClasses: merge('deniedRiskClasses'),
      deniedDataClasses: merge('deniedDataClasses'),
      requireHumanApproval: approvals.length > 0,
      maxTokens: budgets.length ? Math.min(...budgets) : null
    },
    principle: 'Higher-layer mandatory constraints are not overridden by lower-layer policy.',
    compliance: 'Policy evaluation is a control decision, not a legal-compliance guarantee.'
  };
}

export function policyAllows(decision, {
  capability = '', tool = '', model = '', dataClass = '', risk = ''
} = {}) {
  if (!decision || decision.status === 'incomplete') return false;
  if (decision.status === 'unconfigured') return true;
  if (decision.status !== 'evaluated') return false;

  if (dataClass) {
    if (anyMatch(decision.constraints.deniedDataClasses, text(dataClass))) return false;
    if (decision.constraints.allowedDataClassesSpecified
        && !anyMatch(decision.constraints.allowedDataClasses, text(dataClass))) return false;
  }
  if (risk) {
    if (anyMatch(decision.constraints.deniedRiskClasses, risk)) return false;
    if (decision.constraints.allowedRiskClassesSpecified
        && !anyMatch(decision.constraints.allowedRiskClasses, risk)) return false;
  }

  const allowed = (kind, value) => {
    if (!value) return true;
    if (anyMatch(decision.constraints['denied' + kind], value)) return false;
    const rules = decision.constraints['allowed' + kind];
    const specified = decision.constraints['allowed' + kind + 'Specified'] === true;
    return !specified || anyMatch(rules, value);
  };

  return allowed('Capabilities', text(capability))
    && allowed('Tools', text(tool))
    && allowed('Models', text(model));
}

/* ------------------------------------------------------------- task graph */

const makeTask = (id, type, dependsOn, requires, purpose, metadata = {}) => ({
  id, type, dependsOn, requires, purpose, status: 'pending', metadata
});

/**
 * Capabilities every plan carries. A goal that needs nothing beyond these,
 * executes nothing and carries no risk is answered directly.
 */
/** Greetings, thanks and "how are you": conversation, not a task. */
export const SMALL_TALK = /^\s*(?:hi|hii+|hello|hey|hiya|yo|salam|salaam|as+alam\w*(?:[\s-]+(?:o|u|wa)?[\s-]*(?:alaikum|alaykum|alekum)\w*)?|aoa|good (?:morning|afternoon|evening|night)|thanks?(?: you)?(?: so much| a lot)?|thank u|thx|ty|ok(?:ay)?|cool|great|nice|bye|goodbye|how are you(?: doing)?|what'?s up|sup)\b[\s!.,?\p{Emoji_Presentation}]*(?:there|again|everyone|all)?[\s!.,?\p{Emoji_Presentation}]*$/iu;

/** Reminders and scheduled questions: the answer step proposes the schedule. */
const SCHEDULING = /\b(remind me|reminders?|set (?:a|an) (?:alarm|reminder)|notify me|ping me|every (?:day|morning|evening|night|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday))\b/i;

/** Pieces of writing a model can produce on its own. */
const WRITING = /\b(letters?|emails?|e-mails?|poems?|essays?|stor(?:y|ies)|posts?|captions?|speech(?:es)?|messages?|bios?|biograph\w*|resumes?|r[ée]sum[ée]s?|cvs?|cover letters?|summar\w+|articles?|blogs?|scripts? for (?:a )?(?:video|talk|podcast)|slogans?|taglines?|toasts?|invitations?|announcements?|reviews?|replies|reply|paragraphs?|outlines?|lyrics|jokes?|notes?|cards?|wishes|greetings?|condolences?|apolog(?:y|ies)|thank[- ]you|quotes?|descriptions?|headlines?|tweets?)\b/i;

/** Building a whole system rather than one piece of it. */
const BROAD_WORK = /\b(?:build|create|make|develop|design|implement|set up)\b[^.?!]{0,60}\b(?:apps?|applications?|websites?|web ?apps?|apis?|services?|servers?|backends?|platforms?|systems?|games?|dashboards?|databases?|pipelines?|compilers?|engines?)\b/i;

export const BASE_CAPABILITIES = Object.freeze([
  'reasoning', 'situation-understanding', 'adaptive-safety-governance', 'capability-compilation', 'planning', 'verification'
]);

/**
 * A declined request's reply: one reasoning answer to the person's real
 * need, then its check (the refusal path below). Also the direct workflow:
 * answer, then check the answer. It keeps the rules that
 * matter (the answer is evidence, verification runs against it) without the
 * discovery, adaptation and iteration stages that only pay off for work.
 */
function directTasks(analysis) {
  const declined = analysis.ethics?.decision === 'refuse';
  return [
    makeTask('respond', 'respond', [], ['reasoning', 'response'],
      declined
        ? declinedPurpose(analysis.ethics)
        : analysis.crisis && analysis.flags?.crisisKind === 'emergency'
        ? 'This may be an emergency happening now. First tell the person to call their local emergency number (for example 112, 911, 999 or 1122) or get someone nearby to (for an animal: an emergency vet or animal poison line), then give short, plain first steps to stay safe until help arrives. Answer in the language the person wrote in. Do not research, delay or ask for approval.'
        : analysis.crisis
          ? 'Respond now, with care and without judgement: acknowledge what the person said, encourage them to reach someone they trust, and point them to immediate help (local emergency services or a crisis line). Do not research, delay or ask for approval.'
          : analysis.reminder
            ? 'Set up what the person asked to be reminded of or asked at a set time: propose it with schedule.create (they approve it), and say plainly when it will happen.'
          : analysis.writing
            ? 'Do what was asked (write, rewrite, translate or reply) in a form ready to use, fitted to the person and their situation.'
            : 'Answer the question directly, stating assumptions and uncertainty.',
      declined
        ? { declined: true, category: analysis.ethics.category, topic: analysis.ethics.topic === true }
        : analysis.crisis ? { crisis: true, crisisKind: analysis.flags?.crisisKind ?? 'self-harm' } : analysis.conversational ? { conversational: true } : {}),
    // A greeting or a purely conversational reply has no claims, tools or
    // stakes to check: a second model call would only add cost and delay.
    ...(analysis.conversational ? [] : [makeTask('verify', 'verify', ['respond'], ['verification'],
      'Check the answer for correctness, completeness and unsupported claims before it is presented.',
      { verification: analysis.verification ?? verificationContract() })])
  ];
}

/**
 * Create the single adaptive workflow root for every request.
 *
 * The workflow is intentionally NOT pre-built. Understanding is the first
 * server-owned node; every later node is created only after the current node
 * completes and the new situation has been evaluated. This makes the graph
 * itself adaptive instead of merely adapting resources inside a static plan.
 */
export function buildTasks(intent, capabilities, requiresApproval, analysis = {}) {
  const surface = analysis?.surface?.surface
    ?? analysis?.surface
    ?? 'normal-chat';
  const intelligenceProfile = surfaceIntelligenceProfile(surface);
  // Every request enters the same adaptive workflow. "Direct" is only a
  // depth/latency decision made by intelligence; it is never a separate brain
  // or execution path. At focused depth the graph starts at the answer: a
  // greeting costs one call, and a person in crisis is answered at once.
  if (analysis.direct) return directTasks(analysis);
  return [
    makeTask(
      'understand',
      'understand',
      [],
      ['reasoning', 'situation-understanding'],
      'Understand the current situation, outcome, constraints, inputs, success criteria, uncertainty and what should happen next. Do not invent a fixed future workflow.',
      {
        adaptiveRoot: true,
        openWorld: true,
        dynamicGraph: true,
        oneStepAtATime: true,
        candidateCapabilities: capabilities,
        initialApprovalRequired: requiresApproval === true,
        workflowBlueprint: analysis.workflowBlueprint ?? null,
        resourceScope: analysis.resourcePlan ?? null,
        verification: analysis.verification ?? verificationContract(),
        adaptiveDepth: analysis.direct ? 'focused' : 'full',
        intelligence: analysis.unifiedIntelligence ?? null,
        intelligenceProfile,
        surfaceMaturity: intelligenceProfile.maturity,
        metaReasoning: analysis.unifiedIntelligence?.metaReasoning ?? null,
        controlLoop: analysis.unifiedIntelligence?.controlLoop ?? null
      }
    )
  ];
}

export const PRINCIPLES = Object.freeze({
  architecture: 'One adaptive core. Domains are context, not separate engines.',
  universal: 'The native registry is a bootstrap set, not the whole capability universe.',
  openWorld: 'Known, unknown and future requirements are represented as capability descriptors.',
  investigation: 'Investigate when uncertainty, novelty, evidence requirements or complexity justify it.',
  composition: 'Compatible capabilities can be composed into one dependency-aware workflow.',
  creation: 'Missing capabilities become governed specifications instead of hard-coded domain branches.',
  evidence: 'Unknown until observed.',
  execution: 'External execution happens only through an authorized boundary.',
  verification: 'Evidence is checked against criteria fixed before execution.',
  governance: 'Policy is evaluated before execution and remains authoritative.',
  adaptability: 'Tools, models, data, runtime and UI can change without replacing the workflow core.',
  reassessment: 'Every execution produces an opportunity to re-evaluate the situation before verification; new evidence can trigger governed capability discovery and re-planning.'
});

/** A step that no longer holds anything up: done, or skipped as not needed. */
export const isDone = task => task?.status === 'complete' || task?.status === 'skipped';

export function nextTask(tasks) {
  const byId = new Map(tasks.map(item => [item.id, item]));
  return tasks.find(item =>
    item.status === 'pending'
    // The decision after a failure waits on the failed step, and is then due.
    && (item.dependsOn ?? []).every(id => isDone(byId.get(id)) || (item.type === 'iterate' && byId.get(id)?.status === 'failed'))
  ) ?? null;
}

// Words that make a follow-up in a chat about work on code, not new writing.
const ATTACHED_CODE = /\.(?:py|js|mjs|cjs|jsx|ts|tsx|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh)$/i;
export const CODE_FOLLOW_UP = /\b(?:bugs?|functions?|methods?|class(?:es)?|variables?|errors?|exceptions?|stack ?traces?|compil\w*|refactor\w*|tests?|scripts?|code|program)\b/i;

export function planGoal(goal, {
  policies = {},
  activeSurface = '',
  timeZone = '',
  runtimeMode = 'auto',
  workspaceType = 'personal',
  jurisdiction = '',
  // Earlier turns of the same chat: a short follow-up ("why?") is not too
  // thin to plan when the conversation gives it meaning.
  conversation = [],
  // Files attached to this message ("summarise this" plus a file).
  attachments = [],
  // What can really run here: { code }. Unknown (null) plans as
  // if a runner exists; false plans the work as code the person can run.
  executionAvailable = null,
  // Whole-situation context. These fields deliberately remain domain-neutral
  // so the same planner can adapt to education, engineering, research,
  // business, creation, software, physical workflows and future domains.
  user = null,
  workspace = null,
  project = null,
  files = [],
  priorWork = [],
  constraints = [],
  resources = [],
  requirements = [],
  successCriteria = [],
  outputs = [],
  environment = null,
  language = '',
  skillLevel = '',
  preferences = [],
  currentState = null,
  completedSteps = [],
  failedSteps = [],
  evidence = [],
  questions = [],
  dataSources = [],
  connections = [],
  connectedServices = [],
  verifiedConnections = [],
  privacyConsent = {},
  need = null,
  adaptiveControl = {},
  commitments = [],
  dependencies = [],
  dueAt = null,
  startAt = null,
  userBehavior = {},
  capacity = null,
  availability = null,
  competingCommitments = [],
  now = null,
  creationMode = '',
  blockedTopics = [],
  // Validated model classification (src/classifier.js), or null for keywords.
  classifierHints = null,
  modelSelection = null,
  // Learned skill profiles are user/workspace-scoped evidence used only to
  // adapt skill selection. They never grant permissions or bypass governance.
  learnedSkills = [],
  // The ethical reading of the situation (safety.js); a declined request is
  // answered for the person's real need, in one step, without tools.
  ethics = null
} = {}) {
  const value = text(goal);
  if (!value) {
    return {
      contract: CONTRACT,
      state: 'needs-input',
      questions: [
        'What outcome do you want to accomplish?',
        'What would a successful result look like?'
      ]
    };
  }

  const situationContext = {
    user, workspace, project, files, priorWork, constraints, resources,
    requirements, successCriteria, outputs, environment, language,
    skillLevel, preferences, currentState, completedSteps, failedSteps,
    learnedSkills, commitments, dependencies, dueAt, startAt, userBehavior, capacity, availability, competingCommitments, now, creationMode,
    evidence, questions, dataSources, connections, connectedServices, verifiedConnections, privacyConsent, need, adaptiveControl,
    workspaceType, runtimeMode, activeSurface, jurisdiction, blockedTopics, classifierHints, modelSelection,
    // Every attached file is part of the working set; only unreadable ones
    // (in files) need a file tool.
    attachedArtifacts: attachments.map(item => (typeof item === 'string' ? item : item?.name)).filter(Boolean),
    // A classified code project or source file attached makes this code work.
    universalContext,
    attachedCode: attachments.some(item => item && typeof item === 'object'
      && (item.format === 'project' || ATTACHED_CODE.test(String(item.name ?? ''))))
  };
  const policyDecision = evaluatePolicy(policies);
  const analysis = inspectGoal(value, situationContext);

  const universalContext = buildUniversalContextContract({
    goal: value,
    conversationId: conversation?.id ?? null,
    projectId: project?.id ?? project?.projectId ?? null,
    workspaceId: workspace?.id ?? workspace?.workspaceId ?? null,
    principalId: user?.id ?? user?.principalId ?? null,
    organizationId: workspace?.organizationId ?? workspace?.organization_id ?? null,
    crossChatMemory: user?.crossChatMemory === true || user?.settings?.crossChatMemory === true,
    requestedSkills: Array.isArray(preferences?.skills) ? preferences.skills : [],
    candidateSkills: [],
    allowedSkills: Array.isArray(adaptiveControl?.includeSkills) ? adaptiveControl.includeSkills : [],
    deniedSkills: Array.isArray(adaptiveControl?.excludeSkills) ? adaptiveControl.excludeSkills : [],
    maxSkills: 6,
    maxSkillCost: Number(adaptiveControl?.budget?.maxSkillCost ?? 12),
    risk: analysis?.flags?.highImpact ? 'high' : analysis?.flags?.physical ? 'medium' : 'ordinary',
    verificationRequired: false,
    complexity: Number(project ? 0.45 : 0),
    uncertainty: Number(analysis?.unknownSituation ? 0.7 : 0)
  });
  const unifiedWorkContext = buildUnifiedWorkContext({
    goal: value,
    project,
    attachments,
    files,
    projectOverlay: currentState?.adaptation?.projectOverlay ?? [],
    situation: currentState?.situation ?? null,
    currentState
  });

  // Safety is an adaptive invariant, not a prompt instruction. A refusal is
  // terminal for this goal at the planning layer: no capability discovery,
  // execution plan, tool composition or generated workflow is created.
  if (analysis.safety?.decision === 'refuse') {
    const safetyRequirements = discoverCapabilityRequirements(value, analysis);
    const governance = evaluatePolicy(policies);
    const adaptation = resolveAdaptiveContext(value, { ...situationContext, policyDecision });
    // Understood adaptively (the model read the person's situation): still no
    // discovery, tools or execution, only one reasoning reply to the person's
    // real need, then its check. Otherwise the refusal is the fixed message.
    if (ethics?.decision === 'refuse') {
      const reasoningOnly = ['reasoning', 'adaptive-safety-governance', 'verification'];
      const tasks = directTasks({ ethics, verification: verificationContract() });
      adaptation.safetyAdaptive = true;
      return {
        contract: CONTRACT,
        state: nextTask(tasks)?.type ?? 'respond',
        goal: value,
        workflow: 'direct',
        mode: 'safety-adaptive',
        surface: 'chat',
        intent: { kind: 'chat', confidence: 1, signals: ['answer'] },
        capabilities: { required: reasoningOnly, granted: reasoningOnly, blocked: safetyRequirements.map(item => item.id).filter(id => !reasoningOnly.includes(id)), requirements: [] },
        governance,
        situationGovernance: adaptation.governance,
        tasks,
        next: nextTask(tasks)?.id ?? null,
        adaptation,
        safety: analysis.safety,
        principles: PRINCIPLES
      };
    }
    return {
      contract: CONTRACT,
      state: 'blocked',
      goal: value,
      workflow: 'blocked',
      mode: 'safety-blocked',
      surface: adaptation.primarySurface,
      intent: { kind: 'blocked', confidence: 1, signals: [] },
      capabilities: {
        required: safetyRequirements.map(item => item.id),
        granted: [],
        blocked: safetyRequirements.map(item => item.id),
        requirements: safetyRequirements
      },
      governance,
      situationGovernance: adaptation.governance,
      tasks: [],
      next: null,
      adaptation,
      safety: analysis.safety,
      reason: analysis.safety.message,
      alternatives: analysis.safety.alternatives ?? [],
      principles: PRINCIPLES
    };
  }

  // Too little to act on: ask, rather than investigate a guess. Unfamiliar
  // text with some substance still goes to discovery.
  const hasContext = [files, priorWork, successCriteria, outputs, completedSteps, failedSteps, conversation, attachments]
    .some(item => Array.isArray(item) && item.length > 0);
  const words = value.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  // Greetings and thanks are conversation, answered like any chat message.
  const smallTalk = SMALL_TALK.test(value);
  const declined = ethics?.decision === 'refuse';
  // A two-word message is judged on its words: a model's generic reading
  // ("answer" at low confidence) of "Help." is not something to act on.
  const wordActions = words.length < 3 ? compileGoalModel(value).actions : [];
  if (words.length < 3 && !smallTalk && !declined && !wordActions.length && !hasContext && !analysis.flags?.crisis
      && (!classifierHints || !(classifierHints.actions ?? []).some(action => action !== 'answer') || Number(classifierHints.confidence) < 0.7)) {
    return {
      contract: CONTRACT,
      state: 'needs-input',
      questions: [
        'What would you like help with?',
        'What would a good result look like for you?'
      ]
    };
  }

  const intent = smallTalk ? { kind: 'chat', confidence: 1, signals: ['answer'] } : classifyIntent(value, situationContext);
  const surfaceBoundary = classifySurfaceBoundary(value, { activeSurface, attachments, flags: analysis.flags, actions: analysis.goalModel?.actions ?? [] });
  const discovered = discoverCapabilityRequirements(value, analysis);
  // Adapt to what this deployment can really run. A run that needs a missing
  // runner would stop at a step that can never finish; instead the work is
  // done as code and instructions, and the limitation is stated.
  const notAvailableHere = [];
  let capabilityRequirements = discovered;
  // The workspace boundary is not an intelligence boundary. All three
  // workspaces use the same adaptive capability compiler and agentic control
  // loop; Code/Research simply provide specialized context when selected.
  // Normal Chat may therefore retain any justified capability when the
  // situation requires it rather than being artificially downgraded.
  if (executionAvailable?.code === false && capabilityRequirements.some(item => item.id === 'code-execution')) {
    capabilityRequirements = capabilityRequirements.filter(item => item.id !== 'code-execution');
    notAvailableHere.push('code-execution');
  }
  const governance = policyDecision;
  const adaptive = resolveAdaptiveContext(value, { ...situationContext, modelSelection, policyDecision });
  // What this deployment substitutes stays in scope: without it the person
  // would get neither the run nor its replacement.
  const substitutes = capabilityRequirements.filter(item => !discovered.some(found => found.id === item.id)).map(item => item.id);
  const scopedRequirementIds = new Set([...(adaptive.requirements ?? capabilityRequirements.map(item => item.id)), ...substitutes]);
  const scopedRequirements = capabilityRequirements.filter(requirement => scopedRequirementIds.has(requirement.id));
  // Policy is evaluated only against the user's selected working set. Scope
  // omissions are not policy denials; they remain expansion candidates.
  const grantedRequirements = scopedRequirements.filter(requirement =>
    policyAllows(governance, {
      capability: requirement.id,
      risk: requirement.risk,
      dataClass: requirement.dataClasses?.[0] ?? ''
    })
  );
  const policyBlocked = scopedRequirements
    .filter(requirement => !grantedRequirements.some(item => item.id === requirement.id))
    .map(item => item.id);
  const blocked = [...new Set(policyBlocked)];
  // What the person's scope left out: reported, not blocked, so it can be
  // offered as an expansion.
  const scopeOmitted = [...new Set((adaptive.omittedRequirements ?? []).map(text).filter(Boolean))];
  const granted = grantedRequirements.map(item => item.id);
  const executionRequired = granted.some(item =>
    ['code-execution', 'adaptive-execution', 'external-data-routing', 'evidence-retrieval', 'file-analysis'].includes(item)
  );
  // Writing, rewriting and translating need only the model: they get the
  // short path too, unless files, code or real-world stakes are involved.
  // (Composing the answer is the system's own work, not a tool.)
  const writing = WRITING.test(value)
    && !attachments.length && !files.length
    && analysis.flags?.code !== true
    && analysis.flags?.highImpact !== true
    && capabilityRequirements.every(item => BUILT_IN.includes(item.id) || item.id === 'design');
  // A letter or post about physical work is still only writing.
  const writingDocument = writing;
  // A question about physical things ("how many amps does a kettle draw")
  // is answered and checked with physical care, but it takes no action in
  // the world, so there is nothing to approve.
  const goalActions = analysis.goalModel?.actions ?? [];
  const physicalQuestion = analysis.flags?.physical === true && analysis.flags?.highImpact !== true
    && goalActions.length > 0 && goalActions.every(action => action === 'answer')
    && capabilityRequirements.every(item => BUILT_IN.includes(item.id));
  const noPhysicalAction = writingDocument || physicalQuestion;
  const crisis = analysis.flags?.crisis === true;
  // A letter or post about physical work is only writing: it takes no
  // real-world action, so that governance reason does not apply to it.
  const governanceReasons = (adaptive.governance?.execution?.approvalReasons ?? [])
    .filter(reason => !(noPhysicalAction && reason === 'physical or real-world action'));
  const approvalReasonsList = crisis ? [] : approvalReasons({
    governanceRequired: governance.constraints.requireHumanApproval || governanceReasons.length > 0,
    execution: executionRequired,
    highImpact: analysis.flags?.highImpact === true,
    physical: analysis.flags?.physical === true && !noPhysicalAction
  }).concat(governanceReasons);
  const dedupedApprovalReasons = [...new Set(approvalReasonsList.filter(Boolean))];
  // A person certifies work that acts in the physical world; an answer to a
  // question about it is checked against its evidence like any answer.
  const verification = verificationContract({
    physical: analysis.flags?.physical === true && !noPhysicalAction,
    highImpact: analysis.flags?.highImpact === true,
    capabilitySpecs: capabilityRequirements.filter(item => item.dynamic)
  });
  const situation = analysis.situation ?? {};
  const reminder = SCHEDULING.test(value) && !attachments.length && !files.length
    && !['coding', 'invention'].includes(intent.kind) && analysis.flags?.highImpact !== true;
  // A person in crisis gets an immediate answer, whatever else applies.
  const normalChatBounded = surfaceBoundary.surface === 'normal-chat'
    && analysis.flags?.code !== true
    && !surfaceBoundary.redirect
    && analysis.flags?.highImpact !== true
    && analysis.situation?.clarificationRequired !== true
    && analysis.situation?.externalData?.hasExternalDataNeed !== true
    && (analysis.flags?.physical !== true || noPhysicalAction);
  // Normal Chat is the universal surface, not a bypass around the adaptive
  // workflow. Creation, investigation, execution, modeling, invention,
  // attachments and project context are still real work and enter the same
  // server-owned step lifecycle. Only an unscoped conversational request is
  // allowed to take the lightweight direct path.
  const workActions = new Set(['investigate', 'create', 'transform', 'execute', 'model', 'invent', 'discover']);
  const hasRealWork = (analysis.goalModel?.actions ?? []).some(action => workActions.has(action))
    || attachments.length > 0
    || files.length > 0
    || project != null;
  const directConversation = normalChatBounded && !hasRealWork;
  const direct = crisis
    || declined
    || writingDocument
    || ((smallTalk || reminder) && !attachments.length)
    || directConversation;
  const scale = direct ? 'single' : workScale({
    capabilities: granted,
    unknownSituation: analysis.unknownSituation === true,
    clarification: situation.clarificationRequired === true,
    investigation: analysis.investigationNeeded === true,
    depth: classifierHints?.need?.depth ?? '',
    attachments: attachments.length + files.length,
    highImpact: analysis.flags?.highImpact === true,
    physical: analysis.flags?.physical === true && !writingDocument,
    broad: BROAD_WORK.test(value) || value.split(/\s+/).length > 40
      || value.split(/[,;]|\band\b|\bwith\b|\bplus\b/i).filter(part => part.trim().split(/\s+/).length >= 2).length >= 4
  });
  const baseUnifiedIntelligence = buildUnifiedAdaptiveIntelligence(value, {
    analysis,
    files,
    attachments,
    conversation,
    priorWork,
    project,
    workspace,
    currentState,
    successCriteria,
    constraints,
    activeSurface,
    executionAvailable
  });
  const skillTaskType = intent.kind === 'coding' ? 'build-code' : intent.kind === 'discovery' ? 'investigate' : intent.kind === 'chat' ? 'respond' : 'plan';
  const selectedSkills = selectSkillDescriptors(value, {
    taskType: skillTaskType,
    intent: intent.kind,
    capabilities: granted,
    limit: 6,
    learnedSkills,
    skillLevel,
    preferences,
    situation
  });
  universalContext.skills = {
    ...universalContext.skills,
    candidateSkills: selectedSkills.map(skill => skill.name),
    selectionMode: 'adaptive'
  };

  const skillPlan = skillPlanForSelectedSkills(selectedSkills, { taskType: skillTaskType, maxSkills: 8, maxCost: Number(adaptiveControl?.budget?.maxSkillCost ?? 12) });
  const skillLearning = summarizeSkillLearning(selectedSkills);
  const skillPatternContext = skillContextSignature({
    goal: value,
    taskType: skillTaskType,
    intent: intent.kind,
    coding: analysis.flags?.code === true,
    projectWork: Boolean(project || files.length > 1 || attachments.length > 1),
    unknown: analysis.unknownSituation === true,
    complexity: Number(baseUnifiedIntelligence?.complexity ?? 0),
    scale: baseUnifiedIntelligence?.scale ?? '',
    retrying: failedSteps.length > 0,
    verification: verification.required === true,
    language
  });

  const learningCaution = skillLearning.experienced && skillLearning.reliability < 0.58;
  const unifiedIntelligence = {
    ...baseUnifiedIntelligence,
    learning: {
      ...skillLearning,
      caution: learningCaution
    },
    patternContext: skillPatternContext,
    reasoning: {
      ...baseUnifiedIntelligence.reasoning,
      depth: learningCaution && baseUnifiedIntelligence.reasoning.depth === 'focused'
        ? 'structured'
        : baseUnifiedIntelligence.reasoning.depth,
      verification: learningCaution ? 'strong' : baseUnifiedIntelligence.reasoning.verification,
      evidenceRequired: baseUnifiedIntelligence.reasoning.evidenceRequired || learningCaution
    },
    verification: learningCaution
      ? {
          ...baseUnifiedIntelligence.verification,
          stages: [...new Set([...(baseUnifiedIntelligence.verification?.stages ?? []), 'learned-skill-recheck'])],
          drivenBy: { ...(baseUnifiedIntelligence.verification?.drivenBy ?? {}), learnedSkillCaution: true }
        }
      : baseUnifiedIntelligence.verification
  };


  const tasks = buildTasks(
    intent,
    granted,
    dedupedApprovalReasons.length > 0,
    {
      ...analysis,
      direct,
      scale,
      crisis,
      writing: writing && !crisis && !declined,
      reminder: reminder && !crisis && !declined,
      // Greetings, thanks, and replies the model reads as pure conversation.
      conversational: direct && !crisis && !declined && !reminder && !attachments.length
        && (smallTalk || classifierHints?.need?.form === 'conversation')
        && (situation.risk ?? 'ordinary') === 'ordinary' && ethics?.decision !== 'care',
      ethics: crisis ? null : ethics,
      openWorld: true,
      approvalReasons: dedupedApprovalReasons,
      workflowBlueprint: adaptive.workflowBlueprint ?? null,
      resourcePlan: adaptive.resourcePlan ?? null,
      verification,
      unifiedIntelligence,
      intelligenceDepth: unifiedIntelligence.reasoning.depth
    }
  );

  return {
    contract: CONTRACT,
    state: blocked.length ? 'blocked' : nextTask(tasks)?.type ?? 'understand',
    goal: value,
    intent,
    workflow: direct ? 'direct' : 'full',
    mode: intent.kind === 'invention' || intent.kind === 'creation'
      ? 'creation'
      : analysis.unknownSituation ? 'adaptive-open-world' : 'adaptive',
    surface: adaptive.primarySurface,
    surfacePolicy: surfaceRuntimePolicy(adaptive.primarySurface),
    workspaceContract: surfaceBoundary.workspace ?? surfaceRuntimePolicy(adaptive.primarySurface).contract ?? null,
    universalContext,
    surfaceBoundary,
    capabilities: {
      required: scopedRequirements.map(item => item.id),
      granted,
      blocked,
      requirements: scopedRequirements,
      omittedByUserScope: scopeOmitted
    },
    governance,
    situationGovernance: adaptive.governance,
    tasks,
    next: blocked.length ? null : nextTask(tasks)?.id ?? null,
    principles: PRINCIPLES,
    adaptation: {
       ...adaptive,
       scale,
       unifiedWorkContext,
       learning: {
         ...skillLearning,
         patternContext: skillPatternContext
       },
       skillPlan,
       skills: selectedSkills.map(item => ({
         name: item.name,
         version: item.version,
         description: item.description,
         ...(item.learning ? { learning: item.learning } : {}),
         progressiveDisclosure: true
       })),
       parallel: parallelDecision({ mode: adaptiveControl?.parallelMode ?? adaptiveControl?.parallel ?? 'auto', pressure: Number(unifiedIntelligence.complexity) || 0, concurrencyOpportunity: unifiedIntelligence.scale === 'large-project' ? 0.9 : unifiedIntelligence.scale === 'complex' ? 0.7 : unifiedIntelligence.scale === 'multi-file' ? 0.45 : 0, risk: analysis.situation?.risk ?? 'ordinary', maxParallel: adaptiveControl?.maxParallel ?? adaptiveControl?.multiAgentMaxAgents ?? 4, itemCount: Math.max(1, tasks.length), explicit: adaptiveControl?.parallelMode === 'always' }), ...(notAvailableHere.length ? { notAvailableHere } : {}), ...(analysis.ownWork ? { ownWork: true } : {}) },
    intelligence: unifiedIntelligence,
    execution: {
      targets: adaptive.execution?.targets ?? [],
      targetCatalog: adaptive.execution?.targetCatalog ?? [],
      approvalRequired: dedupedApprovalReasons.length > 0,
      approvalReasons: dedupedApprovalReasons,
      policyControlled: true,
      localExecutionRule: 'Local execution is eligible only after exact local-agent preflight and explicit human approval.',
      cloudFallbackRule: 'A cloud fallback is a new execution decision and always requires explicit approval.'
    },
    situation: adaptive.situation,
    clarification: {
      required: adaptive.situation?.clarificationRequired === true,
      questions: adaptive.situation?.clarificationQuestions ?? []
    },
    resourceScope: adaptive.resourcePlan ?? null,
    scopeStatus: adaptive.resourcePlan?.expansion?.needed ? 'expansion-available' : 'within-scope',
    capabilityInvestment: adaptive.resourcePlan?.implementation?.investment ?? null,
    context: {
      activeSurface: adaptive.primarySurface,
      timeZone: text(timeZone) || 'UTC',
      workspaceType: adaptive.workspaceType,
      jurisdiction: adaptive.jurisdiction,
      runtimeMode: adaptive.runtime.mode
    }
  };
}

/**
 * Runtime adaptive controller.
 *
 * The planner creates only the current step. After a step completes, this
 * controller evaluates newly observed evidence/state and creates exactly one
 * next step. The next step is selected from the unified intelligence gates,
 * rather than from a precomputed task list.
 */
const ADAPTIVE_STAGES = Object.freeze([
  'understand', 'model-situation', 'investigate', 'reason', 'challenge',
  'decide', 'plan', 'execute', 'observe', 'verify', 'replan', 'deliver'
]);

const STAGE_REQUIREMENTS = Object.freeze({
  understand: ['reasoning', 'situation-understanding'],
  'model-situation': ['situation-understanding'],
  investigate: ['context-retrieval'],
  reason: ['reasoning', 'goal-understanding'],
  challenge: ['assumption-challenge'],
  decide: ['adaptive-decisioning'],
  plan: ['planning'],
  execute: ['sandbox-execution'],
  observe: ['situation-understanding', 'reasoning'],
  verify: ['verification'],
  replan: ['adaptive-decisioning', 'planning'],
  deliver: ['reasoning', 'verification']
});

function adaptiveNextStage(current, options = {}) {
  return nextAdaptiveStage(current, options);
}

function makeAdaptiveTask(stage, previous, {
  intelligence = null,
  reason = '',
  evidence = [],
  successCriteria = [],
  metadata = {}
} = {}) {
  return makeTask(
    stage,
    stage,
    previous ? [previous.id] : [],
    STAGE_REQUIREMENTS[stage] ?? ['reasoning'],
    reason || ('Continue the adaptive workflow at the ' + stage + ' stage using the current situation and evidence.'),
    {
      adaptiveStep: true,
      stage,
      previousStage: previous?.type ?? null,
      intelligence,
      evidence,
      successCriteria,
      ...metadata
    }
  );
}

/**
 * Runtime counterpart to buildUnifiedAdaptiveIntelligence().
 *
 * Callers feed newly observed evidence, changed requirements, verification
 * results, or execution state back into this controller. It materializes one
 * next step and can reopen reasoning when the situation materially changes.
 */
export function advanceAdaptiveWorkflow(tasks, taskId, {
  status = 'complete',
  situation = {},
  intelligence = null,
  successCriteria = [],
  executionRequired = false,
  needsInvestigation = false,
  verificationFailed = false,
  materialChange = false,
  verified = false,
  observationAvailable = false,
  verificationEvidenceAvailable = false,
  blocked = false
} = {}) {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const target = byId.get(text(taskId));
  if (!target) return { ok: false, reason: 'unknown-task', message: 'Unknown workflow task' };
  if (target.status === 'complete') return { ok: false, reason: 'already-complete', message: 'Task ' + target.id + ' is already complete' };
  if (target.status === 'skipped') return { ok: false, reason: 'skipped', message: 'Task ' + target.id + ' was skipped as not needed' };

  const unmet = (target.dependsOn ?? []).filter(id => !isDone(byId.get(id)));
  if (unmet.length) {
    return {
      ok: false,
      reason: 'unmet-dependencies',
      message: 'Task ' + target.id + ' depends on incomplete work: ' + unmet.join(', '),
      unmet
    };
  }

  const applied = tasks.map(item => item.id === target.id ? {
    ...item,
    status,
    metadata: {
      ...item.metadata,
      completedSituation: situation,
      completionStatus: status
    }
  } : item);

  if (status === 'failed') {
    const retry = makeAdaptiveTask('replan', target, {
      intelligence,
      evidence: situation.evidence ?? [],
      successCriteria,
      reason: 'The previous step failed. Reopen reasoning, challenge the failed assumption and choose a new strategy before retrying.',
      metadata: {
        trigger: 'failure',
        failure: situation.failure ?? null,
        failureDiagnosis: situation.failureDiagnosis ?? intelligence?.failureDiagnosis ?? intelligence?.metaReasoning?.failureDiagnosis ?? null,
        hypothesisSpace: situation.failureDiagnosis?.hypotheses ?? intelligence?.failureDiagnosis?.hypotheses ?? [],
        nextDiscriminatingTest: situation.failureDiagnosis?.nextDiscriminatingTest ?? intelligence?.failureDiagnosis?.nextDiscriminatingTest ?? null,
        materialChange: true
      }
    });
    return { ok: true, status, tasks: [...applied, retry], next: retry.id, state: retry.type };
  }

  const adaptiveProfile = intelligence?.reasoning ?? {};
  const nextStage = adaptiveNextStage(target.type, {
    verificationFailed: verificationFailed || situation.verificationFailed === true,
    materialChange: materialChange || situation.materialChange === true,
    needsInvestigation: needsInvestigation || situation.needsInvestigation === true,
    executionRequired: executionRequired || situation.executionRequired === true,
    observationAvailable: observationAvailable || situation.observationAvailable === true,
    verificationEvidenceAvailable: verificationEvidenceAvailable || situation.verificationEvidenceAvailable === true || situation.evidence?.verification != null,
    verified: verified || situation.verified === true,
    blocked: blocked || situation.blocked === true,
    depth: adaptiveProfile.depth ?? 'full',
    coding: intelligence?.coding === true,
    research: intelligence?.surface === 'research'
      || intelligence?.research === true
      || situation?.research === true,
    situation
  });

  if (!nextStage) return { ok: true, status, tasks: applied, next: null, state: 'complete' };

  const next = makeAdaptiveTask(nextStage, target, {
    intelligence,
    evidence: situation.evidence ?? [],
    successCriteria,
    reason: nextStage === 'replan'
      ? 'Material change or verification failure reopened the adaptive control loop.'
      : '',
    metadata: {
      trigger: verificationFailed || materialChange ? 'material-change-or-verification-failure' : 'normal-control-loop',
      situationDelta: situation.delta ?? null
    }
  });

  return {
    ok: true,
    status,
    tasks: [...applied, next],
    next: next.id,
    state: next.type,
    adaptive: {
      stage: nextStage,
      stages: ADAPTIVE_STAGES,
      replanned: nextStage === 'replan',
      reason: next.purpose
    }
  };
}

/**
 * The one step decision the run engine uses: check the step may run now,
 * apply its outcome, and name what the server-owned graph does next. It
 * never invents future steps; the engine grows the graph from evidence.
 */
export function decideAdvance(tasks, taskId, { status = 'complete' } = {}) {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const target = byId.get(text(taskId));
  if (!target) return { ok: false, reason: 'unknown-task', message: 'Unknown workflow task' };
  if (target.status === 'complete') {
    return { ok: false, reason: 'already-complete', message: 'Task ' + target.id + ' is already complete' };
  }
  if (target.status === 'skipped') {
    return { ok: false, reason: 'skipped', message: 'Task ' + target.id + ' was skipped as not needed' };
  }
  const unmet = (target.dependsOn ?? []).filter(id => !isDone(byId.get(id)));
  if (unmet.length) {
    return {
      ok: false,
      reason: 'unmet-dependencies',
      message: 'Task ' + target.id + ' depends on incomplete work: ' + unmet.join(', '),
      unmet
    };
  }
  const applied = tasks.map(item => item.id === target.id ? { ...item, status } : item);
  if (status === 'failed') return { ok: true, status, tasks: applied, next: null, state: 'iterate' };
  const next = nextTask(applied);
  return { ok: true, status, tasks: applied, next: next?.id ?? null, state: next?.type ?? 'complete' };
}
