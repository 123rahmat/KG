/**
 * Three surface-specific adaptive controllers over one shared intelligence kernel.
 *
 * Controllers specialize policy, context, tool and verification emphasis. They
 * do not own model state, permissions, lifecycle, memory or completion.
 */
import { specialistBudgetRatio } from './agent-topology-policy.js';
import { normalChatTaskProfile } from './normal-chat-task-profile.js';
import { controlEngineProfile, SHARED_RUNTIME_CONTRACT } from './work-control-engines.js';
import { buildControlWorkflowPolicy } from './control-workflow-policy.js';

const text = value => String(value ?? '').trim();
const uniq = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const tGoal = s => text(s?.goal ?? s?.question ?? s?.task ?? '');
const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

const RUNTIME_PROFILES = Object.freeze({
  'normal-chat': Object.freeze({
    agentCeiling: 1,
    parallelCeiling: 1,
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
  const budget = specialistBudgetRatio(remainingBudgetRatio) ?? 1;
  const pressure = Math.max(
    clamp01(complexity),
    clamp01(uncertainty) * 0.95,
    riskPressure(risk),
    previousFailure ? 0.95 : 0,
    verificationRequired ? 0.62 : 0
  );
  const independent = clamp01(independentWork);
  // Scarce remaining budget limits optional advisory work regardless of
  // pressure. Required verification still belongs to the parent workflow.
  const conserve = budget < 0.25;

  let recommendedAgents = key === 'normal-chat'
    ? 1 // one primary Gemini call, not one recruited specialist
    : key === 'code'
      ? (pressure >= 0.78 ? 4 : pressure >= 0.48 ? 3 : 1)
      : (pressure >= 0.72 ? 4 : pressure >= 0.42 ? 3 : 1);

  if (conserve) recommendedAgents = 1;
  else if (budget < 0.45) recommendedAgents = Math.min(recommendedAgents, 2);
  recommendedAgents = Math.min(profile.agentCeiling, recommendedAgents);

  const parallelThreshold = key === 'normal-chat' ? 0.68 : key === 'code' ? 0.52 : 0.42;
  let maxParallel = independent >= parallelThreshold && !previousFailure ? profile.parallelCeiling : 1;
  maxParallel = Math.min(maxParallel, recommendedAgents);
  if (conserve || riskPressure(risk) >= 0.9) maxParallel = 1;

  return Object.freeze({
    workspace: key,
    pressure: Number(pressure.toFixed(3)),
    budgetMode: conserve ? 'conserve' : 'normal',
    recommendedAgents,
    maxAgents: profile.agentCeiling,
    maxParallel,
    parallelBasis: maxParallel > 1 ? 'observed-independent-work' : 'no-safe-parallelism-established',
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
      specialistRule: 'Never recruit agentic roles here. Use deeper primary-model reasoning, authorized tools, and verification when the task warrants it.'
    }),
    verification: Object.freeze({
      default: 'lightweight',
      strengthenWhen: Object.freeze(['claims-matter', 'artifact-created', 'file-transformed', 'tool-used', 'high-stakes'])
    }),
    success: 'The stated need is satisfied without unnecessary workspace escalation or work.',
    roles: Object.freeze([])
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
  const highUncertainty = clamp01(uncertainty) >= 0.55;
  const complex = clamp01(complexity) >= 0.55;
  const limitedBudget = (specialistBudgetRatio(remainingBudgetRatio) ?? 1) < 0.25;
  const escalate = previousFailure || highUncertainty || complex || normalizedRisk === 'high' || normalizedRisk === 'critical';
  const verified = acceptance?.verificationSatisfied === true;
  const criteria = uniq(acceptance?.criteria ?? situation?.successCriteria);
  // Complexity or uncertainty alone does not prove work is independent.
  // The run planner must establish safe independent lanes explicitly.
  const observedIndependentWork = Number(
    situation?.independentWork ?? situation?.parallelOpportunity ?? 0
  );
  const compute = workspaceComputePolicy({
    surface: controller.mode,
    complexity,
    uncertainty,
    risk: normalizedRisk,
    previousFailure,
    remainingBudgetRatio,
    independentWork: observedIndependentWork,
    verificationRequired: acceptance?.verificationRequired === true || criteria.length > 0
  });
  const acceptanceMet = acceptance?.satisfied === true;
  // Personal tutoring, business thinking and file work use the same Normal
  // Chat controller; difficulty can increase reasoning depth without adding
  // a workspace, a permanent specialist team, or new permissions.
  const everyday = controller.mode === 'normal-chat'
    ? normalChatTaskProfile({
        goal: situation?.goal, attachments: situation?.attachments ?? situation?.artifacts,
        complexity, uncertainty, risk: normalizedRisk,
        verificationRequired: compute.qualityFloor === 'verified-before-completion'
      }) : null;
  return Object.freeze({
    version: MODE_CONTROLLER_VERSION,
    controller: controller.id,
    mode: controller.mode,
    // Explicitly record the independent decision owner while every controller
    // still uses the same model, run/task lifecycle, worker and tool runtime.
    ...(controller.mode === 'code' || controller.mode === 'research'
      ? { controlEngine: controlEngineProfile(controller.mode) } : {}),
    sharedRuntime: SHARED_RUNTIME_CONTRACT,
    // The controller is genuinely situation-adaptive rather than a static
    // prompt: conditional work types, optional agent cost ceiling and domain
    // evidence requirements are projected inside the one shared workflow.
    ...(controller.mode === 'code' || controller.mode === 'research'
      ? { workflowPolicy: buildControlWorkflowPolicy({
          surface: controller.mode,
          goal: tGoal(situation),
          complexity,
          uncertainty,
          risk: normalizedRisk,
          failedAttempts: previousFailure ? 1 : 0,
          remainingBudgetRatio,
          observedIndependentWork,
          verifiedStateReusable: verified,
          conflictingEvidence: Boolean(situation?.conflicts?.length || situation?.researchWorkspace?.conflicts?.length),
          authorization: {
            required: acceptance?.authorizationRequired === true,
            approved: acceptance?.authorizationSatisfied === true
          },
          acceptanceSatisfied: acceptanceMet
        }) } : {}),
    objective: controller.objective,
    decision: {
      defaultAction: controller.mode === 'normal-chat' ? 'direct' : 'specialized-next-step',
      broadenContext: escalate,
      recruitSpecialist: controller.mode !== 'normal-chat'
        && !acceptanceMet && compute.recommendedAgents > 1,
      parallelIndependentWork: controller.mode !== 'normal-chat'
        && !acceptanceMet && compute.maxParallel > 1,
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
    ...(everyday ? { everyday } : {}),
    situation: {
      phase: text(situation?.phase) || 'unknown',
      risk: normalizedRisk,
      uncertainty: clamp01(uncertainty),
      complexity: clamp01(complexity)
    },
    principle: 'One KG system and shared task lifecycle; separate Coding and Research control policies, scoped agentic work, task graphs, and acceptance.'
  });
}
