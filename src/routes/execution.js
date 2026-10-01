/**
 * Execution: model reasoning, managed runners, the local agent and the
 * receipts that are the only way external work can be recorded.
 */

import crypto from 'node:crypto';
import { parseJsonObject } from '../structured.js';
import { callModel, callRunner, SANDBOX_TIMEOUT_MS } from '../runtime.js';
import { chooseExecutionTarget, executionTargetsFor, verifyExecutionReceipt, signExecutionChallenge, executionPayloadDigest, executionSucceeded, executionIdFor, RECEIPT_ALGORITHM } from '../execution.js';
import { text } from '../http/context.js';
import { configuredExecutionTargets, runnerForTarget, planPolicyAllows, dataPolicyAllows, dataPolicyDecision, modelPolicyAllows } from '../http/policy.js';
import { assertUsageAllowed, UsageLimitError } from '../usage.js';
import { attachmentContext, projectFiles } from '../attachments.js';
import { answerWithTools } from '../toolbox.js';
import { RunActions, ActionError } from '../run-actions.js';
import { workspaceTools, listWorkspaceTools } from '../tool-forge.js';
import { memoriesFor } from '../memory.js';
import '../tools/finance.js';
import { usagePolicyPrompt, blockedTopicsFrom, guardAnswer, recordRefusal } from '../safety.js';
import { toolNamed } from '../toolbox.js';
import { currentDbScope } from '../db.js';
import { modelForStep, resolveModelSelection } from '../model-routing.js';
import { compileExecutionCapabilityPlan } from '../capability-compiler.js';
import { effortForAdaptiveDepth, adaptiveExecutionBudgetStatus, toolsForTask, adaptiveStepScope } from '../adaptive-control.js';
import { executionSafetyGate } from '../adaptive-safety.js';
import { situationGovernanceExecutionGate } from '../situation-governance.js';
import { systemPromptFor, situationBrief, previousAttempts, normalizeVerdict, GENERIC_CRITERION } from '../reasoning-context.js';
import { gradedCriteria } from '../requirements.js';
import { groundedCheckDecision, verificationBrief, groundVerdict } from '../verification.js';
import { reviewDecision, reviewerModelFor, reviewMessages, readReview, mergeReview, REVIEW_MAX_OUTPUT_TOKENS } from '../agents.js';
import { runAdaptiveAgentPanel } from '../multi-agent.js';
import { workPlan, readStepAnswer } from '../step-plan.js';
import { adaptationFor, compact } from '../prompt-scope.js';
import { codeFailure, codeRunOutput, repairDecision, repairCeiling, codeNotRunNow, repairsThisAttempt, repairContext, untestedCode, missingTests, compactCodeEvidence, TESTS_REQUIRED_PROMPT, isProject, sandboxPayload, hasCode, compactProject, mergeFix, materializeCodePackage } from '../code-workflow.js';
import { cleanCheckpoint } from '../checkpoint.js';
import { buildUnifiedWorkContext } from '../unified-work-context.js';
import { buildProjectIndex } from '../project-index.js';
import { compileCodeContext, isCodeTask } from '../context-compiler.js';
import { RagStore } from '../rag.js';
import { loadSelectedSkills } from '../skills.js';
import { BlackboardStore } from '../blackboard.js';

/** Which tasks execute where. Everything else needs a human decision. */
const RUNNER_FOR = {
  tool: 'tools'
};
const MODEL_TASKS = new Set([
  'understand', 'discover', 'discover-capabilities', 'adapt', 'plan',
  'respond', 'prototype', 'reassess', 'verify', 'deliver', 'step'
]);

// Steps whose answer benefits from tools (see toolbox.js).
// Tools that serve the person in any step, gated by their own checks.
// tool.create works only when the person chose to invest in a tool, and what
// it builds runs only after an administrator approves it.
const PERSONAL_TOOLS = Object.freeze(['memory.save', 'memory.forget', 'schedule.create', 'schedule.list', 'tool.create']);
const TOOL_TASKS = new Set(['respond', 'deliver', 'prototype', 'discover', 'investigate', 'tool', 'step']);
// Steps whose answer the person reads; the service's topic guard applies.
const ANSWER_TASKS = new Set(['respond', 'deliver', 'prototype', 'investigate', 'tool', 'step']);

/** Steps whose answer is one JSON object the server reads. */
export function answersInJson(task) {
  return ['verify', 'understand', 'discover-capabilities', 'reassess', 'plan'].includes(task?.type)
    || task?.id === 'build-code' || Boolean(task?.metadata?.outputSchema);
}

/**
 * How hard the model should think for a step. Someone in crisis needs an
 * answer now; code, checks and designs need the most care.
 */
const EFFORT = ['low', 'medium', 'high'];
const shiftEffort = (level, by) => EFFORT[Math.max(0, Math.min(EFFORT.length - 1, EFFORT.indexOf(level) + by))];

/**
 * How hard the model thinks on one step, from the situation rather than the
 * step type alone. Code, checks and designs start careful; other steps
 * follow the depth asked for. Then: a fix after a failure, and a new attempt
 * after a failed check, think harder (something was missed); complex or
 * high-stakes work thinks harder; small, familiar work thinks less, except
 * its checks; a brief direct answer thinks least. A crisis is answered at
 * once.
 */
export function thinkingFor(task, run = null) {
  if (task?.metadata?.crisis) return 'low';
  const depth = text(run?.adaptation?.resourcePlan?.control?.depth).toLowerCase() || 'standard';
  const careful = ['code', 'verify', 'prototype'].includes(task?.type);
  let level = careful ? (depth === 'brief' ? 'medium' : 'high') : effortForAdaptiveDepth(depth, 'medium');
  if (task?.id === 'build-code' && run && repairsThisAttempt(run).length) return 'high';
  const scale = run?.adaptation?.scale;
  const highStakes = run?.situation?.risk === 'high-impact';
  if (Number(run?.attempt ?? 1) > 1) level = shiftEffort(level, 1);
  if (scale === 'complex' || highStakes) level = shiftEffort(level, 1);
  else if (scale === 'small' && task?.type !== 'verify') level = shiftEffort(level, -1);
  const briefAnswer = run?.workflow === 'direct' && text(run?.situation?.need?.depth ?? run?.adaptation?.need?.depth) === 'brief';
  if (briefAnswer && !highStakes && task?.type === 'respond') level = 'low';
  return level;
}
// Targets carried out by Kindgleam's own toolbox rather than an outside runner.
const BUILTIN_TOOL_TARGETS = new Set(['builtin-research', 'builtin-tools']);

/** Captures status + JSON the way the route code writes them. */
function replyRecorder() {
  return {
    statusCode: 200,
    reply: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.reply = { status: this.statusCode, body: payload }; return this; }
  };
}

