/**
 * Unified adaptive intelligence for chat and coding.
 *
 * This module deliberately stays domain-neutral. It builds a compact,
 * evidence-oriented understanding of the current working set and chooses an
 * execution strategy. It does not invent a fixed future workflow: later
 * evidence can change the strategy.
 */

const text = value => String(value ?? '').trim();

const CODE_EXTENSIONS = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sql|sh|html|css|vue|svelte|json|yaml|yml)$/i;
const PROJECT_ARCHIVES = /\.(?:zip|tar|tgz|gz)$/i;

const RESOURCE_PRIORITY = Object.freeze({
  'working-files': 100,
  'current-state': 98,
  'project-state': 95,
  'success-criteria': 94,
  'constraints': 92,
  'conversation': 88,
  'prior-work': 84,
  'evidence': 90,
  'external-data': 86,
  'tools': 80,
  'capabilities': 78
});

const uniq = values => [...new Set((values ?? []).map(text).filter(Boolean))];

function normalizeFiles(files = [], attachments = []) {
  const items = [
    ...(Array.isArray(files) ? files : []),
    ...(Array.isArray(attachments) ? attachments : [])
  ];
  return items.map(item => {
    if (typeof item === 'string') return { name: item };
    return {
      name: text(item?.name || item?.path || item?.filename),
      path: text(item?.path),
      type: text(item?.type || item?.contentType || item?.mime),
      size: Number.isFinite(item?.size) ? item.size : null,
      format: text(item?.format)
    };
  }).filter(item => item.name);
}

function fileKinds(files) {
  const kinds = new Set();
  for (const file of files) {
    const name = file.name;
    if (CODE_EXTENSIONS.test(name)) kinds.add('source');
    if (/\.(?:test|spec)\.[^.]+$/i.test(name) || /(^|[/\\])tests?[/\\]/i.test(name)) kinds.add('tests');
    if (/package\.json|pnpm-lock|yarn\.lock|package-lock\.json|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle/i.test(name)) kinds.add('dependencies');
    if (/\.github[/\\]|dockerfile|compose|\.env|config|vite|webpack|tsconfig|eslint/i.test(name)) kinds.add('configuration');
    if (/\.sql$|schema|migration/i.test(name)) kinds.add('database');
    if (/\.html?$|\.css$|\.scss$|\.sass$|\.jsx?$|\.tsx$/i.test(name)) kinds.add('ui');
    if (/\.(?:md|txt|rst)$/i.test(name)) kinds.add('documentation');
    if (PROJECT_ARCHIVES.test(name) || file.format === 'project') kinds.add('project-archive');
  }
  return [...kinds];
}

function estimateComplexity({ files, actions, attachments, broad, unknown, project }) {
  let score = 0;
  if (files.length >= 2) score += 0.25;
  if (files.length >= 8) score += 0.2;
  if (files.length >= 25) score += 0.2;
  if (files.length >= 75) score += 0.15;
  if (attachments >= 3) score += 0.1;
  if (actions.length > 1) score += 0.15;
  if (broad) score += 0.25;
  if (unknown) score += 0.2;
  if (project) score += 0.15;
  return Math.min(1, score);
}


function inferReasoningProfile({ complexity, broad, unknown, projectWork, coding, actions }) {
  const ambiguity = unknown ? 'high' : (broad || actions.length > 1 ? 'medium' : 'low');
  const depth = complexity >= 0.8 || unknown ? 'deep' : complexity >= 0.3 ? 'structured' : 'focused';
  const verification = complexity >= 0.55 || unknown ? 'strong' : 'targeted';
  const planning = complexity >= 0.55 || projectWork ? 'task-graph' : complexity >= 0.12 ? 'focused-plan' : 'direct';
  return {
    depth,
    ambiguity,
    planning,
    verification,
    hypothesisDriven: unknown || complexity >= 0.55,
    evidenceRequired: coding || unknown || complexity >= 0.3,
    explainDecisionWhenUseful: true
  };
}

