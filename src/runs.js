/**
 * Runs: the server's copy of a workflow.
 *
 * This module exists because of a specific failure. When the plan lives in
 * the client and is posted back to advance it, a caller can send a graph with
 * every dependency already marked complete and have the server record
 * "verified" against no evidence at all. A dependency check on client-supplied
 * state protects nothing.
 *
 * So the server owns the graph. A run is created here, its tasks are rows, and
 * every advance re-reads them under a row lock and decides from stored state.
 * The client names a task and supplies evidence; it never supplies status.
 */

import crypto from 'node:crypto';
import { adaptAgentTopology } from './adaptive-agents.js';
import { transaction } from './db.js';
import { recordUsage } from './usage.js';
import { decideAdvance, planGoal, nextTask, policyAllows, CODE_FOLLOW_UP } from './core.js';
import { RunError } from './run-error.js';
import { executionTargetsFor, defaultExecutionRequirements } from './execution.js';
import { normalizeCapabilityDiscovery, verificationContract } from './capabilities.js';
import { buildSituationModel, evolveSituation, situationQualityGate } from './situation.js';
import { adaptiveBudgetStatus, adaptiveBudgetForRun, reconcileAdaptiveTransition } from './adaptive-control.js';
import { adaptiveEffortProfile } from './adaptive-efficiency.js';
import { buildAcceptanceContract } from './adaptive-decision-authority.js';
import { buildUnifiedAdaptiveWorkflow, reassessUnifiedWorkflow, completionGate, unifiedRecoveryDecision } from './unified-adaptive-workflow.js';
import { projectPersistedTaskGraph } from './persisted-task-projection.js';
import { composeOpenWorldDecision } from './open-world-task-graph.js';
import { updateAdaptiveRuntimeState, recoveryLesson } from './adaptive-runtime-state.js';
import { createResearchWorkspaceState, updateResearchWorkspaceState } from './research-workspace.js';
import { buildUnifiedWorkContext, applyWorkChange } from './unified-work-context.js';
import { reevaluateSituationGovernance } from './situation-governance.js';
import { MAX_CODE_REPAIRS, canRepair, builtCode, staleAfterRepair, repairRecord, hasCode, isProject, codeFiles, deletedPaths, mergeFix, repairsThisAttempt, normalizePackage } from './code-workflow.js';
import { normalizeNextStep } from './step-plan.js';
import { ventureIntent, ventureDiscoveryStep } from './venture-ideation.js';
import { evidenceNextTaskGate } from './evidence-next-task-gate.js';
import { buildRequirementModel, normalizeRequirementModel, reconcileRequirements, nextRequirement, requirementAction, gradedCriteria } from './requirements.js';
import { insertTask, insertTasks, loadTasks } from './run-graph.js';
import { present, summarize, encodeCursor, decodeCursor, normalizeUnderstanding, isEmpty } from './run-view.js';
import { workspacePath } from './workspace-path.js';

const TERMINAL = new Set(['complete', 'failed', 'blocked', 'exhausted']);
// Generic "continue" steps a run may chain before its result is checked.
const MAX_GENERIC_STEPS = 6;

/** Tasks whose whole purpose is recording reality must record something. */
const EVIDENCE_REQUIRED = new Set(['clarify', 'observe', 'reassess', 'verify']);

// External execution cannot be claimed through the manual advance route.
// A follow-up that points at the work already on the table.
const FOLLOW_UP_ON_WORK = /\b(?:the|this|that|these|those|my|your|our|same) (?:files?|project|code|zip|folder|document|table|sheet|spreadsheet|data|report|app|function|module|tests?|script|program|repo(?:sitory)?)\b/i;

/** The project as the previous turn left it: its overlay plus the files it wrote. */
function continuedProject(previous) {
  const files = new Map((Array.isArray(previous?.adaptation?.projectOverlay) ? previous.adaptation.projectOverlay : [])
    .filter(file => file && typeof file.path === 'string').map(file => [file.path, String(file.content ?? '')]));
  const built = [...(previous?.completed ?? [])].reverse().find(item => item.id === 'build-code')?.evidence?.structured;
  if (built && isProject(built)) {
    for (const path of deletedPaths(built)) files.set(path, null);
    for (const file of codeFiles(built)) files.set(file.path, file.content);
  }
  return [...files].map(([path, content]) => ({ path, content }));
}

const EXECUTION_TASKS = new Set(['code', 'tool', 'investigate']);
// Stages whose evidence is reassessed before the result is verified.
const REASSESSED_STAGES = new Set(['code', 'tool', 'investigate', 'prototype']);
// Stages the plan can select; after one, the next planned stage follows.
const PLANNED_STAGES = new Set(['discover-capabilities', 'investigate', 'respond', 'code', 'prototype']);

// Planning a new build with the person: a plan they can read, then their
// agreement (with any changes), then the code.
const BUILD_PLAN_SCHEMA = Object.freeze({
  summary: 'string',
  features: 'string[]',
  files: 'string[]',
  tests: 'string[]',
  assumptions: 'string[]',
  selectedIdea: 'string',
  targetCustomer: 'string',
  valueProposition: 'string',
  validationExperiment: 'string',
  mvpFeatures: 'string[]',
  nonGoals: 'string[]',
  risks: 'string[]',
  questions: 'string[]',
  keepExisting: 'string[]',
  removeExisting: 'string[]',
  addNew: 'string[]',
  changeExisting: 'string[]'
});
const BUILD_PLAN_STEP = Object.freeze({
  type: 'plan', title: 'Plan the build with you', buildPlan: true,
  purpose: 'Propose a concrete plan for what will be built, for the person to agree before any code is written: what it does, its parts and files, how it will be tested, the assumptions made, and the few questions whose answers would change the build. For existing code, explicitly review the current codebase and propose what to keep, remove, add and change; these are suggestions until the person approves them.'
});
const EXISTING_CODE_PLAN_STEP = Object.freeze({
  type: 'plan', title: 'Review and re-plan the existing code', buildPlan: true, existingCodePlan: true,
  purpose: 'Read the existing codebase and propose a concrete change plan. Clearly separate what should be kept, removed, added and changed, explain why, identify affected files and tests, and wait for the person to approve or modify those choices before any code is changed.'
});
const PLAN_AGREEMENT_STEP = Object.freeze({
  type: 'approval', title: 'Agree the plan', planAgreement: true,
  purpose: 'Read the plan. Build it as it is, or say what to change or answer its questions first; no code is written until you agree.',
  approvalFor: { type: 'code', title: 'Write the code',
    purpose: 'Write the code to the plan the person agreed, with every change or answer they gave, and its automated tests, as a reviewable package; do not claim that it has run.' }
});
// "just build it", "skip the plan": the person has said not to plan first.
const SKIP_PLANNING = /\b(?:just (?:build|write|code|make|do) it|skip (?:the )?plan(?:ning)?|no (?:need to )?plan|without (?:a )?plan|don'?t ask)\b/i;
const BUILD_WORDS = /\b(?:system|app|application|platform|website|web ?site|web service|api|backend|frontend|game|dashboard|chat ?bot|software|cli|command[- ]line (?:app|tool))\b/i;

const concretePlanPath = value => {
  const candidate = text(value);
  if (!workspacePath(candidate)) return null;
  // Natural-language choices such as "auth module" are intentionally not
  // treated as hard path contracts. Exact-looking paths/extensions are.
  return candidate.includes('/')
    || candidate.startsWith('.')
    || /\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(candidate)
    ? candidate
    : null;
};

export function approvedPlanPaths(approvedPlan = {}) {
  const proposed = Array.isArray(approvedPlan?.proposedFiles) ? approvedPlan.proposedFiles : [];
  const choices = approvedPlan?.planChoices && typeof approvedPlan.planChoices === 'object'
    ? Object.values(approvedPlan.planChoices).flatMap(value => Array.isArray(value) ? value : [])
    : [];
  return [...new Set([...proposed, ...choices].map(concretePlanPath).filter(Boolean))];
}

export function approvedPlanScopeDrift(approvedPlan, structured) {
  if (!approvedPlan || typeof approvedPlan !== 'object' || !structured || typeof structured !== 'object') return [];
  const allowed = new Set(approvedPlanPaths(approvedPlan));
  if (!allowed.size) return [];
  return [...new Set([
    ...codeFiles(structured).map(file => file.path),
    ...deletedPaths(structured)
  ].map(text).filter(Boolean))].filter(path => !allowed.has(path));
}

/**
 * Whether a run is a new thing to build: code-making work that does not
 * start from the person's files or an earlier turn's project, and is more
 * than a snippet (or names a system, app or tool).
 */
function newBuild(run) {
  const adaptation = run.adaptation ?? {};
  if (adaptation.ownWork || (adaptation.attachments?.length ?? 0) > 0 || (run.situation?.artifacts?.length ?? 0) > 0) return false;
  if ((adaptation.projectOverlay?.length ?? 0) > 0) return false;
  const goal = String(run.goal ?? '');
  if (SKIP_PLANNING.test(goal)) return false;
  return adaptation.scale !== 'small' || BUILD_WORDS.test(goal);
}

export function codePlanApprovalRequired(run = {}) {
  // An explicit idea-to-software project must agree its MVP scope after
  // exploration even when it would otherwise be classified as a small build.
  if (ventureIntent({goal:run.goal,surface:run.surface||run.adaptation?.primarySurface}).buildAfterDiscovery) return true;
  const adaptation = run.adaptation ?? {};
  const existingCode = (adaptation.attachments?.length ?? 0) > 0
    || (adaptation.projectOverlay?.length ?? 0) > 0
    || (run.situation?.artifacts?.length ?? 0) > 0
    || adaptation.ownWork === true;
  return existingCode || newBuild(run);
}
const HUMAN_COMPLETABLE_TASKS = new Set(['investigate', 'tool']);
const CONVERSATION_ID = /^[A-Za-z0-9-]{8,64}$/;

const MAX_PAGE = 100;
// Recent runs read per chat-list page: enough for pages of short chats.
const RECENT_WINDOW_FACTOR = 20;
// The complete answer, used when the recent window cannot prove the page.
const FULL_CONVERSATIONS_SQL = `
  SELECT conversation_id, single, title, messages, visibility, state, surface, project_id, updated_at
    FROM (
      SELECT COALESCE(conversation_id, id::text) AS conversation_id,
             conversation_id IS NULL AS single,
             first_value(goal) OVER (PARTITION BY COALESCE(conversation_id, id::text) ORDER BY created_at ASC, id ASC) AS title,
             count(*) OVER (PARTITION BY COALESCE(conversation_id, id::text))::int AS messages,
             visibility, state, surface, project_id, updated_at, id,
             row_number() OVER (PARTITION BY COALESCE(conversation_id, id::text) ORDER BY updated_at DESC, id DESC) AS latest
        FROM runs
       WHERE workspace_id = $1
         AND (visibility = 'workspace' OR principal_id = $2)
    ) conversations
   WHERE latest = 1
   ORDER BY updated_at DESC, id DESC
   LIMIT $3`;
const text = value => String(value ?? '').trim();
/** Stable project identity used to prevent accidental cross-project continuation. */
function projectContextKey(project, attachments = []) {
  const p = project && typeof project === 'object' ? project : {};
  const explicit = text(p.id || p.key || p.root || p.path || p.name);
  const names = Array.isArray(attachments)
    ? attachments.map(item => text(typeof item === 'string' ? item : item?.name || item?.path)).filter(Boolean).sort()
    : [];
  const basis = explicit || (names.length ? names.join('|') : '');
  return basis ? crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 24) : null;
}


export { RunError, projectContextKey };

const normalizeWorkspaceSurface = value => {
  const surface = text(value).toLowerCase();
  return ['chat', 'visual', 'design'].includes(surface) ? 'normal-chat' : surface;
};
const previousWorkspaceSurface = state => normalizeWorkspaceSurface(
  state?.surface || state?.adaptation?.modeController?.mode
  || state?.adaptation?.modeController?.surface
  || state?.adaptation?.unifiedAdaptiveWorkflow?.surface
  || state?.adaptation?.primarySurface
);

/** Conversation history is shared; implicit controller/project state is scoped. */
export function workspaceStateFor(previousState, { surface = '', projectKey = null } = {}) {
  if (!previousState) return null;
  const previousSurface = previousWorkspaceSurface(previousState);
  const nextSurface = normalizeWorkspaceSurface(surface);
  const previousKey = text(previousState.adaptation?.projectContext?.key);
  if (nextSurface && previousSurface && nextSurface !== previousSurface) return null;
  if (projectKey && previousKey && text(projectKey) !== previousKey) return null;
  return previousState;
}

export class RunStore {
  constructor(pool, { maxAttempts = 5, maxEvidenceBytes = 512 * 1024, maxGoalChars = 32_000, audit, capabilities } = {}) {
    this.pool = pool;
    this.maxAttempts = maxAttempts;
    this.maxEvidenceBytes = maxEvidenceBytes;
    this.maxGoalChars = maxGoalChars;
    this.audit = audit;
    this.capabilities = capabilities;
  }

