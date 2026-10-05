/**
 * Open-world adaptation.
 *
 * Native capabilities are bootstrap primitives, not a closed universe.
 * A goal can be known, unfamiliar, compound, or genuinely novel. The
 * adaptation layer describes what appears necessary now and marks unknown
 * needs as discoverable so the workflow can investigate and create a
 * capability specification without adding a new domain engine.
 */

import { executionTargetCatalog, executionTargetsFor } from './execution.js';
import { compileCapabilityImplementations } from './capability-compiler.js';
import { capabilityImplementationProposal } from './capability-lifecycle.js';
import { buildAdaptiveSnapshot, ADAPTIVE_CONTRACT_VERSION, ADAPTATION_INVARIANT } from './adaptive-contract.js';
import { evaluateAdaptiveSafety, ADAPTIVE_SAFETY_CONTRACT_VERSION } from './adaptive-safety.js';
import { evaluateSituationGovernance } from './situation-governance.js';
import {
  buildSituationModel,
  mergeSituationEvidence,
  evolveSituation,
  situationQualityGate
} from './situation.js';
import {
  externalConnectorCatalog,
  buildExternalDataPlan,
  resolveExternalDataNeeds
} from './connectors.js';
import {
  CAPABILITY_SCHEMA_VERSION,
  normalizeCapabilitySpec,
  verificationContract
} from './capabilities.js';
import {
  normalizeAdaptiveControl,
  planAdaptiveResources,
  adaptiveScopeForNextStep
} from './adaptive-control.js';
import { selectAdaptiveWorkflow } from './unified-adaptive-workflow.js';
import { adaptiveEffortProfile } from './adaptive-efficiency.js';
import { classifySurfaceBoundary, surfaceRuntimePolicy } from './surface-policy.js';

const text = value => String(value ?? '').trim();

function contextRuntimeList(context) {
  const env = context?.environment;
  if (Array.isArray(context?.runtimes)) return context.runtimes;
  if (env && Array.isArray(env.runtimes)) return env.runtimes;
  return [];
}

const GOAL_MODEL_SCHEMA_VERSION = '1';
const GENERIC_ACTIONS = Object.freeze({
  // A question is a request for an answer, whatever its first word.
  // Everyday asks are answers too: "tell me a joke", "suggest names", "help me negotiate".
  // Working a problem out is an answer too: solve, calculate, prove, show the steps.
  answer: /\b(explain|describe|clarify|teach|answer|summari[sz]e|define|what|why|how|which|who|when|where|tell me|give me|suggest\w*|recommend\w*|advi[sc]e|help me|tips?|ideas?|recipes?|jokes?|opinion|solve|calculate|work out|prove|derive|factori[sz]e|differentiate|show (?:me )?(?:the )?(?:steps|working|work))\b|\?\s*$/i,
  investigate: /\b(research|investigat|analy[sz]e|compare|assess|evaluate|study|review|find|search|survey|audit|latest)\w*\b/i,
  // Verb inflections only: a bare \w* suffix turns nouns such as
  // "transformer", "runner" or "builder" into requested actions.
  create: /\b(creat(?:e|es|ed|ing)|mak(?:e|es|ing)|made|plan(?:s|ned|ning)?|organi[sz](?:e|es|ed|ing)|schedul(?:e|es|ed|ing)|build(?:s|ing)?|built|design(?:s|ed|ing)?|draft(?:s|ed|ing)?|generat(?:e|es|ed|ing)|develop(?:s|ed|ing)?|produc(?:e|es|ed|ing)|writ(?:e|es|ing)|wrote|written|compos(?:e|es|ed|ing)|prototyp(?:e|es|ed|ing)|architect(?:s|ed|ing)?)\b/i,
  // Also changing something in place: implement, integrate, simplify.
  transform: /\b(implement(?:s|ed|ing)?|integrat(?:e|es|ed|ing)|simplif(?:y|ies|ied|ying)|debug(?:s|ged|ging)?|fix(?:es|ed|ing)?|troubleshoot(?:s|ed|ing)?|repair(?:s|ed|ing)?|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|convert(?:s|ed|ing)?|translat(?:e|es|ed|ing)|rewrit(?:e|es|ing|ten)|rewrote|refactor(?:s|ed|ing)?|migrat(?:e|es|ed|ing)|optimi[sz](?:e|es|ed|ing)|clean(?:s|ed|ing)?|format(?:s|ted|ting)?|transform(?:s|ed|ing)?)\b/i,
  // A machine that runs for hours is not code to run.
  execute: /\b(run(?:s|ning)?(?!\s+(?:for|on|at|every|daily|all|about|around|\d))|ran|execut(?:e|es|ed|ing)|simulat(?:e|es|ed|ing)|emulat(?:e|es|ed|ing)|test(?:s|ed|ing)?|deploy(?:s|ed|ing)?|install(?:s|ed|ing)?|launch(?:es|ed|ing)?|automat(?:e|es|ed|ing)|monitor(?:s|ed|ing)?|operat(?:e|es|ed|ing))\b/i,
  // Working out what happens over time or under what-if conditions: by
  // reasoning, or as code when it is to be computed.
  model: /\b(model(?:s|led|ling|ing)?|what[- ]if|forecast(?:s|ed|ing)?|projection)\b/i,
  invent: /\b(invent|novel|new solution|new mechanism|from scratch|never existed|not yet exist)\b/i,
  discover: /\b(discover|explore|figure out|unknown|unfamiliar|uncertain|open[- ]ended|ambiguous|no idea|unseen)\b/i
});