function buildManagementModel({ scale, complexity, projectWork, coding, unknown, executionAvailable }) {
  const persistent = projectWork || scale === 'large-project';
  const execution = coding && executionAvailable?.code !== false;
  const managers = ['objective-manager', 'context-manager', 'task-manager', 'verification-manager'];
  if (projectWork) managers.push('project-state-manager', 'dependency-manager', 'change-manager');
  if (execution) managers.push('execution-manager', 'failure-manager');
  if (unknown) managers.push('capability-manager', 'uncertainty-manager');
  return {
    enabled: true,
    objective: 'maintain the user goal while managing changing state and evidence',
    managers: uniq(managers),
    state: persistent ? 'persistent-project-state' : 'task-state',
    controlLoop: ['observe', 'decide', 'act', 'measure', 'verify', 'replan'],
    resourcePolicy: 'minimum-sufficient-work',
    stopConditions: ['goal-satisfied', 'verified-result', 'blocked-by-missing-authority-or-capability', 'user-cancelled'],
    escalation: {
      enabled: true,
      triggers: ['ambiguity', 'failure', 'scope-change', 'dependency-change', 'missing-capability', 'verification-failure'],
      parallelWork: scale === 'large-project' ? 'eligible-after-dependency-analysis' : 'not-needed'
    },
    uncertainty: {
      tracked: true,
      unknownSituation: unknown,
      confidenceIsNotProof: true
    }
  };
}


function buildResourceDecision({ analysis, complexity, coding, projectWork, unknown, files, conversation, priorWork, constraints, successCriteria, currentState, resourcePlan }) {
  const available = [];
  const required = [];
  const now = [];
  const later = [];
  const add = (bucket, id, why, timing = 'now') => {
    const item = { id, priority: RESOURCE_PRIORITY[id] ?? 50, why, timing };
    bucket.push(item);
  };

  if (files.length) add(required, 'working-files', 'The request depends on the supplied working set.', 'now');
  if (currentState) add(required, 'current-state', 'Existing state can change the correct diagnosis or next action.', 'now');
  if (projectWork) add(required, 'project-state', 'Project relationships and prior changes may affect safe edits.', 'now');
  if (successCriteria.length) add(required, 'success-criteria', 'These define what must be verified.', 'now');
  if (constraints.length) add(required, 'constraints', 'Constraints bound acceptable solutions.', 'now');
  if (conversation.length) add(available, 'conversation', 'Conversation provides relevant intent and context.', 'now');
  if (priorWork.length) add(available, 'prior-work', 'Prior verified work can prevent redundant investigation.', 'later-if-needed');
  if (analysis.externalDataNeed || analysis.situation?.externalData?.hasExternalDataNeed) {
    add(required, 'external-data', 'Current external evidence can materially change the answer or plan.', 'now');
  }
  if (unknown || analysis.investigationNeeded) add(required, 'evidence', 'Unresolved uncertainty needs evidence before committing to a fragile strategy.', 'now');
  if (coding) add(required, 'tools', 'Only tools justified by the current code step should be activated.', 'when-needed');
  add(available, 'capabilities', 'The capability catalog is available, but availability alone does not justify activation.', 'when-needed');

  const selected = resourcePlan?.selected ?? {};
  const selectedCapabilities = Array.isArray(selected.capabilities) ? selected.capabilities.map(String) : [];
  const selectedTools = Array.isArray(selected.tools) ? selected.tools.map(String) : [];
  const selectedArtifacts = Array.isArray(selected.artifacts) ? selected.artifacts.map(String) : [];
  if (selectedCapabilities.length) add(now, 'selected-capabilities', 'Capabilities already justified by the current situation.', 'now');
  if (selectedTools.length) add(now, 'selected-tools', 'Tools already selected for the current step.', 'when-needed');
  if (selectedArtifacts.length) add(now, 'selected-artifacts', 'Artifacts selected for the current step.', 'when-needed');

  const pressure = Math.max(
    complexity,
    unknown ? 0.8 : 0,
    analysis.investigationNeeded ? 0.65 : 0,
    currentState?.verificationFailed ? 0.85 : 0
  );
  const effort = pressure >= 0.8 ? 'deep' : pressure >= 0.35 ? 'standard' : 'minimal';
  const rationale = effort === 'minimal'
    ? 'Use the smallest reliable path; do not broaden context without a material reason.'
    : effort === 'standard'
      ? 'Use targeted context and verification, expanding only when evidence changes the plan.'
      : 'Spend deeper effort on the highest-impact unknowns and verify before committing to completion.';

  const orderedNow = now.sort((a,b) => b.priority-a.priority);
  const orderedRequired = required.sort((a,b) => b.priority-a.priority);
  const orderedLater = [...later].sort((a,b) => b.priority-a.priority);
  return {
    principle: 'Bring only what the current situation justifies, at the moment it becomes useful, with the least effort that can produce sufficient evidence.',
    effort,
    pressure,
    rationale,
    available: available.map(item => ({ id: item.id, why: item.why, timing: item.timing })),
    bring: orderedRequired.map(item => ({ id: item.id, why: item.why, timing: item.timing })),
    activeNow: orderedNow.map(item => ({ id: item.id, why: item.why })),
    deferUntil: orderedLater.map(item => ({ id: item.id, why: item.why })),
    selected: { capabilities: selectedCapabilities, tools: selectedTools, artifacts: selectedArtifacts },
    rules: {
      investigateHighestImpactUnknownFirst: true,
      activateToolsJustInTime: true,
      retrieveOnlyRelevantContext: true,
      reuseVerifiedEvidence: true,
      expandOnMaterialChangeOnly: true,
      stopWhenAcceptanceEvidenceIsSufficient: true
    },
    budget: resourcePlan?.budget ?? null,
    expansion: resourcePlan?.expansion ?? null
  };
}


