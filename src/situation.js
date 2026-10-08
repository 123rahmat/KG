/**
 * Situation intelligence.
 *
 * This is deliberately domain-neutral. It models the whole situation around
 * an outcome instead of classifying a prompt into a fixed product/tool list.
 * Domain hints are signals only; context, evidence and workflow state have
 * precedence.
 */

import { resolveExternalDataNeeds } from './connectors.js';
import { isCareNote } from './safety.js';
import { buildRealWorldTaskModel } from './real-world-adaptation.js';
import { buildRealWorldOutcomeContract } from './real-world-outcome.js';

const text = value => String(value ?? '').trim();

const asList = value => {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).slice(0, 80);
  const v = text(value);
  return v ? [v] : [];
};

const uniq = values => [...new Set(values.map(text).filter(Boolean))];
const asEvidenceList = value => {
  if (Array.isArray(value)) return value.slice(0, 80);
  if (value && typeof value === 'object') return [value];
  const v = text(value);
  return v ? [v] : [];
};


function words(value) {
  return text(value).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function mentions(value, patterns) {
  const v = text(value);
  return patterns.some(pattern => pattern.test(v));
}

function collectContext(context = {}) {
  const c = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  return {
    user: c.user ?? c.userProfile ?? null,
    workspace: c.workspace ?? null,
    project: c.project ?? null,
    // Keep selected attachment names in the situation across reassessment.
    // File contents stay in their scoped artifact stores.
    files: uniq([...asList(c.files ?? c.artifacts), ...asList(c.attachedArtifacts)]).slice(0, 80),
    priorWork: asList(c.priorWork ?? c.history),
    constraints: asList(c.constraints),
    resources: asList(c.resources ?? c.availableResources),
    requirements: asList(c.requirements),
    dataSources: asList(c.dataSources ?? c.externalDataSources),
    connections: Array.isArray(c.connections ?? c.connectedServices)
      ? (c.connections ?? c.connectedServices).slice(0, 40).map(item => item && typeof item === 'object' ? {
          id: text(item.id ?? item.connectorId ?? item.provider),
          status: text(item.status),
          scopes: Array.isArray(item.scopes) ? item.scopes.map(text).filter(Boolean).slice(0, 40) : [],
          principalScope: text(item.principalScope ?? item.accountScope),
          sourceRef: text(item.sourceRef ?? item.resourceId)
        } : { id: text(item) }).filter(item => item.id)
      : [],
    successCriteria: asList(c.successCriteria ?? c.acceptanceCriteria),
    verifiedConnections: Array.isArray(c.verifiedConnections) ? c.verifiedConnections.slice(0, 40) : [],
    outputs: asList(c.outputs ?? c.desiredOutputs),
    environment: c.environment ?? c.runtime ?? null,
    jurisdiction: text(c.jurisdiction),
    language: text(c.language),
    skillLevel: text(c.skillLevel ?? c.user?.skillLevel),
    preferences: asList(c.preferences),
    commitments: c.commitments ?? c.promises ?? c.agendaItems ?? [],
    dependencies: c.dependencies ?? c.prerequisites ?? [],
    dueAt: c.dueAt ?? c.deadline ?? null,
    startAt: c.startAt ?? null,
    userBehavior: c.userBehavior ?? c.behavior ?? c.user?.behavior ?? {},
    creationMode: text(c.creationMode),
    capacity: c.capacity ?? c.user?.capacity ?? null,
    availability: c.availability ?? c.user?.availability ?? null,
    competingCommitments: c.competingCommitments ?? c.busyWith ?? [],
    now: c.now ?? null,
    accessibility: c.accessibility ?? c.user?.accessibility ?? {},
    adaptiveControl: c.user?.adaptiveControl ?? {},
    currentState: c.currentState ?? null,
    completedSteps: asList(c.completedSteps),
    failedSteps: asList(c.failedSteps),
    evidence: asEvidenceList(c.evidence),
    timeline: Array.isArray(c.timeline) ? c.timeline.slice(-100) : [],
    explicitQuestions: asList(c.questions)
  };
}

function extractConstraints(goal) {
  const value = text(goal);
  const found = [];
  const patterns = [
    /\b(?:must|need to|required to|requirement is)\s+([^.;!?]+)/gi,
    /\b(?:without|avoid|do not|don't|cannot|can't)\s+([^.;!?]+)/gi,
    /\b(?:under|within|before|after|by)\s+([^.;!?]+)/gi
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) found.push(text(match[1]));
  }
  return uniq(found).slice(0, 20);
}

