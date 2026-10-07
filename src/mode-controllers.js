/**
 * Three surface-specific adaptive controllers over one shared intelligence kernel.
 *
 * Controllers specialize policy, context, tool and verification emphasis. They
 * do not own model state, permissions, lifecycle, memory or completion.
 */
const text = value => String(value ?? '').trim();
const uniq = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

const RUNTIME_PROFILES = Object.freeze({
  'normal-chat': Object.freeze({
    agentCeiling: 3,
    parallelCeiling: 2,
    modelPolicy: 'efficient-first',
    contextBudget: 'minimum-sufficient',
    verificationBudget: 'targeted-unless-risk-or-artifact'
  }),
  code: Object.freeze({
    agentCeiling: 5,
    parallelCeiling: 3,
    modelPolicy: 'efficient-coordination-frontier-build-and-verify',
    contextBudget: 'revision-first-targeted-expansion',
    verificationBudget: 'diff-tests-runtime'
  }),
  research: Object.freeze({
    agentCeiling: 5,
    parallelCeiling: 4,
    modelPolicy: 'efficient-scoping-frontier-evidence-and-critique',
    contextBudget: 'question-first-evidence-gap-expansion',
    verificationBudget: 'claim-source-provenance'
  })
});

const riskPressure = risk => ['critical','high','high-impact','physical','regulated'].includes(text(risk).toLowerCase()) ? 0.9 : 0;

export function workspaceComputePolicy({
  surface = 'normal-chat',
  complexity = 0,
  uncertainty = 0,
  risk = 'medium',
  previousFailure = false,
  remainingBudgetRatio = 1,
  independentWork = 0,
  verificationRequired = false
} = {}) {
  const key = ['normal-chat','code','research'].includes(text(surface).toLowerCase())
    ? text(surface).toLowerCase()
    : 'normal-chat';
  const profile = RUNTIME_PROFILES[key];
  const budget = clamp01(remainingBudgetRatio);
  const pressure = Math.max(
    clamp01(complexity),
    clamp01(uncertainty) * 0.95,
    riskPressure(risk),
    previousFailure ? 0.95 : 0,
    verificationRequired ? 0.62 : 0
  );
  const independent = clamp01(independentWork);
  const conserve = budget < 0.25 && pressure < 0.8 && !previousFailure;

  let recommendedAgents = 1;
  if (key === 'normal-chat') recommendedAgents = pressure >= 0.78 ? 3 : pressure >= 0.52 ? 2 : 1;
  else if (key === 'code') recommendedAgents = pressure >= 0.78 ? 4 : pressure >= 0.48 ? 3 : 1;
  else recommendedAgents = pressure >= 0.72 ? 4 : pressure >= 0.42 ? 3 : 1;

  if (conserve) recommendedAgents = Math.max(1, recommendedAgents - 1);
  recommendedAgents = Math.min(profile.agentCeiling, recommendedAgents);

  const parallelThreshold = key === 'normal-chat' ? 0.68 : key === 'code' ? 0.52 : 0.42;
  let maxParallel = independent >= parallelThreshold && !previousFailure ? profile.parallelCeiling : 1;
  maxParallel = Math.min(maxParallel, recommendedAgents);
  if (conserve) maxParallel = 1;

  return Object.freeze({
    workspace: key,
    pressure: Number(pressure.toFixed(3)),
    budgetMode: conserve ? 'conserve' : 'normal',
    recommendedAgents,
    maxAgents: profile.agentCeiling,
    maxParallel,
    modelPolicy: profile.modelPolicy,
    contextBudget: profile.contextBudget,
    verificationBudget: profile.verificationBudget,
    qualityFloor: verificationRequired || riskPressure(risk) >= 0.9
      ? 'verified-before-completion'
      : key === 'normal-chat' ? 'sufficient-and-clear' : 'evidence-backed',
    stopRule: 'stop-when-acceptance-is-satisfied-and-more-work-has-no-material-value'
  });
}