function buildFailureDiagnosis({ analysis, currentState, situation = {}, coding, projectWork, complexity }) {
  // An observed error message is a failure as much as a failure flag is.
  const failure = situation.failure ?? currentState?.failure ?? currentState?.error ?? currentState?.failing ?? (text(currentState?.errorMessage) || null);
  const observations = uniq([
    ...(Array.isArray(situation.evidence) ? situation.evidence : []),
    ...(Array.isArray(currentState?.observations) ? currentState.observations : []),
    text(currentState?.errorMessage)
  ]);
  const hypotheses = [];
  if (failure) {
    hypotheses.push(
      { id: 'local-cause', statement: 'The immediate failing component or assumption is the primary cause.', discriminatingEvidence: 'Reproduce the failure at the narrowest affected boundary.' },
      { id: 'dependency-cause', statement: 'A dependency, interface, configuration or upstream change caused the observed failure.', discriminatingEvidence: 'Inspect changed dependencies and upstream/downstream contracts.' }
    );
    if (projectWork || coding) {
      hypotheses.push({
        id: 'integration-cause',
        statement: 'The visible failure is a downstream symptom of an integration or state mismatch.',
        discriminatingEvidence: 'Trace the failing path across affected components and compare expected versus observed state.'
      });
    }
  }
  if (analysis.investigationNeeded || analysis.unknownSituation) {
    hypotheses.push({
      id: 'interpretation-cause',
      statement: 'The current understanding of the situation is incomplete.',
      discriminatingEvidence: 'Acquire the smallest evidence that distinguishes the competing interpretations.'
    });
  }
  const uniqueHypotheses = hypotheses.filter((item, index, all) =>
    all.findIndex(other => other.id === item.id) === index
  );
  const nextTest = uniqueHypotheses[0]?.discriminatingEvidence ?? (
    complexity >= 0.55 ? 'Inspect the highest-impact unknown before changing the system.' : 'Check the most direct observable consequence of the current assumption.'
  );
  return {
    active: Boolean(failure) || analysis.investigationNeeded === true || analysis.unknownSituation === true,
    failure: failure ?? null,
    observations,
    hypotheses: uniqueHypotheses,
    competingHypotheses: uniqueHypotheses.length > 1,
    diagnosisPolicy: {
      doNotTreatSymptomAsCause: true,
      testHighestInformationGainFirst: true,
      updateDiagnosisFromEvidence: true,
      doNotRetryIdenticalStrategyWithoutNewEvidence: true
    },
    nextDiscriminatingTest: nextTest,
    diagnosisConfidenceIsNotProof: true
  };
}

