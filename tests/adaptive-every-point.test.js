import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAdaptiveControl,
  resolveAdaptiveControlHierarchy,
  planAdaptiveResources,
  reconcileAdaptiveTransition
} from '../src/adaptive-control.js';

test('adaptive control narrows from user to task to step to exact need', () => {
  const result = resolveAdaptiveControlHierarchy({
    userControl: { depth: 'thorough', intensity: 'high', budget: { maxToolCalls: 30 } },
    taskControl: { depth: 'standard', budget: { maxToolCalls: 12 } },
    stepControl: { depth: 'brief', budget: { maxToolCalls: 4 } },
    need: { depth: 'brief', deliverable: 'fix one failing test' }
  });
  assert.equal(result.effective.depth, 'brief');
  assert.equal(result.effective.budget.maxToolCalls, 4);
  assert.deepEqual(result.order, ['user', 'task', 'step', 'need']);
});

test('minimum-sufficient planning keeps unrelated capabilities and surfaces out of scope', () => {
  const control = normalizeAdaptiveControl({ depth: 'standard' });
  const plan = planAdaptiveResources({
    requirements: [
      { id: 'reasoning', dynamic: false },
      { id: 'situation-understanding', dynamic: false },
      { id: 'verification', dynamic: false },
      { id: 'code-generation', dynamic: true },
      { id: 'evidence-retrieval', dynamic: true }
    ],
    surfaces: ['chat', 'code', 'research'],
    primarySurface: 'code',
    control,
    situation: { need: { deliverable: 'change one function', depth: 'brief' } }
  });
  assert.ok(plan.selected.capabilities.includes('code-generation'));
  assert.ok(!plan.selected.capabilities.includes('evidence-retrieval'));
  assert.ok(plan.selected.surfaces.includes('code'));
  assert.ok(!plan.selected.surfaces.includes('research'));
  assert.equal(plan.contextPolicy.minimumNecessary, true);
});

test('every transition records additions/removals without silently expanding scope', () => {
  const transition = reconcileAdaptiveTransition({
    resourcePlan: {
      selected: {
        capabilities: ['reasoning', 'situation-understanding', 'verification', 'code-generation'],
        artifacts: ['src/app.js'],
        dataSources: []
      }
    },
    requirements: [
      { id: 'reasoning' },
      { id: 'situation-understanding' },
      { id: 'verification' },
      { id: 'code-generation' },
      { id: 'code-execution' }
    ],
    artifacts: ['src/app.js'],
    dataSources: [],
    nextTask: { id: 'test-code', type: 'code' }
  });
  assert.deepEqual(transition.additions.capabilities, ['code-execution']);
  assert.deepEqual(transition.removals.capabilities, []);
  assert.equal(transition.automaticExpansion, false);
  assert.equal(transition.decision, 're-evaluate-before-expansion');
});


test('adaptive transitions optimize for minimum recomputation and preserve verified state', () => {
  const unchanged = reconcileAdaptiveTransition({
    resourcePlan: {
      selected: {
        capabilities: ['reasoning', 'verification', 'code-generation'],
        artifacts: ['src/app.js'],
        dataSources: []
      }
    },
    requirements: [{ id: 'code-generation' }],
    artifacts: ['src/app.js'],
    dataSources: [],
    nextTask: { id: 'build', type: 'code' }
  });
  assert.equal(unchanged.efficiency.reuseCurrentScope, true);
  assert.equal(unchanged.efficiency.avoidRedundantDiscovery, true);
  assert.equal(unchanged.efficiency.preserveVerifiedEvidence, true);

  const changed = reconcileAdaptiveTransition({
    resourcePlan: {
      selected: {
        capabilities: ['reasoning', 'verification', 'code-generation'],
        artifacts: ['src/app.js'],
        dataSources: []
      }
    },
    requirements: [{ id: 'code-generation' }, { id: 'code-execution' }],
    artifacts: ['src/app.js', 'tests/app.test.js'],
    dataSources: [],
    nextTask: { id: 'verify-build', type: 'code' }
  });
  assert.equal(changed.efficiency.reuseCurrentScope, false);
  assert.equal(changed.efficiency.targetedReassessmentOnly, true);
  assert.equal(changed.efficiency.preserveVerifiedEvidence, true);
});