  /** Plan a goal and persist the result as a run. */
  async create(scope, principal, {
    goal, policies, activeSurface, timeZone, runtimeMode = 'auto',
    workspaceType = 'personal', jurisdiction = '',
    user = null, workspace = null, project = null, projectId = null, files = [], priorWork = [],
    constraints = [], resources = [], requirements = [], successCriteria = [], outputs = [],
    environment = null, language = '', skillLevel = '', preferences = [], currentState = null,
    completedSteps = [], failedSteps = [], evidence = [], questions = [],
    dataSources = [], connections = [], connectedServices = [], verifiedConnections = [], privacyConsent = {}, need = null, adaptiveControl = {},
    commitments = [], dependencies = [], dueAt = null, startAt = null, userBehavior = {}, capacity = null, availability = null, competingCommitments = [], now = null, creationMode = '', visibility = 'private',
    classifierHints = null, classification = null, conversationId = null, attachments = [],
    executionAvailable = null, modelSelection = null, learnedSkills = [],
    // The ethical side of the situation (safety.js ethicsOf): every step adapts to it.
    ethics = null
  } = {}, { requestId } = {}) {
    const goalText = text(goal);
    const conversation = text(conversationId);
    if (conversation && !CONVERSATION_ID.test(conversation)) {
      throw new RunError('conversationId must be 8-64 letters, digits or dashes', { status: 400, code: 'invalid-conversation' });
    }
    // Earlier turns come from runs this person may already see: the same
    // workspace and visibility rule as every other read.
    const history = conversation ? await this.conversationHistory(scope, conversation) : [];
    const previousState = conversation ? await this.conversationState(scope, conversation) : null;
    if (!goalText) throw new RunError('A goal is required', { status: 400, code: 'needs-input' });
    if (Buffer.byteLength(goalText, 'utf8') > this.maxGoalChars) {
      throw new RunError('Goal is too large for one workflow run', { status: 413, code: 'goal-too-large' });
    }

    const linkedProjectId = text(projectId);
    if (linkedProjectId) {
      const { rows: [linkedProject] } = await this.pool.query(
        `SELECT id
           FROM projects
          WHERE id = $1
            AND workspace_id = $2
            AND (visibility = 'workspace' OR principal_id = $3)
            AND state = 'active'
          LIMIT 1`,
        [linkedProjectId, scope.workspaceId, scope.principalId]
      );
      if (!linkedProject) {
        throw new RunError('Project not found or not accessible in this workspace.', {
          status: 404,
          code: 'project-not-found'
        });
      }
    }
    // A follow-up continues the previous project only when the project
    // identity is the same. This prevents two local projects in one chat from
    // silently inheriting each other's files/state.
    const requestedProjectKey = projectContextKey(project, attachments)
      || (linkedProjectId ? 'project:' + linkedProjectId : null);
    const previousSurface = previousWorkspaceSurface(previousState);
    const explicitSurface = normalizeWorkspaceSurface(activeSurface);
    const inheritedSurface = explicitSurface || previousSurface;
    let projectOverlay = null;
    let projectContextSwitched = Boolean(requestedProjectKey && previousState?.adaptation?.projectContext?.key
      && requestedProjectKey !== previousState.adaptation.projectContext.key);
    let workspaceState = workspaceStateFor(previousState, { surface: inheritedSurface, projectKey: requestedProjectKey });
    if (workspaceState && !attachments.length && (CODE_FOLLOW_UP.test(goalText) || FOLLOW_UP_ON_WORK.test(goalText))) {
      const hasFiles = state => Array.isArray(state?.adaptation?.attachments) && state.adaptation.attachments.length > 0;
      const effectiveProjectKey = requestedProjectKey || text(workspaceState.adaptation?.projectContext?.key) || null;
      const withFiles = hasFiles(previousState) ? previousState : await this.conversationState(scope, conversation, {
        withFiles: true, surface: inheritedSurface, projectKey: effectiveProjectKey
      });
      const previousProjectKey = text(withFiles?.adaptation?.projectContext?.key) || null;
      const compatible = !effectiveProjectKey || !previousProjectKey || effectiveProjectKey === previousProjectKey;
      if (compatible && workspaceStateFor(withFiles, { surface: inheritedSurface, projectKey: effectiveProjectKey }) && hasFiles(withFiles)) {
        attachments = withFiles.adaptation.attachments;
        projectOverlay = continuedProject(withFiles);
      } else if (requestedProjectKey && previousProjectKey && requestedProjectKey !== previousProjectKey) {
        projectContextSwitched = true;
      }
    }
    const situationContext = {
      user, workspace, project, files, priorWork: workspaceState?.completed?.length ? [...priorWork, ...workspaceState.completed] : priorWork, constraints, resources, requirements,
      attachedArtifacts: attachments.map(item => text(typeof item === 'string' ? item : item?.name)).filter(Boolean),
      successCriteria, outputs, environment, language, skillLevel, preferences, currentState: currentState ?? workspaceState,
      completedSteps, failedSteps, evidence, questions, dataSources, connections, connectedServices,
      commitments, dependencies, dueAt, startAt, userBehavior, capacity, availability, competingCommitments, now, creationMode,
      privacyConsent, need, adaptiveControl, verifiedConnections, workspaceType, runtimeMode,
      activeSurface: inheritedSurface, jurisdiction, classifierHints, modelSelection, learnedSkills
    };
    let situation = buildSituationModel(goalText, situationContext);
    if (ethics) situation.ethics = ethics;
    let plan = planGoal(goalText, {
      policies, activeSurface: inheritedSurface, timeZone, runtimeMode, workspaceType, jurisdiction,
      conversation: history,
      attachments,
      executionAvailable,
      ethics,
      ...situationContext
    });
    if (plan.state === 'needs-input') {
      throw new RunError('More detail is needed before this can be planned', {
        status: 400, code: 'needs-input', detail: { questions: plan.questions }
      });
    }

    const plannedSurface = text(plan.surface === 'chat' ? 'normal-chat' : plan.surface) || 'normal-chat';
    const surfaceContextSwitched = Boolean(previousState && previousSurface && previousSurface !== plannedSurface);
    if (surfaceContextSwitched) {
      // Conversation history remains continuous, but workspace-specific
      // state never crosses a workspace boundary implicitly.
      if (projectOverlay !== null) {
        attachments = [];
        projectOverlay = null;
      }
      projectContextSwitched = true;
    }
    if (workspaceState && !workspaceStateFor(workspaceState, { surface: plannedSurface, projectKey: requestedProjectKey })) {
      // An implicit intent transition is resolved by the planner. Rebuild its
      // context without the previous workspace before persisting any state.
      workspaceState = null;
      situationContext.currentState = currentState ?? null;
      situationContext.priorWork = priorWork;
      situationContext.attachedArtifacts = attachments.map(item => text(typeof item === 'string' ? item : item?.name)).filter(Boolean);
      situationContext.activeSurface = plannedSurface;
      situation = buildSituationModel(goalText, situationContext);
      if (ethics) situation.ethics = ethics;
      plan = planGoal(goalText, {
        policies, timeZone, conversation: history, attachments, executionAvailable, ethics,
        ...situationContext
      });
      if (plan.state === 'needs-input') {
        throw new RunError('More detail is needed before this can be planned', {
          status: 400, code: 'needs-input', detail: { questions: plan.questions }
        });
      }
    }

    const requirementModel = plan.workflow === 'direct'
      ? { version: 1, items: [], overallProgress: 100, completedCount: 0, requiredCount: 0, unresolvedCount: 0, blockedCount: 0, completionReady: true, nextRequirementId: null }
      : buildRequirementModel({
          goal: goalText,
          requirements,
          successCriteria: [...successCriteria, ...(situation.successCriteria ?? [])],
          outputs,
          constraints
        });

    if (classification) {
      plan.adaptation.classification = { ...plan.adaptation.classification, ...classification };
    }
    plan.adaptation.workflow = plan.workflow;
    // Server-owned maturity contract: agentic breadth and rigor adapt to the situation.
    plan.adaptation.effortProfile = adaptiveEffortProfile({
      complexity: Number(situation.complexity ?? plan.adaptation?.complexity ?? 0),
      uncertainty: Number(situation.uncertainty ?? 0),
      risk: situation.risk ?? 'medium',
      verificationGap: Number(situation.verificationGap ?? 0),
      failureCount: Array.isArray(failedSteps) ? failedSteps.length : 0,
      irreversible: situation.irreversible === true,
      externalSideEffect: situation.externalSideEffect === true,
      physical: situation.physical === true || situation.flags?.physical === true,
      regulated: situation.regulated === true || situation.flags?.regulated === true,
      peopleDecision: situation.peopleDecision === true || situation.flags?.highImpact === true
    });
    const acceptanceContract = buildAcceptanceContract({
      goal: goalText,
      criteria: [...successCriteria, ...(situation.successCriteria ?? [])],
      evidenceRequired: situation.evidenceRequired ?? [],
      evidence,
      authorizationRequired: situation.authorizationRequired === true,
      authorizationSatisfied: situation.authorizationSatisfied !== false,
      verificationRequired: plan.adaptation.effortProfile.maturity?.independentVerificationRequired === true,
      verificationSatisfied: false
    });
    plan.adaptation.acceptanceContract = acceptanceContract;
    // The unified workflow kernel is the single authority calculation. Reuse
    // its profile, acceptance, behavior and decision projection instead of
    // calculating equivalent contracts in parallel.
    plan.adaptation.unifiedAdaptiveWorkflow = buildUnifiedAdaptiveWorkflow({
      goal: goalText,
      surface: plan.surface === 'chat' ? 'normal-chat' : plan.surface,
      situation: {
        ...situation,
        surface: plan.surface === 'chat' ? 'normal-chat' : plan.surface,
        riskScore: Number(situation.riskScore ?? 0),
        consequence: Number(situation.consequence ?? 0)
      },
      acceptance: acceptanceContract,
      evidence,
      failedAttempts: Array.isArray(failedSteps) ? failedSteps.length : 0,
      profile: plan.adaptation.effortProfile
    });
    plan.adaptation.adaptiveBehavior = {
      ...plan.adaptation.unifiedAdaptiveWorkflow.behavior,
      modeController: plan.adaptation.unifiedAdaptiveWorkflow.modeController,
      executionStrategy: plan.adaptation.unifiedAdaptiveWorkflow.execution
    };
    plan.adaptation.modeController = plan.adaptation.unifiedAdaptiveWorkflow.modeController;
    plan.adaptation.adaptiveDecision = plan.adaptation.unifiedAdaptiveWorkflow.authority;

    // Later steps (schedules, dates) work in the person's own time zone.
    plan.adaptation.timeZone = plan.context?.timeZone ?? 'UTC';
    if (history.length) plan.adaptation.conversation = history;
    const projectKey = requestedProjectKey
      || text(workspaceState?.adaptation?.projectContext?.key)
      || (attachments.length ? projectContextKey(null, attachments) : null);
    const workspaceSourceId = text(attachments.find(item => item?.sourceId)?.sourceId) || null;
    plan.adaptation.projectContext = {
      key: projectKey,
      explicit: Boolean(project),
      switched: projectContextSwitched,
      isolation: 'conversation-follow-ups require a compatible project identity before reusing prior project files'
    };
    plan.adaptation.unifiedWorkContext = buildUnifiedWorkContext({
      goal: goalText,
      project,
      attachments,
      files,
      projectOverlay,
      situation,
      currentState: currentState ?? workspaceState,
      identityOverride: projectKey ? {
        key: projectKey,
        source: project || linkedProjectId ? 'project' : attachments.length ? 'attachments' : 'continued-project'
      } : null,
      conversationId: conversation || null,
      multiAgent: {
        // Conversation remains direct even if the user's/global profile
        // requests "always" specialists. Code and Research keep that option.
        mode: plannedSurface==='normal-chat' ? 'off'
          : adaptiveControl?.multiAgentMode ?? adaptiveControl?.multiAgent ?? 'auto',
        maxAgents: plannedSurface==='normal-chat' ? 1
          : adaptiveControl?.maxAgents ?? adaptiveControl?.multiAgentMaxAgents ?? 11
      }
    });
    if (previousState) {
      plan.adaptation.continuation = {
        mode: surfaceContextSwitched ? 'workspace-switch' : projectContextSwitched ? 'context-switch' : 'incremental',
        previousRunId: previousState.runId,
        previousState: previousState.state,
        currentResultAvailable: true,
        rule: projectContextSwitched
          ? 'Do not reuse the previous project overlay; start from the newly identified project context.'
          : 'Start from the current conversation project state; expand scope only when the new request requires it.'
      };
    }
    if (attachments.length) plan.adaptation.attachments = attachments;
    if (workspaceSourceId) plan.adaptation.workspaceSourceId = workspaceSourceId;
    const usesResearchWorkspace = plan.surface === 'research'
      || (Array.isArray(plan.adaptation?.surfaces) && plan.adaptation.surfaces.includes('research'));
    if (usesResearchWorkspace) {
      plan.adaptation.researchWorkspace = createResearchWorkspaceState({
        goal: goalText,
        question: goalText,
        prior: workspaceState?.adaptation?.researchWorkspace ?? null,
        conversationId: conversation || null
      });
    }
    if (projectOverlay?.length) plan.adaptation.projectOverlay = projectOverlay;
    // Later stages (understanding) may add work only this deployment can run.
    if (executionAvailable) plan.adaptation.executionAvailable = executionAvailable;
    // Initial work is projected from the very tasks about to be persisted.
    // This is a view, never an alternative scheduler or permission source.
    const initialGraph = projectPersistedTaskGraph(plan.tasks);
    const initialUnified = plan.adaptation.unifiedAdaptiveWorkflow;
    if (initialUnified) {
      plan.adaptation.unifiedAdaptiveWorkflow = {
        ...initialUnified,
        taskGraph: initialGraph,
        openWorld: composeOpenWorldDecision({
          goal: goalText, situation, graph: initialGraph,
          acceptance: initialUnified.acceptance
        })
      };
    }
    const id = crypto.randomUUID();
    const maxTokens = plan.governance.constraints.maxTokens;

    return transaction(this.pool, async client => {
      await client.query(
        `INSERT INTO runs (id, workspace_id, principal_id, goal, surface, state,
                           intent, capabilities, governance, adaptation, situation, requirements, project_id, visibility, attempt, max_attempts, max_tokens,
                           conversation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $16, $17)`,
        [id, scope.workspaceId, principal.id, plan.goal, plan.surface, plan.state,
         JSON.stringify(plan.intent), JSON.stringify(plan.capabilities),
         JSON.stringify(plan.governance), JSON.stringify(plan.adaptation), JSON.stringify(situation), JSON.stringify(requirementModel),
         linkedProjectId || null,
         ['private', 'workspace'].includes(text(visibility)) ? text(visibility) : 'private',
         this.maxAttempts, maxTokens, conversation || null]
      );
      const tasks = plan.workflow === 'direct' ? plan.tasks : plan.tasks.map((task, index) => index === 0
        ? { ...task, metadata: { ...(task.metadata ?? {}), requirementIds: requirementModel.items.filter(item => item.kind === 'outcome').map(item => item.id) } }
        : task);
      await insertTasks(client, id, tasks);

      await this.audit?.record({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'run.create',
        target: id,
        outcome: plan.state === 'blocked' ? 'denied' : 'allowed',
        detail: {
          surface: plan.surface,
          intent: plan.intent.kind,
          blocked: plan.capabilities.blocked,
          governance: plan.governance.status
        },
        requestId
      }, client);

      return this.load(client, scope, id);
    });
  }

  async get(scope, id) {
    return this.load(this.pool, scope, text(id));
  }

  /**
   * Issue a one-time server-side local execution challenge. Only a hash of
   * the nonce is persisted; the signed plaintext challenge is returned to the
   * caller and can be consumed exactly once by advance().
   */
  async issueExecutionChallenge(scope, principal, runId, taskId, { attempt, nonce, expiresAt, executionId, payloadDigest } = {}) {
    const nonceText = text(nonce);
    const expires = text(expiresAt);
    if (!nonceText || !expires) return false;
    const nonceHash = crypto.createHash('sha256').update(nonceText, 'utf8').digest('hex');

    return transaction(this.pool, async client => {
      const { rows: [run] } = await client.query(
        `SELECT * FROM runs
           WHERE id = $1 AND workspace_id = $2
             AND (visibility = 'workspace' OR principal_id = $3)
           FOR UPDATE`,
        [text(runId), scope.workspaceId, scope.principalId]
      );
      if (!run || TERMINAL.has(run.state) || Number(run.attempt) !== Number(attempt)) return false;

      const tasks = await loadTasks(client, run.id);
      const next = nextTask(tasks);
      const task = tasks.find(item => item.id === text(taskId));
      if (!task || !next || next.id !== task.id) return false;

      const metadata = {
        ...(task.metadata ?? {}),
        executionChallenge: {
          attempt: Number(run.attempt),
          executionId: text(executionId),
          principalId: principal.id,
          nonceHash,
          payloadDigest: text(payloadDigest),
          expiresAt: expires
        }
      };
      await client.query(
        `UPDATE run_tasks SET metadata = $3::jsonb
           WHERE run_id = $1 AND id = $2`,
        [run.id, task.id, JSON.stringify(metadata)]
      );
      return true;
    });
  }