const CONTROLLERS = Object.freeze({
  'normal-chat': Object.freeze({
    id: 'normal-chat-controller',
    mode: 'normal-chat',
    objective: 'Solve the immediate user need with the minimum reliable work and keep the interaction conversational.',
    context: Object.freeze({
      strategy: 'minimum-sufficient',
      prioritize: Object.freeze(['current-request', 'active-conversation', 'directly-relevant-artifacts']),
      expandWhen: Object.freeze(['missing-critical-evidence', 'material-uncertainty', 'user-requests-depth', 'tool-result-changes-situation'])
    }),
    tools: Object.freeze({
      default: 'just-in-time',
      autonomy: 'bounded-adaptive',
      specialistRule: 'Use no specialist for simple work; add one focused role only when it can materially improve the result.'
    }),
    verification: Object.freeze({
      default: 'lightweight',
      strengthenWhen: Object.freeze(['claims-matter', 'artifact-created', 'file-transformed', 'tool-used', 'high-stakes'])
    }),
    success: 'The stated need is satisfied without unnecessary workspace escalation or work.',
    roles: Object.freeze(['communicator', 'analyst', 'critic'])
  }),

  code: Object.freeze({
    id: 'code-controller',
    mode: 'code',
    objective: 'Make the smallest safe software change against an exact revision and prove the resulting state.',
    context: Object.freeze({
      strategy: 'revision-first',
      prioritize: Object.freeze(['affected-files', 'dependencies', 'tests', 'runtime-evidence', 'current-revision']),
      expandWhen: Object.freeze(['dependency-uncertainty', 'shared-state-impact', 'test-failure', 'stale-revision', 'scope-change'])
    }),
    tools: Object.freeze({
      default: 'targeted',
      autonomy: 'deep-but-scoped',
      specialistRule: 'Use architect/implementer/debugger/test/security/performance roles only when their independent value exceeds coordination cost.'
    }),
    verification: Object.freeze({
      default: 'diff-plus-targeted-tests',
      strengthenWhen: Object.freeze(['broad-change-surface', 'regression-risk', 'security-impact', 'performance-impact', 'runtime-change'])
    }),
    success: 'The approved software change is correct, scoped, reproducible and verified against the relevant project state.',
    roles: Object.freeze(['architect', 'implementer', 'diagnostician', 'debugger', 'test-engineer', 'security-reviewer', 'performance-reviewer'])
  }),

  research: Object.freeze({
    id: 'research-controller',
    mode: 'research',
    objective: 'Reduce the highest-impact unknowns and produce traceable conclusions from sufficient evidence.',
    context: Object.freeze({
      strategy: 'question-first',
      prioritize: Object.freeze(['active-question', 'claim-gaps', 'source-quality', 'freshness', 'conflicts']),
      expandWhen: Object.freeze(['unsupported-claim', 'source-conflict', 'freshness-required', 'scope-expands', 'high-impact-claim'])
    }),
    tools: Object.freeze({
      default: 'bounded-search',
      autonomy: 'deep-but-evidence-bounded',
      specialistRule: 'Use independent researchers/analysts only when source diversity or disagreement materially changes confidence.'
    }),
    verification: Object.freeze({
      default: 'provenance-and-claim-check',
      strengthenWhen: Object.freeze(['conflicting-sources', 'high-impact-claim', 'current-information', 'weak-primary-source'])
    }),
    success: 'Material claims are sufficiently supported, traceable and honestly qualified, with unresolved conflicts visible.',
    roles: Object.freeze(['researcher', 'analyst', 'critic', 'communicator'])
  })
});

export const MODE_CONTROLLER_VERSION = '1';

export function controllerForSurface(surface = 'normal-chat') {
  const key = text(surface).toLowerCase();
  return CONTROLLERS[key] ?? CONTROLLERS['normal-chat'];
}

export function modeControllerCatalog() {
  return Object.values(CONTROLLERS).map(controller => ({
    id: controller.id,
    mode: controller.mode,
    objective: controller.objective,
    roles: [...controller.roles]
  }));
}

export function buildModeControllerContract({
  surface = 'normal-chat',
  situation = {},
  acceptance = {},
  pressure = 0,
  uncertainty = 0,
  complexity = 0,
  risk = 'medium',
  previousFailure = false,
  remainingBudgetRatio = 1
} = {}) {
  const controller = controllerForSurface(surface);
  const normalizedRisk = text(risk) || 'medium';
  const highPressure = clamp01(pressure / 4) >= 0.75;
  const highUncertainty = clamp01(uncertainty) >= 0.55;
  const complex = clamp01(complexity) >= 0.55;
  const limitedBudget = clamp01(remainingBudgetRatio) < 0.25;
  const escalate = previousFailure || highUncertainty || complex || normalizedRisk === 'high' || normalizedRisk === 'critical';
  const verified = acceptance?.verificationSatisfied === true;
  const criteria = uniq(acceptance?.criteria ?? situation?.successCriteria);
  const inferredIndependentWork = Number(
    situation?.independentWork
      ?? situation?.parallelOpportunity
      ?? (controller.mode === 'normal-chat' ? 0 : (complex || highUncertainty || highPressure ? 0.7 : 0))
  );
  const compute = workspaceComputePolicy({
    surface: controller.mode,
    complexity,
    uncertainty,
    risk: normalizedRisk,
    previousFailure,
    remainingBudgetRatio,
    independentWork: inferredIndependentWork,
    verificationRequired: acceptance?.verificationRequired === true || criteria.length > 0
  });
  return Object.freeze({
    version: MODE_CONTROLLER_VERSION,
    controller: controller.id,
    mode: controller.mode,
    objective: controller.objective,
    decision: {
      defaultAction: controller.mode === 'normal-chat' ? 'direct' : 'specialized-next-step',
      broadenContext: escalate,
      recruitSpecialist: compute.recommendedAgents > 1 && (controller.mode !== 'normal-chat' || escalate || highPressure),
      parallelIndependentWork: compute.maxParallel > 1,
      reduceEffort: limitedBudget && !highUncertainty && !previousFailure,
      reuseVerifiedState: verified,
      stopWhenSatisfied: true
    },
    context: controller.context,
    tools: controller.tools,
    verification: controller.verification,
    compute,
    success: {
      statement: controller.success,
      criteriaCount: criteria.length,
      acceptanceAware: criteria.length > 0
    },
    roles: [...controller.roles],
    situation: {
      phase: text(situation?.phase) || 'unknown',
      risk: normalizedRisk,
      uncertainty: clamp01(uncertainty),
      complexity: clamp01(complexity)
    },
    principle: 'Specialize the control policy, not the intelligence kernel: one shared state, one authority model, one verification contract, one model family.'
  });
}
