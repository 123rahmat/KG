import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAdaptiveControl,
  planAdaptiveResources,
  adaptiveExecutionBudgetStatus,
  toolsForTask,
  resolveAdaptiveControlHierarchy,
  adaptiveStepScope
} from '../src/adaptive-control.js';

const baseRequirements = [
  { id: 'reasoning', risk: 'low' },
  { id: 'adaptive-safety-governance', risk: 'low' },
  { id: 'situation-understanding', risk: 'low' },
  { id: 'capability-compilation', risk: 'low' },
  { id: 'planning', risk: 'low' },
  { id: 'verification', risk: 'low' },
  { id: 'file-analysis', risk: 'medium' },
  { id: 'evidence-retrieval', risk: 'medium', dynamic: true },
  { id: 'code-generation', risk: 'medium' },
  { id: 'code-execution', risk: 'high' }
];

test('depth produces explicit user-controlled resource ceilings', () => {
  const control = normalizeAdaptiveControl({ depth: 'brief' });
  assert.equal(control.depth, 'brief');
  assert.equal(control.depthSource, 'user');
  assert.equal(control.userControlled, true);
  assert.equal(control.budget.maxCapabilities, 8);
  assert.equal(control.allowAdaptiveExpansion, false);
  assert.equal(control.expansionApprovalRequired, true);
});

test('selection keeps protected reasoning and governance while omitting excess work', () => {
  const plan = planAdaptiveResources({
    requirements: baseRequirements,
    externalData: { requested: ['public-web', 'source-b', 'source-c', 'source-d'] },
    artifacts: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'],
    surfaces: ['chat', 'research', 'code', 'creation', 'workspace', 'adaptive'],
    primarySurface: 'code',
    control: { depth: 'brief' }
  });
  assert.equal(plan.userControlled, true);
  assert.ok(plan.selected.capabilities.includes('reasoning'));
  assert.ok(plan.selected.capabilities.includes('adaptive-safety-governance'));
  assert.ok(plan.selected.capabilities.includes('verification'));
  assert.ok(plan.selected.capabilities.length <= 8);
  assert.ok(plan.omitted.capabilities.length > 0);
  assert.equal(plan.mode, 'minimum-necessary');
  assert.equal(plan.expansion.approvalRequired, true);
});

test('explicit resource exclusions cannot remove protected safety and planning capabilities', () => {
  const plan = planAdaptiveResources({
    requirements: baseRequirements,
    externalData: { requested: ['public-web'] },
    surfaces: ['chat', 'research', 'code'],
    primarySurface: 'chat',
    control: {
      depth: 'standard',
      excludeCapabilities: ['reasoning', 'adaptive-safety-governance', 'verification', 'code-execution']
    }
  });
  assert.ok(plan.selected.capabilities.includes('reasoning'));
  assert.ok(plan.selected.capabilities.includes('adaptive-safety-governance'));
  assert.ok(plan.selected.capabilities.includes('verification'));
  assert.ok(!plan.selected.capabilities.includes('code-execution'));
  assert.ok(plan.excluded.capabilities.includes('code-execution'));
});

test('missing discovered capability becomes a user investment choice', () => {
  const plan = planAdaptiveResources({
    requirements: [{ id: 'novel-controller', dynamic: true, source: 'discoverable', risk: 'high' }],
    implementationPlan: { missing: ['novel-controller'] },
    control: { depth: 'standard', capabilityInvestment: 'ask' },
    surfaces: ['chat'],
    primarySurface: 'chat'
  });
  assert.equal(plan.implementation.investment.decision, 'user-choice-required');
  assert.equal(plan.implementation.investment.automatic, false);
  assert.deepEqual(plan.implementation.investment.capabilities, ['novel-controller']);
  assert.equal(plan.expansion.needed, false);
});

test('missing native execution runner is not treated as a capability investment', () => {
  const plan = planAdaptiveResources({
    requirements: [{ id: 'code-execution', dynamic: false, source: 'native', risk: 'high' }],
    implementationPlan: { missing: ['code-execution'] },
    control: { depth: 'standard', capabilityInvestment: 'ask' },
    surfaces: ['chat', 'code'],
    primarySurface: 'code'
  });
  assert.equal(plan.implementation.investment.decision, 'none');
});

test('prepared capability investment remains non-executable', () => {
  const plan = planAdaptiveResources({
    requirements: [{ id: 'novel-controller', dynamic: true, source: 'discoverable', risk: 'high' }],
    implementationPlan: { missing: ['novel-controller'] },
    control: { depth: 'thorough', capabilityInvestment: 'build-candidate' },
    surfaces: ['chat', 'adaptive'],
    primarySurface: 'adaptive'
  });
  assert.equal(plan.implementation.investment.decision, 'prepare-build-candidate');
  assert.equal(plan.implementation.investment.automatic, false);
  assert.ok(plan.implementation.investment.capabilities.includes('novel-controller'));
});