  /**
   * The earlier turns of a conversation, oldest first: what the person asked
   * and what was delivered. Capped so a long chat cannot flood the prompt.
   */
  async conversationHistory(scope, conversationId, { turns = 8, chars = 2000 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT r.goal,
              (SELECT t.evidence FROM run_tasks t
                WHERE t.run_id = r.id
                  AND t.status = 'complete'
                  AND t.type IN ('deliver', 'respond', 'prototype', 'investigate', 'code')
                ORDER BY (t.type IN ('deliver', 'respond', 'prototype')) DESC, t.position DESC
                LIMIT 1) AS evidence,
              -- Before anything is delivered, the latest recorded progress
              -- is what the chat knows about where the work stands.
              (SELECT t.summary FROM run_tasks t
                WHERE t.run_id = r.id AND t.status = 'complete' AND COALESCE(t.summary, '') <> ''
                ORDER BY t.completed_at DESC NULLS LAST, t.position DESC
                LIMIT 1) AS progress
         FROM runs r
        WHERE r.workspace_id = $1
          AND (r.visibility = 'workspace' OR r.principal_id = $2)
          AND r.conversation_id = $3
        ORDER BY r.created_at DESC
        LIMIT $4`,
      [scope.workspaceId, scope.principalId, conversationId, turns]
    );
    const answerOf = evidence => text(evidence?.text)
      || text(evidence?.findings)
      || (evidence?.structured?.source ? `${text(evidence.structured.language)} code:\n${text(evidence.structured.source)}` : '')
      || (isProject(evidence?.structured) ? `${text(evidence.structured.language)} project: ${codeFiles(evidence.structured).map(file => file.path).join(', ')}` : '');
    return rows.reverse().map(row => ({
      user: row.goal.slice(0, chars),
      assistant: answerOf(row.evidence).slice(0, chars)
        || (text(row.progress) ? `(not delivered yet; progress so far: ${text(row.progress).slice(0, chars)})` : '(no answer was delivered)')
    }));
  }

  /**
   * The latest verified workspace state for a conversation. Follow-up turns
   * should inherit the current result instead of treating the chat as a new
   * isolated task. The state is deliberately compact: the full artifacts stay
   * in their normal stores and are selected later by the adaptive resource
   * planner.
   */
  async conversationState(scope, conversationId, { withFiles = false, surface = '', projectKey = null } = {}) {
    // withFiles: the latest turn that worked on files, so a follow-up after
    // small talk ("thanks", then "now add a test") still finds the project.
    const { rows: [run] } = await this.pool.query(
      `SELECT id, goal, surface, state, adaptation, situation, requirements, updated_at
         FROM runs
        WHERE workspace_id = $1
          AND (visibility = 'workspace' OR principal_id = $2)
          AND conversation_id = $3
          ${withFiles ? "AND CASE WHEN jsonb_typeof(adaptation->'attachments') = 'array' THEN jsonb_array_length(adaptation->'attachments') ELSE 0 END > 0" : ''}
          AND ($4::text IS NULL OR surface = $4 OR ($4 = 'normal-chat' AND surface IN ('chat', 'visual', 'design')))
          AND ($5::text IS NULL OR adaptation->'projectContext'->>'key' = $5)
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
      [scope.workspaceId, scope.principalId, conversationId, normalizeWorkspaceSurface(surface) || null, text(projectKey) || null]
    );
    if (!run) return null;
    const { rows: tasks } = await this.pool.query(
      `SELECT id, type, status, purpose, summary, evidence, metadata
         FROM run_tasks
        WHERE run_id = $1
        ORDER BY position ASC`,
      [run.id]
    );
    const completed = tasks.filter(item => item.status === 'complete').map(item => ({
      id: item.id,
      type: item.type,
      summary: text(item.summary).slice(0, 1000),
      evidence: item.evidence ?? null
    }));
    const latestEvidence = [...completed].reverse().find(item => item.evidence)?.evidence ?? null;
    return {
      runId: run.id,
      goal: text(run.goal),
      surface: text(run.surface),
      state: text(run.state),
      situation: run.situation ?? {},
      requirements: run.requirements ?? {},
      adaptation: run.adaptation ?? {},
      completed,
      latestEvidence,
      updatedAt: run.updated_at
    };
  }

  /** One entry per conversation, newest first, for the chat list. */
  async conversations(scope, { limit, projectId = null } = {}) {
    const size = Math.min(Math.max(Number(limit) || 30, 1), MAX_PAGE);
    const filterProjectId = text(projectId) || null;
    if (filterProjectId) {
      const { rows } = await this.pool.query(
        `SELECT conversation_id, conversation_id IS NULL AS single,
                first_value(goal) OVER (
                  PARTITION BY COALESCE(conversation_id, id::text)
                  ORDER BY created_at ASC, id ASC
                ) AS title,
                count(*) OVER (
                  PARTITION BY COALESCE(conversation_id, id::text)
                )::int AS messages,
                visibility, state, surface, project_id, updated_at, id
           FROM runs
          WHERE workspace_id = $1
            AND (visibility = 'workspace' OR principal_id = $2)
            AND project_id = $3
          ORDER BY updated_at DESC, id DESC
          LIMIT $4`,
        [scope.workspaceId, scope.principalId, filterProjectId, size]
      );
      const latest = new Map();
      for (const row of rows) {
        const id = row.conversation_id ?? row.id;
        if (!latest.has(id)) latest.set(id, row);
      }
      return [...latest.values()].map(row => ({
        id: row.conversation_id ?? row.id,
        single: row.single,
        title: row.title,
        messages: row.messages,
        shared: row.visibility === 'workspace',
        state: row.state,
        surface: row.surface || 'normal-chat',
        projectId: row.project_id ?? null,
        updatedAt: row.updated_at
      }));
    }
    const params = [scope.workspaceId, scope.principalId, size];
    // Bounded path: read the most recently updated visible runs through
    // runs_recent_idx, keep the newest `size` conversations among them, then
    // look up each one's title, size and latest state through its own index.
    // Cost follows the page, not the workspace's history.
    const window = size * RECENT_WINDOW_FACTOR;
    const { rows, windowFull, distinct } = await this.recentConversations(params, window);
    // A window that ran out of rows before it held enough conversations (one
    // very long chat) cannot prove the page complete: use the full query.
    const page = windowFull && distinct < size ? (await this.pool.query(FULL_CONVERSATIONS_SQL, params)).rows : rows;
    return page.map(row => ({
      id: row.conversation_id,
      single: row.single,
      title: row.title,
      messages: row.messages,
      shared: row.visibility === 'workspace',
      state: row.state,
      surface: row.surface || 'normal-chat',
      projectId: row.project_id ?? null,
      updatedAt: row.updated_at
    }));
  }

  async recentConversations(params, window) {
    const { rows } = await this.pool.query(
      `WITH recent AS (
         SELECT COALESCE(conversation_id, id::text) AS conversation_id, updated_at, id
           FROM runs
          WHERE workspace_id = $1 AND (visibility = 'workspace' OR principal_id = $2)
          ORDER BY updated_at DESC, id DESC
          LIMIT $4
       ),
       counted AS (SELECT count(*)::int AS scanned, count(DISTINCT conversation_id)::int AS distinct_conversations FROM recent),
       page AS (
         SELECT conversation_id, max(updated_at) AS last_update
           FROM recent GROUP BY conversation_id
          ORDER BY last_update DESC
          LIMIT $3
       )
       SELECT page.conversation_id, latest.single, first.goal AS title, size.messages,
              latest.visibility, latest.state, latest.surface, latest.project_id, latest.updated_at,
              counted.scanned, counted.distinct_conversations
         FROM page
        CROSS JOIN counted
        CROSS JOIN LATERAL (
          SELECT r.conversation_id IS NULL AS single, r.visibility, r.state, r.surface, r.project_id, r.updated_at, r.id
            FROM runs r
           WHERE r.workspace_id = $1 AND (r.visibility = 'workspace' OR r.principal_id = $2)
             AND (r.conversation_id = page.conversation_id OR (r.conversation_id IS NULL AND r.id::text = page.conversation_id))
           ORDER BY r.updated_at DESC, r.id DESC LIMIT 1
        ) latest
        CROSS JOIN LATERAL (
          SELECT r.goal
            FROM runs r
           WHERE r.workspace_id = $1 AND (r.visibility = 'workspace' OR r.principal_id = $2)
             AND (r.conversation_id = page.conversation_id OR (r.conversation_id IS NULL AND r.id::text = page.conversation_id))
           ORDER BY r.created_at ASC, r.id ASC LIMIT 1
        ) first
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS messages
            FROM runs r
           WHERE r.workspace_id = $1 AND (r.visibility = 'workspace' OR r.principal_id = $2)
             AND (r.conversation_id = page.conversation_id OR (r.conversation_id IS NULL AND r.id::text = page.conversation_id))
        ) size
        ORDER BY latest.updated_at DESC, latest.id DESC`,
      [...params, window]
    );
    // An empty page still says whether the window was full.
    const scanned = rows[0]?.scanned ?? 0;
    return { rows, windowFull: scanned >= window, distinct: rows[0]?.distinct_conversations ?? 0 };
  }

  /** Every run of one conversation, oldest first, with its tasks. */
  async conversationRuns(scope, conversationId) {
    const id = text(conversationId);
    if (!id) return [];
    const { rows } = await this.pool.query(
      `SELECT id FROM runs
        WHERE workspace_id = $1
          AND (visibility = 'workspace' OR principal_id = $2)
          AND (conversation_id = $3 OR (conversation_id IS NULL AND id::text = $3))
        ORDER BY created_at ASC
        LIMIT 100`,
      [scope.workspaceId, scope.principalId, id]
    );
    const runs = [];
    for (const row of rows) {
      const run = await this.get(scope, row.id);
      if (run) runs.push(run);
    }
    return runs;
  }