function buildChangeImpact({ files, currentState = {}, situation = {}, coding, projectWork }) {
  const changed = uniq([
    ...(Array.isArray(currentState.changedFiles) ? currentState.changedFiles : []),
    ...(Array.isArray(situation.changedFiles) ? situation.changedFiles : []),
    ...(Array.isArray(situation.delta?.changedFiles) ? situation.delta.changedFiles : [])
  ]);
  const changedSet = new Set(changed);
  const affected = changed.length ? changed : [];
  const impacted = [];
  if (affected.some(path => /test|spec/i.test(path))) impacted.push('verification');
  if (affected.some(path => /package|lock|requirements|pyproject|cargo|go\.mod|pom|gradle/i.test(path))) impacted.push('dependencies');
  if (affected.some(path => /config|env|docker|\.github/i.test(path))) impacted.push('configuration');
  if (affected.some(path => /db|schema|migration|sql/i.test(path))) impacted.push('data-boundary');
  if (affected.some(path => /api|route|controller|service/i.test(path))) impacted.push('interfaces');
  if (affected.some(path => /ui|jsx|tsx|html|css|vue|svelte/i.test(path))) impacted.push('presentation');
  if (coding && projectWork && !impacted.length) impacted.push('implementation');
  const reverify = uniq([
    ...(impacted.includes('verification') ? ['changed-tests'] : []),
    ...(impacted.includes('dependencies') ? ['dependency-resolution', 'affected-build'] : []),
    ...(impacted.includes('interfaces') ? ['interface-contracts', 'integration-paths'] : []),
    ...(impacted.includes('data-boundary') ? ['data-integrity'] : []),
    ...(impacted.includes('configuration') ? ['runtime-configuration'] : []),
    ...(impacted.includes('presentation') ? ['affected-ui-behavior'] : []),
    ...(impacted.length ? ['regression-surface'] : [])
  ]);
  return {
    changedArtifacts: affected,
    changedArtifactCount: changedSet.size,
    impactedAreas: uniq(impacted),
    invalidation: {
      selective: true,
      invalidateOnlyAffectedEvidence: true,
      preserveUnaffectedVerifiedEvidence: true,
      requireDependencyRecheck: impacted.includes('dependencies') || impacted.includes('interfaces')
    },
    reverify
  };
}

function buildAdaptiveVerification({ coding, complexity, scale, successCriteria, changeImpact, failureDiagnosis }) {
  const stages = [];
  if (coding) {
    if (failureDiagnosis.active) stages.push('reproduce-diagnosis');
    if (changeImpact.reverify.length) stages.push(...changeImpact.reverify);
    if (!stages.length) stages.push('targeted-tests');
    if (complexity >= 0.55 || scale === 'large-project') stages.push('integration-check');
    if (scale === 'large-project') stages.push('build-check');
    if (complexity >= 0.55 || changeImpact.impactedAreas.length) stages.push('regression-check');
  } else {
    stages.push(failureDiagnosis.active ? 'evidence-check' : 'answer-check');
  }
  const uniqueStages = uniq(stages);
  return {
    required: true,
    stages: uniqueStages,
    drivenBy: {
      successCriteria: successCriteria.length > 0,
      actualChanges: changeImpact.changedArtifactCount > 0,
      observedFailure: failureDiagnosis.active,
      complexityAsFallback: true
    },
    rerunOnChange: true,
    selectiveReverification: true,
    preserveUnaffectedEvidence: true,
    certifyOnlyFromEvidence: true,
    minimumEvidence: successCriteria.length
      ? successCriteria.map(criterion => ({ criterion, evidenceRequired: true }))
      : [{ criterion: 'current result is supported by sufficient evidence', evidenceRequired: true }]
  };
}

function buildSituationalControl({ goal, analysis, currentState, successCriteria, constraints, resourceDecision, failureDiagnosis, changeImpact }) {
  const situation = analysis.situation ?? {};
  return {
    goal,
    state: {
      current: currentState ?? null,
      known: uniq([...(Array.isArray(situation.known) ? situation.known : []), ...(Array.isArray(situation.evidence) ? situation.evidence : [])]),
      unknown: uniq([...(Array.isArray(situation.unknowns) ? situation.unknowns : []), ...(failureDiagnosis.hypotheses.length ? ['root cause is not yet proven'] : [])]),
      changes: changeImpact.changedArtifacts,
      constraints: uniq(constraints),
      successCriteria: uniq(successCriteria)
    },
    decisionBoundary: {
      current: 'choose only the next action that can materially improve the verified outcome',
      unresolved: failureDiagnosis.hypotheses.map(item => item.id),
      evidenceNeeded: failureDiagnosis.nextDiscriminatingTest
    },
    control: {
      observeBeforeAssume: true,
      challengeBeforeCommit: true,
      evidenceBeforeConfidence: true,
      adaptDepthToSituation: true,
      preserveVerifiedTruth: true,
      invalidateSelectiveEvidenceOnly: true,
      stopWhenAcceptanceEvidenceIsSufficient: true
    },
    resources: {
      effort: resourceDecision.effort,
      activeNow: resourceDecision.activeNow.map(item => item.id),
      deferUntilNeeded: resourceDecision.deferUntil.map(item => item.id)
    }
  };
}