test('minimum necessary surfaces follow the selected capabilities', () => {
  const plan = planAdaptiveResources({
    requirements: [
      { id: 'reasoning', risk: 'low' },
      { id: 'adaptive-safety-governance', risk: 'low' },
      { id: 'situation-understanding', risk: 'low' },
      { id: 'capability-compilation', risk: 'low' },
      { id: 'planning', risk: 'low' },
      { id: 'verification', risk: 'low' },
      { id: 'code-generation', risk: 'medium' }
    ],
    surfaces: ['chat', 'research', 'code', 'creation', 'workspace'],
    primarySurface: 'code',
    control: { depth: 'standard' }
  });
  assert.deepEqual(plan.selected.surfaces.sort(), ['chat', 'code'].sort());
});


test('adaptive hierarchy narrows from user to task to step to exact need', () => {
  const hierarchy = resolveAdaptiveControlHierarchy({
    userControl: {
      depth: 'standard',
      allowAdaptiveExpansion: false,
      budget: { maxToolCalls: 4, maxContextItems: 20 }
    },
    taskControl: {
      depth: 'thorough',
      allowAdaptiveExpansion: true,
      budget: { maxToolCalls: 10, maxContextItems: 50 }
    },
    stepControl: {
      depth: 'brief',
      budget: { maxToolCalls: 2 }
    },
    need: { deliverable: 'the final number only', form: 'number', depth: 'brief', exclude: ['background'] }
  });
  assert.equal(hierarchy.effective.depth, 'brief');
  assert.equal(hierarchy.effective.allowAdaptiveExpansion, false);
  assert.equal(hierarchy.effective.budget.maxToolCalls, 2);
  assert.equal(hierarchy.effective.budget.maxContextItems, 20);
  assert.deepEqual(hierarchy.order, ['user', 'task', 'step', 'need']);
});

test('step scope contains only resources justified by that task and exact need', () => {
  const plan = planAdaptiveResources({
    requirements: [
      ...baseRequirements.slice(0, 6),
      { id: 'evidence-retrieval', dynamic: true, risk: 'medium' },
      { id: 'modeling', risk: 'medium' }
    ],
    externalData: { requested: ['public-web'] },
    artifacts: ['design.xlsx', 'notes.pdf'],
    surfaces: ['chat', 'research'],
    primarySurface: 'research',
    situation: { need: { deliverable: 'how the motor heats over time', form: 'explanation', depth: 'standard' } },
    control: { depth: 'thorough' }
  });
  const researchStep = adaptiveStepScope(plan, { type: 'investigate', requires: ['evidence-retrieval'] }, { need: plan.hierarchy.need });
  assert.deepEqual(researchStep.tools, ['web.search', 'web.fetch', 'web.download']);
  assert.deepEqual(researchStep.dataSources, ['public-web']);
  assert.deepEqual(researchStep.artifacts, []);
  const modelStep = adaptiveStepScope(plan, { type: 'respond', requires: ['modeling'] }, { need: plan.hierarchy.need });
  assert.deepEqual(modelStep.tools, ['math.evaluate']);
  assert.deepEqual(modelStep.dataSources, []);
  assert.deepEqual(modelStep.artifacts, []);
});


test('selected tools are the minimum tools justified by the current situation', () => {
  const chat = planAdaptiveResources({
    requirements: baseRequirements.slice(0, 6),
    surfaces: ['chat', 'research', 'code', 'workspace'],
    primarySurface: 'chat',
    situation: { need: { deliverable: 'explain the concept', form: 'text' } },
    control: { depth: 'standard' }
  });
  assert.deepEqual(chat.selected.tools, []);

  const research = planAdaptiveResources({
    requirements: [...baseRequirements.slice(0, 6), { id: 'evidence-retrieval', dynamic: true, risk: 'medium' }],
    externalData: { requested: ['public-web'] },
    surfaces: ['chat', 'research'],
    primarySurface: 'research',
    control: { depth: 'standard' }
  });
  assert.deepEqual(research.selected.tools, ['web.search', 'web.fetch', 'web.download']);

  const modeling = planAdaptiveResources({
    requirements: [...baseRequirements.slice(0, 6), { id: 'modeling', risk: 'medium' }],
    surfaces: ['chat'],
    primarySurface: 'chat',
    control: { depth: 'standard' },
    situation: { need: { deliverable: 'how the system changes over time', form: 'explanation' } }
  });
  assert.deepEqual(modeling.selected.tools, ['math.evaluate']);
});