  async list(scope, { limit, cursor, state } = {}) {
    const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_PAGE);
    const after = decodeCursor(cursor);
    const { rows } = await this.pool.query(
      `SELECT id, goal, surface, state, intent, visibility, conversation_id, project_id, attempt, max_attempts, tokens_used, max_tokens,
              created_at, updated_at, completed_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
         FROM runs
        WHERE workspace_id = $1
          AND (visibility = 'workspace' OR principal_id = $2)
          AND ($3::text IS NULL OR state = $3)
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5))
        ORDER BY created_at DESC, id DESC
        LIMIT $6`,
      [scope.workspaceId, scope.principalId, text(state) || null, after?.createdAt ?? null, after?.id ?? null, size + 1]
    );
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      runs: page.map(summarize),
      nextCursor: rows.length > size && last ? encodeCursor(last) : null
    };
  }

  /**
   * Complete or fail one task.
   *
   * Everything that decides the outcome is read inside the transaction, after
   * `FOR UPDATE` on the run, so two concurrent advances cannot both see the
   * same dependency state.
   */
  async advance(scope, principal, runId, taskId, result = {}, { requestId, externalExecution = false } = {}) {
    return transaction(this.pool, async client => {
      const { rows: [run] } = await client.query(
        `SELECT * FROM runs
           WHERE id = $1 AND workspace_id = $2
             AND (visibility = 'workspace' OR principal_id = $3)
           FOR UPDATE`,
        [text(runId), scope.workspaceId, scope.principalId]
      );
      if (!run) throw new RunError('Run not found', { status: 404, code: 'no-run' });
      if (TERMINAL.has(run.state)) {
        throw new RunError(`Run is ${run.state} and cannot be advanced`, { status: 409, code: 'run-terminal' });
      }

      const tasks = await loadTasks(client, run.id);

      // After a failure the run waits on one decision: replan with what was
      // learned, or stop. It is available whatever the graph looks like, so
      // a failed run is never stranded (direct runs have no iterate task).
      if (run.state === 'iterate' && text(taskId) === 'iterate' && tasks.some(item => item.status === 'failed')) {
        const outcome = result.replan === true
          ? await this.replan(client, run, tasks, { reason: text(result.summary) || 'A task failed.' })
          : await this.stop(client, run);
        await client.query(
          'INSERT INTO situation_events (run_id, workspace_id, principal_id, event_type, event) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [run.id, scope.workspaceId, principal.id, 'iterate', JSON.stringify({
            replan: result.replan === true, state: outcome.state, attempt: outcome.attempt, summary: text(result.summary)
          })]
        );
        await this.audit?.record({
          principalId: principal.id,
          workspaceId: scope.workspaceId,
          action: 'run.iterate',
          target: run.id,
          outcome: 'allowed',
          detail: { afterFailure: true, replan: result.replan === true, state: outcome.state, attempt: outcome.attempt },
          requestId
        }, client);
        return this.load(client, scope, run.id);
      }

      const requestedStatus = result.status === undefined || result.status === null || result.status === ''
        ? 'complete'
        : text(result.status).toLowerCase();
      if (!['complete', 'failed'].includes(requestedStatus)) {
        throw new RunError(
          'Task status must be either complete or failed.',
          { status: 400, code: 'invalid-task-status' }
        );
      }
      const status = requestedStatus;
      const adaptiveBudget = adaptiveBudgetStatus(tasks, run.adaptation?.resourcePlan ?? {});
      const targetPreview = tasks.find(item => item.id === text(taskId));
      const budgetSensitive = targetPreview
        && ['code', 'tool', 'investigate'].includes(targetPreview.type)
        && targetPreview.metadata?.execution !== false;
      if (status === 'complete' && budgetSensitive) {
        const used = adaptiveBudget.used.toolCalls;
        const max = adaptiveBudget.budget.maxToolCalls;
        const stageUsed = adaptiveBudget.used.executionStages;
        const stageMax = adaptiveBudget.budget.maxExecutionStages;
        // Discovery rounds limit finding new capabilities, not running the
        // stages already planned; only tool calls and stages gate execution.
        if (used >= max || stageUsed >= stageMax) {
          const reason = used >= max ? 'tool-call budget' : 'execution-stage budget';
          await this.audit?.record({
            principalId: principal.id,
            workspaceId: scope.workspaceId,
            action: 'run.advance',
            target: run.id + ':' + targetPreview.id,
            outcome: 'denied',
            detail: { reason: 'adaptive-budget-exhausted', budget: reason, adaptiveBudget },
            requestId
          });
          throw new RunError(
            'The adaptive working budget was reached. The workflow must stop or explicitly expand its scope before more work is added.',
            { status: 409, code: 'adaptive-budget-exhausted', detail: { adaptiveBudget } }
          );
        }
      }
      // A material clarification gate is server-enforced. A client cannot
      // skip an unresolved question by manually advancing a later task.
      // The clarify task's own prerequisites (understanding the goal) must
      // still be able to run, or the question could never be reached.
      // In a progressive run the clarify step does not exist until understanding
      // completes, so understanding itself must stay open or the run deadlocks.
      const clarifyTask = tasks.find(task => task.type === 'clarify');
      const clarifyPrerequisites = clarifyTask?.dependsOn ?? [];
      const leadsToClarify = !clarifyTask && tasks.find(item => item.id === text(taskId))?.type === 'understand';
      if (tasks.find(item => item.id === text(taskId))?.type !== 'clarify' && !clarifyPrerequisites.includes(text(taskId))
          && !leadsToClarify && run.situation?.clarificationRequired === true) {
        throw new RunError(
          'Material clarification is required before this workflow can continue.',
          {
            status: 409,
            code: 'clarification-required',
            detail: { questions: run.situation.clarificationQuestions ?? run.situation.questions ?? [] }
          }
        );
      }

      const decision = decideAdvance(tasks, taskId, { status });
      if (!decision.ok) {
        // Deliberately NOT on `client`: this transaction is about to roll
        // back, and a denial recorded inside it would roll back with it. A
        // refused action is exactly the one an audit trail must retain.
        await this.audit?.record({
          principalId: principal.id,
          workspaceId: scope.workspaceId,
          action: 'run.advance',
          target: `${run.id}:${text(taskId)}`,
          outcome: 'denied',
          detail: { reason: decision.reason, unmet: decision.unmet ?? null },
          requestId
        });
        throw new RunError(decision.message, {
          status: decision.reason === 'unknown-task' ? 404 : 409,
          code: decision.reason,
          detail: decision.unmet ? { unmet: decision.unmet } : undefined
        });
      }

      const target = tasks.find(item => item.id === text(taskId));
      const candidateSituation = target?.type === 'clarify' && status === 'complete'
        ? evolveSituation(run.situation ?? {}, {
            type: 'clarify',
            taskId: target.id,
            status,
            summary: result.summary,
            evidence: result.evidence ?? {}
          })
        : null;

      if (target?.type === 'clarify' && status === 'complete' && candidateSituation?.clarificationRequired === true) {
        throw new RunError(
          'The clarification did not resolve the material ambiguity required to continue.',
          {
            status: 422,
            code: 'clarification-incomplete',
            detail: {
              questions: candidateSituation.clarificationQuestions ?? candidateSituation.questions ?? []
            }
          }
        );
      }

      if (target?.type === 'verify' && status === 'complete') {
        const gate = situationQualityGate(run.situation ?? {}, { requireEvidence: true });
        if (!gate.ready) {
          throw new RunError(
            'Verification cannot complete until the situation, success criteria, unknowns and evidence are ready.',
            {
              status: 422,
              code: 'verification-preconditions',
              detail: gate
            }
          );
        }
      }

      const receipt = result.executionReceipt;
      // Research and file inspection can honestly be done by a person: their
      // findings are recorded as human-provided evidence, never as an
      // execution receipt. Code always needs a real executor.
      const humanFindings = HUMAN_COMPLETABLE_TASKS.has(target?.type)
        && externalExecution !== true
        && result.evidence?.humanProvided === true
        && text(result.evidence?.findings).length > 0;
      const externalExecutionRequired = EXECUTION_TASKS.has(target?.type) && target?.metadata?.execution !== false
        && !humanFindings;
      const targetKind = EXECUTION_TASKS.has(target?.type) ? target.type : null;
      const receiptTarget = text(receipt?.executionTarget);
      const allowedReceiptTarget = targetKind
        ? executionTargetsFor(targetKind).includes(receiptTarget)
        : false;
      const verifiedExternalExecution = externalExecution === true
        && externalExecutionRequired
        && receipt?.executed === true
        && receipt?.serverAuthenticated === true
        && allowedReceiptTarget
        && (receipt?.attempt === undefined || Number(receipt.attempt) === Number(run.attempt));

      if (status === 'complete' && externalExecutionRequired && !verifiedExternalExecution) {
        await this.audit?.record({
          principalId: principal.id,
          workspaceId: scope.workspaceId,
          action: 'run.advance',
          target: run.id + ':' + target.id,
          outcome: 'denied',
          detail: { reason: 'execution-required', taskType: target.type },
          requestId
        });
        throw new RunError(
          'Task "' + target.id + '" must use the authorized executor; manual completion is not allowed.',
          { status: 409, code: 'execution-required' }
        );
      }

      if (externalExecution === true && !verifiedExternalExecution) {
        throw new RunError('Invalid external execution receipt', {
          status: 422, code: 'invalid-execution-receipt'
        });
      }

      if (externalExecution === true && receiptTarget === 'local') {
        const challenge = target.metadata?.executionChallenge;
        const challengeValid = challenge
          && Number(challenge.attempt) === Number(run.attempt)
          && text(challenge.executionId) === text(receipt?.executionId)
          && text(challenge.principalId) === text(principal.id)
          && text(receipt?.challengeNonce)
          && crypto.createHash('sha256').update(text(receipt.challengeNonce), 'utf8').digest('hex') === text(challenge.nonceHash)
          && Date.parse(text(challenge.expiresAt)) > Date.now();
        if (!challengeValid) {
          throw new RunError(
            'The local execution challenge is missing, expired, stale or already consumed.',
            { status: 409, code: 'stale-execution-challenge' }
          );
        }
        await client.query(
          `UPDATE run_tasks
              SET metadata = metadata - 'executionChallenge'
            WHERE run_id = $1 AND id = $2`,
          [run.id, target.id]
        );
      }

      if (status === 'complete' && target.id === 'build-code') {
        const structured = result.evidence?.structured && typeof result.evidence.structured === 'object'
          ? result.evidence.structured
          : {};
        const scopeDrift = approvedPlanScopeDrift(run.adaptation?.approvedPlan ?? null, structured);
        if (scopeDrift.length) {
          await this.audit?.record({
            principalId: principal.id,
            workspaceId: scope.workspaceId,
            action: 'run.approval-scope',
            target: run.id + ':' + target.id,
            outcome: 'denied',
            detail: { reason: 'approved-plan-scope-drift', paths: scopeDrift.slice(0, 40) },
            requestId
          });
          throw new RunError(
            'The generated code proposes files outside the approved plan. Re-plan and approve those paths before writing them.',
            {
              status: 409,
              code: 'approved-plan-scope-drift',
              detail: { paths: scopeDrift.slice(0, 40) }
            }
          );
        }
        if (!text(structured.language) || !hasCode(structured)) {
          throw new RunError(
            'Code generation must produce a structured language and source artifact before testing can proceed.',
            { status: 422, code: 'code-artifact-required' }
          );
        }
        // A fix to a project returns the files it changes: it is laid over
        // the project it fixes, so nothing else is lost.
        const previous = repairsThisAttempt(run).at(-1)?.code;
        if (isProject(structured) && isProject(previous)) result.evidence.structured = mergeFix(previous, structured);
        // Stored in one shape, whatever shape the model used, so every reader agrees.
        result.evidence.structured = normalizePackage(result.evidence.structured);
      }

      if (status === 'complete' && target.type === 'approval' && result.approved !== true) {
        await this.audit?.record({
          principalId: principal.id,
          workspaceId: scope.workspaceId,
          action: 'run.approval',
          target: `${run.id}:${target.id}`,
          outcome: 'denied',
          detail: { reason: 'explicit-approval-flag-required' },
          requestId
        });
        throw new RunError(
          'Approval requires an explicit approved=true decision from the authenticated actor.',
          { status: 422, code: 'approval-required' }
        );
      }

      const evidenceBytes = result.evidence === null || result.evidence === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(result.evidence), 'utf8');
      if (evidenceBytes > this.maxEvidenceBytes) {
        throw new RunError('Task evidence is too large to persist', { status: 413, code: 'evidence-too-large' });
      }

      let evidence = verifiedExternalExecution
        ? { ...(result.evidence ?? {}), executionTarget: receiptTarget, executionReceipt: receipt }
        : humanFindings
          ? {
              findings: text(result.evidence.findings).slice(0, 20000),
              sources: Array.isArray(result.evidence.sources) ? result.evidence.sources.map(text).filter(Boolean).slice(0, 50) : [],
              // Provenance is set by the server, not taken from the client.
              provenance: { source: 'human', actor: principal.id, recordedAt: new Date().toISOString(), executed: false }
            }
          : result.evidence ?? null;

      if (status === 'complete' && target.type === 'verify') {
        const contract = target.metadata?.verification ?? {};
        const submitted = evidence && typeof evidence.verification === 'object'
          ? evidence.verification
          : {};
        const verdict = evidence && typeof evidence.verdict === 'object'
          ? evidence.verdict
          : {};
        const plannedCriteria = gradedCriteria(run.requirements, run.situation);
        if (verdict.verdict !== 'pass') {
          throw new RunError(
            'Verification must return an explicit passing verdict before the run can be delivered.',
            { status: 422, code: 'verification-not-passed' }
          );
        }
        const checkedCriteria = Array.isArray(verdict.criteria)
          ? verdict.criteria.filter(item => item && typeof item === 'object')
          : [];
        const normalizeCriterion = value => text(value).replace(/\s+/g, ' ').toLowerCase();
        const plannedNormalized = plannedCriteria.map(normalizeCriterion);
        const checkedNormalized = checkedCriteria.map(item => normalizeCriterion(item.criterion));
        const uniqueChecked = new Set(checkedNormalized.filter(Boolean));
        const criteriaComplete = plannedNormalized.length === checkedCriteria.length
          && uniqueChecked.size === plannedNormalized.length
          && plannedNormalized.every(criterion => uniqueChecked.has(criterion))
          && checkedCriteria.every(item => item.met === true);
        if (!criteriaComplete) {
          throw new RunError(
            'Every planned success criterion must be explicitly checked exactly once and met before verification can pass.',
            {
              status: 422,
              code: 'verification-criteria-incomplete',
              detail: {
                plannedCriteria,
                checkedCriteria
              }
            }
          );
        }
        const humanRequired = contract.humanReviewRequired === true;
        if (humanRequired && (
          submitted.humanReviewed !== true
          || submitted.level !== 'human-certified'
        )) {
          await this.audit?.record({
            principalId: principal.id,
            workspaceId: scope.workspaceId,
            action: 'run.advance',
            target: `${run.id}:${target.id}`,
            outcome: 'denied',
            detail: { reason: 'human-verification-required' },
            requestId
          });
          throw new RunError(
            'This verification requires an authorized human review before it can be completed.',
            { status: 422, code: 'human-verification-required' }
          );
        }
        evidence = {
          ...(evidence ?? {}),
          verification: {
            level: submitted.level === 'human-certified' ? 'human-certified' : 'evidence-backed',
            method: text(submitted.method) || contract.rule || 'Evidence checked against the planned criteria.',
            humanReviewed: submitted.humanReviewed === true
          }
        };
      }

      if (status === 'complete' && EVIDENCE_REQUIRED.has(target.type) && isEmpty(evidence)) {
        // Recorded outside the transaction, for the same reason as above.
        await this.audit?.record({
          principalId: principal.id,
          workspaceId: scope.workspaceId,
          action: 'run.advance',
          target: `${run.id}:${target.id}`,
          outcome: 'denied',
          detail: { reason: 'evidence-required', taskType: target.type },
          requestId
        });
        throw new RunError(
          `Task "${target.id}" records what actually happened and cannot complete without evidence`,
          { status: 422, code: 'evidence-required' }
        );
      }

      // Completion is decided from the unified workflow contract, never from a model/status claim alone.
      if (status === 'complete') {
        const priorUnified = run.adaptation?.unifiedAdaptiveWorkflow ?? {};
        const priorEvidence = Array.isArray(priorUnified?.evidence?.items) ? priorUnified.evidence.items : [];
        const currentEvidence = result.evidence === null || result.evidence === undefined ? [] : [result.evidence];
        const persistedVerify = target.type === 'deliver'
          ? tasks.find(item =>
              item.type === 'verify'
              && item.status === 'complete'
              && item.evidence?.verdict?.verdict === 'pass'
            )
          : null;
        // The only source of real-world verification authority is a persisted,
        // criterion-checked verification task, not a generated confidence claim.
        const verifiedReceipt = persistedVerify ? [{
          kind: 'verified',
          state: 'verified',
          verdict: persistedVerify.evidence.verdict,
          provenance: { source: 'server-recorded-verification', taskId: persistedVerify.id }
        }] : [];
        const allEvidence = [...priorEvidence, ...currentEvidence, ...verifiedReceipt];
        const verifiedEarlier = persistedVerify != null
          || priorUnified.acceptance?.verificationSatisfied === true;
        const completionWorkflow = reassessUnifiedWorkflow(priorUnified, {
          event: { type: target.type, material: true },
          situation: run.situation ?? {},
          acceptance: {
            ...(priorUnified.acceptance ?? {}),
            evidence: allEvidence,
            verificationSatisfied: verifiedEarlier
          },
          evidence: allEvidence,
          failedAttempts: Number(run.attempt ?? 0),
          candidates: [target.id],
          surface: run.surface || run.adaptation?.unifiedAdaptiveWorkflow?.surface || 'normal-chat'
        });
        const gate = completionGate({
          workflow: completionWorkflow,
          status,
          taskType: target.type,
          evidence: allEvidence,
          verification: persistedVerify?.evidence?.verdict
            ?? result.evidence?.verdict
            ?? result.evidence?.verification
            ?? null,
          authorizationSatisfied: run.situation?.authorizationSatisfied !== false
        });
        if (!gate.allowed) {
          await this.audit?.record({
            principalId: principal.id,
            workspaceId: scope.workspaceId,
            action: 'run.completion-gate',
            target: run.id + ':' + target.id,
            outcome: 'denied',
            detail: { reason: gate.reason, gaps: gate.gaps, taskType: target.type },
            requestId
          });
          throw new RunError(
            'The workflow cannot mark this step complete until its acceptance evidence and required controls are satisfied.',
            { status: 409, code: 'completion-gate', detail: gate }
          );
        }
      }

      let approvedPlanUpdate = null;
      if (status === 'complete' && target.type === 'approval') {
        const conditions = text(result.conditions ?? result.evidence?.conditions).slice(0, 4000);
        const normalizePlanChoices = value => {
          const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
          const normalize = name => [...new Set(
            (Array.isArray(source[name]) ? source[name] : String(source[name] ?? '').split(/\\n|;/))
              .map(text).filter(Boolean)
          )].slice(0, 40);
          return {
            keepExisting: normalize('keepExisting'),
            removeExisting: normalize('removeExisting'),
            addNew: normalize('addNew'),
            changeExisting: normalize('changeExisting')
          };
        };
        const planChoices = normalizePlanChoices(result.planChoices ?? result.evidence?.planChoices);
        const hasChoices = Object.values(planChoices).some(items => items.length);
        evidence = {
          approved: true,
          actor: principal.id,
          approvedAt: new Date().toISOString(),
          reasons: target.purpose,
          ...(conditions ? { conditions } : {}),
          ...(hasChoices ? { planChoices } : {})
        };
        if (target.metadata?.planAgreement) {
          const planTask = tasks.find(item => item.id === target.dependsOn?.[0]);
          const proposed = planTask?.evidence?.structured;
          const proposedFiles = [
            ...(Array.isArray(proposed?.files) ? proposed.files : []),
            ...(Array.isArray(proposed?.tests) ? proposed.tests : [])
          ].map(concretePlanPath).filter(Boolean);
          // The approved plan is authoritative for the following coding step.
          // The model proposal remains evidence, but these user choices are
          // the only plan overrides the coding stage may treat as instructions.
          approvedPlanUpdate = {
            sourceTaskId: target.dependsOn?.[0] ?? null,
            existingCodePlan: target.metadata?.existingCodePlan === true,
            planChoices,
            proposedFiles: [...new Set(proposedFiles)],
            conditions: conditions || null,
            approvedAt: evidence.approvedAt,
            actor: principal.id
          };
        }
      }



      await client.query(
        `UPDATE run_tasks SET status = $3, summary = $4, evidence = $5, completed_at = now()
          WHERE run_id = $1 AND id = $2`,
        [run.id, target.id, status, text(result.summary) || null,
         evidence === null ? null : JSON.stringify(evidence)]
      );

      const currentAgentPlan = run.adaptation?.agentPlan ?? run.adaptation?.agentTopology ?? null;
      const agentPlan = adaptAgentTopology(currentAgentPlan, {
        event: status === 'failed' ? 'failed' : 'completed',
        taskId: target.id,
        failed: status === 'failed',
        risk: run.situation?.risk ?? (run.situation?.highImpact ? 'high-impact' : 'ordinary')
      });
      const applied = await this.settle(client, run, decision, target, result, { evidence, verifiedExternalExecution, approvedPlanUpdate });
      await client.query(
        `UPDATE runs SET adaptation = jsonb_set(COALESCE(adaptation, '{}'::jsonb), '{agentPlan}', $2::jsonb, true), updated_at = now() WHERE id = $1`,
        [run.id, JSON.stringify(agentPlan)]
      );

      const nextSituation = applied.situation ?? evolveSituation(run.situation ?? {}, {
        type: target.type,
        taskId: target.id,
        status,
        summary: result.summary,
        evidence: result.evidence ?? {}
      });
      if (!applied.situation) {
        await client.query(
          'UPDATE runs SET situation = $2::jsonb, updated_at = now() WHERE id = $1',
          [run.id, JSON.stringify(nextSituation)]
        );
      }
      await client.query(
        'INSERT INTO situation_events (run_id, workspace_id, principal_id, event_type, event) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [run.id, scope.workspaceId, principal.id, target.type, JSON.stringify({
          taskId: target.id, status, summary: text(result.summary), evidence: result.evidence ?? null
        })]
      );

      await this.audit?.record({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'run.advance',
        target: `${run.id}:${target.id}`,
        outcome: status === 'failed' ? 'failed' : 'allowed',
        detail: {
          taskType: target.type,
          status,
          state: applied.state,
          attempt: applied.attempt,
          executionTarget: verifiedExternalExecution ? receiptTarget : null
        },
        requestId
      }, client);

      return this.load(client, scope, run.id);
    });
  }

  /**
   * Apply the decision to the run row, including the iterate loop.
   *
   * Completing `iterate` with `replan: true` starts a fresh attempt: the task
   * graph resets to pending and the attempt counter rises. Without the
   * counter, `iterate` is an unbounded loop that can burn budget forever.
   */
  async settle(client, run, decision, target, result, { evidence = result?.evidence ?? null, verifiedExternalExecution = false, approvedPlanUpdate = null } = {}) {
    const structured = result?.evidence?.structured;
    let requirementModel = run.adaptation?.workflow === 'direct'
      ? (run.requirements ?? { version: 1, items: [], overallProgress: 100, completionReady: true })
      : reconcileRequirements(run.requirements ?? null, {
          goal: run.goal,
          task: target,
          structured: structured ?? {},
          summary: text(result?.summary),
          evidence: result?.evidence ?? null,
          requirementIds: target.metadata?.requirementIds ?? []
        });

    await client.query(
      'UPDATE runs SET requirements = $2::jsonb WHERE id = $1',
      [run.id, JSON.stringify(requirementModel)]
    );
    run.requirements = requirementModel;
    let nextState;
    const discovery = target.type === 'discover-capabilities'
      ? normalizeCapabilityDiscovery(structured)
      : { capabilities: [], executionRequirements: {} };

    const understanding = target.type === 'understand'
      ? normalizeUnderstanding(structured)
      : null;
    const reassessmentDiscovery = target.type === 'reassess'
      ? normalizeCapabilityDiscovery(structured)
      : { capabilities: [], executionRequirements: {} };

    const discoveredCandidates = ['discover-capabilities', 'reassess'].includes(target.type)
      ? (target.type === 'reassess' ? reassessmentDiscovery.capabilities : discovery.capabilities)
      : [];

    const persistedDiscoveryIds = discoveredCandidates.map(spec => spec.id).filter(Boolean);
    if (persistedDiscoveryIds.length) {
      const existingDiscovered = Array.isArray(run.capabilities?.discovered)
        ? run.capabilities.discovered
        : [];
      const mergedDiscovered = [...existingDiscovered, ...discoveredCandidates].filter((item, index, items) => {
        const id = text(item?.id || item?.name);
        return id && items.findIndex(other => text(other?.id || other?.name) === id) === index;
      });
      await client.query(
        'UPDATE runs SET capabilities = $2::jsonb WHERE id = $1',
        [run.id, JSON.stringify({
          ...(run.capabilities ?? {}),
          required: [...new Set([
            ...((run.capabilities?.required ?? [])),
            ...persistedDiscoveryIds
          ])],
          discovered: mergedDiscovered
        })]
      );
    }
    if (discoveredCandidates.length && this.capabilities) {
      await this.capabilities.upsertCandidatesTx(
        client,
        { workspaceId: run.workspace_id ?? run.workspaceId },
        { id: run.principal_id ?? run.principalId },
        discoveredCandidates
      );
    }

    const adaptiveDiscoveries = target.type === 'reassess'
      ? reassessmentDiscovery.capabilities
      : discovery.capabilities;
    const adaptiveExecutionRequirements = target.type === 'reassess'
      ? reassessmentDiscovery.executionRequirements
      : discovery.executionRequirements;
    const dynamicExecutionRequirements = Object.fromEntries(
      Object.entries(discovery.executionRequirements).map(([kind, candidate]) =>
        [kind, planExecutionRequirements(kind, candidate)]
      )
    );

    const adaptiveUpdate = {
      ...(run.adaptation ?? {}),
          discoveries: [
            ...((run.adaptation?.discoveries ?? [])),
            ...adaptiveDiscoveries
          ],
          executionRequirements: {
            ...((run.adaptation?.executionRequirements ?? {})),
            ...dynamicExecutionRequirements,
            ...Object.fromEntries(
              Object.entries(adaptiveExecutionRequirements).map(([kind, candidate]) =>
                [kind, planExecutionRequirements(kind, candidate)]
              )
            )
          },
          lastDiscovery: adaptiveDiscoveries.length || Object.keys(adaptiveExecutionRequirements).length
            ? {
                capabilities: adaptiveDiscoveries,
                executionRequirements: adaptiveExecutionRequirements
              }
            : (run.adaptation?.lastDiscovery ?? null),
          understanding: target.type === 'understand'
            ? understanding
            : (run.adaptation?.understanding ?? null),
          lastReassessment: target.type === 'reassess'
            ? structured
            : (run.adaptation?.lastReassessment ?? null)
        };

    // Persist the same evidence/acceptance projection used by the completion
    // gate. Previously a verify step could pass, but the following deliver
    // step still saw verificationSatisfied=false from the original plan and
    // rejected already-verified work.
    if (decision.status === 'complete') {
      const priorUnified = run.adaptation?.unifiedAdaptiveWorkflow ?? {};
      const priorEvidence = Array.isArray(priorUnified?.evidence?.items)
        ? priorUnified.evidence.items
        : [];
      const currentEvidence = evidence === null || evidence === undefined ? [] : [evidence];
      const unifiedEvidence = [...priorEvidence, ...currentEvidence].slice(-128);
      const verificationPassed = target.type === 'verify'
        && (evidence?.verdict?.verdict === 'pass'
          || evidence?.verification?.verdict === 'pass'
          || result?.evidence?.verdict?.verdict === 'pass');
      const unified = reassessUnifiedWorkflow(priorUnified, {
        event: { type: target.type === 'verify' ? 'verification' : target.type, material: true },
        situation: run.situation ?? {},
        acceptance: {
          ...(priorUnified.acceptance ?? {}),
          evidence: unifiedEvidence,
          verificationSatisfied: priorUnified.acceptance?.verificationSatisfied === true || verificationPassed
        },
        evidence: unifiedEvidence,
        failedAttempts: Number(run.attempt ?? 0),
        candidates: [target.id],
        surface: run.surface || priorUnified.surface || 'normal-chat'
      });
      adaptiveUpdate.unifiedAdaptiveWorkflow = unified;
      adaptiveUpdate.acceptanceContract = unified.acceptance;
      adaptiveUpdate.adaptiveBehavior = {
        ...(adaptiveUpdate.adaptiveBehavior ?? {}),
        ...unified.behavior,
        modeController: unified.modeController,
        executionStrategy: unified.execution
      };
      adaptiveUpdate.modeController = unified.modeController;
      adaptiveUpdate.adaptiveDecision = unified.authority;
    }

    if (approvedPlanUpdate) adaptiveUpdate.approvedPlan = approvedPlanUpdate;
    const usesResearchWorkspace = run.surface === 'research'
      || (Array.isArray(run.adaptation?.surfaces) && run.adaptation.surfaces.includes('research'));
    if (usesResearchWorkspace && (result.evidence != null || result.citations?.length || result.toolLog?.length)) {
      adaptiveUpdate.researchWorkspace = updateResearchWorkspaceState(run.adaptation?.researchWorkspace ?? null, {
        goal: run.goal,
        question: run.goal,
        runId: run.id,
        conversationId: run.conversation_id ?? null,
        evidence: result.evidence ?? null,
        citations: result.citations ?? result.evidence?.citations ?? [],
        toolLog: result.toolLog ?? result.evidence?.toolLog ?? []
      });
    }

    // Code changes are written back into the same unified context used by
    // planning and file reads. This keeps workflow state, editable files and
    // code artifacts synchronized after every material code change.
    if (target.type === 'code' && decision.status === 'complete' && structured && isProject(structured)) {
      adaptiveUpdate.unifiedWorkContext = applyWorkChange(
        run.adaptation?.unifiedWorkContext ?? buildUnifiedWorkContext({ goal: run.goal }),
        {
          files: codeFiles(structured),
          deleted: deletedPaths(structured)
        }
      );
    }

    // Governance follows the work: a newly discovered capability (physical,
    // high-impact, with side effects or new data) re-evaluates it, so the
    // execution gate and the person see the stricter state before it runs.
    if (adaptiveUpdate && run.adaptation?.governance && adaptiveDiscoveries.length) {
      adaptiveUpdate.governance = reevaluateSituationGovernance({
        goal: run.goal,
        situation: run.situation ?? {},
        adaptation: run.adaptation,
        policyDecision: run.governance ?? null
      }, adaptiveDiscoveries);
      if (adaptiveUpdate.governance.escalated) {
        await this.audit?.record({
          principalId: run.principal_id ?? run.principalId,
          workspaceId: run.workspace_id ?? run.workspaceId,
          action: 'run.governance.escalate',
          target: run.id,
          outcome: 'allowed',
          detail: {
            taskId: target.id,
            from: run.adaptation.governance.status,
            to: adaptiveUpdate.governance.status,
            reasons: adaptiveUpdate.governance.reasons,
            capabilities: adaptiveDiscoveries.map(item => item.id)
          }
        }, client);
      }
    }

    if (target.type === 'iterate' && decision.status === 'complete' && result.replan === true) {
      return this.replan(client, run, decision.tasks, { reason: text(result.summary) || 'Replan requested.' });
    }

    // Only the completed task can create the next task. The server never
    // pre-creates future workflow stages. Direct work follows the same rule:
    // the response is materialized first, and its verification step is created
    // only after the response has actually completed.
    if (decision.status === 'complete' && run.adaptation?.workflow === 'direct'
        && target.type === 'respond' && target.metadata?.verificationPending === true) {
      const { rows: existingVerify } = await client.query(
        "SELECT id FROM run_tasks WHERE run_id = $1 AND type = 'verify' LIMIT 1",
        [run.id]
      );
      if (!existingVerify.length) {
        const { rows: positionRows } = await client.query(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM run_tasks WHERE run_id = $1',
          [run.id]
        );
        await insertTask(client, run.id, {
          id: 'verify',
          position: Number(positionRows[0]?.position ?? 1),
          type: 'verify',
          dependsOn: [target.id],
          requires: ['verification'],
          purpose: 'Check the completed direct response for correctness, completeness and unsupported claims before delivery.',
          metadata: {
            adaptive: true,
            dynamicGraph: true,
            createdFrom: target.id,
            verification: run.adaptation?.acceptanceContract
              ? {
                  ...(run.adaptation.acceptanceContract ?? {}),
                  required: true
                }
              : verificationContract()
          }
        });
      }
    } else if (decision.status === 'complete' && run.adaptation?.workflow !== 'direct') {
      await this.adaptSteps(client, run, target, structured && typeof structured === 'object' ? structured : {}, requirementModel);
    }

    // Adaptive checkpoint runs AFTER the next step is actually derived. This
    // makes the scope decision task-aware: unchanged work keeps its current
    // resources, unnecessary resources are narrowed, and newly required
    // resources are detected before the next step executes. This check is
    // pure/cheap; it never performs hidden discovery or silently expands scope.
    if (run.adaptation?.workflow !== 'direct') {
      const { rows: nextRows } = await client.query(
        'SELECT id, type, status, requires, depends_on FROM run_tasks WHERE run_id = $1 ORDER BY position',
        [run.id]
      );
      const candidateNext = nextTask(nextRows.map(row => ({
        id: row.id,
        type: row.type,
        status: row.status,
        requires: row.requires ?? [],
        // nextTask needs each task's dependencies to know which one is ready.
        dependsOn: Array.isArray(row.depends_on) ? row.depends_on : []
      })));
      const transition = reconcileAdaptiveTransition({
        resourcePlan: run.adaptation?.resourcePlan ?? {},
        requirements: Array.isArray(candidateNext?.requires) && candidateNext.requires.length
          ? candidateNext.requires.map(id => ({ id }))
          : (requirementModel?.items ?? []),
        artifacts: Array.isArray(run.adaptation?.resourcePlan?.selected?.artifacts)
          ? run.adaptation.resourcePlan.selected.artifacts
          : [],
        dataSources: Array.isArray(run.adaptation?.resourcePlan?.selected?.dataSources)
          ? run.adaptation.resourcePlan.selected.dataSources
          : [],
        nextTask: candidateNext,
        situationChanged: true
      });
      adaptiveUpdate.transition = {
        ...(transition ?? {}),
        afterTask: target.id,
        nextTask: candidateNext?.id ?? null,
        at: new Date().toISOString()
      };
    }

    if (decision.status === 'failed') {
      const recoveryReason = text(result?.summary) || text(result?.reason) || 'workflow-step-failed';
      // Recovery has one decision authority: the unified adaptive workflow.
      // The runtime-state module records the resulting projection/history only.
      const effectiveRecovery = unifiedRecoveryDecision({
        reason: recoveryReason,
        attempts: run.attempt,
        maxAttempts: run.max_attempts,
        consequence: run.adaptation?.unifiedAdaptiveWorkflow?.authority?.consequence ?? 0,
        humanControlRequired: run.adaptation?.unifiedAdaptiveWorkflow?.authority?.controls?.humanControlRequired === true,
        governanceStatus: run.adaptation?.governance?.status ?? 'ready'
      });
      const recoveryRecord = recoveryLesson(effectiveRecovery, {
        taskId: target.id,
        summary: result?.summary
      });
      adaptiveUpdate.recovery = recoveryRecord;
      adaptiveUpdate.recoveryHistory = [
        ...(Array.isArray(run.adaptation?.recoveryHistory) ? run.adaptation.recoveryHistory : []),
        recoveryRecord
      ].slice(-16);

      const { rows: existingIterate } = await client.query(
        "SELECT id FROM run_tasks WHERE run_id = $1 AND id = 'iterate'",
        [run.id]
      );
      if (effectiveRecovery.action !== 'stop' && !existingIterate.length) {
        const { rows: currentRows } = await client.query(
          'SELECT position FROM run_tasks WHERE run_id = $1 ORDER BY position',
          [run.id]
        );
        const position = currentRows.reduce((max, row) => Math.max(max, Number(row.position ?? 0)), -1) + 1;
        await insertTask(client, run.id, {
          id: 'iterate',
          position,
          type: 'iterate',
          dependsOn: [target.id],
          requires: ['iteration'],
          purpose: 'Apply the bounded recovery decision: retry transient work, repair a bounded coding failure, re-plan from new evidence, escalate to a person, or stop.',
          metadata: {
            adaptive: true,
            dynamicGraph: true,
            createdFrom: target.id,
            recoveryAction: effectiveRecovery.action,
            failureClass: effectiveRecovery.failureClass
          }
        });
      }
    }

    // Dynamic discovery/reassessment may have inserted or rewired tasks.
    // The persisted state must be derived from the final server-owned graph,
    // never from the pre-edit decision.
    const { rows: authoritativeTasks } = await client.query(
      'SELECT id, type, status, depends_on, requires, purpose, metadata FROM run_tasks WHERE run_id = $1 ORDER BY position',
      [run.id]
    );
    const authoritativeNext = nextTask(authoritativeTasks.map(row => ({
      id: row.id, type: row.type, status: row.status, dependsOn: row.depends_on
    })));
    if (decision.status === 'failed' && adaptiveUpdate?.recovery?.action === 'stop') {
      nextState = 'exhausted';
    } else if (decision.status === 'failed') {
      nextState = 'iterate';
    } else if (authoritativeNext) {
      nextState = authoritativeNext.type;
    } else if (run.adaptation?.workflow !== 'direct' && !requirementModel.completionReady) {
      // No task exists, but required work remains. Never report completion:
      // expose a resumable waiting state until a new input or expansion can
      // produce the next justified action.
      nextState = 'waiting';
    } else {
      nextState = 'complete';
    }

    if (adaptiveUpdate) {
      // The actual persisted run_tasks rows win over speculative model graphs.
      // Mirror the final committed task statuses while still in this same
      // RunStore transaction, after dynamic insertions and recovery rewiring.
      const priorUnified = adaptiveUpdate.unifiedAdaptiveWorkflow
        ?? run.adaptation?.unifiedAdaptiveWorkflow;
      if (priorUnified) {
        const graph = projectPersistedTaskGraph(authoritativeTasks, priorUnified.taskGraph);
        adaptiveUpdate.unifiedAdaptiveWorkflow = {
          ...priorUnified, taskGraph: graph,
          openWorld: composeOpenWorldDecision({
            goal: run.goal, situation: run.situation ?? {}, graph,
            acceptance: priorUnified.acceptance ?? {}
          })
        };
      }
      // Record the authoritative next task only after all server-side graph
      // edits have finished, preventing stale UI/runtime state.
      adaptiveUpdate.runtime = updateAdaptiveRuntimeState(run.adaptation?.runtime ?? {}, {
        run,
        target,
        nextTask: authoritativeNext,
        status: decision.status,
        evidence,
        execution: verifiedExternalExecution,
        verification: target.type === 'verify' ? evidence?.verdict ?? null : null,
        reason: result.summary
      });
      // adaptiveUpdate was copied before the next step was chosen; keep what
      // that choice recorded (a step the policy refused) instead of losing it.
      const { rows: [stored] } = await client.query(
        "SELECT adaptation->'lastBlockedAdaptiveStep' AS blocked, adaptation->'scale' AS scale, adaptation->'scaleChangedBy' AS \"scaleChangedBy\" FROM runs WHERE id = $1",
        [run.id]
      );
      if (stored?.blocked) adaptiveUpdate.lastBlockedAdaptiveStep = stored.blocked;
      if (stored?.scaleChangedBy) Object.assign(adaptiveUpdate, { scale: stored.scale, scaleChangedBy: stored.scaleChangedBy });
      await client.query(
        `UPDATE runs
            SET state = $2, adaptation = $4, updated_at = now(), completed_at = $3
          WHERE id = $1`,
        [run.id, nextState, nextState === 'complete' ? new Date() : null, JSON.stringify(adaptiveUpdate)]
      );
    } else {
      await client.query(
        `UPDATE runs SET state = $2, updated_at = now(), completed_at = $3 WHERE id = $1`,
        [run.id, nextState, nextState === 'complete' ? new Date() : null]
      );
    }
    return { state: nextState, attempt: run.attempt };
  }

  /**
   * Start a fresh attempt that remembers the last one. What failed, why, and
   * what was already done is kept as a lesson in the run's adaptation (and
   * as failed steps in its situation) before the graph resets, so the next
   * attempt is told what to do differently instead of repeating itself.
   */
  async replan(client, run, tasks, { reason }) {
    if (run.attempt >= run.max_attempts) {
      await client.query(
        `UPDATE runs SET state = 'exhausted', updated_at = now(), completed_at = now() WHERE id = $1`,
        [run.id]
      );
      return { state: 'exhausted', attempt: run.attempt };
    }
    const lesson = lessonFrom(run, tasks, reason);
    const adaptation = {
      ...(run.adaptation ?? {}),
      iterations: [...(run.adaptation?.iterations ?? []), lesson].slice(-MAX_LESSONS)
    };
    const situation = evolveSituation(run.situation ?? {}, {
      type: 'iterate',
      status: 'replanned',
      summary: `Attempt ${run.attempt} ended: ${reason}`,
      failedSteps: lesson.failed.map(item => item.taskId),
      evidence: lesson.failed.map(item => `${item.taskId}: ${item.summary || item.evidence}`)
    });
    // A progressive run starts its next attempt from understanding alone and
    // grows again from what was learned; resetting every grown step would
    // replay the old plan. A direct chat keeps its two steps.
    const root = run.adaptation?.workflow !== 'direct'
      ? tasks.filter(item => item.type === 'understand').sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))[0]
      : null;
    if (root) {
      await client.query('DELETE FROM run_tasks WHERE run_id = $1 AND id <> $2', [run.id, root.id]);
    } else {
      // The decision added after the failure belongs to that attempt only.
      await client.query("DELETE FROM run_tasks WHERE run_id = $1 AND type = 'iterate'", [run.id]);
    }
    await client.query(
      `UPDATE run_tasks SET status = 'pending', summary = NULL, evidence = NULL,
                            started_at = NULL, completed_at = NULL
        WHERE run_id = $1`,
      [run.id]
    );
    if (root && run.requirements && Array.isArray(run.requirements.items)) {
      // What failed is pursued again in the new attempt.
      const requirements = { ...run.requirements, items: run.requirements.items.map(item => (
        ['failed', 'in-progress', 'partially-satisfied', 'verified'].includes(item.status) ? { ...item, status: 'identified' } : item
      )) };
      await client.query('UPDATE runs SET requirements = $2::jsonb WHERE id = $1', [run.id, JSON.stringify(normalizeRequirementModel(requirements, run.goal))]);
    }
    const first = root ? { type: root.type } : nextTask(tasks.map(item => ({ ...item, status: 'pending' })));
    const state = first?.type ?? 'understand';
    const attempt = run.attempt + 1;
    await client.query(
      `UPDATE runs SET state = $2, attempt = $3, adaptation = $4::jsonb, situation = $5::jsonb,
                       updated_at = now(), completed_at = NULL
        WHERE id = $1`,
      [run.id, state, attempt, JSON.stringify(adaptation), JSON.stringify(situation)]
    );
    return { state, attempt, situation };
  }

  /**
   * Send code that failed its run back for a targeted fix in the same
   * attempt: build-code and the steps it made stale return to pending, and
   * what failed is kept for the next build step. Returns null when the
   * attempt's repairs are used up (the caller then records the failure).
   */
  async repairCode(scope, principal, runId, taskId, failure, { requestId, maxRepairs = MAX_CODE_REPAIRS } = {}) {
    return transaction(this.pool, async client => {
      const { rows: [run] } = await client.query(
        `SELECT * FROM runs
           WHERE id = $1 AND workspace_id = $2
             AND (visibility = 'workspace' OR principal_id = $3)
           FOR UPDATE`,
        [text(runId), scope.workspaceId, scope.principalId]
      );
      if (!run || TERMINAL.has(run.state) || !canRepair(run, maxRepairs)) return null;
      const tasks = await loadTasks(client, run.id);
      const failed = tasks.find(item => item.id === text(taskId));
      if (!failed || failed.status === 'complete' || !builtCode(tasks)) return null;
      const stale = staleAfterRepair(tasks, failed.id);
      const { record, history } = repairRecord(run, tasks, failed.id, failure);
      await client.query(
        `UPDATE run_tasks SET status = 'pending', summary = NULL, evidence = NULL,
                              started_at = NULL, completed_at = NULL
          WHERE run_id = $1 AND id = ANY($2::text[])`,
        [run.id, stale]
      );
      const first = nextTask(tasks.map(item => (stale.includes(item.id) ? { ...item, status: 'pending' } : item)));
      await client.query(
        `UPDATE runs SET state = $2, adaptation = $3::jsonb, updated_at = now() WHERE id = $1`,
        [run.id, first?.type ?? 'code', JSON.stringify({ ...(run.adaptation ?? {}), codeRepairs: history })]
      );
      const detail = { taskId: failed.id, round: record.round, maxRounds: maxRepairs, status: failure?.status ?? 'failed', reset: stale };
      await client.query(
        'INSERT INTO situation_events (run_id, workspace_id, principal_id, event_type, event) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [run.id, scope.workspaceId, principal.id, 'code-repair', JSON.stringify(detail)]
      );
      await this.audit?.record({
        principalId: principal.id, workspaceId: scope.workspaceId, action: 'run.code.repair',
        target: run.id, outcome: 'allowed', detail, requestId
      }, client);
      return this.load(client, scope, run.id);
    });
  }

  /**
   * Code in a language this sandbox cannot run (not turned on, or its
   * toolchain could not be fetched): the test step is skipped with the
   * reason, and the run goes on with the code marked as not run, so the
   * check and the answer say so and a person certifies it.
   */
  async skipUnrunnableCode(scope, principal, runId, taskId, { language = '', reason = '' } = {}, { requestId } = {}) {
    return transaction(this.pool, async client => {
      const { rows: [run] } = await client.query(
        `SELECT * FROM runs
           WHERE id = $1 AND workspace_id = $2
             AND (visibility = 'workspace' OR principal_id = $3)
           FOR UPDATE`,
        [text(runId), scope.workspaceId, scope.principalId]
      );
      if (!run || TERMINAL.has(run.state)) return null;
      const tasks = await loadTasks(client, run.id);
      const target = tasks.find(item => item.id === text(taskId));
      if (!target || target.status !== 'pending' || target.id !== 'test-code') return null;
      const why = `Not run: ${text(reason) || 'this sandbox cannot run this language'}`.slice(0, 400);
      await client.query(
        `UPDATE run_tasks SET status = 'skipped', summary = $3, completed_at = now()
          WHERE run_id = $1 AND id = $2 AND status = 'pending'`,
        [run.id, target.id, why]
      );
      const adaptation = { ...(run.adaptation ?? {}), codeNotRun: { language: text(language), reason: why, attempt: Number(run.attempt) } };
      let requirementModel = run.adaptation?.workflow === 'direct'
        ? { version: 1, items: [], overallProgress: 100, completedCount: 0, requiredCount: 0, unresolvedCount: 0, blockedCount: 0, completionReady: true, nextRequirementId: null }
        : reconcileRequirements(run.requirements ?? null, {
            goal: run.goal,
            task: target,
            structured: {},
            summary: why,
            evidence: { codeNotRun: true, language: text(language), reason: why },
            requirementIds: target.metadata?.requirementIds ?? []
          });
      run.requirements = requirementModel;
      await client.query(
        'UPDATE runs SET requirements = $2::jsonb WHERE id = $1',
        [run.id, JSON.stringify(requirementModel)]
      );
      if (run.adaptation?.workflow !== 'direct') {
        await this.adaptSteps(client, { ...run, adaptation, requirements: requirementModel }, target, {}, requirementModel);
      }
      const afterDynamic = await loadTasks(client, run.id);
      const next = nextTask(afterDynamic);
      await client.query(
        `UPDATE runs SET state = $2, adaptation = $3::jsonb, updated_at = now() WHERE id = $1`,
        [run.id, next?.type ?? (requirementModel.completionReady ? 'complete' : 'blocked'), JSON.stringify(adaptation)]
      );
      await this.audit?.record({
        principalId: principal.id, workspaceId: scope.workspaceId, action: 'run.code.not-run',
        target: run.id, outcome: 'allowed', detail: { taskId: target.id, language: text(language) }, requestId
      }, client);
      return this.load(client, scope, run.id);
    });
  }

  /**
   * Apply a plan's steps and skips, or a step's judgement that the need is
   * met or the steps ahead should change. See step-plan.js for what the
   * model may and may not change.
   */
  /**
   * Progress the workflow one node at a time.
   *
   * There is deliberately no plan-shaped future graph. The model can propose
   * the next action, but the server validates it, applies governance, and
   * inserts exactly one new task after the current task. If the situation
   * changes, the next proposal replaces the future that would otherwise have
   * existed.
   */
  async adaptSteps(client, run, target, structured, requirementModel = normalizeRequirementModel(run.requirements, run.goal)) {
    const tasks = await loadTasks(client, run.id);
    const existingIds = new Set(tasks.map(item => item.id));
    const totalCreated = tasks.length;
    const workflowBudget = adaptiveBudgetForRun(run.adaptation?.resourcePlan ?? {});
    if (totalCreated >= workflowBudget.maxWorkflowNodes) return;

    const textValue = value => String(value ?? '').trim();
    const next = normalizeNextStep(structured);
    const enough = structured?.enough === true;
    const venture=ventureIntent({goal:run.goal,surface:run.surface||run.adaptation?.primarySurface});
    const ventureStep=venture.enabled && !tasks.some(item=>item.metadata?.ventureDiscovery===true)
      ? ventureDiscoveryStep({goal:run.goal,surface:run.surface||run.adaptation?.primarySurface})
      : null;
    const requirementsEnabled = run.adaptation?.workflow !== 'direct';
    const activeRequirement = requirementsEnabled ? nextRequirement(requirementModel) : null;

    const canonical = candidate => {
      if (!candidate) return null;
      const type = textValue(candidate.type || candidate.kind || 'step').toLowerCase();
      const aliases = {
        // A simulation is code to write and run.
        simulation: 'code', simulate: 'code', research: 'investigate', discovery: 'discover-capabilities',
        capability_discovery: 'discover-capabilities', approval_gate: 'approval', answer: 'respond',
        code_generation: 'code', verification: 'verify', delivery: 'deliver'
      };
      const normalizedType = aliases[type] || type;
      return {
        ...candidate, type: normalizedType,
        title: textValue(candidate.title || candidate.purpose) || normalizedType,
        purpose: textValue(candidate.purpose || candidate.title) || 'Continue the work for the current situation.'
      };
    };

    // When nothing more specific is known, the work the plan selected and
    // has not started yet comes next, one stage at a time and in the order
    // that lets each build on the last: discovery, research, the person's
    // files, the code, and an invention's prototype.
    // Without this a request to run code never reached it.
    const planned = new Set([...(run.capabilities?.granted ?? []), ...(run.capabilities?.required ?? [])]);
    const started = type => tasks.some(item => item.type === type);
    const plannedStage = () => {
      // Idea discovery is one conditional, saved step. It must finish before
      // authoring or approving the MVP plan, not silently spawn a separate team.
      if (ventureStep) return ventureStep;
      if (planned.has('capability-discovery') && !started('discover-capabilities')) {
        return { type: 'discover-capabilities', title: 'Discover the required capability',
          purpose: 'Determine the capability, tools, data, environment and verification needed for the current situation.' };
      }
      if (planned.has('evidence-retrieval') && !started('investigate')) {
        return { type: 'investigate', title: 'Investigate the required evidence',
          purpose: 'Retrieve or establish the evidence needed to resolve the identified uncertainty.' };
      }
      if (planned.has('code-generation') && !started('code')) {
        // All substantive coding work is reviewed with the person before
        // mutation. New builds and existing-code changes use the same
        // approval surface; existing code adds explicit keep/remove/add/change
        // decisions so the person's intent is not inferred by the model.
        const hasExistingCode = (run.adaptation?.attachments?.length ?? 0) > 0
          || (run.adaptation?.projectOverlay?.length ?? 0) > 0
          || (run.situation?.artifacts?.length ?? 0) > 0
          || run.adaptation?.ownWork === true;
        if (!started('plan') && codePlanApprovalRequired(run)) {
          return hasExistingCode ? EXISTING_CODE_PLAN_STEP : BUILD_PLAN_STEP;
        }
        return { type: 'code', title: 'Write the code',
          purpose: 'Write the requested code with its automated tests, as a reviewable package; do not claim that it has run.' };
      }
      // Only files the person gave: "a single HTML file" is what to make.
      const hasFiles = (run.adaptation?.attachments?.length ?? 0) > 0 || (run.situation?.artifacts?.length ?? 0) > 0;
      if (planned.has('file-analysis') && hasFiles && !started('respond')) {
        return { type: 'respond', title: 'Work from the attached files',
          purpose: 'Read the attached files with the file tools, work out what the person asked from their actual contents, and answer from that evidence.' };
      }
      if (planned.has('invention') && !started('prototype')) {
        return { type: 'prototype', title: 'Invent and plan the decisive experiment',
          purpose: 'Generate, compare and turn candidate concepts into a testable prototype or experiment plan.', inventionLoop: true };
      }
      // Research and other groundwork are not an answer: when nothing has
      // written one yet, the answer is composed from the evidence before it is checked.
      if (started('investigate') && !['respond', 'code', 'prototype', 'deliver'].some(started)) {
        return { type: 'respond', title: 'Answer from the evidence',
          purpose: 'Answer the person\'s question directly, in their terms, from the evidence gathered so far; say what is uncertain and cite the sources used.' };
      }
      return null;
    };

    let candidate = canonical(next);
    const novelProposal = candidate && (
      target.type === 'reassess' ||
      (target.type === 'step' && ['investigate', 'tool', 'code', 'discover-capabilities', 'prototype'].includes(candidate.type))
    );
    let admittedExpansion = null;
    // A build plan is followed by the person agreeing it, whatever the model
    // suggested; only then is the code written, to the agreed plan.
    if (target.type === 'plan' && target.metadata?.buildPlan) {
      candidate = {
        ...PLAN_AGREEMENT_STEP,
        ...(target.metadata?.existingCodePlan ? { existingCodePlan: true } : {})
      };
    }
    // Selection is advisory until the parent writes the next server-owned
    // task. Once explored, continue to the existing scoped build plan or the
    // remaining Research stage, not a model-proposed unauthorised build.
    if (target.metadata?.ventureDiscovery === true) {
      candidate = plannedStage() ?? {
        type:'respond',title:'Present the idea evaluation',
        purpose:'Present compared ideas, customer needs, evidence versus assumptions, recommended direction, and a decisive validation experiment. Do not claim a product was built.'
      };
    }
    if (!candidate && target.type === 'approval' && target.metadata?.approvalFor) {
      candidate = canonical(target.metadata.approvalFor);
    }
    if (!candidate) {
      if (target.id === 'build-code' || (target.type === 'code' && target.metadata?.execution === false)) {
        candidate = { type: 'code', title: 'Test the generated code',
          purpose: 'Run syntax checks and the available automated tests against the generated code and record real execution evidence.' };
      } else if (target.type === 'verify') {
        candidate = { type: 'deliver', title: 'Deliver the verified result',
          purpose: 'Present the verified result, artifacts, evidence, limitations and any necessary next actions.' };
      } else if (target.id === 'test-code') {
        // Tested work is checked next, before anything else is added.
        candidate = { type: 'verify', title: 'Verify the result',
          purpose: 'Check the current result against the success criteria and the evidence actually produced.', requires: ['verification'] };
      }
    }

    if (!candidate && ['discover-capabilities', 'reassess'].includes(target.type)) {
      // A capability found here that the server does not have is used next,
      // through a governed tool step (approved by the person, and the
      // capability itself approved by an administrator before it runs).
      const discovered = normalizeCapabilityDiscovery(structured).capabilities;
      if (discovered.length) {
        candidate = { type: 'tool', title: 'Use the discovered capability',
          purpose: `Apply the newly discovered capability (${discovered.map(spec => spec.id).join(', ')}) through the authorized tool boundary and record real evidence.`,
          capability: discovered[0].id, capabilitySpecs: discovered };
      }
    }

    // A finished stage, or a reassessment that changed nothing, moves on to
    // the next planned stage; with none left the result is checked.
    if (!candidate && (target.type === 'reassess' || PLANNED_STAGES.has(target.type))
        && !(target.type === 'code' && target.metadata?.execution === false)) {
      candidate = plannedStage() ?? { type: 'verify', title: 'Verify the result',
        purpose: 'Check the current result against the success criteria and the evidence actually produced.', requires: ['verification'] };
    }

    if (!candidate && target.type === 'understand') {
      // A material question the situation still holds is asked next, whether
      // or not this understanding repeated it.
      const openQuestions = run.situation?.clarificationRequired === true
        && !tasks.some(item => item.type === 'clarify' && item.status === 'complete');
      if ((Array.isArray(structured?.questions) && structured.questions.length) || openQuestions) {
        candidate = { type: 'clarify', title: 'Clarify the material unknowns',
          purpose: 'Resolve the questions that materially change the situation, constraints or success criteria.', humanInput: true };
      // Work on the person's own files or code is done from those files: a
      // model's wish to investigate adds web research only when it was planned.
      } else if (structured?.needsInvestigation === true && !(run.adaptation?.ownWork && !planned.has('evidence-retrieval'))) {
        candidate = { type: 'investigate', title: 'Investigate the required evidence',
          purpose: 'Retrieve or establish the evidence needed to resolve the identified uncertainty.' };
      } else if (structured?.needsCapabilityDiscovery === true || structured?.unknownSituation === true
          || (Array.isArray(structured?.candidateCapabilities) && structured.candidateCapabilities.length)) {
        candidate = { type: 'discover-capabilities', title: 'Discover the required capability',
          purpose: 'Determine the capability, tools, data, environment and verification needed for the current situation.' };
      } else if (structured?.highImpact === true || structured?.physical === true
          || run.governance?.constraints?.requireHumanApproval === true) {
        candidate = { type: 'approval', title: 'Approve the next real-world or high-impact action',
          purpose: 'Review and explicitly approve the next governed action before it can execute.' };
      } else {
        candidate = plannedStage() ?? { type: 'step', title: 'Work on the current need',
          purpose: 'Perform the smallest useful next piece of work for the situation and report what changed.' };
      }
    }

    if (target.type === 'understand' && run.adaptation?.scale === 'small' && (
      ['investigate', 'discover-capabilities'].includes(candidate?.type)
      || structured?.highImpact === true || (structured?.needsInvestigation === true && !run.adaptation?.ownWork) || structured?.needsCapabilityDiscovery === true
    )) {
      // A small plan that grew (research, discovery, a risk) is
      // no longer small: the brief and later steps are told so.
      await client.query(
        `UPDATE runs SET adaptation = jsonb_set(jsonb_set(COALESCE(adaptation, '{}'::jsonb), '{scale}', '"standard"'::jsonb, true), '{scaleChangedBy}', '"understand"'::jsonb, true)
          WHERE id = $1`,
        [run.id]
      );
    }

    if (requirementsEnabled && target.type === 'verify' && requirementModel.completionReady) {
      candidate = { type: 'deliver', title: 'Deliver the verified result',
        purpose: 'Present the verified result, artifacts, evidence, limitations and any necessary next actions.',
        requirementIds: requirementModel.items.filter(item => item.status === 'satisfied').map(item => item.id) };
    }

    if (requirementsEnabled && candidate?.type === 'deliver' && !requirementModel.completionReady) {
      candidate = requirementAction(requirementModel);
      if (candidate) candidate.requirementIds = [activeRequirement?.id].filter(Boolean);
    }

    // Full workflows never jump straight from work/tool output to delivery.
    // A completed, criterion-checked server verification is the authority that
    // unlocks delivery. The completion gate remains the final defense; this
    // graph rule prevents an avoidable blocked deliver node from being created.
    if (requirementsEnabled && candidate?.type === 'deliver') {
      const verified = tasks.some(item =>
        item.type === 'verify'
        && item.status === 'complete'
        && item.evidence?.verdict?.verdict === 'pass'
      );
      if (!verified) {
        candidate = {
          type: 'verify',
          title: 'Verify the result',
          purpose: 'Check the current result against the success criteria and the evidence actually produced.',
          requires: ['verification']
        };
      }
    }

    if (requirementsEnabled && !candidate && activeRequirement && structured?.judged !== false) {
      const action = requirementAction(requirementModel);
      if (action && target.type !== 'deliver') candidate = { ...action, requirementIds: [activeRequirement.id] };
    }

    if (requirementsEnabled && candidate && activeRequirement
        && (!Array.isArray(candidate.requirementIds) || candidate.requirementIds.length === 0)) {
      candidate = { ...candidate, requirementIds: [activeRequirement.id] };
    }

    if (enough && target.type !== 'verify' && target.type !== 'deliver'
        && !target.metadata?.buildPlan && !target.metadata?.ventureDiscovery) {
      candidate = { type: 'verify', title: 'Verify the result',
        purpose: 'Check the result against the current success criteria and the evidence actually produced.', requires: ['verification'] };
    }
    if (!candidate) {
      if (target.id === 'test-code') {
        candidate = {
          type: 'verify',
          title: 'Verify the result',
          purpose: 'Check the current result against the success criteria and the evidence actually produced.',
          requires: ['verification']
        };
      } else if (target.type === 'step' && structured?.enough !== true) {
        // A step that answered in plain text named no further step: the
        // planned work continues, or the result is checked, instead of
        // chaining steps that were never asked for.
        candidate = plannedStage() ?? (structured?.judged === false || tasks.filter(item => item.type === 'step').length >= MAX_GENERIC_STEPS
          // Steps that name no next action stop here and the work is checked.
          ? { type: 'verify', title: 'Verify the result',
              purpose: 'Check the current result against the success criteria and the evidence actually produced.', requires: ['verification'] }
          : { type: 'step', title: 'Continue the current need',
              purpose: 'Perform the smallest useful next piece of work based on the current situation and observed evidence.' });
      } else if (target.type !== 'deliver' && target.type !== 'verify') {
        candidate = {
          type: 'verify',
          title: 'Verify the result',
          purpose: 'Check the current result against the success criteria and the evidence actually produced.',
          requires: ['verification']
        };
      }
    }
    // Model-proposed next steps and even an early "enough:true" are not
    // authority to bypass explicitly needed ideation. Keep essential human
    // clarification/approval and genuine evidence-gathering gates available,
    // but never schedule coding, planning or finalization before the recorded
    // idea comparison exists. The parent inserts only this one next step.
    if (ventureStep && candidate && [
      'code','plan','step','prototype','respond','verify','deliver'
    ].includes(candidate.type)) {
      candidate = ventureStep;
    }

    // Delivery is never allowed to skip a required verification boundary.
    // Some deterministic tool/result paths can otherwise select a planned
    // deliver stage directly even though the run-level acceptance contract
    // still requires verification. Enforce the invariant from server-owned
    // persisted state rather than trusting the candidate transition.
    const verificationRequiredForDelivery = run.adaptation?.acceptanceContract?.verificationRequired === true
      || run.adaptation?.unifiedAdaptiveWorkflow?.acceptance?.verificationRequired === true
      || run.adaptation?.unifiedAdaptiveWorkflow?.outcomeContract?.controls?.verificationRequired === true;
    const passingVerificationRecorded = run.adaptation?.acceptanceContract?.verificationSatisfied === true
      || run.adaptation?.unifiedAdaptiveWorkflow?.acceptance?.verificationSatisfied === true
      || tasks.some(item => item.type === 'verify'
        && item.status === 'complete'
        && (item.evidence?.verdict?.verdict === 'pass' || item.evidence?.verification?.verdict === 'pass'));
    if (candidate?.type === 'deliver' && verificationRequiredForDelivery && !passingVerificationRecorded) {
      candidate = {
        type: 'verify',
        title: 'Verify the result',
        purpose: 'Check the current result against the success criteria and the evidence actually produced.',
        requires: ['verification']
      };
    }

    // Unplanned model-proposed extensions must be justified by a real
    // prior observation and an unmet acceptance need. Planned work, user
    // approvals and mandatory verification remain governed by their existing
    // distinct server gates.
    if (candidate && (
      (novelProposal && candidate.type === canonical(next)?.type)
      || (target.type === 'reassess' && Array.isArray(candidate.capabilitySpecs)
        && candidate.capabilitySpecs.length > 0)
    )) {
      const evidenceDecision = evidenceNextTaskGate({
        sourceTask: target,
        proposal: candidate,
        tasks,
        requirements: requirementModel,
        budgetAllows: totalCreated < workflowBudget.maxWorkflowNodes
      });
      if (!evidenceDecision.allowed) {
        await client.query(
          'INSERT INTO situation_events (run_id, workspace_id, principal_id, event_type, event) VALUES ($1, $2, $3, $4, $5::jsonb)',
          [run.id, run.workspace_id, run.principal_id, 'adaptive-expansion-deferred',
            JSON.stringify({ after: target.id, proposedType: candidate.type, reason: evidenceDecision.reason })]
        );
        candidate = plannedStage() ?? {
          type: 'verify', title: 'Verify the result',
          purpose: 'Check the recorded evidence and remaining requirements before adding more work.',
          requires: ['verification']
        };
      } else {
        admittedExpansion = evidenceDecision;
      }
    }
    if (!candidate) return;
    // Executed work is reassessed before it is verified: the evidence may call
    // for a new capability or a changed plan. Clean evidence is recorded by
    // the server without a model call (checkpoint.js).
    if ((candidate.type === 'verify' || PLANNED_STAGES.has(candidate.type)) && candidate.type !== target.type
        && !canonical(next) && REASSESSED_STAGES.has(target.type) && target.metadata?.execution !== false
        && !tasks.some(item => item.type === 'reassess' && (item.dependsOn ?? []).includes(target.id))) {
      candidate = { type: 'reassess', title: 'Reassess the situation',
        purpose: 'Inspect the evidence produced so far and decide whether the situation needs a new capability or a changed plan before verification.',
        requires: ['reasoning'],
        // Between stages only the stage just finished is read; before the
        // check, everything done so far.
        ...(candidate.type !== 'verify' ? { sourceTask: target.id } : {}) };
    }
    // However a generic step was chosen (a requirement still open, a step with
    // nothing more specific), the chain ends at the limit and the work is checked.
    if (candidate.type === 'step' && !textValue(candidate.capability)
        && tasks.filter(item => item.type === 'step').length >= MAX_GENERIC_STEPS
        && !tasks.some(item => item.type === 'verify' && item.status === 'pending')) {
      candidate = { type: 'verify', title: 'Verify the result',
        purpose: 'Check the current result against the success criteria and the evidence actually produced.', requires: ['verification'] };
    }

    // Policies name capabilities (evidence-retrieval…), not step types:
    // checking only the step type let a denied capability through.
    const STEP_CAPABILITY = { investigate: 'evidence-retrieval', tool: 'adaptive-execution' };
    const policyCapability = textValue(candidate.capability)
      || (candidate.type === 'code' ? (target.id === 'build-code' ? 'code-generation' : 'code-execution') : '')
      || STEP_CAPABILITY[candidate.type] || '';
    const policyRisk = textValue(candidate.risk)
      || '';
    if (!policyAllows(run.governance, { capability: policyCapability, risk: policyRisk })) {
      const adaptation = {
        ...(run.adaptation ?? {}),
        lastBlockedAdaptiveStep: {
          after: target.id,
          type: candidate.type,
          capability: policyCapability,
          reason: 'policy'
        }
      };
      await client.query(
        'UPDATE runs SET adaptation = $2::jsonb, updated_at = now() WHERE id = $1',
        [run.id, JSON.stringify(adaptation)]
      );
      return;
    }

    const executionType = ['tool', 'investigate'].includes(candidate.type)
      || (candidate.type === 'code' && target.id === 'build-code');
    const hasApprovedGate = tasks.some(item => item.type === 'approval' && item.status === 'complete' && !item.metadata?.planAgreement);
    // An earlier approval never covers a capability discovered later: a tool
    // step with discovered capabilities needs an approval of exactly those.
    const discoveredIds = Array.isArray(candidate.capabilitySpecs) ? candidate.capabilitySpecs.map(spec => textValue(spec?.id)).filter(Boolean) : [];
    const discoveredApproved = discoveredIds.length > 0 && target.type === 'approval' && target.status !== 'failed'
      && discoveredIds.every(id => (target.metadata?.approvalFor?.capabilitySpecs ?? []).some(spec => textValue(spec?.id) === id));
    const requiresApproval = discoveredIds.length ? !discoveredApproved : executionType && !hasApprovedGate && (
      candidate.type === 'tool'
      || candidate.type === 'investigate' || run.governance?.constraints?.requireHumanApproval === true
      || candidate.approvalRequired === true
    );
    if (requiresApproval && target.type !== 'approval') {
      candidate = { type: 'approval', title: 'Approve the next governed action',
        purpose: 'Explicitly approve the next action before it executes.', approvalFor: canonical(candidate) };
    }
    if (candidate.type === 'approval' && target.type === 'approval') return;

    const baseId = candidate.type === 'code'
      ? (target.id === 'build-code' ? 'test-code' : 'build-code')
      : candidate.type;
    // Fixed code goes back to the test step the repair reset, which is still
    // waiting on it; a second test step would run with no code of its own.
    if (candidate.type === 'code' && tasks.some(item => item.id === baseId && item.status === 'pending'
        && (item.dependsOn ?? []).includes(target.id))) return;
    let id = baseId;
    let ordinal = 1;
    while (existingIds.has(id)) { id = baseId + '-' + ordinal++; }

    const execution = candidate.type === 'code'
      ? id !== 'build-code'
      : ['tool', 'investigate'].includes(candidate.type);
    const requires = Array.isArray(candidate.requires)
      ? [...new Set(candidate.requires.map(textValue).filter(Boolean))]
      : candidate.type === 'verify' ? ['verification']
        : candidate.type === 'code' ? [id === 'build-code' ? 'code-generation' : 'code-execution']
          : candidate.type === 'investigate' ? ['evidence-retrieval'] : ['reasoning'];

    const requirementIds = [...new Set([
      ...(Array.isArray(candidate.requirementIds) ? candidate.requirementIds : []),
      ...(requirementsEnabled && candidate.type === 'verify'
        ? requirementModel.items.filter(item => item.required !== false && item.status !== 'superseded').map(item => item.id)
        : [])
    ])].filter(reqId => requirementModel.items.some(item => item.id));

    const metadata = {
      adaptive: true, dynamicGraph: true, createdFrom: target.id, title: candidate.title,
      ...(candidate.approvalFor ? { approvalFor: {
        type: candidate.approvalFor.type, purpose: candidate.approvalFor.purpose,
        ...(candidate.approvalFor.capabilitySpecs ? { title: candidate.approvalFor.title, capability: candidate.approvalFor.capability, capabilitySpecs: candidate.approvalFor.capabilitySpecs } : {})
      } } : {}),
      ...(candidate.type === 'code' ? {
        execution, modelGenerated: id === 'build-code', incremental: true,
        repairOnFailure: id === 'test-code' ? { returnsTo: 'build-code', whileImproving: true } : undefined,
        // The code step answers with a structured package; without the schema
        // the model's code is not read as code and the step records nothing.
        ...(id === 'build-code' ? {
          qualityGate: 'implementation', testBeforeDelivery: true,
          outputSchema: { language: 'string', source: 'string', tests: 'string', packages: 'string[]', notes: 'string' }
        } : {})
      } : {}),
      ...(candidate.type === 'tool' || candidate.type === 'investigate' ? { execution: true, approvalRequired: requiresApproval } : {}),
      ...(candidate.type === 'tool' && Array.isArray(candidate.capabilitySpecs) && candidate.capabilitySpecs.length
        ? { capabilitySpecs: candidate.capabilitySpecs, approvalRequired: true, dynamic: true }
        : {}),
      ...(candidate.type === 'verify' ? { verification: run.adaptation?.verification ?? run.situation?.verification ?? verificationContract() } : {}),
      ...(candidate.inventionLoop === true ? { inventionLoop: true } : {}),
      ...(candidate.ventureDiscovery===true ? { ventureDiscovery:true,
        venturePhase:'explore-before-build' } : {}),
      ...(candidate.type === 'reassess' && candidate.sourceTask ? { sourceTask: candidate.sourceTask } : {}),
      ...(candidate.humanInput ? { humanInput: true } : {}),
      ...(admittedExpansion?.evidenceTaskId ? { evidenceAnchorTaskId: admittedExpansion.evidenceTaskId, admission: admittedExpansion.reason } : {}),
      ...(candidate.buildPlan ? {
        buildPlan: true,
        outputSchema: BUILD_PLAN_SCHEMA,
        ...(candidate.existingCodePlan ? { existingCodePlan: true } : {})
      } : {}),
      ...(candidate.planAgreement ? {
        planAgreement: true,
        ...(candidate.existingCodePlan ? { existingCodePlan: true } : {})
      } : {}),
      requirementIds
    };

    const position = tasks.reduce((max, item) => Math.max(max, Number(item.position ?? 0)), -1) + 1;
    await insertTask(client, run.id, { id, position, type: candidate.type, dependsOn: [target.id],
      requires, purpose: candidate.purpose, metadata });
    await client.query(
      'INSERT INTO situation_events (run_id, workspace_id, principal_id, event_type, event) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [run.id, run.workspace_id, run.principal_id, 'adaptive-step-created', JSON.stringify({
        after: target.id, taskId: id, type: candidate.type, title: candidate.title, requirementIds, oneStepAtATime: true
      })]
    );
  }

  /** Stop after a failure: the run ends as failed, with its evidence kept. */
  async stop(client, run) {
    await client.query(
      `UPDATE runs SET state = 'failed', updated_at = now(), completed_at = now() WHERE id = $1`,
      [run.id]
    );
    return { state: 'failed', attempt: run.attempt };
  }

  /**
   * Add tokens a provider actually reported to a run's total, and say whether
   * policy's budget is now spent. Nothing is estimated: a provider that
   * returns no usage adds nothing.
   */
  /**
   * Charge a model call to the run's token budget and record it in the usage
   * ledger for the person who made it. `usage` is { inputTokens, outputTokens,
   * provider, model } (a bare number is taken as output).
   */
  async addTokens(runId, usage, { source = 'chat' } = {}) {
    const detail = typeof usage === 'number' ? { outputTokens: usage } : (usage ?? {});
    const tokens = (Number(detail.inputTokens) || 0) + (Number(detail.outputTokens) || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) return null;
    const { rows: [row] } = await this.pool.query(
      `UPDATE runs SET tokens_used = tokens_used + $2, updated_at = now() WHERE id = $1
       RETURNING tokens_used, max_tokens, conversation_id`,
      [text(runId), Math.round(tokens)]
    );
    if (!row) return null;
    await recordUsage(this.pool, {
      runId: text(runId), conversationId: row.conversation_id, source,
      provider: detail.provider, model: detail.model,
      inputTokens: detail.inputTokens, outputTokens: detail.outputTokens
    });
    const maxTokens = row.max_tokens === null ? null : Number(row.max_tokens);
    return {
      tokensUsed: Number(row.tokens_used),
      maxTokens,
      exceeded: maxTokens !== null && Number(row.tokens_used) > maxTokens
    };
  }

  /** Mark a run failed, e.g. when execution errored outside a task boundary. */
  async fail(scope, principal, runId, reason, { requestId } = {}) {
    const { rows } = await this.pool.query(
      `UPDATE runs SET state = 'failed', updated_at = now(), completed_at = now()
        WHERE id = $1 AND workspace_id = $2
          AND (visibility = 'workspace' OR principal_id = $3)
          AND state NOT IN ('complete', 'failed', 'blocked', 'exhausted') RETURNING id`,
      [text(runId), scope.workspaceId, scope.principalId]
    );
    if (!rows[0]) return null;
    await this.audit?.record({
      principalId: principal.id,
      workspaceId: scope.workspaceId,
      action: 'run.fail',
      target: text(runId),
      outcome: 'failed',
      detail: { reason: text(reason) || null },
      requestId
    });
    return this.get(scope, runId);
  }

  async load(client, scope, id) {
    const { rows: [run] } = await client.query(
      `SELECT * FROM runs
         WHERE id = $1 AND workspace_id = $2
           AND (visibility = 'workspace' OR principal_id = $3)`,
      [id, scope.workspaceId, scope.principalId]
    );
    if (!run) return null;
    const tasks = await loadTasks(client, run.id);
    // Replan, repair, stop and legacy paths can change task rows without
    // passing through the ordinary advance checkpoint. Every authorized read
    // therefore reflects the real persisted task table, never a stale UI
    // projection. This does not mutate the DB or grant any new authority.
    const unified = run.adaptation?.unifiedAdaptiveWorkflow;
    if (unified) {
      const graph = projectPersistedTaskGraph(tasks, unified.taskGraph);
      const synchronized = {
        ...unified, taskGraph: graph,
        openWorld: composeOpenWorldDecision({
          goal: run.goal, situation: run.situation ?? {}, graph,
          acceptance: unified.acceptance ?? {}
        })
      };
      return present({
        ...run,
        adaptation: { ...run.adaptation, unifiedAdaptiveWorkflow: synchronized }
      }, tasks);
    }
    return present(run, tasks);
  }
}