export function registerExecutionRoutes(app, { config, pool, audit, governance, capabilities, objects, runs, jobs, scheduler = null, memories = null, metrics, fetchImpl, scoped, route, idempotent = (_req, _res, next) => next() }) {
  // A refusal at the execution boundary belongs in the audit trail as much as
  // an approval does. Only the reason is kept, never the task content.
  const recordBoundaryDenial = (req, run, task, code, detail = {}) => audit?.record({
    principalId: req.principal.id,
    workspaceId: req.scope.workspaceId,
    action: 'run.execute.denied',
    target: run.id,
    outcome: 'denied',
    detail: { taskId: task?.id ?? null, code, ...detail },
    requestId: req.requestId
  });

  /**
   * Execute a run's next task. The HTTP route calls this synchronously and
   * the background worker calls it for queued jobs: one code path, so every
   * policy, consent and receipt check applies identically. Returns
   * { status, body } instead of writing a response.
   */
  const actions = new RunActions(pool, { audit });
  const rag = config.security?.personalDataEncryptionKey
    ? new RagStore(pool, { encryptionKey: config.security.personalDataEncryptionKey, maxChunkChars: 12000 })
    : null;
  const blackboard = config.security?.personalDataEncryptionKey
    ? new BlackboardStore(pool, { encryptionKey: config.security.personalDataEncryptionKey })
    : null;

  /** What tools may use in a step: the person's files and scope, and a way to propose actions. */
  function selectedAttachmentNames(run) {
    const selected = run.adaptation?.resourcePlan?.selected?.artifacts;
    return Array.isArray(selected) ? new Set(selected.map(text).filter(Boolean).map(name => name.toLowerCase())) : null;
  }

  function scopedAttachments(run, task = null) {
    const attachments = Array.isArray(run.adaptation?.attachments) ? run.adaptation.attachments : [];
    const selected = selectedAttachmentNames(run);
    const base = selected
      ? attachments.filter(file => file.sourceId || selected.has(text(file.name).toLowerCase()))
      : attachments;
    if (!task) return base;
    // Files attached to the message are what the person is asking about: every
    // step sees them. A step's scope narrows them only when it names the files
    // it needs (a large project's code step), never down to nothing.
    const step = adaptiveStepScope(run.adaptation?.resourcePlan, task, { need: run.situation?.need ?? null });
    const stepNames = new Set((step.artifacts ?? []).map(text).filter(Boolean).map(name => name.toLowerCase()));
    if (!stepNames.size) return base;
    const named = base.filter(file => file.sourceId || stepNames.has(text(file.name).toLowerCase()));
    return named.length ? named : base;
  }

  /**
   * What a runner is sent. The code test step runs what build-code wrote:
   * one source file with its tests, or a project's files on top of the
   * project the person attached.
   */
  async function runnerPayload(run, task, body, scope) {
    const submitted = body?.payload && typeof body.payload === 'object' ? body.payload : {};
    if (task.type !== 'code' || task.id !== 'test-code') return submitted;
    const built = run.tasks.find(item => item.id === 'build-code')?.evidence?.structured;
    if (!built || typeof built !== 'object') return submitted;
    if (isProject(built)) {
      const baseFiles = await projectFiles(objects, scope ?? currentDbScope(), scopedAttachments(run, task), { overlay: run.adaptation?.projectOverlay });
      return { ...sandboxPayload(built, { baseFiles }), ...submitted };
    }
    return {
      ...submitted,
      language: submitted.language || built.language,
      source: submitted.source || built.source,
      // The libraries it needs (fetched from the registries) and its tests.
      ...(Array.isArray(built.packages) && !submitted.packages ? { packages: built.packages } : {}),
      ...(built.tests && !submitted.tests ? { tests: built.tests } : {})
    };
  }

  async function toolContext(run, task, scope) {
    const workScope = scope ?? currentDbScope();
    const selectedTools = Array.isArray(run.adaptation?.resourcePlan?.selected?.tools)
      ? run.adaptation.resourcePlan.selected.tools
      : [];
    const attachments = scopedAttachments(run, task);
    const approvedTools = await workspaceTools(pool, workScope);
    const allowedTools = [...new Set([
      ...toolsForTask(task, {
        selectedTools,
        artifacts: run.adaptation?.resourcePlan?.selected?.artifacts ?? [],
        need: run.situation?.need ?? null
      }),
      // Always in reach, each behind its own safeguard: chat-local memory
      // (always on for the chat owner) and schedules (only proposed until
      // approved), the files attached to this message, and tools this workspace built
      // and an administrator approved.
      ...PERSONAL_TOOLS,
      ...(attachments.length ? ['file.read', 'data.analyze', 'code.run'] : []),
      ...approvedTools.map(tool => tool.name)
    ])];
    return {
      config, fetchImpl, objects, scope: workScope, pool, run, task, scheduler,
      // Workflow, file system and code all resolve through the same
      // situation-owned context. Tools cannot silently switch to a second
      // project state.
      unifiedWorkContext: run.adaptation?.unifiedWorkContext
        ?? buildUnifiedWorkContext({ goal: run.goal, situation: run.situation }),
      // Memory tools check the chat's owner and scope themselves (memory.js).
      memories,
      attachments,
      capabilityInvestment: text(run.adaptation?.resourcePlan?.implementation?.investment?.decision) === 'prepare-build-candidate'
        ? 'build-candidate'
        : text(run.adaptation?.resourcePlan?.control?.capabilityInvestment) || 'ask',
      modelId: run.adaptation?.modelSelection || null,
      allowedTools,
      // Tools this workspace built and approved earlier (tool-forge.js).
      dynamicTools: approvedTools,
      propose: workScope?.workspaceId
        ? action => actions.propose(workScope, { runId: run.id, taskId: task.id, ...action })
        : null
    };
  }
  /** Null when the person may use the AI now; otherwise the not-executed result that says when. */
  async function usageBlock(scope) {
    const principalId = scope?.principalId ?? currentDbScope()?.principalId;
    const workspaceId = scope?.workspaceId ?? currentDbScope()?.workspaceId;
    try {
      await assertUsageAllowed(pool, { principalId, config, workspaceId });
      return null;
    } catch (error) {
      if (!(error instanceof UsageLimitError)) throw error;
      return { configured: true, executed: false, status: error.code, message: error.message, resetsAt: error.window.resetsAt };
    }
  }

  async function executeNext({ scope, principal, runId, body = {}, requestId = null, expectedTaskId = null }) {
    const req = { scope, principal, params: { id: runId }, body: body ?? {}, requestId };
    const res = replyRecorder();
    await (async () => {
      const run = await runs.get(req.scope, req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
      if (run.state === 'blocked') {
        return res.status(409).json({
          error: `Policy denies required capabilities: ${run.capabilities.blocked.join(', ')}`,
          code: 'policy-blocked', run
        });
      }
      if (run.state === 'iterate') {
        return res.status(409).json({
          error: run.tasks.some(task => task.status === 'failed')
            ? 'A step failed. Decide whether to replan with what was learned or to stop.'
            : 'The work is delivered. Decide whether to refine it further or to finish.',
          code: 'decision-required', run
        });
      }
      const task = run.tasks.find(item => item.id === run.next);
      if (!task) return res.status(409).json({ error: 'This run has no task ready to execute', code: 'no-next-task', run });

      // Independent, model-free safety gate. The adaptive decision is checked
      // again at the execution boundary so later task payloads cannot bypass
      // the invariant established during planning.
      const safetyGate = executionSafetyGate(run, task, {
        blockedTopics: blockedTopicsFrom(config),
        payload: req.body?.payload ?? null
      });
      if (!safetyGate.allowed) {
        await recordBoundaryDenial(req, run, task, 'adaptive-safety-blocked', { category: safetyGate.category ?? null });
        return res.status(422).json({
          error: safetyGate.reason,
          code: 'adaptive-safety-blocked',
          category: safetyGate.category ?? null,
          run
        });
      }
      const adaptiveBudget = adaptiveExecutionBudgetStatus(run, task);
      if (!adaptiveBudget.allowed) {
        await recordBoundaryDenial(req, run, task, adaptiveBudget.code, {
          completedExecutionStages: adaptiveBudget.completedExecutionStages ?? null,
          maxExecutionStages: adaptiveBudget.maxExecutionStages ?? null,
          completedToolCalls: adaptiveBudget.completedToolCalls ?? null,
          maxToolCalls: adaptiveBudget.maxToolCalls ?? null
        });
        return res.status(409).json({
          error: adaptiveBudget.reason,
          code: adaptiveBudget.code,
          adaptiveBudget,
          run
        });
      }

      const situationGate = situationGovernanceExecutionGate(run, task);
      if (!situationGate.allowed) {
        await recordBoundaryDenial(req, run, task, 'situation-governance-blocked', { reason: situationGate.reason });
        return res.status(422).json({
          error: situationGate.reason,
          code: 'situation-governance-blocked',
          run
        });
      }

      // A caller (or a queued job) may pin the task it means. If the run has
      // moved on, refuse rather than execute a different task.
      if (expectedTaskId && task.id !== expectedTaskId) {
        return res.status(409).json({
          error: `Task ${expectedTaskId} is no longer the next task; the run is at ${task.id}.`,
          code: 'stale-execution', run
        });
      }

      let executionDecision = null;

      // Governance comes first: a discovered capability nobody has approved
      // says so before the deployment is asked whether it can run it.
      const dynamicIds = Array.isArray(task.metadata?.capabilitySpecs)
        ? task.metadata.capabilitySpecs.map(spec => text(spec?.id || spec?.name)).filter(Boolean)
        : [];
      if (task.metadata?.approvalRequired === true && task.type === 'tool') {
        if (task.dependsOn.every(id => !String(id).startsWith('approval'))) {
          return res.status(409).json({
            error: 'Dynamic capability execution must pass an explicit approval gate.',
            code: 'execution-approval-required',
            run
          });
        }
        const approvedIds = capabilities
          ? await capabilities.approved(req.scope, dynamicIds)
          : [];
        if (approvedIds.length !== dynamicIds.length) {
          return res.status(409).json({
            error: 'One or more discovered capabilities are still awaiting administrator approval.',
            code: 'capability-approval-required',
            pending: dynamicIds.filter(id => !approvedIds.includes(id)),
            run
          });
        }
      }

      // One execution gate for every environment-dependent task. The planner
      // may discover a capability, but this route checks the deployment's
      // actual targets/runners before anything is allowed to execute.
      const executionTaskTypes = new Set(['code', 'tool', 'investigate']);
      let capabilityImplementationPlan = null;
      if (executionTaskTypes.has(task.type)) {
        // The run's capabilities are checked against everything this
        // deployment can really do; each capability still maps only to the
        // targets that implement it (capability-compiler.js).
        const targets = [...new Set([...executionTaskTypes].flatMap(type => configuredExecutionTargets(config, type)))];
        const runtimeIds = [
          ...targets,
          ...(task.type === 'tool' && config.runners?.tools ? ['generic-tool-router'] : []),
          ...(task.type === 'code' && config.runners?.sandbox ? ['general-ai-sandbox'] : [])
        ];
        capabilityImplementationPlan = compileExecutionCapabilityPlan(
          run.capabilities?.requirements ?? [],
          {
            taskType: task.type,
            executionTargets: targets,
            runtimes: runtimeIds,
            connectors: run.adaptation?.connections ?? run.adaptation?.connectedServices ?? [],
            connectorAccessReady: Array.isArray(run.adaptation?.verifiedConnections)
              ? run.adaptation.verifiedConnections.length > 0
              : false,
            hardwareRunners: run.situation?.environment?.hardwareRunners ?? []
          }
        );
        if (!capabilityImplementationPlan.ready) {
          return res.status(409).json({
            error: 'The required capability has been discovered, but this deployment does not yet have a concrete implementation for it.',
            code: 'capability-implementation-required',
            capabilityPlan: capabilityImplementationPlan,
            run
          });
        }
      }
      if (task.type === 'investigate' && config.ai) {
        const availableTargets = configuredExecutionTargets(config, task.type);
        if (!availableTargets.includes('builtin-research')) {
          return res.status(409).json({
            error: 'Web research is turned off on this site (TOOLS_WEB_ACCESS=false). You can add your own findings instead.',
            code: 'research-runner-not-configured',
            run
          });
        }
        if (!planPolicyAllows(run, 'builtin-research', 'medium')
            || !dataPolicyAllows(run, run.adaptation?.dataClasses ?? ['user-content'], 'model-provider', {
              explicitConsent: req.body?.approved === true
            })) {
          return res.status(403).json({
            error: 'The active governance policy denies provider-backed web research.',
            code: 'research-policy-denied',
            run
          });
        }
        executionDecision = {
          status: 'ready',
          taskType: 'investigate',
          target: 'builtin-research',
          options: availableTargets,
          requiresApproval: true
        };
        if (req.body?.approved !== true) {
          return res.status(409).json({
            error: 'Provider-backed web research requires explicit human approval.',
            code: 'execution-approval-required',
            execution: executionDecision,
            run
          });
        }
      } else if (['tool', 'investigate'].includes(task.type)) {
        const availableTargets = configuredExecutionTargets(config, task.type);
        // Kindgleam's own toolbox first; a deployment's separate tool runner otherwise.
        const target = availableTargets.includes('builtin-tools') ? 'builtin-tools'
          : availableTargets.includes('generic-tool-router') ? 'generic-tool-router' : null;
        if (!target) {
          return res.status(409).json({
            error: 'No tools can run this step: no AI model is connected and no tool runner is configured.',
            code: 'tool-runner-not-configured',
            run
          });
        }
        executionDecision = {
          status: 'ready',
          taskType: task.type,
          target,
          options: availableTargets,
          requiresApproval: true
        };
        if (executionDecision.requiresApproval && req.body?.approved !== true) {
          return res.status(409).json({
            error: 'External tool or investigation execution requires explicit human approval.',
            code: 'execution-approval-required',
            execution: executionDecision,
            run
          });
        }
        if (!dataPolicyAllows(run, run.adaptation?.dataClasses ?? ['user-content'], target === 'builtin-tools' ? 'model-provider' : 'execution-runner', {
          explicitConsent: req.body?.approved === true
        })) {
          return res.status(403).json({
            error: 'Private data cannot be used by these tools without explicit consent and policy authorization.',
            code: 'tool-data-policy-denied',
            run
          });
        }
        if (!planPolicyAllows(run, target, 'high')) {
          return res.status(403).json({
            error: 'The active governance policy denies these tools.',
            code: 'execution-target-policy-denied',
            run
          });
        }
      }

      if (task.type === 'code' && task.metadata?.execution === true) {
        executionDecision = chooseExecutionTarget(task.type, {
          preference: req.body?.executionTarget,
          preflight: req.body?.preflight,
          requirements: req.body?.requirements ?? task.metadata?.requirements,
          cloudFallbackAllowed: req.body?.cloudFallbackAllowed !== false,
          availableTargets: configuredExecutionTargets(config, task.type)
        });

        // No runner can run code here at all: the tests are skipped with the
        // reason and the code goes on marked as not run, rather than failing
        // a step no retry can ever complete.
        if (executionDecision.status === 'unsupported' && task.id === 'test-code') {
          const reason = 'no code sandbox is configured on this deployment';
          const skipped = await runs.skipUnrunnableCode(req.scope, req.principal, run.id, task.id, { reason }, { requestId: req.requestId });
          metrics.increment('executions_total', { type: task.type, outcome: 'no-execution-target' });
          return res.status(200).json({ run: skipped ?? run, execution: { configured: false, executed: false, status: 'no-execution-target', message: `Not run: ${reason}.` } });
        }
        if (executionDecision.status === 'unsupported'
            || executionDecision.status === 'invalid-selection'
            || executionDecision.status === 'local-insufficient'
            || executionDecision.status === 'preflight-required') {
          return res.status(409).json({
            error: executionDecision.reason || 'A compatible execution target is required before this task can run.',
            code: 'execution-target-required',
            execution: executionDecision,
            run
          });
        }
        if (!executionDecision.target) {
          return res.status(409).json({
            error: 'Choose an execution target before running this task.',
            code: 'execution-target-required',
            execution: executionDecision,
            run
          });
        }
        if (!planPolicyAllows(run, executionDecision.target, 'high')
            || !dataPolicyAllows(run, run.adaptation?.dataClasses ?? ['workspace-content'], 'execution-runner', {
            explicitConsent: req.body?.approved === true || executionDecision?.target === 'local'
          })) {
          return res.status(403).json({
            error: 'The active governance policy denies the selected execution target.',
            code: 'execution-target-policy-denied',
            execution: executionDecision,
            run
          });
        }

        if (executionDecision.requiresApproval && req.body?.approved !== true) {
          return res.status(409).json({
            error: 'Execution requires explicit human approval for the selected target.',
            code: 'execution-approval-required',
            execution: executionDecision,
            run
          });
        }

        if (executionDecision.target === 'local') {
          const localPayload = await runnerPayload(run, task, req.body, req.scope);
          const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
          const nonce = crypto.randomBytes(16).toString('base64url');
          const executionId = executionIdFor({
            runId: run.id,
            taskId: task.id,
            attempt: run.attempt,
            executionTarget: 'local',
            round: repairsThisAttempt(run).length
          });
          const payloadDigest = executionPayloadDigest(localPayload);
          const signature = signExecutionChallenge(config.execution.localAgentSharedSecret, {
            runId: run.id,
            taskId: task.id,
            taskType: task.type,
            attempt: run.attempt,
            executionId,
            executionTarget: 'local',
            expiresAt,
            nonce,
            payloadDigest
          });
          const issued = await runs.issueExecutionChallenge(
            req.scope,
            req.principal,
            run.id,
            task.id,
            { attempt: run.attempt, nonce, expiresAt, executionId, payloadDigest }
          );
          if (!issued) {
            return res.status(409).json({
              error: 'The run changed while the local execution challenge was being prepared.',
              code: 'stale-execution'
            });
          }
          return res.status(200).json({
            run: await runs.get(req.scope, run.id),
            execution: {
              configured: true,
              executed: false,
              status: 'local-agent-required',
              target: 'local',
              agentUrl: config.execution.localAgentUrl,
              request: {
                runId: run.id,
                taskId: task.id,
                taskType: task.type,
                attempt: run.attempt,
                executionId,
                goal: run.goal,
                task: {
                  id: task.id,
                  type: task.type,
                  purpose: task.purpose,
                  metadata: task.metadata ?? {}
                },
                payload: localPayload,
                preflight: executionDecision.local?.preflight ?? req.body?.preflight ?? null,
                receiptAlgorithm: RECEIPT_ALGORITHM,
                executionChallenge: {
                  expiresAt,
                  nonce,
                  payloadDigest,
                  signature,
                  executionId,
                  attempt: run.attempt
                },
                resultEndpoint: `/api/runs/${run.id}/execution-result`
              },
              message: 'Run this approved task through the paired local agent. The server accepts the resulting receipt only once.'
            }
          });
        }
      }

      if (task.type === 'clarify') {
        return res.status(409).json({
          error: 'Material clarification requires direct human input. Advance this task with the requested answers.',
          code: 'awaiting-clarification', taskId: task.id, questions: task.metadata?.questions ?? [], run
        });
      }

      if (task.type === 'approval') {
        return res.status(409).json({
          error: 'Policy requires a human approval. Advance this task explicitly.',
          code: 'awaiting-approval', taskId: task.id, approvals: run.governance.approvals, run
        });
      }
      if (task.type === 'iterate') {
        return res.status(409).json({
          error: 'Whether to replan or finish is a human decision. Advance this task explicitly.',
          code: 'decision-required', taskId: task.id, run
        });
      }

      if (run.maxTokens !== null && run.tokensUsed >= run.maxTokens) {
        return res.status(409).json({
          error: `Run has spent its ${run.maxTokens} token budget`, code: 'budget-exhausted', run
        });
      }

      // `observe` is not an outside call. It collects what execution actually
      // recorded — which is the whole point of having the step.
      if (task.type === 'observe') {
        const observed = run.tasks
          .filter(item => item.evidence && item.id !== task.id)
          .map(item => ({ taskId: item.id, type: item.type, status: item.status, evidence: item.evidence }));
        if (!observed.length) {
          return res.status(422).json({
            error: 'Nothing has been recorded to observe yet', code: 'evidence-required', run
          });
        }
        return res.json({
          run: await runs.advance(req.scope, req.principal, run.id, task.id,
            { summary: `Collected ${observed.length} recorded result(s).`, evidence: { observed } },
            { requestId: req.requestId }),
          execution: { configured: true, executed: true, status: 'completed', source: 'recorded-evidence' }
        });
      }

      const runnerKey = executionDecision?.target === 'builtin-research'
        ? null
        : executionDecision?.target === 'general-ai-sandbox'
          ? 'sandbox'
        : executionDecision?.target === 'generic-tool-router'
          ? 'tools'
          : RUNNER_FOR[task.type];
      const runnerUrl = executionDecision?.target
        ? runnerForTarget(config, executionDecision.target)
        : config.runners[runnerKey];
      const managedExecutionId = executionDecision?.target
        ? executionIdFor({
            runId: run.id,
            taskId: task.id,
            attempt: run.attempt,
            executionTarget: executionDecision.target,
            // Each fixed version of the code is a new execution, not a replay.
            round: repairsThisAttempt(run).length
          })
        : null;
      const execution = runnerKey && runnerUrl
        ? await callRunner(runnerUrl, {
            runId: run.id,
            goal: run.goal,
            task: {
              id: task.id,
              type: task.type,
              purpose: task.purpose,
              metadata: task.metadata ?? {}
            },
            adaptation: run.adaptation ?? {},
            capabilityRequirements: run.capabilities?.requirements ?? [],
            capabilityImplementationPlan,
            workContext: run.adaptation?.unifiedWorkContext ?? null,
            payload: await runnerPayload(run, task, req.body, req.scope),
            executionTarget: executionDecision?.target ?? null,
            executionId: managedExecutionId,
            preflight: executionDecision?.local?.preflight ?? req.body?.preflight ?? null
          }, {
            config,
            fetchImpl,
            token: runnerKey === 'sandbox' ? config.runners.sandboxToken : config.runners.toolToken,
            ...(executionDecision?.target === 'general-ai-sandbox' ? { timeoutMs: SANDBOX_TIMEOUT_MS } : {})
          })
        : MODEL_TASKS.has(task.type) || task.metadata?.modelGenerated === true || BUILTIN_TOOL_TARGETS.has(executionDecision?.target)
          ? await reason(run, task, {
              managedTarget: BUILTIN_TOOL_TARGETS.has(executionDecision?.target) ? executionDecision.target : null,
              executionId: managedExecutionId,
              scope: req.scope,
              // Approving built-in research or tools is explicit consent for
              // them, and a person may consent for this step when asked
              // (policy denials still apply; consent only satisfies the consent rule).
              explicitConsent: (BUILTIN_TOOL_TARGETS.has(executionDecision?.target) && req.body?.approved === true)
                || req.body?.modelConsent === true
            })
          : { configured: false, executed: false, status: 'unsupported-task', message: `No executor for task type "${task.type}"` };

      // Code in a language this sandbox cannot run goes on untested, and says
      // why, rather than waiting for a run that cannot happen.
      if (!execution.executed && task.id === 'test-code' && ['language-unavailable', 'sandbox-language'].includes(codeRunOutput(execution.result).status)) {
        const output = codeRunOutput(execution.result);
        const skipped = await runs.skipUnrunnableCode(req.scope, req.principal, run.id, task.id, { language: output.language, reason: output.message }, { requestId: req.requestId });
        metrics.increment('executions_total', { type: task.type, outcome: 'language-unavailable' });
        return res.status(200).json({ run: skipped ?? run, execution: { configured: true, executed: false, status: 'language-unavailable', message: output.message } });
      }

      if (!execution.executed) {
        // Tokens already spent (a design whose run then failed) still count.
        if (execution.usage) {
          await runs.addTokens(run.id, { provider: execution.provider, model: execution.model, ...execution.usage }, { source: execution.usageSource });
        }
        // Nothing ran, so nothing is recorded and the task stays pending. A
        // missing runner is a deployment gap, not a failed attempt, and must
        // not burn the run's attempt budget.
        metrics.increment('executions_total', { type: task.type, outcome: execution.status });
        return res.status(200).json({ run, execution });
      }

      // A code package without language and source cannot be tested. The
      // tokens were spent, but nothing usable is recorded, and the person is
      // told how to go on instead of seeing a generic failure.
      if (task.id === 'build-code' && task.metadata?.modelGenerated === true
          && !(text(execution.structured?.language) && hasCode(execution.structured))) {
        if (execution.usage) {
          await runs.addTokens(run.id, { provider: execution.provider, model: execution.model, ...execution.usage }, { source: execution.usageSource });
        }
        metrics.increment('executions_total', { type: task.type, outcome: 'invalid-model-output' });
        return res.status(200).json({
          run,
          execution: {
            configured: true,
            executed: false,
            status: 'invalid-model-output',
            message: 'The AI did not return usable code (a language and its source or files). Try again, or write the code yourself.'
          }
        });
      }

      if (execution.usage) {
        const budget = await runs.addTokens(run.id, { provider: execution.provider, model: execution.model, ...execution.usage }, { source: execution.usageSource });
        if (budget) execution.budget = budget;
      }

      if (
        execution.executionReceipt
        && managedExecutionId
        && text(execution.executionReceipt.executionId) !== managedExecutionId
      ) {
        return res.status(502).json({
          error: 'The managed runner returned a receipt for a different execution request.',
          code: 'invalid-runner-receipt',
          run
        });
      }
      const managedReceipt = execution.executionReceipt && executionDecision?.target
        ? {
            ...execution.executionReceipt,
            executionTarget: executionDecision.target,
            serverAuthenticated: true,
            receiptAlgorithm: 'managed-runner-http-authenticated'
          }
        : null;
      const failedCheck = execution.verdict?.verdict === 'fail';
      const externalExecutionFailure = Boolean(executionDecision?.target)
        && ['code', 'tool', 'investigate'].includes(task.type)
        && execution.executed === true
        && executionSucceeded(execution) === false;
      const taskFailed = failedCheck || externalExecutionFailure;
      // Failing code goes back for a targeted fix with its real error output,
      // a few times within this attempt, before the run falls back to a new one.
      if (externalExecutionFailure && task.id === 'test-code' && config.ai) {
        const failure = { ...codeFailure(execution), target: executionDecision?.target ?? null };
        // Fixes go on while they make progress (see repairDecision).
        const decision = repairDecision(run, failure);
        const repaired = decision.repair
          ? await runs.repairCode(req.scope, req.principal, run.id, task.id, failure, { requestId: req.requestId, maxRepairs: decision.ceiling })
          : null;
        if (repaired) {
          metrics.increment('executions_total', { type: task.type, outcome: 'repair' });
          const round = repairsThisAttempt(repaired).length;
          return res.json({
            run: repaired,
            execution: {
              ...execution,
              status: 'repairing',
              repair: { round, maxRounds: decision.ceiling, reason: decision.reason, failure },
              message: `The code failed (${failure.status}); it goes back for fix ${round} with the error output${decision.reason === 'progress' ? ', since the last fix got it closer' : ''}.`
            }
          });
        }
      }
      metrics.increment('executions_total', {
        type: task.type,
        outcome: taskFailed ? 'failed' : text(execution.status) || 'completed'
      });
      const advanced = await runs.advance(req.scope, req.principal, run.id, task.id, {
        ...(taskFailed ? { status: 'failed' } : {}),
        summary: failedCheck
          ? `Verification failed: ${execution.verdict.problems.concat(execution.verdict.criteria.filter(item => !item.met).map(item => item.criterion)).join('; ').slice(0, 450)}`
          : externalExecutionFailure
            ? `Execution failed: ${text(execution.message) || text(execution.result?.message) || text(execution.status) || 'runner reported failure'}`
            : execution.text ? execution.text.slice(0, 500) : task.type === 'code' ? codeRunSummary(execution.result) : `Executed ${task.type}`,
        executionReceipt: managedReceipt,
        evidence: execution.text
          ? {
              ...(execution.verdict ? { verdict: execution.verdict } : {}),
              text: execution.text,
              provider: execution.provider,
              model: execution.model,
              usage: execution.usage ?? null,
              structured: execution.structured ?? null,
              ...(execution.citations?.length ? { citations: execution.citations } : {}),
              // Which tools the AI used, and what it proposed for approval.
              ...(execution.toolLog?.length ? { tools: execution.toolLog } : {}),
              ...(execution.multiAgent ? { multiAgent: execution.multiAgent } : {}),
              // How many memories from earlier chats this step used.
              ...(execution.remembered ? { remembered: execution.remembered } : {}),
              executionTarget: executionDecision?.target ?? null
            }
          : {
              runner: runnerKey,
              executionTarget: executionDecision?.target ?? null,
              result: execution.result
            }
      }, {
        requestId: req.requestId,
        externalExecution: Boolean(managedReceipt)
      });

      if (rag && (task.type === 'investigate'
        || task.type === 'plan'
        || task.type === 'code'
        || task.type === 'verify'
        || task.type === 'step'
        || run.adaptation?.scale === 'large-project')) {
        const evidenceText = [
          execution.text,
          execution.structured ? JSON.stringify(execution.structured) : '',
          execution.result && typeof execution.result === 'object' ? JSON.stringify(execution.result) : ''
        ].filter(Boolean).join('\n').slice(0, 30000);
        if (evidenceText.trim()) {
          await rag.index(req.scope, {
            sourceType: 'run-evidence',
            sourceId: run.id + ':' + task.id + ':' + String(run.attempt),
            title: task.metadata?.title || task.id,
            text: evidenceText,
            metadata: {
              runId: run.id,
              taskId: task.id,
              attempt: run.attempt,
              conversationId: run.conversationId ?? null,
              source: 'verified-workflow-evidence'
            }
          }).catch(() => {});
        }
      }

      res.json({ run: advanced, execution });
    })();
    return res.reply ?? { status: 500, body: { error: 'Execution produced no response', code: 'internal' } };
  }

  app.post('/api/runs/:id/execute', scoped('editor'), idempotent, route(async (req, res) => {
    const expectedTaskId = text(req.body?.taskId) || null;
    if (req.body?.background !== true) {
      const reply = await executeNext({
        scope: req.scope, principal: req.principal, runId: req.params.id,
        body: req.body, requestId: req.requestId, expectedTaskId
      });
      return res.status(reply.status).json(reply.body);
    }

    // Background: queue the next task and return at once.
    if (!jobs) return res.status(503).json({ error: 'Background execution is unavailable', code: 'jobs-unavailable' });
    if (text(req.body?.executionTarget) === 'local') {
      return res.status(400).json({
        error: 'Local execution runs through your browser and the paired agent; it cannot run in the background.',
        code: 'background-not-supported'
      });
    }
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });
    const taskId = expectedTaskId ?? run.next;
    if (!taskId || taskId !== run.next) {
      return res.status(409).json({ error: 'That task is not the next task in this run', code: 'stale-execution', run });
    }
    try {
      const job = await jobs.enqueue(req.scope, req.principal, {
        runId: run.id, taskId, request: req.body, requestId: req.requestId
      });
      metrics.increment('background_jobs_total', { phase: 'queued' });
      return res.status(202).json({ job, run });
    } catch (error) {
      if (error?.code === '23505') {
        // A retry after a lost response attaches to the job already running.
        const job = await jobs.active(req.scope, run.id, taskId).catch(() => null);
        return res.status(409).json({ error: 'This task is already queued or running', code: 'job-already-active', run, job });
      }
      throw error;
    }
  }));

  app.get('/api/runs/:id/jobs/:jobId', scoped('viewer'), route(async (req, res) => {
    const job = jobs ? await jobs.get(req.scope, req.params.id, req.params.jobId) : null;
    if (!job) return res.status(404).json({ error: 'Job not found', code: 'no-job' });
    res.json({ job });
  }));

  app.post('/api/runs/:id/execution-result', scoped('editor'), route(async (req, res) => {
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'no-run' });

    const taskId = text(req.body?.taskId);
    const task = run.tasks.find(item => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Execution task not found', code: 'no-task' });

    // Receipt submission is itself an execution boundary. Re-check the
    // adaptive safety invariant before accepting external execution evidence.
    const safetyGate = executionSafetyGate(run, task, {
      blockedTopics: blockedTopicsFrom(config),
      payload: req.body?.payload ?? req.body?.evidence ?? null
    });
    if (!safetyGate.allowed) {
      await recordBoundaryDenial(req, run, task, 'adaptive-safety-blocked', { category: safetyGate.category ?? null });
      return res.status(422).json({
        error: safetyGate.reason,
        code: 'adaptive-safety-blocked',
        category: safetyGate.category ?? null
      });
    }
    // A receipt reports external execution, whatever the task is called.
    const situationGate = situationGovernanceExecutionGate(run, task, { external: true });
    if (!situationGate.allowed) {
      await recordBoundaryDenial(req, run, task, 'situation-governance-blocked', { reason: situationGate.reason });
      return res.status(422).json({
        error: situationGate.reason,
        code: 'situation-governance-blocked'
      });
    }

    if (task.id !== run.next) {
      return res.status(409).json({
        error: 'This task is no longer the next task in the server-owned workflow.',
        code: 'stale-execution-result',
        run
      });
    }

    const executionTarget = text(req.body?.executionTarget);
    const targetKind = task.type === 'code' ? 'code' : null;
    if (!targetKind || !executionTargetsFor(targetKind).includes(executionTarget)) {
      return res.status(422).json({
        error: 'The execution target is not valid for this task type.',
        code: 'invalid-execution-target'
      });
    }
    if (!planPolicyAllows(run, executionTarget, 'high')) {
      return res.status(403).json({
        error: 'The active governance policy denies this execution target.',
        code: 'execution-target-policy-denied'
      });
    }

    const receipt = req.body?.receipt;
    if (!receipt || receipt.executed !== true) {
      return res.status(422).json({
        error: 'A real execution receipt is required.',
        code: 'invalid-execution-receipt'
      });
    }
    // A receipt that is unsigned or not bound to an attempt and execution
    // request is not a stale receipt; it was never a valid one.
    if (!text(receipt.signature) || receipt.attempt === undefined || receipt.attempt === null
        || !text(receipt.executionId)) {
      return res.status(403).json({
        error: 'The execution receipt is not signed and bound to an execution request.',
        code: 'invalid-execution-receipt'
      });
    }
    if (Number(receipt.attempt) !== Number(run.attempt)) {
      return res.status(409).json({
        error: 'This execution receipt belongs to an older run attempt.',
        code: 'stale-execution-receipt'
      });
    }
    const expectedExecutionId = executionIdFor({
      runId: run.id,
      taskId: task.id,
      attempt: run.attempt,
      executionTarget,
      round: repairsThisAttempt(run).length
    });
    if (text(receipt.executionId) !== expectedExecutionId) {
      return res.status(409).json({
        error: 'This execution receipt does not belong to the current execution request.',
        code: 'stale-execution-id'
      });
    }

    const challenge = task.metadata?.executionChallenge;
    if (!challenge || Number(challenge.attempt) !== Number(run.attempt)
        || text(challenge.executionId) !== expectedExecutionId
        || text(challenge.principalId) !== text(req.principal.id)
        || !text(receipt.challengeNonce)
        || crypto.createHash('sha256').update(text(receipt.challengeNonce), 'utf8').digest('hex') !== text(challenge.nonceHash)
        || !text(challenge.payloadDigest)
        || text(receipt.payloadDigest) !== text(challenge.payloadDigest)
        || Date.parse(text(challenge.expiresAt)) <= Date.now()) {
      return res.status(409).json({
        error: 'The local execution receipt does not match the server-issued execution challenge.',
        code: 'stale-execution-challenge'
      });
    }

    if (executionTarget !== 'local') {
      return res.status(422).json({
        error: 'Unmanaged external execution receipts cannot complete a task. Use the configured managed runner callback.',
        code: 'managed-runner-required'
      });
    }

    // Only the local target reaches this point, and it is the user's own
    // machine running an approved task, so it is consented exactly as in
    // /execute. Governance deny rules and allow-lists still apply.
    if (!dataPolicyAllows(run, run.adaptation?.dataClasses ?? ['workspace-content'], 'execution-runner', {
          explicitConsent: true
        })) {
      return res.status(403).json({
        error: 'The active governance policy denies transfer of the task data to this execution target.',
        code: 'execution-data-policy-denied'
      });
    }

    const signatureValid = verifyExecutionReceipt(
      config.execution.localAgentSharedSecret,
      {
        runId: run.id,
        taskId: task.id,
        taskType: task.type,
        attempt: run.attempt,
        executionId: expectedExecutionId,
        challengeNonce: text(receipt.challengeNonce),
        receipt: { ...receipt, executionTarget }
      },
      receipt.signature
    );
    if (!signatureValid) {
      return res.status(403).json({
        error: 'The local execution receipt could not be authenticated.',
        code: 'invalid-execution-receipt'
      });
    }

    const succeeded = executionSucceeded(receipt);
    // Code that failed on the local agent gets the same targeted fix.
    if (!succeeded && task.id === 'test-code' && config.ai) {
      const failure = { ...codeFailure({ status: receipt.status, result: receipt.result ?? receipt }), target: executionTarget };
      const decision = repairDecision(run, failure);
      const repaired = decision.repair
        ? await runs.repairCode(req.scope, req.principal, run.id, task.id, failure, { requestId: req.requestId, maxRepairs: decision.ceiling })
        : null;
      if (repaired) {
        metrics.increment('executions_total', { type: task.type, outcome: 'repair' });
        const round = repairsThisAttempt(repaired).length;
        return res.json({ run: repaired, execution: { ...receipt, status: 'repairing', repair: { round, maxRounds: decision.ceiling, reason: decision.reason, failure } } });
      }
    }
    const advanced = await runs.advance(
      req.scope,
      req.principal,
      run.id,
      task.id,
      {
        status: succeeded ? 'complete' : 'failed',
        summary: text(req.body?.summary) || (succeeded
          ? `Executed ${task.type} on ${executionTarget}`
          : `Execution of ${task.type} on ${executionTarget} finished with status ${text(receipt.status) || 'failed'}`),
        executionReceipt: {
          ...receipt,
          executionTarget,
          serverAuthenticated: true,
          receiptAlgorithm: RECEIPT_ALGORITHM
        },
        evidence: req.body?.evidence ?? null
      },
      { requestId: req.requestId, externalExecution: true }
    );
    res.json({ run: advanced, execution: receipt });
  }));

  /**
   * Text of the files attached to a run, read under the requester's own
   * scope, capped so a large file cannot flood the prompt.
   */
  async function attachmentTexts(scope, run, task, { maxChars = null, focus = '' } = {}) {
    const selectedBudget = run.adaptation?.resourcePlan?.budget?.maxAttachmentChars;
    const limit = Number.isFinite(Number(selectedBudget)) ? Number(selectedBudget) : (maxChars ?? 60_000);
    return attachmentContext(objects, scope, scopedAttachments(run, task), { maxChars: limit, focus, overlay: run.adaptation?.projectOverlay });
  }

  /**
   * What a step is about, for choosing which files of a large project it
   * reads: the request, this step, what the design steps concluded, and
   * the failure a fix is for.
   */
  /** Build one deterministic semantic evidence pack for code-aware steps. */
  async function codeIntelligenceForStep(run, task, scope) {
    if (!isCodeTask(task)) return null;
    const attachments = scopedAttachments(run, task);
    if (!attachments.length) return null;
    const files = await projectFiles(objects, scope ?? currentDbScope(), attachments, { overlay: run.adaptation?.projectOverlay });
    if (!files.length) return null;
    const workspace = run.adaptation?.unifiedWorkContext?.workspace ?? {};
    const lastChange = run.adaptation?.unifiedWorkContext?.lastChange ?? null;
    const changedPaths = [
      ...(Array.isArray(lastChange?.files) ? lastChange.files : []),
      ...(Array.isArray(lastChange?.deleted) ? lastChange.deleted : [])
    ];
    const failure = task.id === 'build-code' ? repairContext(run)?.failure : null;
    const index = buildProjectIndex(files, { revisionId: workspace.revisionId ?? null });
    const budget = run.adaptation?.resourcePlan?.budget?.maxAttachmentChars;
    const maxChars = Number.isFinite(Number(budget)) ? Math.min(44_000, Math.max(12_000, Number(budget))) : null;
    return compileCodeContext({
      files, index, goal: run.goal, task, changedPaths, failure,
      previousAttempts: previousAttempts(run), scale: run.adaptation?.scale ?? 'standard', maxChars
    });
  }

  function stepFocus(run, task) {
    const stepResults = (run.tasks ?? []).filter(item => item.type === 'step' && item.status === 'complete').map(item => `${item.metadata?.title ?? ''} ${item.summary ?? ''} ${item.evidence?.text ?? ''}`);
    const failure = task.id === 'build-code' ? repairContext(run)?.failure : null;
    return [run.goal, task.purpose, ...stepResults, failure?.stderr ?? '', failure?.stdout ?? ''].join('\n');
  }

  /** The adapt step, completed by the server from its own composition. */
  function composedLocally(run) {
    const plan = run.adaptation?.resourcePlan ?? {};
    const blueprint = run.adaptation?.workflowBlueprint ?? {};
    const selected = plan.selected ?? {};
    const lines = [
      `Way of working: ${blueprint.mode ?? 'answer'}${blueprint.phases?.length ? ` (${blueprint.phases.join(' → ')})` : ''}.`,
      selected.capabilities?.length ? `Capabilities: ${selected.capabilities.join(', ')}.` : null,
      selected.dataSources?.length ? `Data: ${selected.dataSources.join(', ')}.` : null,
      selected.artifacts?.length ? `Files: ${selected.artifacts.join(', ')}.` : null,
      run.adaptation?.notAvailableHere?.length ? `Not available here: ${run.adaptation.notAvailableHere.join(', ')}.` : null
    ].filter(Boolean);
    return {
      configured: true,
      executed: true,
      status: 'completed',
      text: lines.join('\n'),
      structured: { composedBy: 'server', mode: blueprint.mode ?? null, selected },
      provider: 'server',
      model: null,
      usage: null,
      citations: [],
      toolLog: []
    };
  }

  /** What later reasoning needs from a step's structured result: projects compacted. */
  function evidenceForReasoning(evidence) {
    const structured = evidence?.structured;
    if (!structured || typeof structured !== 'object') return evidence;
    if (isProject(structured)) return { ...evidence, structured: compactProject(structured) };
    return evidence;
  }

  /** A code run in words: its tests, then what the program printed. */
  function codeRunSummary(result) {
    const output = codeRunOutput(result);
    const tests = output.testSummary;
    const printed = String(output.program?.stdout ?? (output.tested ? '' : output.stdout ?? '')).trim();
    return [
      tests?.total ? `Tests: ${tests.passed} of ${tests.total} passed.` : output.status === 'completed' ? 'Ran without errors.' : `Run ${output.status ?? 'finished'}.`,
      printed ? `Output: ${printed.slice(-300)}` : ''
    ].filter(Boolean).join(' ');
  }

  /** The criteria a verification is graded on: the requirements, or the situation's success criteria. */
  function plannedCriteriaFor(run) {
    return gradedCriteria(run.requirements, run.situation);
  }

  async function reason(run, task, { managedTarget = null, explicitConsent = false, executionId = null, scope = null } = {}) {
    let ragResults = [];
    if (rag && scope) {
      try {
        ragResults = await rag.search(scope, [run.goal, task.purpose].filter(Boolean).join('\n'), { limit: 8 });
      } catch (error) {
        metrics?.increment('rag_retrieval_errors_total');
        ragResults = [];
      }
    }
    // The composition this step records is the one the server already chose
    // (working scope and way of working): no model call is needed for it.
    if (task.type === 'adapt') return composedLocally(run);
    const checkpoint = cleanCheckpoint(run, task);
    if (checkpoint) return { configured: true, executed: true, status: 'completed', ...checkpoint, provider: 'server', model: null, usage: null, citations: [], toolLog: [] };
    const adaptiveBudget = run.adaptation?.resourcePlan?.budget ?? {};
    const maxContextItems = Number(adaptiveBudget.maxContextItems) > 0 ? Number(adaptiveBudget.maxContextItems) : 48;
    const evidence = run.tasks
      .filter(item => item.status === 'complete' && item.evidence)
      .slice(-maxContextItems)
      .map(item => ({ taskId: item.id, type: item.type, evidence: compactCodeEvidence(evidenceForReasoning(item.evidence)) }));

    if (!config.ai) {
      return {
        configured: false,
        executed: false,
        status: 'not-configured',
        message: 'No reasoning model is configured, so nothing was reasoned. You can complete this step yourself with "Mark done manually", or an operator can configure AI_PROVIDER.'
      };
    }

    const blocked = await usageBlock(scope);
    if (blocked) return blocked;

    const selection = await resolveModelSelection(pool, config, { workspaceId: scope?.workspaceId ?? run.workspaceId, principalId: scope?.principalId ?? run.principalId });
    const requestedModelId = run.adaptation?.modelSelection || selection.selectedModelId || null;
    const model = (requestedModelId && selection.planModelIds.includes(requestedModelId) && selection.enabledModelIds.includes(requestedModelId) && selection.configuredModelIds.includes(requestedModelId))
      ? requestedModelId
      : selection.selectedModelId;
    const modelAllowed = modelPolicyAllows(run, model, 'medium');
    const dataDecision = dataPolicyDecision(run, run.adaptation?.dataClasses ?? ['user-content'], 'model-provider', {
      explicitConsent: explicitConsent || run.adaptation?.privacy?.consent?.modelProvider === true
    });
    if (modelAllowed && !dataDecision.allowed && dataDecision.reason === 'explicit-data-consent-required') {
      return {
        configured: true,
        executed: false,
        status: 'consent-required',
        message: 'This work was started without permission to send it to the AI provider. Allow it for this step to continue.',
        model
      };
    }
    const dataAllowed = dataDecision.allowed;
    if (!modelAllowed || !dataAllowed) {
      return {
        configured: Boolean(config.ai),
        executed: false,
        status: 'policy-blocked',
        message: !modelAllowed
          ? 'The active governance policy denies the selected reasoning model.'
          : 'The active governance policy denies transfer of the current data classes to the reasoning provider.',
        model
      };
    }

    // A verifier gets the sources the work rests on and, when the work
    // depends on outside facts and research is permitted, checks them live.
    const grounding = task.type === 'verify'
      ? groundedCheckDecision(run, {
          webAccess: config.tools?.webAccess !== false,
          researchAllowed: configuredExecutionTargets(config, 'investigate').includes('builtin-research')
            && planPolicyAllows(run, 'builtin-research', 'medium')
        })
      : null;
    const verificationContext = grounding ? verificationBrief(run, grounding) : null;
    const attached = await attachmentTexts(scope, run, task, { focus: stepFocus(run, task) });
    const codeIntelligence = await codeIntelligenceForStep(run, task, scope).catch(() => null);
    const remembered = await memoriesFor(memories, scope ?? currentDbScope(), run).catch(() => []);
    // Each step is sent only what it uses (prompt-scope.js), and only the
    // rules that apply to it (systemPromptFor): the server keeps its full
    // records, the model gets what the step acts on.
    // The verifier is shown exactly the criteria it is graded on (see the
    // verdict below); otherwise it can pass what it was shown and still fail
    // on criteria it never saw.
    const brief = situationBrief(run);
    if (task.type === 'verify') brief.successCriteria = plannedCriteriaFor(run);
    const selectedSkills = await loadSelectedSkills(run.goal, {
      taskType: task.id === 'build-code' ? 'build-code' : task.type,
      intent: run.intent?.kind,
      capabilities: run.capabilities?.granted ?? [],
      limit: 6,
      maxInstructionChars: 5000
    });
    // The server's stand-in criterion is for the check only: shown to the
    // step that answers, it padded short answers with "evidence" sections.
    else if (Array.isArray(brief.successCriteria)) brief.successCriteria = brief.successCriteria.filter(item => item !== GENERIC_CRITERION);
    let payload = compact({
      goal: run.goal,
      adaptation: adaptationFor(run, task),
      ...(['discover-capabilities', 'reassess'].includes(task.type) ? { capabilities: run.capabilities } : {}),
      situation: brief,
      // What this person told Kindgleam in earlier chats.
      remembered: remembered.slice(-maxContextItems).map(item => item.content),
      // Every code-workspace chat carries its explicit, server-owned chat
      // identity so the primary model and every advisory agent share the
      // same memory scope and adaptive panel policy.
      skills: selectedSkills.map(skill => ({ name: skill.name, version: skill.version, description: skill.description, instructions: skill.instructions, fingerprint: skill.fingerprint, risk: skill.risk })),
      chat: run.adaptation?.unifiedWorkContext?.chat ?? {
        conversationId: run.conversationId ?? null,
        memory: { scope: run.conversationId ? 'conversation' : 'unavailable', alwaysOn: Boolean(run.conversationId), crossChat: 'user-controlled' },
        multiAgent: { mode: config.agents?.multiAgent ?? 'auto', maxAgents: config.agents?.maxAgents ?? 5, adaptive: true, serverOrchestrated: true, advisoryOnly: true }
      },
      workspace: run.adaptation?.unifiedWorkContext?.workspace ?? null,
      // Deterministic code intelligence: symbols, dependencies and tests are computed server-side,
      // then only task-relevant source windows are sent to the reasoning layer.
      codeIntelligence,
      // Earlier turns of the same chat, oldest first.
      conversation: (run.adaptation?.conversation ?? []).slice(-maxContextItems),
      attachments: codeIntelligence
        ? (attached.files ?? []).map(item => ({
            name: item?.name,
            readable: item?.readable,
            kind: item?.kind,
            format: item?.format,
            ...(item?.kind === 'image' ? { note: item.note } : {})
          }))
        : attached.files,
      previousAttempts: previousAttempts(run),
      task: {
        id: task.id,
        type: task.type,
        purpose: task.purpose,
        requirementIds: task.metadata?.requirementIds ?? [],
        ...(task.metadata?.inventionLoop ? { method: 'invention' } : {}),
        ...(task.metadata?.buildPlan ? { buildPlan: true } : {})
      },
      // What the plan can shape: the stages still ahead.
      stagesAhead: task.type === 'plan' ? run.tasks.filter(item => item.status === 'pending' && item.id !== task.id).map(item => ({ id: item.id, type: item.type, purpose: item.purpose })) : null,
      // The steps planned for this need, and where this one stands.
      workPlan: workPlan(run.tasks, task.id),
      evidenceSoFar: evidence,
      blackboard: blackboard ? await blackboard.load(scope ?? currentDbScope(), run.id).catch(() => null) : null,
      rag: ragResults.map(item => ({ id: item.id, sourceType: item.sourceType, sourceId: item.sourceId, title: item.title, content: item.content, score: item.score ?? null, metadata: item.metadata ?? {} })).slice(0, 8),
      // Code that failed its run, and how, for a targeted fix.
      codeRepair: task.id === 'build-code' ? repairContext(run, repairCeiling(run)) : null,
      verification: verificationContext
    });
    const effort = thinkingFor(task, run);
    const effectiveModelId = modelForStep(selection, {
      run, task, effort, hasImages: attached.images.length > 0, fallback: model,
      allows: id => modelPolicyAllows(run, id, 'medium')
    });
    // Backups obey the same rules: governance, and a model an admin turned off.
    const allowBackup = name => modelPolicyAllows(run, `google:${name}`, 'medium')
      && (!selection.configuredModelIds.includes(`google:${name}`) || selection.enabledModelIds.includes(`google:${name}`));

    const multiAgent = await runAdaptiveAgentPanel({
      run,
      task,
      basePayload: payload,
      selection,
      primaryModelId: effectiveModelId,
      config,
      fetchImpl,
      allowBackup,
      allowsModel: id => modelPolicyAllows(run, id, 'medium'),
      dataAllowed,
      canSpend: async () => !(await usageBlock(scope)),
      recordUsage: async (usage, provider, model) => {
        await runs.addTokens(run.id, { ...usage, provider, model }, { source: 'multi-agent' });
      },
      recordWave: async ({ run: currentRun, task: currentTask, wave }) => {
        await pool.query(
          'INSERT INTO run_waves (id, run_id, wave_index, state, agent_count, started_at, completed_at, metadata) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now(), now(), $5::jsonb) ON CONFLICT (run_id, wave_index) DO UPDATE SET state = EXCLUDED.state, agent_count = EXCLUDED.agent_count, completed_at = now(), metadata = EXCLUDED.metadata',
          [currentRun.id, wave.index, wave.failed?.length ? 'completed-with-failures' : 'completed', wave.roles.length, JSON.stringify(wave)]
        );
      },
      recordAgent: async ({ run: currentRun, task: currentTask, waveIndex, role, modelId, state: agentState, finding, errorCode }) => {
        await pool.query(
          'INSERT INTO run_agents (id, run_id, task_id, role, model_id, state, wave_index, finding, error_code, started_at, completed_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), now()) ON CONFLICT (run_id, role, wave_index) DO UPDATE SET model_id = EXCLUDED.model_id, state = EXCLUDED.state, finding = EXCLUDED.finding, error_code = EXCLUDED.error_code, completed_at = now()',
          [currentRun.id, currentTask.id, role, modelId || null, agentState, JSON.stringify(finding ?? {}), errorCode || null, waveIndex]
        );
      },
      loadBlackboard: async () => blackboard && scope
        ? blackboard.load(scope, run.id).catch(() => null)
        : null,
      recordBlackboard: async ({ run: currentRun, blackboard: currentBoard }) => {
        if (!blackboard || !scope || !currentBoard) return;
        const contribution = {
          objective: currentBoard.objective,
          facts: currentBoard.facts,
          hypotheses: currentBoard.hypotheses,
          decisions: currentBoard.decisions,
          findings: currentBoard.findings,
          blockers: currentBoard.blockers,
          evidence: currentBoard.evidence,
          openQuestions: currentBoard.openQuestions
        };
        try {
          await blackboard.merge(scope, currentRun.id, contribution, Math.max(0, Number(currentBoard.version) - 1));
        } catch (error) {
          if (error?.code !== 'blackboard-conflict') throw error;
          const latest = await blackboard.load(scope, currentRun.id);
          await blackboard.merge(scope, currentRun.id, contribution, latest.version);
        }
      }
    });
    if (multiAgent.brief) payload = { ...payload, multiAgent: multiAgent.brief };

    const messages = [
      { role: 'system', content: `${systemPromptFor({ task: payload.task, run, payload })} ${usagePolicyPrompt(blockedTopicsFrom(config))}` },
      {
        role: 'user',
        ...(attached.images.length ? { images: attached.images } : {}),
        content: JSON.stringify(payload)
      }
    ];
    let answer = (managedTarget || TOOL_TASKS.has(task.type)) && !task.metadata?.declined && !task.metadata?.conversational
      ? await answerWithTools(messages, await toolContext(run, task, scope), {
          config, fetchImpl, modelId: effectiveModelId, allowBackup, effort,
          maxRounds: Math.max(0, Number(run.adaptation?.resourcePlan?.budget?.maxDiscoveryRounds ?? run.adaptation?.resourcePlan?.budget?.maxToolCalls ?? 6))
        })
      : await callModel(messages, { config, fetchImpl, modelId: effectiveModelId, allowBackup, webSearch: grounding?.grounded === true, effort, json: answersInJson(task) });

    if (!answer) {
      return {
        configured: false,
        executed: false,
        status: 'not-configured',
        message: 'No reasoning model is configured, so nothing was reasoned. You can complete this step yourself with "Mark done manually", or an operator can configure AI_PROVIDER.'
      };
    }
    if (answer.incomplete) {
      // Tokens were spent, so they count against the budget, but a refused,
      // truncated or empty answer is never recorded as the task's result.
      if (answer.usage) {
        await runs.addTokens(run.id, { ...answer.usage, provider: answer.provider, model: answer.model });
      }
      return {
        configured: true,
        executed: false,
        status: answer.incomplete === 'refusal' ? 'model-declined' : 'model-incomplete',
        message: answer.incomplete === 'refusal'
          ? 'The reasoning model declined this task; nothing was recorded.'
          : answer.incomplete === 'model_context_window_exceeded'
            ? 'This chat has grown longer than the model can read at once; nothing was recorded. Start a new chat and bring over what matters.'
            : `The reasoning model did not return a complete answer (${answer.incomplete}); nothing was recorded.`,
        provider: answer.provider,
        model: answer.model
      };
    }
    // Code comes with tests: a package without them is sent back once. A
    // project change counts the tests it already had (the version it fixes,
    // the attached project), since it returns only the files it writes.
    let firstPackage = task.id === 'build-code' ? parseJsonObject(answer.text) : null;
    let baseFilesForPackage = [];
    if (firstPackage && (isProject(firstPackage) || Array.isArray(firstPackage.patches))) {
      baseFilesForPackage = await projectFiles(
        objects,
        scope ?? currentDbScope(),
        scopedAttachments(run),
        { overlay: run.adaptation?.projectOverlay }
      );
      if (Array.isArray(firstPackage.patches) && firstPackage.patches.length) {
        firstPackage = materializeCodePackage(firstPackage, { baseFiles: baseFilesForPackage });
      }
    }
    if (task.id === 'build-code' && firstPackage && hasCode(firstPackage)) {
      answer = { ...answer, text: JSON.stringify(firstPackage) };
    }
    const hadTests = firstPackage && isProject(firstPackage)
      ? { previous: repairsThisAttempt(run).at(-1)?.code ?? null, baseFiles: baseFilesForPackage }
      : {};
    if (task.id === 'build-code' && missingTests(firstPackage, hadTests)) {
      const retry = await callModel([
        ...messages,
        { role: 'assistant', content: answer.text },
        { role: 'user', content: TESTS_REQUIRED_PROMPT }
      ], { config, fetchImpl, modelId: effectiveModelId, allowBackup, effort, json: true });
      if (retry?.usage) {
        answer.usage = {
          ...answer.usage,
          inputTokens: (answer.usage?.inputTokens ?? 0) + (retry.usage.inputTokens ?? 0),
          outputTokens: (answer.usage?.outputTokens ?? 0) + (retry.usage.outputTokens ?? 0)
        };
      }
      const retried = retry && !retry.incomplete ? parseJsonObject(retry.text) : null;
      // A retry that returns only the test files is laid over the first answer.
      const withTests = retried && isProject(firstPackage) ? mergeFix(firstPackage, retried) : retried;
      if (withTests && !missingTests(withTests, hadTests) && hasCode(withTests)) answer = { ...answer, text: JSON.stringify(withTests) };
    }
    // Answers never carry what this service does not discuss: an answer with
    // religious teaching or rulings is replaced before anyone sees it.
    // A work step answers its part, and may say the need is met or re-plan.
    let stepJudgement = null;
    if (task.type === 'step') {
      const read = readStepAnswer(answer.text);
      answer.text = read.text;
      stepJudgement = { enough: read.enough, ...(read.judged === false ? { judged: false } : {}), ...(read.next ? { next: read.next } : {}), ...(read.revise?.length ? { revise: read.revise } : {}) };
    }
    if (ANSWER_TASKS.has(task.type)) {
      const withheld = guardAnswer(answer.text, blockedTopicsFrom(config));
      if (withheld) {
        answer.text = withheld.text;
        answer.citations = [];
        await recordRefusal(pool, scope ?? currentDbScope(), { category: withheld.topic, source: 'model', topic: true });
      }
    }
    let verdict = null;
    if (task.type === 'verify') {
      const raw = parseJsonObject(answer.text);
      const plannedCriteria = plannedCriteriaFor(run);
      verdict = groundVerdict(normalizeVerdict(raw, plannedCriteria), raw, {
        brief: verificationContext, grounded: grounding.grounded, checkedSources: answer.citations ?? []
      });
      const spent = answer.usage ? (answer.usage.inputTokens ?? 0) + (answer.usage.outputTokens ?? 0) : 0;
      if (!verdict) {
        if (spent) await runs.addTokens(run.id, { ...answer.usage, provider: answer.provider, model: answer.model });
        return {
          configured: true, executed: false, status: 'verification-inconclusive',
          message: 'The verifier did not return a readable verdict; nothing was recorded.',
          provider: answer.provider, model: answer.model
        };
      }
      // Adaptive second agent: when the work warrants it and the first
      // verifier passed it, an independent reviewer looks for what was
      // missed. It can only turn a pass into a fail. Its tokens are recorded
      // under its own model, and it runs under the same governance.
      const second = verdict.verdict === 'pass' ? reviewDecision(run, { mode: config.agents?.review ?? 'auto' }) : { review: false };
      if (second.review) {
        const reviewerId = reviewerModelFor(selection, effectiveModelId, { allows: id => modelPolicyAllows(run, id, 'medium') });
        const capped = await usageBlock(scope);
        let reviewed = null;
        if (!capped) {
          reviewed = await callModel(reviewMessages(run, { criteria: plannedCriteria, verdict }), {
            config, fetchImpl, modelId: reviewerId, allowBackup, effort: 'medium', json: true, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS
          }).catch(() => null);
          if (reviewed?.usage) await runs.addTokens(run.id, { ...reviewed.usage, provider: reviewed.provider, model: reviewed.model });
        }
        const review = reviewed && !reviewed.incomplete ? readReview(parseJsonObject(reviewed.text)) : null;
        verdict = mergeReview(verdict, review, { reason: second.reason, model: reviewed?.model ?? null });
      }
      // A model may fail work, but it cannot certify work that requires a
      // human, or code that ran without tests of its own.
      const untested = untestedCode(run);
      if (verdict.verdict === 'pass' && (task.metadata?.verification?.humanReviewRequired === true || untested)) {
        if (spent) await runs.addTokens(run.id, { ...answer.usage, provider: answer.provider, model: answer.model });
        return {
          configured: true, executed: false, status: 'human-verification-required',
          message: task.metadata?.verification?.humanReviewRequired === true
            ? 'The automated check passed, but this work requires an authorized human to certify it.'
            : codeNotRunNow(run)
              ? `The code could not be run here (${codeNotRunNow(run).reason.replace(/^Not run: /, '')}), so the automated check cannot certify it. Run it yourself before relying on it.`
              : 'The code ran, but without tests of its own, so the automated check cannot certify it. Check the result yourself.',
          advisoryVerdict: verdict, provider: answer.provider, model: answer.model
        };
      }
    }
    return {
      configured: true,
      executed: true,
      status: 'completed',
      text: answer.text,
      verdict,
      structured: stepJudgement ?? (['understand', 'discover-capabilities', 'reassess', 'plan'].includes(task.type) || task.metadata?.outputSchema
        ? parseJsonObject(answer.text)
        : null),
      citations: answer.citations ?? [],
      provider: answer.provider,
      model: answer.model,
      usage: answer.usage,
      multiAgent: multiAgent.brief ?? null,
      toolLog: answer.toolLog ?? [],
      remembered: remembered.length,
      ...(managedTarget ? {
        executionReceipt: {
          executed: true,
          status: 'completed',
          executionTarget: managedTarget,
          ...(executionId ? { executionId } : {}),
          managed: true,
          result: { citations: answer.citations ?? [] }
        }
      } : {})
    };
  }

  /* ------------------------------------------------ proposed actions and workspace tools */

  const actionFailure = (res, error) => {
    if (!(error instanceof ActionError)) throw error;
    return res.status(error.status).json({ error: error.message, code: error.code });
  };

  app.get('/api/runs/:id/actions', scoped('viewer'), route(async (req, res) => {
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'run-not-found' });
    res.json({ actions: await actions.list(req.scope, run.id) });
  }));

  // Approving runs the proposed tool once, as the person approving.
  app.post('/api/runs/:id/actions/:actionId', scoped('editor'), route(async (req, res) => {
    const run = await runs.get(req.scope, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found', code: 'run-not-found' });
    const approve = req.body?.approve === true;
    if (!approve && req.body?.approve !== false) return res.status(400).json({ error: 'Say approve: true or false.', code: 'action-decision-required' });
    const task = run.tasks.find(item => item.id === text(req.body?.taskId)) ?? run.tasks.at(-1);
    // Declining runs nothing, so it is always allowed; only approving an
    // action crosses the execution boundary and passes the gates.
    const safetyGate = approve ? executionSafetyGate(run, task, { blockedTopics: blockedTopicsFrom(config) }) : { allowed: true };
    const governanceGate = approve ? situationGovernanceExecutionGate(run, task, { external: true }) : { allowed: true };
    if (!safetyGate.allowed) {
      await recordBoundaryDenial(req, run, task, 'adaptive-safety-blocked', { category: safetyGate.category ?? null });
      return res.status(422).json({ error: safetyGate.reason, code: 'adaptive-safety-blocked', category: safetyGate.category ?? null });
    }
    if (!governanceGate.allowed) {
      await recordBoundaryDenial(req, run, task, 'situation-governance-blocked', { reason: governanceGate.reason });
      return res.status(422).json({ error: governanceGate.reason, code: 'situation-governance-blocked' });
    }
    try {
      const ctx = await toolContext(run, task, req.scope);
      const action = await actions.decide(req.scope, req.principal, {
        runId: run.id, actionId: text(req.params.actionId), approve, requestId: req.requestId,
        ctxFor: async () => ({ ...ctx, propose: null }),
        canApprove: tool => toolNamed(tool, ctx)?.approveRole !== 'admin' || req.scope.role === 'admin'
      });
      res.json({ action });
    } catch (error) {
      return actionFailure(res, error);
    }
  }));

  app.get('/api/workspace-tools', scoped('viewer'), route(async (req, res) => {
    res.json({ tools: await listWorkspaceTools(pool, req.scope), sandbox: Boolean(config.runners?.sandbox) });
  }));

  app.post('/api/workspace-tools/:name/retire', scoped('admin'), route(async (req, res) => {
    const { rowCount } = await pool.query(
      "UPDATE workspace_tools SET status = 'retired', updated_at = now() WHERE workspace_id = $1 AND name = $2 AND status = 'active'",
      [req.scope.workspaceId, text(req.params.name)]
    );
    if (!rowCount) return res.status(404).json({ error: 'No active tool has that name.', code: 'tool-not-found' });
    await audit?.record({ principalId: req.principal.id, workspaceId: req.scope.workspaceId, action: 'workspace-tool.retire', target: text(req.params.name), outcome: 'allowed', requestId: req.requestId });
    res.json({ retired: true });
  }));

  return { executeNext };
}