function extractOutcomes(goal) {
  const value = text(goal);
  const outcomes = [];
  for (const pattern of [
    /\b(?:i want|we want|need|needs|goal is|objective is|help me)\s+([^.;!?]+)/gi,
    /\b(?:so that|in order to|to)\s+([^.;!?]+)/gi
  ]) {
    for (const match of value.matchAll(pattern)) outcomes.push(text(match[1]));
  }
  return uniq(outcomes).slice(0, 12);
}

function inferPhase(state) {
  if (state.failedSteps.length) return 'recovery';
  if (state.completedSteps.length && state.currentState) return 'in-progress';
  if (state.priorWork.length) return 'continuation';
  return 'discovery';
}

/**
 * Someone at risk of harming themselves needs an immediate, caring answer
 * that points to real help, not a research-and-approval workflow.
 */
export const CRISIS = /\b(kill(?:ing)? myself|hurt(?:ing)? myself|harm(?:ing)? myself|end(?:ing)? my (?:own )?life|suicid\w*|self[- ]harm\w*|(?:do not|don'?t) want to (?:live|be alive)|want to die)\b/i;

/**
 * A medical or physical emergency happening now. Like a crisis, it gets an
 * immediate answer that sends the person to emergency help first.
 */
export const EMERGENCY = /\b(chest pains?|pain in my chest|heart attack|stroke|(?:can'?t|cannot|can ?not|struggling to|hard to|trouble) breath\w*|not breathing|stopped breathing|chok(?:ing|ed)|unconscious|passed out|won'?t wake up|severe(?:ly)? bleed\w*|bleeding (?:heavily|a lot|won'?t stop)|overdos\w*|swallowed (?:bleach|poison|pills|batter\w+|chemicals?)|poisoned|seizure|anaphyla\w*|throat (?:is )?(?:swelling|closing)|gas leak|smell (?:of )?gas|carbon monoxide|(?:house|home|kitchen|flat|apartment|car) is on fire|electrocuted|electric shock)\b/i;

const HIGH_IMPACT = [
  /medical|clinical|patient|diagnos|symptom|medication|medicine|\bdos(e|age)\b|pregnan|illness|disease|injur|\brash\b|\bmole\b|tumou?r|cancer|mental health/i,
  /legal|court|(?<!['’]s )\blaw\b(?! of (?:physics|motion|gravit\w*|thermodynamics|conservation|nature|averages|large numbers|reflection|refraction|cosines|sines|supply|demand)\b)|\bcontracts?\b|\blease\b|\bevict\w*|security deposit|tenan(?:t|cy) rights|\blandlords? (?:kept|keeps|won'?t|refus\w*|is (?:suing|threatening))|\bemployer\b|unfair dismissal|wrongful\w*|\bpolice\b|\barrest\w*|\bscam\w*|\bfraud\w*|inheritance|lawsuit|\bsue\b|lawyer|attorney|\bvisa\b|immigration|custody|divorce/i,
  /payment|financial|money|\bwire\b|transfer (?:money|funds)|\binvest\w*|\bloans?\b|mortgage|bank account|crypto\w*|\btax(?:es)?\b|pension/i,
  /chemical|hazard|explosive/i,
  /safety-critical|life-critical/i
];

function inferRisk(goal, state) {
  // What the person asked and required; the server's own care notes ("not a
  // diagnosis", "not legal advice") would otherwise make every such topic
  // look high-impact.
  const value = [goal, ...state.constraints.filter(item => !isCareNote(item)), ...state.requirements].join(' ');
  if (CRISIS.test(value) || EMERGENCY.test(value)) return 'crisis';
  if (mentions(value, HIGH_IMPACT)) return 'high-impact';
  if (mentions(value, [/physical|hardware|machine|robot|vehicle|industrial|electrical/i])) return 'physical';
  return 'ordinary';
}

/**
 * Wording that says the situation itself is not yet understood. Only this —
 * not the mere absence of optional context — triggers capability discovery.
 */
const UNFAMILIAR = /\b(unknown|uncertain|unfamiliar|unseen|unprecedented|novel|open[- ]ended|ambiguous|never existed|not yet exist\w*|from scratch|no predefined|no idea|not sure|figure out|whatever)\b/i;
const MATERIAL_OUTCOME_AMBIGUITY = /\b(best|optimal|optimum|production[- ]ready|production|launch|real[- ]world|safe|compliant|for (?:my|our) (?:company|organization|school|team)|for everyone|as much as possible)\b/i;

const OUTSIDE_ACCOUNTS = /\b(google\s*drive|google\s*docs?|google\s*sheets?|google\s*calendar|gmail|google\s*photos|dropbox|one\s*drive|onedrive|outlook|icloud|sharepoint|notion|slack)\b/gi;

function presentationFor(state) {
  if (state.skillLevel && /beginner|novice|student/i.test(state.skillLevel)) return 'guided';
  if (/expert|advanced|engineer|developer/i.test(state.skillLevel)) return 'dense';
  if (state.files.length || state.outputs.length) return 'artifact-first';
  return 'adaptive';
}

/**
 * Build a persistent, domain-neutral situation model.
 *
 * The model is intentionally useful even when the goal does not contain
 * recognizable domain keywords. Keywords may enrich it, but they never decide
 * whether a situation is valid or open-world.
 */
export function buildSituationModel(goal, context = {}) {
  const value = text(goal);
  const c = collectContext(context);
  const tokens = words(value);
  const explicitOutcome = uniq([...c.outputs, ...c.successCriteria, ...extractOutcomes(value)]);
  const constraints = uniq([...c.constraints, ...c.requirements, ...extractConstraints(value)]);
  const resources = uniq([...c.resources, ...c.files]);
  const externalData = resolveExternalDataNeeds(value, {
    dataSources: c.dataSources,
    connections: c.connections,
    verifiedConnections: c.verifiedConnections,
    workspace: c.workspace,
    user: c.user
  });
  // Unknowns are facts that materially block or reshape the work. Gaps are
  // ordinary missing context: worth a clarifying question, but they must not
  // turn every simple request into an open-world investigation.
  const unknowns = [];
  const gaps = [];

  if (!value) unknowns.push('user outcome is not specified');
  // Ask only what matters for this kind of goal: a plain question needs no
  // success criteria spelled out, and only executable work needs to know
  // its environment.
  const question = /\?\s*$/.test(value) || /^(what|who|when|where|why|how|which|is|are|can|does|do|should)\b/i.test(value);
  const executable = /\b(code|coding|script|program\w*|run|execut\w*|deploy\w*|test\w*|build|install\w*|server|app|robot\w*)\b/i.test(value);
  // Nobody in crisis should be asked to define success criteria.
  // The rules read English wording; the model reads a crisis in any language.
  const ruleCrisis = CRISIS.test(value) ? 'self-harm' : EMERGENCY.test(value) ? 'emergency' : null;
  // A crisis already recorded on this situation stays when it is rebuilt.
  const known = kind => (['self-harm', 'emergency'].includes(kind) ? kind : null);
  const crisisKind = ruleCrisis ?? known(context?.classifierHints?.crisis) ?? (context?.crisis === true ? known(context.crisisKind) : null);
  const inCrisis = Boolean(crisisKind);
  if (!explicitOutcome.length && value && !question && !inCrisis) gaps.push('success criteria are not explicit');
  if (!resources.length) gaps.push('available resources/evidence are not yet known');
  if (!c.environment && executable && !inCrisis) gaps.push('execution environment is not specified');
  // Kindgleam connects to no outside account. Data kept in one arrives as
  // an attached file, and the person is told so instead of a pretend connection.
  const outside = [...new Set([...value.matchAll(OUTSIDE_ACCOUNTS)].map(match => match[0].toLowerCase().replace(/\s+/g, ' ')))];
  if (outside.length) gaps.push(`files from ${outside.join(', ')} must be attached: Kindgleam does not connect to outside accounts`);
  if (externalData.authorizationRequired.length) {
    unknowns.push('authorization is required for: ' + externalData.authorizationRequired.join(', '));
  }
  if (c.explicitQuestions.length) unknowns.push(...c.explicitQuestions);

  const outcome = explicitOutcome.length ? explicitOutcome : [value || 'unspecified outcome'];
  const phase = inferPhase({
    ...c,
    priorWork: c.priorWork,
    completedSteps: c.completedSteps,
    failedSteps: c.failedSteps,
    currentState: c.currentState
  });
  const risk = inCrisis ? 'crisis' : inferRisk(value, { ...c, constraints });
  const physical = risk === 'physical';
  const realWorld = buildRealWorldTaskModel(value, {
    ...c,
    goal: value,
    situation: { risk, physical, highImpact: risk === 'high-impact', externalSideEffect: c.externalSideEffect, peopleDecision: c.peopleDecision },
    completedSteps: c.completedSteps,
    failedSteps: c.failedSteps
  });
  const highImpact = risk === 'high-impact';
  const crisis = risk === 'crisis';
  if (highImpact && !c.jurisdiction) {
    unknowns.push('jurisdiction is required to evaluate applicable rules for a high-impact situation');
  }

  const outcomeContract = buildRealWorldOutcomeContract({
    goal: value,
    realWorld,
    successCriteria: uniq([...c.successCriteria, ...c.outputs]),
    execution: c.execution ?? {},
    authorizationSatisfied: c.authorizationSatisfied !== false,
    evidence: c.evidence ?? []
  });

  const successCriteria = uniq([
    ...c.successCriteria,
    ...c.outputs,
    // Outcomes guessed from the wording are too rough to check against, so
    // without stated criteria or outputs the default criterion applies.
    ...(c.successCriteria.length || c.outputs.length ? [] : ["Satisfy the user's stated outcome with evidence appropriate to the work."])
  ]);

  const materialQuestions = uniq([
    ...c.explicitQuestions,
    ...(highImpact && !c.jurisdiction
      ? ['Which country or region’s rules apply here (for example, where you live or where the agreement is made)?']
      : []),
    ...(phase === 'continuation' && !c.currentState
      ? ['What is the current state of the existing work?']
      : []),
    ...(!c.successCriteria.length && MATERIAL_OUTCOME_AMBIGUITY.test(value)
      ? ['What result would count as success for you? Be as concrete as you can.']
      : [])
  ]).slice(0, 12);

  const clarificationRequired = materialQuestions.length > 0;

  const questions = uniq([
    ...c.explicitQuestions,
    ...(gaps.includes('success criteria are not explicit') ? ['What result would count as successful?'] : []),
    ...(gaps.includes('execution environment is not specified') ? ['What execution environment or resources are available?'] : [])
  ]).slice(0, 12);

  const confidence = Math.max(0, Math.min(1,
    0.35
    + Math.min(tokens.length, 30) / 100
    + (c.successCriteria.length ? 0.15 : 0)
    + (c.resources.length ? 0.1 : 0)
    + (c.currentState ? 0.1 : 0)
    - Math.min(unknowns.length * 0.08 + gaps.length * 0.04, 0.4)
  ));
  const unfamiliar = UNFAMILIAR.test(value);
  const needsCapabilityDiscovery = unknowns.length > 0 || unfamiliar;
  const needsInvestigation = unknowns.length > 0 || unfamiliar || externalData.hasExternalDataNeed;

  return {
    schemaVersion: '2',
    openWorld: true,
    goal: value,
    outcome,
    phase,
    risk,
    physical,
    highImpact,
    crisis,
    ...(crisis ? { crisisKind: crisisKind ?? (CRISIS.test(value) ? 'self-harm' : 'emergency') } : {}),
    // What exactly the person wants back (the model's reading), kept when
    // the situation is rebuilt, so every step builds that and nothing extra.
    ...((context?.classifierHints?.need ?? context?.need) ? { need: context?.classifierHints?.need ?? context.need } : {}),
    actors: c.user ? [c.user] : [],
    workspace: c.workspace,
    project: c.project,
    userProfile: {
      skillLevel: c.skillLevel,
      language: c.language,
      preferences: c.preferences,
      accessibility: c.accessibility,
      adaptiveControl: c.adaptiveControl
    },
    state: {
      current: c.currentState,
      completedSteps: c.completedSteps,
      failedSteps: c.failedSteps,
      priorWork: c.priorWork
    },
    constraints,
    resources,
    artifacts: c.files,
    externalData,
    verifiedConnections: c.verifiedConnections,
    environment: c.environment,
    jurisdiction: c.jurisdiction,
    successCriteria,
    unknowns: uniq(unknowns).slice(0, 30),
    gaps: uniq(gaps),
    questions,
    clarificationRequired,
    clarificationQuestions: materialQuestions,
    evidence: c.evidence,
    timeline: c.timeline,
    realWorld,
    creationMode: c.creationMode || null,
    adaptation: {
      user: {
        skillLevel: c.skillLevel || null,
        language: c.language || null,
        preferences: c.preferences,
        accessibility: c.accessibility,
        adaptiveControl: c.adaptiveControl
      },
      situation: {
        phase,
        risk,
        environment: c.environment,
        jurisdiction: c.jurisdiction || null,
        constraints,
        resources
      },
      goal: {
        requested: value,
        outcomes: outcome,
        successCriteria
      },
      realWorld: realWorld,
      outcomeContract,
      creationMode: c.creationMode || null,
      operational: {
        realWorld,
        nextAction: realWorld.nextAction,
        urgency: realWorld.temporal?.urgency ?? 0,
        userAutonomy: realWorld.userBehavior?.autonomy ?? 'collaborate',
        externalActionBoundary: realWorld.controls?.includes('external-action-boundary') === true
      },
      capability: {
        discoveryRequired: needsCapabilityDiscovery,
        investigationRequired: needsInvestigation,
        externalDataRequired: externalData.hasExternalDataNeed,
        connectedExternalData: externalData.connected
      },
      presentation: {
        mode: presentationFor({ ...c, files: c.files, outputs: c.outputs }),
        primarySurface: c.files.length ? 'workspace' : 'adaptive'
      }
    },
    confidence,
    needsInvestigation,
    needsCapabilityDiscovery,
    presentation: {
      mode: presentationFor({ ...c, files: c.files, outputs: c.outputs }),
      primarySurface: c.files.length ? 'workspace' : 'adaptive',
      explainDecisions: /beginner|novice|student/i.test(c.skillLevel)
    },
    quality: {
      clarificationRequired,
      materialQuestions: materialQuestions.length,
      unresolvedUnknowns: uniq(unknowns).length
    },
    suggestions: [
      ...(clarificationRequired
        ? [{ type: 'clarify', reason: 'Resolve information that can materially change the workflow before planning or execution.', questions: materialQuestions }]
        : []),
      ...(questions.length ? [{ type: 'clarify', reason: 'Resolve information that can materially change the workflow.', questions }] : []),
      { type: 'plan', reason: 'Convert the situation into a dependency-aware workflow after capability discovery.' },
      { type: 'verify', reason: 'Define evidence and success checks before execution.' }
    ]
  };
}

export function evolveSituation(situation, event = {}) {
  const base = situation && typeof situation === 'object' ? situation : buildSituationModel('');
  const e = event && typeof event === 'object' ? event : {};
  const eventRecord = {
    type: text(e.type) || 'observation',
    at: text(e.at) || new Date().toISOString(),
    summary: text(e.summary),
    taskId: text(e.taskId),
    status: text(e.status),
    evidence: asEvidenceList(e.evidence)
  };
  const evidence = e.evidence && typeof e.evidence === 'object' && !Array.isArray(e.evidence) ? e.evidence : {};
  return mergeSituationEvidence(base, {
    ...e,
    // A clarification records the person's answers inside its evidence.
    answers: e.answers ?? evidence.answers ?? evidence.questionAnswers,
    timeline: [eventRecord]
  });
}

export function situationQualityGate(situation, { requireEvidence = true } = {}) {
  const current = situation && typeof situation === 'object' ? situation : buildSituationModel('');
  const criteria = current.successCriteria ?? [];
  const evidence = current.evidence ?? [];
  const unresolved = current.unknowns ?? [];
  const ready = Boolean(current.goal)
    && criteria.length > 0
    && current.clarificationRequired !== true
    && (!requireEvidence || evidence.length > 0)
    && unresolved.length === 0;
  return {
    ready,
    status: ready ? 'ready-for-verification' : 'needs-more-situation-work',
    missing: [
      ...(!current.goal ? ['goal'] : []),
      ...(criteria.length ? [] : ['success-criteria']),
      ...(current.clarificationRequired ? ['clarification'] : []),
      ...(!requireEvidence || evidence.length ? [] : ['evidence']),
      ...(unresolved.length ? ['unknowns'] : [])
    ]
  };
}

export function mergeSituationEvidence(situation, evidence = {}) {
  const base = situation && typeof situation === 'object' ? situation : buildSituationModel('');
  const e = evidence && typeof evidence === 'object' ? evidence : {};
  // Rebuild from the persisted model. Derived fields (questions, unknowns)
  // are recomputed rather than fed back in, or they would become permanent
  // "explicit" questions; the user profile is carried through explicitly.
  const { questions: _derivedQuestions, unknowns: _derivedUnknowns, gaps: _derivedGaps, ...persisted } = base;
  const profile = base.userProfile ?? {};
  const answers = e.answers && typeof e.answers === 'object' && !Array.isArray(e.answers)
    ? e.answers
    : e.questionAnswers && typeof e.questionAnswers === 'object' && !Array.isArray(e.questionAnswers)
      ? e.questionAnswers
      : {};
  const next = buildSituationModel(base.goal, {
    ...persisted,
    user: base.actors?.[0] ?? null,
    skillLevel: profile.skillLevel,
    language: profile.language,
    preferences: profile.preferences,
    accessibility: profile.accessibility,
    currentState: answers.currentState ?? e.currentState ?? base.state?.current,
    completedSteps: [...(base.state?.completedSteps ?? []), ...asList(e.completedSteps)],
    failedSteps: [...(base.state?.failedSteps ?? []), ...asList(e.failedSteps)],
    evidence: [...(base.evidence ?? []), ...asEvidenceList(e.evidence)],
    resources: [...(base.resources ?? []), ...asList(answers.resources ?? e.resources)],
    constraints: [...(base.constraints ?? []), ...asList(answers.constraints)],
    requirements: [...(base.requirements ?? []), ...asList(answers.requirements)],
    successCriteria: (() => {
      const supplied = asList(answers.successCriteria);
      const existing = base.successCriteria ?? [];
      const isDefaultOnly = existing.length === 1
        && existing[0] === "Satisfy the user's stated outcome with evidence appropriate to the work.";
      // The default criterion is derived, not supplied: feeding it back in
      // would make it look explicit and silently resolve a material
      // ambiguity that only a clarification may resolve.
      if (!supplied.length) return isDefaultOnly ? [] : existing;
      return isDefaultOnly ? supplied : [...existing, ...supplied];
    })(),
    outputs: [
      ...(base.outputs ?? []),
      ...asList(answers.outputs)
    ],
    environment: answers.environment ?? base.environment,
    jurisdiction: answers.jurisdiction ?? base.jurisdiction,
    dataSources: [...(base.externalData?.requested ?? []), ...asList(answers.dataSources ?? e.dataSources ?? e.externalDataSources)],
    connections: [...(base.externalData?.sources ?? []), ...(Array.isArray(e.connections) ? e.connections : [])],
    verifiedConnections: [
      ...(Array.isArray(base.verifiedConnections) ? base.verifiedConnections : []),
      ...(Array.isArray(e.verifiedConnections) ? e.verifiedConnections : []),
      ...(Array.isArray(base.externalData?.sources) ? base.externalData.sources
        .filter(item => item?.access === 'authorized' && item?.status === 'connected')
        .map(item => ({
          id: item.id,
          status: item.status,
          scopes: Array.isArray(item.scopes) ? item.scopes : [],
          principalScope: item.principalScope ?? null,
          sourceRef: item.sourceRef ?? null,
          verified: true
        })) : [])
    ],
    files: base.artifacts,
    timeline: [
      ...(Array.isArray(base.timeline) ? base.timeline : []),
      ...(Array.isArray(e.timeline) ? e.timeline : [])
    ].slice(-100),
    commitments: [...(Array.isArray(base.realWorld?.commitments) ? base.realWorld.commitments : []), ...asList(e.commitments)],
    dependencies: [...(Array.isArray(base.realWorld?.dependencies) ? base.realWorld.dependencies : []), ...(Array.isArray(e.dependencies) ? e.dependencies : [])],
    dueAt: e.dueAt ?? e.deadline ?? base.realWorld?.temporal?.dueAt ?? null,
    startAt: e.startAt ?? base.realWorld?.temporal?.startAt ?? null,
    userBehavior: e.userBehavior ?? base.realWorld?.userBehavior ?? {},
    capacity: e.capacity ?? base.realWorld?.capacity ?? null,
    availability: e.availability ?? base.realWorld?.availability ?? null,
    competingCommitments: [
      ...(Array.isArray(base.realWorld?.competingCommitments) ? base.realWorld.competingCommitments : []),
      ...asList(e.competingCommitments ?? e.busyWith)
    ],
    now: e.now ?? null
  });
  // The ethical reading is made once, when the request arrives, and stays.
  if (base.ethics) next.ethics = base.ethics;
  return next;
}