function goalWords(value) {
  return text(value).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

export function compileGoalModel(goal, context = {}) {
  const value = text(goal);
  const actions = Object.entries(GENERIC_ACTIONS)
    .filter(([, pattern]) => pattern.test(value))
    .map(([name]) => name);
  const explicitUnknown = /\b(unknown|uncertain|unfamiliar|unseen|open[- ]ended|never existed|not yet exist|from scratch)\b/i.test(value);
  const novelty = /\b(invent|novel|new mechanism|new system|new solution|breakthrough|unprecedented)\b/i.test(value);
  const multiAction = actions.length > 1;
  // A generic verb ("make", "do") with an outcome the user cannot yet name is
  // still an unresolved domain: the required approach is itself unknown.
  const vagueOutcome = /\b(whatever|however (?:it|this) (?:is|needs to be)|somehow|in any way|any way (?:that|you))\b/i.test(value);
  const domainUnrecognized = actions.length === 0 || vagueOutcome;
  const uncertainty = explicitUnknown || novelty ? 0.9 : domainUnrecognized ? 0.65 : multiAction ? 0.45 : 0.2;
  const unknownSituation = explicitUnknown || novelty || domainUnrecognized;
  // Several verbs ("write and run") make a goal compound, not uncertain;
  // composition handles that without an extra research stage.
  const investigationNeeded = actions.includes('investigate')
    || actions.includes('discover')
    // Length is not a need for evidence: a long, detailed message usually
    // gives the facts rather than asking for them.
    || unknownSituation;
  const requestedCapabilities = [];
  if (actions.includes('answer')) requestedCapabilities.push('response');
  if (actions.includes('investigate')) requestedCapabilities.push('evidence-retrieval');
  if (actions.includes('create')) requestedCapabilities.push('artifact-creation');
  if (actions.includes('transform')) requestedCapabilities.push('artifact-transformation');
  if (actions.includes('execute')) requestedCapabilities.push('execution');
  if (actions.includes('model')) requestedCapabilities.push('modeling');
  if (actions.includes('invent')) requestedCapabilities.push('innovation');
  if (unknownSituation) requestedCapabilities.push('capability-discovery');
  return {
    schemaVersion: GOAL_MODEL_SCHEMA_VERSION,
    goal: value,
    context: context && typeof context === 'object' ? context : {},
    actions,
    outcome: value || 'No goal supplied',
    openWorld: true,
    known: !unknownSituation,
    unknownSituation,
    investigationNeeded,
    uncertainty,
    confidence: Math.max(0, 1 - uncertainty),
    compound: multiAction,
    requestedCapabilities: [...new Set(requestedCapabilities)],
    resolution: domainUnrecognized ? 'unresolved-domain' : multiAction ? 'compound' : 'direct'
  };
}


export const NATIVE_CAPABILITY_DEFINITIONS = Object.freeze([
  { name: 'reasoning', category: 'intelligence', source: 'native', risk: 'low' },
  { name: 'situation-understanding', category: 'adaptation', source: 'native', risk: 'low' },
  { name: 'adaptive-safety-governance', category: 'governance', source: 'native', risk: 'low' },
  { name: 'capability-compilation', category: 'adaptation', source: 'native', risk: 'low' },
  { name: 'planning', category: 'orchestration', source: 'native', risk: 'low' },
  { name: 'verification', category: 'quality', source: 'native', risk: 'low' },
  { name: 'iteration', category: 'orchestration', source: 'native', risk: 'low' },
  { name: 'code-generation', category: 'creation', source: 'native', risk: 'medium' },
  { name: 'code-execution', category: 'execution', source: 'native', risk: 'high' },
  { name: 'design', category: 'creation', source: 'native', risk: 'medium' },
  { name: 'invention', category: 'creation', source: 'native', risk: 'medium' },
  { name: 'hypothesis-generation', category: 'invention', source: 'native', risk: 'low' },
  { name: 'concept-evaluation', category: 'invention', source: 'native', risk: 'medium' },
  { name: 'experiment-design', category: 'invention', source: 'native', risk: 'medium' },
  { name: 'file-analysis', category: 'workspace', source: 'native', risk: 'medium' },
  { name: 'web-research', category: 'investigation', source: 'discoverable', risk: 'medium' },
  { name: 'adaptive-composition', category: 'adaptation', source: 'native', risk: 'medium' }
]);

// Compatibility exports: these are the native bootstrap primitives only.
export const CAPABILITY_DEFINITIONS = NATIVE_CAPABILITY_DEFINITIONS;
export const CAPABILITIES = Object.freeze(CAPABILITY_DEFINITIONS.map(item => item.name));
export const SURFACES = Object.freeze([
  'chat', 'research', 'code', 'creation', 'workspace'
]);


const PATTERNS = Object.freeze({
  // Facts that change (today's prices, rates, news, weather, scores) need the web.
  research: /\b(research\w*|investigat\w*|sources?|papers?|evidence|literature|survey|state of the art|latest|compare|references?)\b|\b(?:prices?|rates?|news|weather|forecast|scores?|stocks?|shares?)\b[^.?!]{0,40}\b(?:today|now|currently|this week|right now)\b|\b(?:today'?s|current|live|latest)\s+(?:\w+\s+)?(?:prices?|rates?|news|weather|forecast|scores?)\b/i,
  file: /\b(files?|documents?|pdfs?|images?|datasets?|spreadsheets?|csv|upload\w*|attachments?)\b/i,
  // Also a named source file (invoice.py, main.go, lib.rs), unit tests, or C++.
  code: /\b(code|coding|program\w*|scripts?|software|apps?|apis?|debug\w*|compil\w*|refactor\w*|repositor\w*|repos?|javascript|typescript|python|rust|golang|java|sql|computational models?|numerical models?|the bugs?|bugs? in|failing tests?|tests? (?:fail|pass)\w*|test suite|tracebacks?|stack ?traces?|simulations?|simulat(?:e|es|ed|ing)|monte carlo|netlists?|spice|ltspice|ngspice|simulink|modelica|freecad|openscad|unit tests?|website|websites|web app|web apps|webpage|webpages|frontend|front-end|landing page|landing pages)\b|\b[\w-]+\.(py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|c|cc|cpp|hpp|h|html|css|mo|slx|mdl|cir|asc|scad|fcstd)\b|c\+\+/i,
  creation: /\b(creat\w*|design\w*|build\w*|prototyp\w*|engineer\w*|architect\w*|develop\w*|draft\w*)\b/i,
  invention: /\b(invent\w*|novel|unprecedented|from scratch|new mechanism|new system|unknown problem|unfamiliar problem|never existed|not yet exist\w*|not known)\b/i,
  uncertainty: /\b(unknown|uncertain|unfamiliar|not sure|explore|discover|figure out|no idea|unseen|open[- ]ended|ambiguous)\b/i,
  physical: /\b(physical|hardware|machine|device|factory|industrial|robot|vehicle|building|laboratory|lab|fabricat\w*|manufactur\w*)\b/i,
  highImpact: /\b(medical|clinical|diagnos\w*|patient|symptoms?|medications?|medicine|dos(?:e|age)|pregnan\w*|illness|disease|injur(?:y|ies)|rash|mole|tumou?r|cancer|mental health|safety[- ]critical|legal|court|contracts?|lease|evict\w*|security deposit|tenan(?:t|cy) rights|landlords? (?:kept|keeps|won'?t|refus\w*|is (?:suing|threatening))|employer|unfair dismissal|wrongful\w*|police|arrest\w*|scam\w*|fraud\w*|inheritance|lawsuit|sue|lawyer|attorney|visa|immigration|custody|divorce|financial|payment|wire|invest\w*|loans?|mortgage|crypto\w*|tax(?:es)?|pension|chemical|hazard\w*|security[- ]critical|wiring|rewir\w*|cable siz\w*|circuit breakers?|mains (?:power|voltage|supply))\b/i
});

// "Code" that is a rulebook or an identifier, not software: the National
// Electrical Code, a building code, a postal code, a code of conduct.
const NOT_SOFTWARE_CODE = /\b(?:electrical|electric|building|fire|plumbing|grid|wiring|penal|civil|criminal|tax|zip|postal|post|dress|country|area|dialling|dialing|qr|bar|colou?r|morse|genetic|safety|highway|traffic|health|labou?r|commercial|legal|discount|promo|coupon|voucher)\s+codes?\b|\bcodes? of (?:conduct|practice|ethics)\b/gi;

function flags(goal) {
  const value = text(goal);
  return Object.fromEntries(
    Object.entries(PATTERNS).map(([name, pattern]) => [name, pattern.test(name === 'code' ? value.replace(NOT_SOFTWARE_CODE, ' ') : value)])
  );
}

/**
 * Replace keyword readings with validated model classifier hints. Risk only
 * escalates: a physical or high-impact reading from either source stands.
 */
function applyClassifierHints(value, model, signal, hints) {
  if (!hints) return { model, signal, source: 'keywords' };
  const actions = hints.actions;
  const unresolved = actions.length === 0;
  const unknownSituation = hints.unknownSituation || unresolved;
  const compound = actions.length > 1;
  return {
    source: 'model',
    signal: {
      ...hints.signals,
      physical: hints.signals.physical || signal.physical,
      highImpact: hints.signals.highImpact || signal.highImpact
    },
    model: {
      ...model,
      actions,
      ...(hints.need ? { need: hints.need } : {}),
      known: !unknownSituation,
      unknownSituation,
      compound,
      investigationNeeded: actions.includes('investigate') || actions.includes('discover')
        || unknownSituation,
      uncertainty: unknownSituation ? 0.8 : Math.max(0.1, 1 - hints.confidence),
      confidence: hints.confidence,
      resolution: unresolved ? 'unresolved-domain' : compound ? 'compound' : 'direct'
    }
  };
}

export function inspectGoal(goal, context = {}) {
  const value = text(goal);
  const situation = buildSituationModel(value, context);
  const safety = evaluateAdaptiveSafety(value, {
    blockedTopics: Array.isArray(context?.blockedTopics) ? context.blockedTopics : [],
    classifierHints: context?.classifierHints ?? null
  });
  const classified = applyClassifierHints(
    value,
    compileGoalModel(value, { ...context, situation }),
    flags(value),
    context.classifierHints ?? null
  );
  const signal = classified.signal;
  const model = classified.model;
  const positive = Object.values(signal).filter(Boolean).length;
  const tokenCount = goalWords(value).length;
  const effort = adaptiveEffortProfile({
    complexity: Math.min(1, positive / 5 + (tokenCount >= 40 ? 0.25 : 0) + (model.compound ? 0.2 : 0)),
    uncertainty: Math.max(model.uncertainty, 1 - situation.confidence, signal.uncertainty || signal.invention ? 0.8 : 0),
    risk: signal.highImpact || signal.physical ? 'high' : 'medium'
  });
  // Work on the person's own files or code (fix, change, run, extend them)
  // needs those files, not the web, unless the wording asks for research.
  const attachedCode = context.attachedCode === true;
  const ownWork = (attachedCode || (situation.artifacts?.length ?? 0) > 0)
    && ['transform', 'execute', 'create'].some(action => model.actions.includes(action))
    // The wording decides: a model reading "find the bugs" as research does
    // not send work on the person's own code to the web.
    && !PATTERNS.research.test(value)
    // High-impact work (health, money, safety) is checked against outside
    // evidence even when it is the person's own file.
    && !signal.highImpact && !situation.highImpact;
  if (!value) {
    return {
      openWorld: true,
      unknownSituation: false,
      investigationNeeded: false,
      uncertainty: 1,
      complexity: 0,
      flags: {},
      goalModel: model,
      situation,
      safety,
      effort
    };
  }
  return {
    openWorld: true,
    unknownSituation: classified.source === 'model'
      ? situation.unknowns.length > 0 || model.unknownSituation
      : situation.unknowns.length > 0 || model.unknownSituation || signal.uncertainty || signal.invention,
    ownWork,
    investigationNeeded: !ownWork && ((classified.source === 'model'
      ? situation.unknowns.length > 0 || situation.externalData?.hasExternalDataNeed === true
      : situation.needsInvestigation)
      || model.investigationNeeded || signal.research || signal.highImpact || positive >= 4),
    uncertainty: Math.max(model.uncertainty, 1 - situation.confidence, signal.uncertainty || signal.invention ? 0.8 : 0),
    complexity: Math.min(1, positive / 5 + (tokenCount >= 40 ? 0.25 : 0) + (model.compound ? 0.2 : 0) + (situation.state.completedSteps.length ? 0.1 : 0)),
    flags: {
      ...signal,
      // Files in the context are file work even when the goal never says so.
      file: signal.file || (situation.artifacts?.length ?? 0) > 0,
      // An attached code file or zipped project makes it code work.
      code: signal.code || attachedCode,
      physical: situation.physical || signal.physical,
      highImpact: situation.highImpact || signal.highImpact,
      crisis: situation.crisis === true,
      crisisKind: situation.crisisKind ?? null
    },
    goalModel: model,
    classification: classified.source,
    situation,
    safety,
    effort
  };
}

// "…that I can run myself": the person runs it; nothing is executed here.
const SELF_RUN = /\b(?:i (?:can|could|will|'ll) run|run (?:it|this|them) (?:myself|on my own)|for me to run|so (?:that )?i can run|that i can run|run it myself)\b/i;

export function discoverCapabilityRequirements(goal, analysis = inspectGoal(goal)) {
  const f = analysis.flags ?? flags(goal);
  const model = analysis.goalModel ?? compileGoalModel(goal);
  const situation = analysis.situation ?? buildSituationModel(goal);
  const externalData = buildExternalDataPlan(goal, {
    dataSources: situation.externalData?.requested ?? [],
    connections: situation.externalData?.connections ?? [],
    user: situation.userProfile,
    workspace: situation.workspace
  });
  const requirements = [
    { id: 'reasoning', category: 'intelligence', source: 'native', dynamic: false, risk: 'low', reason: 'Understand the problem and make justified decisions.' },
    { id: 'adaptive-safety-governance', category: 'governance', source: 'native', dynamic: false, risk: 'low', reason: 'Apply the server-owned safety invariant before capability discovery, tool selection, side effects, execution and delivery.' },
    { id: 'situation-understanding', category: 'adaptation', source: 'native', dynamic: false, risk: 'low', reason: 'Build a domain-neutral situation model from the user outcome, context, constraints, unknowns and evidence needs.' },
    { id: 'capability-compilation', category: 'adaptation', source: 'native', dynamic: false, risk: 'low', reason: 'Compile the situation model into the capabilities, tools, resources and verification needed for this particular task.' },
    { id: 'planning', category: 'orchestration', source: 'native', dynamic: false, risk: 'low', reason: 'Compose the work into an executable dependency graph.' },
    { id: 'verification', category: 'quality', source: 'native', dynamic: false, risk: 'low', reason: 'Check evidence against success criteria.' }
  ];
  const add = item => requirements.push(item);
  if (analysis.safety?.decision === 'refuse') return requirements;
  const actions = new Set(model.actions);
  if (externalData.hasExternalDataNeed) {
    add({
      id: 'external-data-routing',
      category: 'data-access',
      source: 'discoverable',
      dynamic: true,
      risk: externalData.userOrWorkspaceScoped ? 'high' : 'medium',
      dataClasses: [...new Set(externalData.sources.flatMap(item => item.dataClasses ?? []))],
      reason: 'Route the situation to only the external data sources actually requested and authorized, preserving source identity and provenance.'
    });
    if (externalData.sources.some(source => source.authMode !== 'none')) {
      add({
        id: 'adaptive-execution',
        category: 'data-access',
      source: 'discoverable',
      dynamic: true,
      risk: externalData.userOrWorkspaceScoped ? 'high' : 'medium',
      dataClasses: [...new Set(externalData.sources.flatMap(item => item.dataClasses ?? []))],
        reason: 'Retrieve private or deployment-scoped external data only through a configured authorized connector/tool boundary and return a real retrieval receipt.'
      });
    }
  }
  if (!analysis.ownWork && (analysis.investigationNeeded || actions.has('investigate') || actions.has('discover'))) {
    add({ id: 'evidence-retrieval', category: 'investigation', source: 'discoverable', dynamic: true, risk: f.highImpact ? 'high' : 'medium', reason: 'Retrieve and trace evidence when the situation requires external knowledge or uncertainty reduction.' });
  }
  if (f.file) {
    add({ id: 'file-analysis', category: 'workspace', source: 'discoverable', dynamic: true, risk: 'medium', reason: 'Inspect user-provided artifacts in formats available at runtime.' });
  }
  const artifacts = Array.isArray(situation.artifacts) ? situation.artifacts : [];
  const hasImageArtifact = artifacts.some(name => /\.(?:png|jpe?g|webp|gif)$/i.test(String(name)));
  const visualRequest = text(situation.creationMode).toLowerCase() === 'visual'
    || /\b(?:image|images|visual|diagram|figure|illustration|poster|thumbnail|photo|render)\b/i.test(text(goal));
  if (hasImageArtifact || visualRequest) {
    add({ id: 'image-understanding', category: 'multimodal', source: 'native', dynamic: false, risk: 'medium', reason: 'Understand visual inputs when the current task depends on an image or other non-human visual artifact.' });
  }
  if (visualRequest && (actions.has('create') || actions.has('transform') || text(situation.creationMode).toLowerCase() === 'visual')) {
    add({ id: 'image-generation', category: 'creation', source: 'native', dynamic: true, risk: 'medium', reason: 'Generate or edit a visual through the governed Grok image-generation boundary and save the resulting artifact.' });
  }
  const selfRun = SELF_RUN.test(text(goal));
  if (actions.has('create') && !f.code && !visualRequest) {
    add({ id: 'artifact-creation', category: 'creation', source: 'native', dynamic: true, risk: 'medium', reason: 'Create the requested non-code file artifact and keep the original separate when one already exists.' });
  }
  if (actions.has('transform') && f.file && !f.code && !visualRequest) {
    add({ id: 'artifact-transformation', category: 'workspace', source: 'native', dynamic: true, risk: 'medium', reason: 'Transform the contents of a supported stored artifact without silently widening the requested scope.' });
  }
  // Software being the topic is not a request to write or run it: a question
  // about code (explain it, review it, what does this keyword do) is answered.
  const codeWork = actions.has('create') || actions.has('transform') || actions.has('execute')
    || !['answer', 'investigate'].some(action => actions.has(action));
  if ((f.code && codeWork) || (actions.has('transform') && /\b(code|software|program|script|api|repository|repo)\b/i.test(text(goal)))) {
    add({ id: 'code-generation', category: 'creation', source: 'native', dynamic: false, risk: 'medium', reason: 'Create or modify executable source.' });
    if (!selfRun) add({ id: 'code-execution', category: 'execution', source: 'native', dynamic: false, risk: 'high', reason: 'Execute code only through an authorized isolated runner.' });
  }
  // Pure software work is designed and built in its code stages; a separate
  // generic prototype stage would only duplicate them.
  const softwareOnly = f.code && !f.invention && !f.physical && !actions.has('invent');
  if ((f.creation || f.invention || actions.has('create') || actions.has('invent')) && !softwareOnly) {
    add({ id: 'design', category: 'creation', source: 'native', dynamic: false, risk: f.physical ? 'high' : 'medium', reason: 'Produce a concrete design or artifact specification.' });
  }
  if (f.invention || actions.has('invent')) {
    const inventionRisk = f.physical || f.highImpact ? 'high' : 'medium';
    add({ id: 'invention', category: 'creation', source: 'native', dynamic: false, risk: inventionRisk, reason: 'Generate candidate concepts for a novel requirement and compare them against constraints.' });
    add({ id: 'hypothesis-generation', category: 'invention', source: 'native', dynamic: false, risk: 'low', reason: 'Generate testable hypotheses from the problem model and explicit constraints.' });
    add({ id: 'concept-evaluation', category: 'invention', source: 'native', dynamic: false, risk: inventionRisk, reason: 'Evaluate candidate concepts against requirements, evidence and failure modes.' });
    add({ id: 'experiment-design', category: 'invention', source: 'native', dynamic: false, risk: inventionRisk, reason: 'Design a reproducible experiment or prototype test that can falsify or support the candidate concept.' });
  }
  // A pure inquiry about an unfamiliar subject resolves its unknowns through
  // evidence retrieval; it needs no generic tool execution of its own.
  const pureInquiry = model.resolution !== 'unresolved-domain'
    && model.actions.length > 0
    && model.actions.every(action => ['answer', 'investigate', 'discover'].includes(action))
    && !f.code && !f.file;
  // With a model classification its reading of novelty decides; the keyword
  // path also treats unfamiliar-sounding wording as novelty.
  const needsDiscovery = analysis.classification === 'model'
    ? analysis.unknownSituation || model.resolution === 'unresolved-domain'
    : analysis.unknownSituation || situation.needsCapabilityDiscovery || model.resolution === 'unresolved-domain';
  if (needsDiscovery) {
    add({ id: 'situation-understanding', category: 'meta', source: 'native', dynamic: false, risk: 'low', reason: 'Turn an unfamiliar situation into explicit outcome, constraints, unknowns and evidence requirements before choosing tools.' });
    add({ id: 'capability-discovery', category: 'meta', source: 'native', dynamic: true, risk: 'medium', reason: 'Determine what capability, tool, environment, data or expertise is missing without assuming a fixed domain.' });
  }
  if (needsDiscovery && !pureInquiry) {
    add({ id: 'adaptive-execution', category: 'execution', source: 'discoverable', dynamic: true, risk: f.highImpact || f.physical ? 'high' : 'medium', reason: 'Execute a newly composed capability only through an authorized generic tool boundary.' });
  }
  if (model.compound) {
    add({ id: 'adaptive-composition', category: 'meta', source: 'native', dynamic: true, risk: 'medium', reason: 'Compose multiple capabilities into one dependency-aware workflow and re-evaluate their ordering as evidence arrives.' });
  }
  const seen = new Set();
  return requirements.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export const SURFACE_CATALOG = Object.freeze({
  chat: { type: 'conversation', label: 'Normal Chat', publicMode: 'normal-chat', purpose: 'Adaptive simple-to-medium conversation, explanation and rich multimodal understanding.' },
  research: { type: 'investigation', label: 'Research Workspace', publicMode: 'research', purpose: 'Evidence gathering, source tracking, analysis and verification when justified.' },
  code: { type: 'workspace', label: 'Code Workspace', publicMode: 'code', purpose: 'Repository-aware software creation, debugging, testing and authorized execution.' },
  creation: { type: 'conversation', label: 'Normal Chat', publicMode: 'normal-chat', internalAlias: true, purpose: 'Creation is handled as adaptive normal-chat work unless it crosses into Coding or Research.' },
  workspace: { type: 'conversation', label: 'Normal Chat', publicMode: 'normal-chat', internalAlias: true, purpose: 'Files and artifacts can be understood in Normal Chat without opening a deep workspace workflow.' },
  adaptive: { type: 'adaptive', label: 'Adaptive', publicMode: 'normal-chat', internalAlias: true, purpose: 'A server-selected internal work surface for a capability not represented by a fixed domain surface.' }
});

function surfaceDescriptors(ids) {
  return ids.map(id => ({
    id,
    ...(SURFACE_CATALOG[id] ?? SURFACE_CATALOG.adaptive),
    state: 'available',
    actions: ['view', 'adapt']
  }));
}

export { buildSituationModel, mergeSituationEvidence, evolveSituation, situationQualityGate };

export function resolveAdaptiveContext(goal, {
  runtimeMode = 'auto',
  workspaceType = 'personal',
  activeSurface = '',
  jurisdiction = '',
  user = null,
  workspace = null,
  project = null,
  files = [],
  priorWork = [],
  constraints = [],
  resources = [],
  requestedRequirements = [],
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
  attachedArtifacts = [],
  attachedCode = false,
  classifierHints = null,
  blockedTopics = [],
  modelSelection = null,
  policyDecision = null,
  learnedSkills = []
} = {}) {
  // The adaptive engine receives the complete situation, not just the prompt.
  // This keeps user, workspace, project, state, evidence and constraints in
  // the same decision loop as capability discovery and presentation.
  const adaptiveContext = {
    runtimeMode, workspaceType, activeSurface, jurisdiction,
    user, workspace, project, files, priorWork, constraints, resources,
    requirements: requestedRequirements, successCriteria, outputs, environment, language,
    skillLevel, preferences, currentState, completedSteps, failedSteps,
    evidence, questions, dataSources, connections, connectedServices,
    verifiedConnections, privacyConsent, need, adaptiveControl, classifierHints, blockedTopics, modelSelection, policyDecision,
    learnedSkills, attachedCode
  };
  const analysis = inspectGoal(goal, adaptiveContext);
  const capabilityRequirements = discoverCapabilityRequirements(goal, analysis);
  const externalData = buildExternalDataPlan(goal, {
    dataSources,
    connections,
    connectedServices,
    verifiedConnections,
    user,
    workspace
  });
  const f = analysis.flags ?? {};
  const model = analysis.goalModel ?? compileGoalModel(goal);
  const boundary = classifySurfaceBoundary(goal, {
    activeSurface,
    attachments: attachedArtifacts,
    flags: f,
    actions: model.actions
  });
  const surfaces = new Set(['chat']);
  if (boundary.surface === 'research') surfaces.add('research');
  if (boundary.surface === 'code') surfaces.add('code');
  if (boundary.surface === 'normal-chat') surfaces.add('chat');
  // Compound situations can legitimately require a second workspace surface.
  // The primary surface stays stable, while supporting research/code is exposed
  // only when the current situation actually contains that need.
  const codeNeed = f.code === true && ['create', 'transform', 'execute'].some(action => model.actions.includes(action));
  const researchNeed = analysis.investigationNeeded
    || model.actions.includes('investigate')
    || externalData.hasExternalDataNeed === true;
  if (boundary.surface === 'code' && researchNeed) surfaces.add('research');
  if (boundary.surface === 'research' && codeNeed) surfaces.add('code');
  if (analysis.unknownSituation || capabilityRequirements.some(item => item.dynamic)) surfaces.add('adaptive');

  const allowed = ['auto', 'local', 'hosted', 'hybrid'];
  const requested = allowed.includes(text(runtimeMode)) ? text(runtimeMode) : 'auto';
  const mode = requested === 'auto' ? 'hosted' : requested;
  const preferred = text(activeSurface);
  const primarySurface = boundary.surface === 'code' ? 'code'
    : boundary.surface === 'research' ? 'research'
      : analysis.unknownSituation && !['chat', 'normal-chat'].includes(preferred) ? 'adaptive'
        : 'chat';
  const provisionalControl = normalizeAdaptiveControl(adaptiveControl, {
    inferredDepth: analysis.situation?.need?.depth || 'standard'
  });
  const provisionalImplementationPlan = compileCapabilityImplementations(capabilityRequirements, {
    connectors: externalData.connectors ?? [],
    connectorAccessReady: externalData.authorizationRequired?.length === 0,
    runtimes: contextRuntimeList(adaptiveContext),
    hardwareRunners: adaptiveContext.hardwareRunners ?? []
  });
  const resourcePlan = planAdaptiveResources({
    requirements: capabilityRequirements,
    externalData,
    artifacts: [...new Set([...files, ...attachedArtifacts])],
    surfaces: [...surfaces],
    primarySurface,
    implementationPlan: provisionalImplementationPlan,
    situation: analysis.situation,
    control: provisionalControl
  });
  const selectedCapabilityIds = new Set(resourcePlan.selected.capabilities);
  const selectedRequirements = capabilityRequirements.filter(item => selectedCapabilityIds.has(item.id));
  const discoveredSpecs = selectedRequirements.filter(item => item.dynamic).map(item => normalizeCapabilitySpec(item));
  const implementationPlan = compileCapabilityImplementations(selectedRequirements, {
    connectors: externalData.connectors ?? [],
    connectorAccessReady: externalData.authorizationRequired?.length === 0,
    runtimes: contextRuntimeList(adaptiveContext),
    hardwareRunners: adaptiveContext.hardwareRunners ?? []
  });
  const capabilityProposals = selectedRequirements
    .filter(item => item.dynamic || implementationPlan.missing.includes(item.id))
    .map(item => capabilityImplementationProposal(item, {
      situationId: text(workspace?.id) || null,
      implementationKind: 'external'
    }));
  resourcePlan.implementation = {
    ...resourcePlan.implementation,
    missing: [...new Set([
      ...resourcePlan.implementation.missing,
      ...implementationPlan.missing
    ])]
  };
  // The plan's real implementation state: whether what it selected can run here.
  resourcePlan.status = implementationPlan.state;
  const scopeDelta = adaptiveScopeForNextStep(resourcePlan);
  const workflowBlueprint = selectAdaptiveWorkflow({
    goal,
    need: analysis.situation?.need ?? model.need ?? null,
    capabilities: selectedRequirements,
    situation: analysis.situation,
    resourcePlan
  });
  const selectedSurfaces = resourcePlan.selected.surfaces ?? ['chat'];
  const selectedPrimarySurface = boundary.surface === 'code' ? 'code'
    : boundary.surface === 'research' ? 'research' : 'chat';
  resourcePlan.selected.surfaces = [...new Set(selectedSurfaces.filter(surface => ['chat','code','research'].includes(surface)).concat(selectedPrimarySurface))];
  resourcePlan.selected.primarySurface = selectedPrimarySurface;
  const modeRouting = {
    version: 1,
    publicModes: ['normal-chat', 'code', 'research'],
    activeMode: text(activeSurface) === 'chat' || text(activeSurface) === 'normal-chat'
      ? 'normal-chat'
      : ['code', 'research'].includes(text(activeSurface))
        ? text(activeSurface)
        : null,
    primary: selectedPrimarySurface === 'chat' ? 'normal-chat' : selectedPrimarySurface,
    supporting: [...new Set((resourcePlan.selected.surfaces ?? [])
      .filter(surface => ['chat', 'code', 'research'].includes(surface))
      .map(surface => surface === 'chat' ? 'normal-chat' : surface))]
      .filter(surface => surface !== (selectedPrimarySurface === 'chat' ? 'normal-chat' : selectedPrimarySurface)),
    transition: boundary.transition ?? 'stay',
    reason: boundary.reason,
    authority: 'server-owned',
    stabilityRule: 'Keep a selected deep workspace across ordinary follow-ups; switch only on explicit or strongly evidenced cross-mode intent.',
    compositionRule: 'Supporting modes may contribute capabilities without replacing the primary mode unless the next situation explicitly requires a different operating envelope.'
  };

  const selectedSourceIds = new Set(resourcePlan.selected.dataSources);
  const dataClasses = [...new Set([
    'user-content',
    ...(externalData.sources ?? [])
      .filter(item => selectedSourceIds.has(item.id))
      .flatMap(item => item.dataClasses ?? [])
  ])];
  const governance = evaluateSituationGovernance({
    goal,
    situation: analysis.situation,
    goalModel: model,
    safety: analysis.safety,
    policyDecision,
    dataClasses,
    privacyConsent,
    externalData,
    candidateCapabilities: capabilityRequirements.map(item => item.id),
    candidateTools: capabilityRequirements.flatMap(item => Array.isArray(item.tools) ? item.tools : []),
    candidateSideEffects: capabilityRequirements.filter(item => item.sideEffects === true).map(item => item.id)
  });
  const privacy = {
    priority: 'first',
    consent: {
      modelProvider: privacyConsent?.modelProvider === true,
      executionRunner: privacyConsent?.executionRunner === true,
      externalConnectors: Array.isArray(privacyConsent?.externalConnectors)
        ? [...new Set(privacyConsent.externalConnectors.map(text).filter(Boolean))]
        : []
    },
    dataClasses,
    tenantScope: workspace?.id ? 'workspace:' + text(workspace.id) : 'authenticated-workspace',
    userScope: user?.id ? 'user:' + text(user.id) : null,
    externalEgress: resourcePlan.selected.dataSources.length > 0,
    minimumNecessary: true,
    noCrossTenantAccess: true,
    noImplicitProviderAccess: true,
    evidenceProvenanceRequired: true,
    rule: 'Every data access and egress decision must preserve authenticated user/workspace scope, minimum necessary data, authorization, policy and provenance.'
  };
  const adaptiveSnapshot = buildAdaptiveSnapshot({
    situation: analysis.situation,
    requirements: selectedRequirements,
    implementationPlan,
    resourcePlan,
    workflowBlueprint,
    primarySurface: selectedPrimarySurface,
    presentation: analysis.situation?.presentation ?? { mode: 'adaptive', primarySurface: selectedPrimarySurface },
    runtime: { mode, storage: mode === 'local' ? 'local' : mode === 'hybrid' ? 'local+hosted' : 'hosted' },
    privacy,
    governance,
    verification: verificationContract({ physical: f.physical, highImpact: f.highImpact, capabilitySpecs: discoveredSpecs }),
    provenance: { workspaceId: text(workspace?.id) || null }
  });
  return {
    universal: true,
    openWorld: true,
    adaptationEngine: 'goal-model + situation-model + user-controlled-scope + capability-compiler + learned-skill-selection + model-router + evidence-driven replan',
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    adaptiveContractVersion: ADAPTIVE_CONTRACT_VERSION,
    adaptiveSnapshot,
    situationFingerprint: adaptiveSnapshot.fingerprint,
    audience: workspaceType === 'enterprise' ? 'enterprise' : 'individual',
    workspaceType: workspaceType === 'enterprise' ? 'enterprise' : 'personal',
    jurisdiction: text(jurisdiction) || null,
    runtime: {
      mode,
      storage: mode === 'local' ? 'local' : mode === 'hybrid' ? 'local+hosted' : 'hosted',
      execution: mode === 'local' ? 'local-first' : mode === 'hybrid' ? 'local-preferred' : 'hosted'
    },
    execution: {
      targets: [...new Set(selectedSurfaces.flatMap(surface =>
        surface === 'code' ? executionTargetsFor('code')
          : surface === 'research' ? executionTargetsFor('investigate')
            : []
      ))],
      targetCatalog: executionTargetCatalog(),
      approvalRequired: true,
      localPreflightRequired: selectedSurfaces.includes('code')
    },
    surfaces: selectedSurfaces,
    surfaceDescriptors: surfaceDescriptors(resourcePlan.selected.surfaces),
    primarySurface: selectedPrimarySurface,
    surfacePolicy: surfaceRuntimePolicy(selectedPrimarySurface),
    surfaceBoundary: boundary,
    modeRouting,
    compound: model.compound || selectedSurfaces.length > 2,
    investigation: {
      needed: analysis.investigationNeeded,
      unknownSituation: analysis.unknownSituation,
      uncertainty: analysis.uncertainty,
      complexity: analysis.complexity
    },
    goalModel: model,
    classification: { source: analysis.classification ?? 'keywords' },
    modelSelection: adaptiveContext.modelSelection?.selectedModelId || null,
    skillLearning: {
      version: '1',
      enabled: true,
      profileScope: 'workspace+principal',
      evidence: 'verified outcomes + explicit user feedback',
      profilesAvailable: Array.isArray(learnedSkills) ? learnedSkills.length : 0
    },
    skillLevel: text(skillLevel) || null,
    preferences: Array.isArray(preferences) ? preferences.map(text).filter(Boolean).slice(0, 30) : [],
    situation: analysis.situation,
    presentation: {
      ...(analysis.situation?.presentation ?? { mode: 'adaptive' }),
      primarySurface: selectedPrimarySurface,
      explainDecisions: analysis.situation?.presentation?.explainDecisions === true
    },
    suggestions: analysis.situation?.suggestions ?? [],
    requirements: selectedRequirements.map(item => item.id),
    consideredRequirements: capabilityRequirements.map(item => item.id),
    omittedRequirements: resourcePlan.omitted.capabilities,
    dynamicRequirements: selectedRequirements.filter(item => item.dynamic).map(item => item.id),
    capabilityContracts: discoveredSpecs,
    verification: verificationContract({ physical: f.physical, highImpact: f.highImpact, capabilitySpecs: discoveredSpecs }),
    dataClasses,
    privacy,
    governance,
    externalData,
    connectors: [...new Set([
      ...(externalData.connectors ?? []).filter(id => resourcePlan.selected.dataSources.includes(id)),
      ...(selectedRequirements.some(item => item.id.startsWith('code-')) ? ['general-ai-sandbox'] : []),
      ...(selectedRequirements.some(item => item.id === 'evidence-retrieval') ? ['builtin-research'] : []),
      ...(selectedRequirements.some(item => item.dynamic) ? ['generic-tool-router'] : []),
      ...(selectedSurfaces.includes('code') ? ['local-agent'] : [])
    ])],
    resourcePlan,
    workflowBlueprint,
    genericToolRouter: selectedRequirements.some(item => item.dynamic),
    implementationPlan,
    capabilityGraph: implementationPlan.capabilityGraph,
    capabilityProposals,
    capabilityLifecycle: 'discover → specify → candidate → verify → register → approve → execute → observe → promote-or-rollback',
    capabilityImplementationState: implementationPlan.state,
    adaptiveScope: scopeDelta,
    adaptationInvariant: ADAPTATION_INVARIANT,
    safety: analysis.safety,
    safetyContractVersion: ADAPTIVE_SAFETY_CONTRACT_VERSION,
    fileContext: f.file,
    physicalContext: f.physical,
    highImpactContext: f.highImpact,
    principle: 'The system continuously adapts from the goal, context, capabilities and observed evidence, while the user controls scope and depth. Unknown requirements stay explicit until a governed capability is actually available.'
  };
}


export function capabilityCatalog() {
  return CAPABILITY_DEFINITIONS.map(item => ({
    ...item,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    openWorld: true,
    note: 'Bootstrap capability only; additional capabilities can be discovered at runtime.'
  }));
}

export function connectorCatalog() {
  return externalConnectorCatalog();
}

export { resolveExternalDataNeeds, buildExternalDataPlan };
