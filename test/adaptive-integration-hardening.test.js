import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';
import { buildRealWorldOutcomeContract } from '../src/real-world-outcome.js';
import { decideAgentTopology, adaptAgentTopology, decomposeAgentTasks } from '../src/adaptive-agents.js';
import { buildHumanGovernanceContract } from '../src/human-governance.js';
import { completionGate, buildUnifiedAdaptiveWorkflow } from '../src/unified-adaptive-workflow.js';
import { workspaceEnvironment } from '../src/surface-policy.js';

const scope = {
  user: { id: 'principal-1', crossChatMemory: false },
  workspace: { id: 'workspace-1' }
};

test('planner carries one adaptive execution envelope into every non-empty plan', () => {
  const plan = planGoal('Explain how this works', scope);
  assert.ok(plan.adaptiveExecution);
  assert.equal(plan.adaptiveExecution.version, '1');
  assert.equal(plan.adaptiveExecution.verification.required, true);
  assert.equal(plan.adaptiveExecution.webSearch.shouldSearch, false);
});

test('planner escalates evidence gathering for current research', () => {
  const plan = planGoal('Research the latest documentation and cite the sources', {
    ...scope,
    activeSurface: 'research'
  });
  assert.ok(plan.adaptiveExecution);
  assert.equal(plan.adaptiveExecution.webSearch.shouldSearch, true);
  assert.equal(plan.adaptiveExecution.webSearch.provenance.citationsRequired, true);
});

test('explicit web-search disable remains authoritative', () => {
  const plan = planGoal('Research the latest documentation', {
    ...scope,
    activeSurface: 'research',
    adaptiveControl: { webSearch: false }
  });
  assert.ok(plan.adaptiveExecution);
  assert.equal(plan.adaptiveExecution.webSearch.shouldSearch, false);
  assert.equal(plan.adaptiveExecution.webSearch.reason, 'caller-disabled-search');
});


test('direct work materializes only the current response step', () => {
  const plan = planGoal('Explain what adaptive execution means', scope);
  assert.equal(plan.workflow, 'direct');
  assert.deepEqual(plan.tasks.map(task => task.type), ['respond']);
  assert.equal(plan.tasks[0].metadata.verificationPending, true);
});

test('pure conversation stays one-step and does not request verification', () => {
  const plan = planGoal('hello', scope);
  assert.equal(plan.workflow, 'direct');
  assert.deepEqual(plan.tasks.map(task => task.type), ['respond']);
  assert.equal(plan.tasks[0].metadata.conversational, true);
  assert.equal(plan.tasks[0].metadata.verificationPending, false);
});


test('real-world action requires observed and verified outcome evidence', () => {
  const contract = buildRealWorldOutcomeContract({
    goal: 'send the approved report to the client',
    realWorld: {
      realWorld: true,
      intent: 'action',
      risk: 'consequential',
      signals: { externalAction: true }
    },
    successCriteria: ['client received the report'],
    authorizationSatisfied: true,
    evidence: []
  });
  assert.equal(contract.realWorldTask, true);
  assert.equal(contract.controls.observationRequired, true);
  assert.equal(contract.completion.eligible, false);
  assert.ok(contract.gaps.includes('world-observation-required'));
});

test('real-world outcome becomes complete only after observation and verification', () => {
  const evidence = [
    { kind: 'observed', provenance: { source: 'authorized-tool-result', executed: true } },
    { kind: 'verified', verification: { verdict: 'pass' } }
  ];
  const contract = buildRealWorldOutcomeContract({
    goal: 'send the approved report to the client',
    realWorld: {
      realWorld: true,
      intent: 'action',
      risk: 'consequential',
      signals: { externalAction: true }
    },
    successCriteria: ['client received the report'],
    authorizationSatisfied: true,
    evidence
  });
  assert.equal(contract.completion.eligible, true);

  const workflow = buildUnifiedAdaptiveWorkflow({
    goal: contract.goal,
    situation: {
      goal: contract.goal,
      realWorld: contract,
      outcomeContract: contract,
      successCriteria: contract.successCriteria,
      consequence: 0.8,
      externalSideEffect: true
    },
    acceptance: {
      criteria: contract.successCriteria,
      evidence,
      verificationRequired: true,
      verificationSatisfied: true
    },
    evidence
  });
  const gate = completionGate({
    workflow,
    status: 'complete',
    taskType: 'deliver',
    evidence,
    verification: { verdict: 'pass' },
    authorizationSatisfied: true
  });
  assert.equal(gate.allowed, true);
});


