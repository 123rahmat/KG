import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_CONTRACT_VERSION,
  ADAPTATION_INVARIANT,
  buildAdaptiveSnapshot,
  situationFingerprint,
  validateAdaptiveSnapshot
} from '../src/adaptive-contract.js';

test('adaptive snapshot is deterministic and self-validating', () => {
  const snapshot = buildAdaptiveSnapshot({
    situation: { goal: 'unknown machine', constraints: ['safe'] },
    requirements: ['reasoning', 'capability-discovery'],
    implementationPlan: { state: 'implementation-required', ready: false, missing: ['capability-discovery'] },
    resourcePlan: { selected: { capabilities: ['reasoning'], dataSources: [], artifacts: [], surfaces: ['chat'] } },
    workflowBlueprint: { mode: 'adaptive-discovery', phases: ['understand-and-bound', 'verify', 'deliver'] },
    primarySurface: 'adaptive'
  });
  assert.equal(snapshot.contractVersion, ADAPTIVE_CONTRACT_VERSION);
  assert.equal(snapshot.invariant, ADAPTATION_INVARIANT);
  assert.equal(validateAdaptiveSnapshot(snapshot).valid, true);
  const { fingerprint, ...unsigned } = snapshot;
  assert.equal(fingerprint, situationFingerprint(unsigned));
});

test('tampering with the decision snapshot is detectable', () => {
  const snapshot = buildAdaptiveSnapshot({
    situation: { goal: 'build a model' },
    requirements: ['code-generation'],
    implementationPlan: { state: 'ready', ready: true, executionReady: false }
  });
  const tampered = { ...snapshot, situation: { goal: 'different goal' } };
  const result = validateAdaptiveSnapshot(tampered);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('fingerprint-mismatch'));
});


test('resource scope and workflow blueprint are part of the signed adaptive snapshot', () => {
  const snapshot = buildAdaptiveSnapshot({
    situation: { goal: 'research one answer' },
    requirements: ['reasoning'],
    implementationPlan: { state: 'ready', ready: true },
    resourcePlan: {
      userControlled: true,
      selected: { capabilities: ['reasoning'], dataSources: ['public-web'], artifacts: [], surfaces: ['chat', 'research'] }
    },
    workflowBlueprint: {
      mode: 'evidence-first',
      stopConditions: ['required deliverable is satisfied']
    },
    primarySurface: 'research'
  });
  assert.deepEqual(snapshot.resourcePlan.selected.dataSources, ['public-web']);
  assert.equal(snapshot.workflowBlueprint.mode, 'evidence-first');
  assert.equal(validateAdaptiveSnapshot(snapshot).valid, true);
  const tampered = { ...snapshot, workflowBlueprint: { ...snapshot.workflowBlueprint, mode: 'answer' } };
  assert.equal(validateAdaptiveSnapshot(tampered).valid, false);
  assert.ok(validateAdaptiveSnapshot(tampered).errors.includes('fingerprint-mismatch'));
});


test('resource scope and workflow blueprint are part of the signed adaptive snapshot', () => {
  const snapshot = buildAdaptiveSnapshot({
    situation: { goal: 'research one answer' },
    requirements: ['reasoning'],
    implementationPlan: { state: 'ready', ready: true },
    resourcePlan: {
      userControlled: true,
      selected: { capabilities: ['reasoning'], dataSources: ['public-web'], artifacts: [], surfaces: ['chat', 'research'] }
    },
    workflowBlueprint: {
      mode: 'evidence-first',
      stopConditions: ['required deliverable is satisfied']
    },
    primarySurface: 'research'
  });
  assert.deepEqual(snapshot.resourcePlan.selected.dataSources, ['public-web']);
  assert.equal(snapshot.workflowBlueprint.mode, 'evidence-first');
  assert.equal(validateAdaptiveSnapshot(snapshot).valid, true);
  const tampered = { ...snapshot, workflowBlueprint: { ...snapshot.workflowBlueprint, mode: 'answer' } };
  assert.equal(validateAdaptiveSnapshot(tampered).valid, false);
  assert.ok(validateAdaptiveSnapshot(tampered).errors.includes('fingerprint-mismatch'));
});
