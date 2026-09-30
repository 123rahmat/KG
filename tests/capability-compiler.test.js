import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCapabilityImplementations,
  compileExecutionCapabilityPlan
} from '../src/capability-compiler.js';

test('native planning capability is executable without an external runner', () => {
  const plan = compileCapabilityImplementations([
    { id: 'planning', source: 'native', dynamic: false, risk: 'low' }
  ]);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.missing, []);
});

test('code execution is not executable without a concrete execution target', () => {
  const plan = compileCapabilityImplementations([
    { id: 'code-execution', source: 'native', dynamic: false, risk: 'high' }
  ]);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.missing, ['code-execution']);
});

test('discovered execution is executable only through a real tool boundary', () => {
  const missing = compileCapabilityImplementations([
    { id: 'adaptive-execution', source: 'discoverable', dynamic: true, risk: 'high' }
  ]);
  assert.equal(missing.ready, false);

  const available = compileCapabilityImplementations([
    { id: 'adaptive-execution', source: 'discoverable', dynamic: true, risk: 'high' }
  ], { executionTargets: ['generic-tool-router'] });
  assert.equal(available.ready, true);
  assert.equal(available.implementations[0].route, 'execution-target');
});

test('private external data requires a connector or authorized tool boundary', () => {
  const missing = compileCapabilityImplementations([
    { id: 'external-data-routing', source: 'discoverable', dynamic: true, risk: 'high' }
  ]);
  assert.equal(missing.ready, false);

  const connected = compileCapabilityImplementations([
    { id: 'external-data-routing', source: 'discoverable', dynamic: true, risk: 'high' }
  ], {
    connectors: ['workspace-drive'],
    connectorAccessReady: true
  });
  assert.equal(connected.ready, true);
  assert.equal(connected.implementations[0].route, 'connector');
});

test('unknown dynamic capabilities never become executable merely because they were discovered', () => {
  const plan = compileCapabilityImplementations([
    { id: 'quantum-fabrication-controller', source: 'discoverable', dynamic: true, risk: 'high' }
  ], { runtimes: ['generic-tool-router'] });
  assert.equal(plan.ready, false);
  assert.equal(plan.implementations[0].executable, false);
  assert.equal(plan.implementations[0].status, 'discovered-not-implemented');
});

test('execution task compilation filters to the capability contract relevant to that task', () => {
  const plan = compileExecutionCapabilityPlan([
    { id: 'reasoning', source: 'native', dynamic: false, risk: 'low' },
    { id: 'code-generation', source: 'native', dynamic: false, risk: 'medium' },
    { id: 'code-execution', source: 'native', dynamic: false, risk: 'high' }
  ], {
    taskType: 'code',
    executionTargets: ['local']
  });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.executable, ['code-generation', 'code-execution']);
});

test('capability plans expose a lifecycle and dependency graph instead of a flat availability list', () => {
  const plan = compileCapabilityImplementations([
    { id: 'code-generation', source: 'native', dynamic: false, risk: 'medium' },
    { id: 'code-execution', source: 'native', dynamic: false, risk: 'high', dependencies: ['code-generation'] }
  ], { executionTargets: ['local'] });
  assert.equal(plan.ready, true);
  assert.equal(plan.implementations[1].lifecycle.state, 'ready-for-execution');
  assert.ok(plan.implementations[1].lifecycle.stages.includes('observe'));
  assert.deepEqual(plan.capabilityGraph.missingDependencies, []);
  assert.deepEqual(plan.capabilityGraph.executionOrder, ['code-generation', 'code-execution']);
  assert.equal(plan.executionReady, false);
  assert.deepEqual(plan.approvalRequired, ['code-execution']);
});

test('missing capability dependencies block readiness even when the dependent runner exists', () => {
  const plan = compileCapabilityImplementations([
    { id: 'custom-controller', source: 'discoverable', dynamic: true, risk: 'high', dependencies: ['missing-solver'] }
  ], { runtimes: ['custom-controller'] });
  assert.equal(plan.ready, false);
  assert.equal(plan.state, 'dependency-required');
  assert.deepEqual(plan.capabilityGraph.missingDependencies, [
    { capabilityId: 'custom-controller', dependency: 'missing-solver' }
  ]);
});


test('implementation readiness does not bypass approval for side-effecting capabilities', () => {
  const plan = compileCapabilityImplementations([
    { id: 'adaptive-execution', source: 'discoverable', dynamic: true, risk: 'high' }
  ], { executionTargets: ['generic-tool-router'] });
  assert.equal(plan.ready, true);
  assert.equal(plan.executionReady, false);
  assert.equal(plan.state, 'approval-required');
  assert.deepEqual(plan.approvalRequired, ['adaptive-execution']);
});