test('adaptive agents parallelize only independent low-risk work', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'research-a', type: 'investigate' },
      { id: 'research-b', type: 'investigate' },
      { id: 'analyze', type: 'analyze' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.5,
    risk: 'ordinary',
    budget: { maxAgents: 4, maxParallelAgents: 3 }
  });
  assert.equal(plan.mode, 'parallel-then-integrate');
  assert.ok(plan.maxParallel > 1);
  assert.equal(plan.authority.modelCannotAuthorize, true);
});

test('adaptive agents serialize consequential external work', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'prepare', type: 'create' },
      { id: 'execute', type: 'execute', dependencies: ['prepare'] }
    ],
    scale: 'medium',
    complexity: 0.9,
    uncertainty: 0.5,
    risk: 'high-impact',
    externalAction: true,
    budget: { maxAgents: 4, maxParallelAgents: 4 }
  });
  assert.equal(plan.mode, 'serialized');
  assert.equal(plan.maxParallel, 1);
  assert.equal(plan.authority.externalActionsSerialized, true);
});

test('agent topology is replanned after failure', () => {
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'investigate' },
      { id: 'b', type: 'analyze' }
    ],
    scale: 'medium',
    complexity: 0.7,
    uncertainty: 0.4
  });
  const next = adaptAgentTopology(plan, { event: 'failed', taskId: 'a', failed: true });
  assert.equal(next.replanned, true);
  assert.equal(next.mode, 'pipeline');
  assert.equal(next.failedTaskId, 'a');
});


test('human-first governance is present across the adaptive planner and agent topology', () => {
  const plan = planGoal('Design a website and create a logo', { ...scope, activeSurface: 'design' });
  assert.equal(plan.humanGovernance.priority, 'first');
  assert.equal(plan.humanGovernance.scope.design, true);
  assert.equal(plan.humanGovernance.enforcement.serverOwned, true);
  assert.equal(plan.humanGovernance.enforcement.modelCannotOverride, true);
  assert.equal(plan.agentPlan.humanGovernance.priority, 'first');
});

test('refused human-harm work remains blocked by the existing safety boundary', () => {
  const governance = buildHumanGovernanceContract({ safety: { decision: 'refuse', category: 'intimate-images' }, imageWork: true });
  assert.equal(governance.status, 'blocked');
  assert.equal(governance.decision, 'refuse');
  assert.equal(governance.enforcement.modelCannotOverride, true);
  assert.equal(governance.enforcement.toolCannotBypassPolicy, true);
});


test('multi-agent executor runs independent agents in parallel and checkpoints the wave', async () => {
  const { executeAdaptiveAgentPlan } = await import('../src/adaptive-agents.js');
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'investigate' },
      { id: 'b', type: 'investigate' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.5,
    budget: { maxAgents: 4, maxParallelAgents: 2 }
  });
  const started = [];
  let checkpoints = 0;
  const result = await executeAdaptiveAgentPlan(plan, {
    tasks: [
      { id: 'a', type: 'investigate', resourceKeys: ['a'] },
      { id: 'b', type: 'investigate', resourceKeys: ['b'] }
    ],
    executeAgent: async agent => {
      started.push(agent.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true };
    },
    checkpoint: async () => { checkpoints += 1; }
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.completedAgents.length, 2);
  assert.equal(started.length, 2);
  assert.ok(checkpoints >= 1);
});

test('multi-agent executor serializes shared-resource conflicts', async () => {
  const { executeAdaptiveAgentPlan } = await import('../src/adaptive-agents.js');
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'analyze' },
      { id: 'b', type: 'analyze' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.5,
    budget: { maxAgents: 4, maxParallelAgents: 2 }
  });
  let active = 0;
  let peak = 0;
  const result = await executeAdaptiveAgentPlan(plan, {
    tasks: [
      { id: 'a', type: 'analyze', writePaths: ['shared/file.js'] },
      { id: 'b', type: 'analyze', writePaths: ['shared/file.js'] }
    ],
    executeAgent: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true };
    }
  });
  assert.equal(result.status, 'completed');
  assert.equal(peak, 1);
  assert.ok(result.conflicts.length >= 1);
});

test('multi-agent executor detects stale revisions before execution', async () => {
  const { executeAdaptiveAgentPlan } = await import('../src/adaptive-agents.js');
  const plan = decideAgentTopology({
    tasks: [{ id: 'a', type: 'analyze' }],
    budget: { maxAgents: 2, maxParallelAgents: 2 }
  });
  let executed = false;
  const result = await executeAdaptiveAgentPlan(plan, {
    tasks: [{ id: 'a', type: 'analyze', revision: 3 }],
    currentRevision: async () => 4,
    executeAgent: async () => { executed = true; }
  });
  assert.equal(result.status, 'failed');
  assert.equal(executed, false);
  assert.equal(result.results[0].reason, 'stale-revision');
});

