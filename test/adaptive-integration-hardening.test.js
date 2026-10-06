import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';
import { buildRealWorldOutcomeContract } from '../src/real-world-outcome.js';
import { decideAgentTopology, adaptAgentTopology } from '../src/adaptive-agents.js';
import { buildHumanGovernanceContract } from '../src/human-governance.js';
import { completionGate, buildUnifiedAdaptiveWorkflow } from '../src/unified-adaptive-workflow.js';

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