/* ------------------------------------------------------------------ helpers */

const MAX_LESSONS = 5;

const clip = (value, max) => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return raw.length > max ? raw.slice(0, max) + '…' : raw;
};

/** What an attempt taught: what failed and why, and what was already done. */
function lessonFrom(run, tasks, reason) {
  const verification = tasks.find(item => item.type === 'verify' && item.evidence)?.evidence?.verdict ?? null;
  return {
    attempt: run.attempt,
    at: new Date().toISOString(),
    reason,
    recovery: Array.isArray(run.adaptation?.recoveryHistory)
      ? run.adaptation.recoveryHistory.slice(-6)
      : [],
    failed: tasks.filter(item => item.status === 'failed').map(item => ({
      taskId: item.id,
      type: item.type,
      summary: clip(text(item.summary), 300),
      evidence: clip(item.evidence, 1500)
    })),
    verification,
    completed: tasks.filter(item => item.status === 'complete').slice(0, 20).map(item => ({
      taskId: item.id,
      summary: clip(text(item.summary), 200)
    }))
  };
}

function planExecutionRequirements(kind, candidate) {
  const requirements = candidate && typeof candidate === 'object' ? candidate : {};
  const cpuCores = Number.isFinite(Number(requirements.cpuCores)) && Number(requirements.cpuCores) > 0
    ? Number(requirements.cpuCores)
    : 0;
  const memoryBytes = Number.isFinite(Number(requirements.memoryBytes)) && Number(requirements.memoryBytes) > 0
    ? Number(requirements.memoryBytes)
    : 0;
  const storageBytes = Number.isFinite(Number(requirements.storageBytes)) && Number(requirements.storageBytes) > 0
    ? Number(requirements.storageBytes)
    : 0;
  const gpu = requirements.gpu && typeof requirements.gpu === 'object'
    ? {
        required: requirements.gpu.required === true,
        memoryBytes: Number.isFinite(Number(requirements.gpu.memoryBytes)) && Number(requirements.gpu.memoryBytes) > 0
          ? Number(requirements.gpu.memoryBytes)
          : 0
      }
    : { required: false, memoryBytes: 0 };
  const software = requirements.software && typeof requirements.software === 'object'
    ? Object.fromEntries(
        Object.entries(requirements.software)
          .filter(([name, version]) => /^[A-Za-z0-9._-]+$/.test(name) && text(version))
          .map(([name, version]) => [name, text(version)])
      )
    : {};

  const defaults = defaultExecutionRequirements(kind);
  return {
    cpuCores: Math.max(defaults.cpuCores, cpuCores),
    memoryBytes: Math.max(defaults.memoryBytes, memoryBytes),
    storageBytes: Math.max(defaults.storageBytes, storageBytes),
    gpu: {
      required: gpu.required || defaults.gpu.required,
      memoryBytes: Math.max(defaults.gpu.memoryBytes, gpu.memoryBytes)
    },
    software: {
      ...defaults.software,
      ...software
    }
  };
}

/* ------------------------------------------------ graph-edit primitives */
// Every edit runs in the caller's transaction on rows it has locked.