test('multi-agent executor stops cleanly on cancellation', async () => {
  const { executeAdaptiveAgentPlan } = await import('../src/adaptive-agents.js');
  const plan = decideAgentTopology({
    tasks: [
      { id: 'a', type: 'investigate' },
      { id: 'b', type: 'investigate' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.5,
    budget: { maxAgents: 4, maxParallelAgents: 2 }
  });
  const controller = new AbortController();
  const resultPromise = executeAdaptiveAgentPlan(plan, {
    tasks: [
      { id: 'a', type: 'investigate' },
      { id: 'b', type: 'investigate' }
    ],
    signal: controller.signal,
    executeAgent: async (_agent, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
      });
    }
  });
  setTimeout(() => controller.abort(), 5);
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
});


test('workspace-specific agent policy is selected without creating separate intelligence', async () => {
  const codePlan = decideAgentTopology({
    workspace: 'code',
    tasks: [
      { id: 'inspect', type: 'analyze' },
      { id: 'build', type: 'code' },
      { id: 'test', type: 'test' }
    ],
    scale: 'medium',
    complexity: 0.9,
    uncertainty: 0.5,
    budget: { maxAgents: 6, maxParallelAgents: 3 }
  });
  assert.equal(codePlan.workspace, 'code');
  assert.equal(codePlan.workspacePolicy.context, 'revision-first');
  assert.equal(codePlan.workspacePolicy.mutation, 'ownership-and-revision');
  assert.ok(codePlan.agents.every(agent => agent.model === 'xai:grok-4.7'));

  const researchPlan = decideAgentTopology({
    workspace: 'research',
    tasks: [
      { id: 'sources', type: 'research' },
      { id: 'synthesis', type: 'analyze' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.6,
    budget: { maxAgents: 4, maxParallelAgents: 2 }
  });
  assert.equal(researchPlan.workspacePolicy.context, 'question-and-evidence-first');
  assert.equal(researchPlan.workspacePolicy.verification, 'claim-source-provenance');

  const designPlan = decideAgentTopology({
    workspace: 'design',
    tasks: [
      { id: 'layout', type: 'create' },
      { id: 'review', type: 'verify' }
    ],
    scale: 'medium',
    complexity: 0.8,
    uncertainty: 0.4,
    budget: { maxAgents: 4, maxParallelAgents: 2 }
  });
  assert.equal(designPlan.workspacePolicy.context, 'canvas-and-asset-first');
  assert.equal(designPlan.workspacePolicy.mutation, 'single-canvas-owner');
});


test('specialized workspaces expose independent operating environments over shared intelligence', () => {
  const chat = workspaceEnvironment('normal-chat');
  const code = workspaceEnvironment('code');
  const research = workspaceEnvironment('research');
  const design = workspaceEnvironment('design');

  assert.equal(chat.environment, 'conversation');
  assert.equal(code.environment, 'software-engineering');
  assert.equal(research.environment, 'evidence-investigation');
  assert.equal(design.environment, 'visual-canvas');
  assert.ok(code.stateModel.includes('immutable-revision'));
  assert.ok(research.stateModel.includes('evidence-ledger'));
  assert.ok(design.stateModel.includes('object-tree'));
  assert.equal(code.mutationBoundary, 'approved-write-set-and-revision');
  assert.equal(research.verification, 'claim-source-provenance');
  assert.equal(design.verification, 'visual-and-export');
  assert.notDeepEqual(code.stateModel, research.stateModel);
  assert.notDeepEqual(research.stateModel, design.stateModel);
});

test('medium work decomposes into workspace-specific parallel-ready subtasks', () => {
  for (const workspace of ['normal-chat', 'code', 'research', 'design']) {
    const tasks = decomposeAgentTasks([
      { id: 'root', type: 'understand', metadata: {} }
    ], { workspace, scale: 'medium', complexity: 0.7, uncertainty: 0.5 });
    assert.ok(tasks.length >= 3);
    assert.ok(tasks.every(task => task.parentTaskId === 'root'));
    assert.ok(tasks.every(task => task.metadata?.advisory === true));
    const plan = decideAgentTopology({
      tasks,
      workspace,
      scale: 'medium',
      complexity: 0.7,
      uncertainty: 0.5
    });
    assert.equal(plan.mode, 'parallel-then-integrate');
    assert.ok(plan.maxParallel >= 2);
  }
});

test('high-risk work does not get parallelized by decomposition', () => {
  const tasks = decomposeAgentTasks([{ id: 'root', type: 'understand', metadata: {} }], {
    workspace: 'code', scale: 'large', complexity: 0.9, uncertainty: 0.8, risk: 'high'
  });
  assert.equal(tasks.length, 1);
});