function buildMetaReasoning({ goal, analysis, complexity, coding, projectWork, unknown, files, constraints, successCriteria, currentState }) {
  const model = analysis.goalModel ?? {};
  const actions = uniq(model.actions ?? []);
  const explicitConstraints = uniq(constraints);
  const explicitCriteria = uniq(successCriteria);
  const assumptions = [];
  const unknowns = [];
  const conflicts = [];

  if (!explicitCriteria.length) assumptions.push('success criteria are not fully explicit');
  if (!files.length && coding) unknowns.push('repository working set is not yet established');
  if (unknown || analysis.investigationNeeded) unknowns.push('the situation contains unresolved uncertainty');
  // Uncertainty the person states is an unknown, however the goal was classified.
  if (/\b(?:not sure|unsure|don'?t know|do not know|no idea|unclear|not certain)\b/i.test(text(goal))) unknowns.push('the person says the cause or situation is not yet known');
  if (projectWork && !currentState) unknowns.push('current project state is not yet verified');
  if (actions.length > 1) assumptions.push('requested actions may have dependencies that are not yet proven');
  if (analysis.situation?.clarificationRequired === true) unknowns.push('a materially important user clarification may be required');
  if (analysis.safety?.decision === 'refuse') conflicts.push('requested outcome conflicts with platform safety constraints');

  const hypotheses = [];
  if (coding && files.length) hypotheses.push('the failure or requested change may cross file or dependency boundaries');
  if (projectWork) hypotheses.push('the visible request may have hidden integration or regression requirements');
  if (unknown || analysis.investigationNeeded) hypotheses.push('the initial interpretation may be incomplete and should be updated from evidence');

  const alternatives = [];
  if (coding) {
    alternatives.push(
      { id: 'minimal-change', strategy: 'make the smallest verified change that satisfies the goal' },
      { id: 'structural-change', strategy: 'change the underlying structure when evidence shows the local fix would be fragile' }
    );
  } else {
    alternatives.push(
      { id: 'direct-answer', strategy: 'answer from established context and explicitly mark uncertainty' },
      { id: 'investigate-first', strategy: 'retrieve or inspect evidence when uncertainty could materially change the answer' }
    );
  }

  const missingRequirements = [];
  if (!explicitCriteria.length) missingRequirements.push('acceptance criteria');
  if (coding && projectWork && !files.length) missingRequirements.push('complete working-set discovery');
  if (complexity >= 0.55) missingRequirements.push('dependency and integration evidence');
  if (unknown || analysis.investigationNeeded) missingRequirements.push('evidence resolving the highest-impact unknowns');

  const ask = analysis.situation?.clarificationRequired === true
    ? ['Ask only the clarification that materially changes the strategy or safe execution.']
    : [];
  const infer = missingRequirements.length
    ? ['Infer low-risk details from available context; do not silently invent material requirements.']
    : [];
  const investigate = (unknown || analysis.investigationNeeded || complexity >= 0.55)
    ? ['Investigate the highest-impact unknown before committing to an irreversible strategy.']
    : [];

  return {
    goalInterpretation: {
      explicitActions: actions,
      inferredObjective: text(model.need?.objective ?? model.objective ?? goal),
      constraints: explicitConstraints,
      successCriteria: explicitCriteria
    },
    evidenceState: {
      known: uniq([
        files.length ? 'working-set is available' : '',
        currentState ? 'current state is available' : '',
        explicitCriteria.length ? 'success criteria are explicit' : ''
      ]),
      assumptions,
      unknowns,
      conflicts,
      confidenceIsNotEvidence: true
    },
    hypothesisSpace: hypotheses,
    alternatives,
    missingRequirements: uniq(missingRequirements),
    nextDecision: {
      ask,
      infer,
      investigate,
      choose: alternatives.length ? alternatives[0].id : 'direct-answer'
    },
    challenge: {
      enabled: true,
      question: 'What could make the current interpretation wrong or incomplete?',
      triggers: ['new evidence', 'failed verification', 'scope change', 'contradiction', 'unexpected outcome']
    }
  };
}

function buildUnifiedControlLoop({ metaReasoning, management, decisionModel }) {
  return {
    stages: ['understand', 'model-situation', 'reason', 'challenge', 'decide', 'plan', 'execute', 'observe', 'verify', 'replan', 'deliver'],
    adaptive: true,
    oneWorkflow: true,
    decisionGate: 'Only the minimum necessary next action is selected from the current evidence.',
    replanningGate: 'Any material change in evidence, requirements, dependencies or verification outcome reopens reasoning and decision selection.',
    completionGate: 'Completion requires verified evidence against the current success criteria.',
    management,
    decisionModel,
    metaReasoning,
    resourceDecision: metaReasoning.resourceDecision ?? null
  };
}

function buildDecisionModel({ scale, complexity, projectWork, coding, unknown }) {
  return {
    objective: 'maximize verified task completion while minimizing unnecessary work',
    decisions: [
      'what to understand',
      'what context to retrieve',
      'whether to investigate',
      'which capabilities to use',
      'how much work to plan',
      'whether execution is necessary',
      'when to verify',
      'whether to escalate, de-escalate, or replan'
    ],
    policy: {
      adaptiveEscalation: true,
      adaptiveDeescalation: true,
      evidenceBeforeCompletion: true,
      noParallelismBeforeDependencies: true,
      preserveUserControl: true
    },
    current: {
      scale,
      complexity,
      projectWork,
      coding,
      unknown
    }
  };
}

/**
 * Build the same intelligence object for chat and coding. Chat can use it for
 * context depth and response planning; coding can use it for project scope,
 * file selection and verification strategy.
 */
export function buildUnifiedAdaptiveIntelligence(goal, {
  analysis = {},
  files = [],
  attachments = [],
  conversation = [],
  priorWork = [],
  project = null,
  workspace = null,
  currentState = null,
  successCriteria = [],
  constraints = [],
  activeSurface = '',
  executionAvailable = null
} = {}) {
  const workingFiles = normalizeFiles(files, attachments);
  const kinds = fileKinds(workingFiles);
  const flags = analysis.flags ?? {};
  const actions = analysis.goalModel?.actions ?? [];
  const coding = flags.code === true || activeSurface === 'code' || kinds.includes('source');
  const projectWork = coding && (
    workingFiles.length > 1 ||
    kinds.includes('project-archive') ||
    project != null ||
    /\b(entire|whole|full|complete|project|application|app|repository|repo|system|codebase|multi[- ]file|multiple files|across the project|existing project)\b/i.test(goal)
  );
  const broad = /\b(build|rebuild|refactor|migrat|architect|implement|develop|fix|improve|upgrade|complete|entire|whole|full)\w*\b/i.test(goal);
  const unknown = analysis.unknownSituation === true || analysis.investigationNeeded === true;
  const complexity = estimateComplexity({
    files: workingFiles,
    actions,
    attachments: attachments.length,
    broad,
    unknown,
    project: projectWork
  });

  let scale = 'single';
  if (complexity >= 0.8) scale = 'large-project';
  else if (complexity >= 0.55) scale = 'complex';
  else if (complexity >= 0.3) scale = 'multi-file';
  else if (complexity >= 0.12) scale = 'small-work';
  if (projectWork && scale === 'single') scale = 'multi-file';

  const contextSources = uniq([
    workingFiles.length ? 'working-files' : '',
    conversation.length ? 'conversation' : '',
    priorWork.length ? 'prior-work' : '',
    project ? 'project-state' : '',
    workspace ? 'workspace-state' : '',
    currentState ? 'current-state' : '',
    successCriteria.length ? 'success-criteria' : '',
    constraints.length ? 'constraints' : ''
  ]);

  const failureDiagnosis = buildFailureDiagnosis({
    analysis, currentState, situation: analysis.situation ?? {}, coding, projectWork, complexity
  });

  const changeImpact = buildChangeImpact({
    files: workingFiles, currentState: currentState ?? {}, situation: analysis.situation ?? {}, coding, projectWork
  });

  const metaReasoning = buildMetaReasoning({
    goal, analysis, complexity, coding, projectWork, unknown,
    files: workingFiles, constraints, successCriteria, currentState
  });

  const resourceDecision = buildResourceDecision({
    analysis, complexity, coding, projectWork, unknown,
    files: workingFiles,
    conversation,
    priorWork,
    constraints,
    successCriteria,
    currentState,
    resourcePlan: analysis.resourcePlan ?? null
  });

  metaReasoning.resourceDecision = resourceDecision;
  metaReasoning.failureDiagnosis = failureDiagnosis;
  metaReasoning.changeImpact = changeImpact;

  const capabilities = ['goal-understanding', 'situation-modeling', 'assumption-challenge', 'hypothesis-generation', 'alternative-evaluation', 'uncertainty-management', 'adaptive-decisioning'];
  if (coding) capabilities.push('repository-intelligence', 'context-retrieval', 'multi-file-editing');
  if (coding && executionAvailable?.code !== false) capabilities.push('sandbox-execution', 'test-and-build');
  if (coding && (projectWork || complexity >= 0.55)) capabilities.push('dependency-aware-task-graph', 'failure-diagnosis', 'regression-verification');
  if (complexity >= 0.8) capabilities.push('long-running-project-state', 'parallel-agent-ready');
  if (unknown) capabilities.push('dynamic-capability-discovery');
  capabilities.push('adaptive-verification', 'replanning');

  metaReasoning.missingRequirements = uniq(metaReasoning.missingRequirements);
  const verification = buildAdaptiveVerification({
    coding, complexity, scale, successCriteria, changeImpact, failureDiagnosis
  });

  return {
    schemaVersion: '1',
    unified: true,
    surface: activeSurface || (coding ? 'code' : 'chat'),
    coding,
    projectWork,
    scale,
    complexity,
    context: {
      sources: contextSources,
      fileCount: workingFiles.length,
      fileKinds: kinds,
      selectedWorkingSet: workingFiles.slice(0, 200).map(item => item.name)
    },
    execution: {
      strategy: scale === 'single' ? 'direct'
        : scale === 'small-work' ? 'focused'
        : scale === 'multi-file' ? 'dependency-aware'
        : scale === 'complex' ? 'task-graph'
        : 'coordinated-project',
      parallelization: scale === 'large-project' ? 'eligible-after-dependency-analysis' : 'not-needed-yet',
      neverParallelizeUntilDependenciesKnown: true
    },
    capabilities: uniq(capabilities),
    verification,
    state: {
      persistent: projectWork || scale === 'large-project',
      retain: projectWork
        ? ['architecture', 'file-relationships', 'dependencies', 'decisions', 'changes', 'tests', 'failures', 'verification']
        : ['current-goal', 'relevant-context', 'verification']
    },
    adaptation: {
      escalateWhen: ['new dependencies', 'failure', 'scope expansion', 'missing capability', 'new user requirement'],
      deescalateWhen: ['task becomes simpler', 'no execution is needed', 'verification is sufficient'],
      preserveUserControl: true
    },
    reasoning: inferReasoningProfile({
      complexity, broad, unknown, projectWork, coding, actions
    }),
    management: buildManagementModel({
      scale, complexity, projectWork, coding, unknown, executionAvailable
    }),
    decisionModel: buildDecisionModel({
      scale, complexity, projectWork, coding, unknown
    }),
    metaReasoning,
    resourceDecision,
    failureDiagnosis,
    changeImpact,
    situationalControl: buildSituationalControl({ goal, analysis, currentState, successCriteria, constraints, resourceDecision, failureDiagnosis, changeImpact }),
    controlLoop: buildUnifiedControlLoop({
      metaReasoning,
      management: buildManagementModel({ scale, complexity, projectWork, coding, unknown, executionAvailable }),
      decisionModel: buildDecisionModel({ scale, complexity, projectWork, coding, unknown })
    })
  };
}