test('runtime budget guard stops execution stages and tool use at the selected ceiling', () => {
  const run = {
    adaptation: { resourcePlan: { budget: { maxExecutionStages: 1, maxToolCalls: 2 } } },
    tasks: [
      { type: 'investigate', status: 'complete', evidence: { tools: [{ tool: 'web.search' }, { tool: 'web.fetch' }] } }
    ]
  };
  const stage = adaptiveExecutionBudgetStatus(run, { type: 'code' });
  assert.equal(stage.allowed, false);
  assert.equal(stage.code, 'adaptive-execution-budget-exhausted');

  const toolsOnly = {
    adaptation: { resourcePlan: { budget: { maxExecutionStages: 4, maxToolCalls: 2 } } },
    tasks: [
      { type: 'investigate', status: 'complete', evidence: { tools: [{ tool: 'web.search' }, { tool: 'web.fetch' }] } }
    ]
  };
  const calls = adaptiveExecutionBudgetStatus(toolsOnly, { type: 'tool' });
  assert.equal(calls.allowed, false);
  assert.equal(calls.code, 'adaptive-tool-budget-exhausted');
});


test('adaptive intensity tunes discovery rounds without changing the selected depth ceiling', () => {
  const low = normalizeAdaptiveControl({ depth: 'standard', intensity: 'low' });
  const standard = normalizeAdaptiveControl({ depth: 'standard', intensity: 'standard' });
  const high = normalizeAdaptiveControl({ depth: 'standard', intensity: 'high' });
  assert.equal(low.depth, standard.depth);
  assert.equal(high.depth, standard.depth);
  assert.ok(low.budget.maxDiscoveryRounds <= standard.budget.maxDiscoveryRounds);
  assert.ok(high.budget.maxDiscoveryRounds >= standard.budget.maxDiscoveryRounds);
  assert.equal(high.intensity, 'high');
});


test('an explicitly excluded capability does not force its domain surface into the working UI', () => {
  const plan = planAdaptiveResources({
    requirements: [
      { id: 'reasoning', risk: 'low' },
      { id: 'adaptive-safety-governance', risk: 'low' },
      { id: 'situation-understanding', risk: 'low' },
      { id: 'capability-compilation', risk: 'low' },
      { id: 'planning', risk: 'low' },
      { id: 'verification', risk: 'low' },
      { id: 'code-generation', risk: 'medium' }
    ],
    surfaces: ['chat', 'code'],
    primarySurface: 'code',
    control: { depth: 'standard', excludeCapabilities: ['code-generation'] }
  });
  assert.deepEqual(plan.selected.surfaces, ['chat']);
  assert.equal(plan.selected.primarySurface, 'chat');
});


test('adaptive budget status counts completed work and exposes remaining budget', async () => {
  const { adaptiveBudgetStatus } = await import('../src/adaptive-control.js');
  const resourcePlan = planAdaptiveResources({
    requirements: baseRequirements.slice(0, 6),
    control: { depth: 'brief' },
    surfaces: ['chat'],
    primarySurface: 'chat'
  });
  const status = adaptiveBudgetStatus([
    { id: 'investigate', type: 'investigate', status: 'complete', metadata: {}, evidence: { tools: [{ tool: 'web.search' }] } },
    { id: 'step', type: 'step', status: 'complete', metadata: {}, evidence: {} }
  ], resourcePlan);
  assert.equal(status.used.toolCalls, 1);
  assert.equal(status.used.executionStages, 0);
  assert.ok(status.remaining.toolCalls < status.budget.maxToolCalls);
  assert.equal(status.decision, 'continue-within-scope');
});

test('per-task tool scope intersects the situation with that task only', () => {
  const selected = ['web.search', 'web.fetch', 'web.download', 'math.evaluate'];
  assert.deepEqual(
    toolsForTask({ requires: ['evidence-retrieval'] }, { selectedTools: selected }),
    ['web.search', 'web.fetch', 'web.download']
  );
  assert.deepEqual(
    toolsForTask({ requires: ['modeling'] }, { selectedTools: selected }),
    ['math.evaluate']
  );
  assert.deepEqual(
    toolsForTask({ requires: ['reasoning'] }, { selectedTools: selected }),
    []
  );
  assert.deepEqual(
    toolsForTask({
      requires: ['adaptive-execution'],
      metadata: { capabilitySpecs: [{ tools: ['custom.situation.tool'] }] }
    }, { selectedTools: selected }),
    ['custom.situation.tool']
  );
});


test('workflow-node ceilings follow adaptive depth', () => {
  const brief = planAdaptiveResources({
    requirements: baseRequirements.slice(0, 6),
    control: { depth: 'brief' },
    surfaces: ['chat'],
    primarySurface: 'chat'
  });
  const thorough = planAdaptiveResources({
    requirements: baseRequirements.slice(0, 6),
    control: { depth: 'thorough' },
    surfaces: ['chat'],
    primarySurface: 'chat'
  });
  assert.equal(brief.control.budget.maxWorkflowNodes, 10);
  assert.equal(thorough.control.budget.maxWorkflowNodes, 32);
});