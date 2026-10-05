import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModeControllerContract,
  controllerForSurface,
  modeControllerCatalog
} from '../src/mode-controllers.js';
import {
  classifySurfaceBoundary,
  surfaceIntelligenceProfile,
  surfaceRuntimePolicy
} from '../src/surface-policy.js';

test('four mode controllers are distinct policies over one contract', () => {
  const modes = ['normal-chat', 'code', 'research', 'design'];
  const controllers = modes.map(controllerForSurface);
  assert.deepEqual(controllers.map(item => item.mode), modes);
  assert.equal(new Set(controllers.map(item => item.id)).size, modes.length);
  for (const controller of controllers) {
    assert.equal(typeof controller.objective, 'string');
    assert.ok(controller.objective.length > 20);
    assert.ok(Array.isArray(controller.roles));
  }
});

test('controller effort adapts without changing authority', () => {
  const design = buildModeControllerContract({
    surface: 'design',
    situation: { goal: 'Create a product landing visual', successCriteria: ['coherent', 'exportable'] },
    acceptance: { criteria: ['coherent', 'exportable'] },
    pressure: 3,
    uncertainty: 0.8,
    complexity: 0.7,
    risk: 'medium',
    remainingBudgetRatio: 0.9
  });
  assert.equal(design.mode, 'design');
  assert.equal(design.decision.recruitSpecialist, true);
  assert.equal(design.decision.parallelIndependentWork, true);
  assert.equal(design.decision.stopWhenSatisfied, true);
  assert.match(design.principle, /one shared state/i);
});

test('surface boundary recognizes a dedicated design workspace', () => {
  const boundary = classifySurfaceBoundary('Create a poster layout and visual identity', {
    activeSurface: 'normal-chat',
    actions: ['create']
  });
  assert.equal(boundary.surface, 'design');
  assert.equal(boundary.redirect, true);
});

test('selected design workspace remains sticky for ordinary follow-ups', () => {
  const boundary = classifySurfaceBoundary('Move the title slightly left', {
    activeSurface: 'design',
    actions: ['transform']
  });
  assert.equal(boundary.surface, 'design');
  assert.equal(boundary.transition, 'stay');
  assert.equal(boundary.redirect, false);
});

test('deep research and code boundaries retain precedence over generic visual wording', () => {
  const research = classifySurfaceBoundary('Research the latest visual design trends with sources', {
    activeSurface: 'normal-chat',
    actions: ['investigate']
  });
  assert.equal(research.surface, 'research');

  const code = classifySurfaceBoundary('Implement this design in the existing website repository', {
    activeSurface: 'normal-chat',
    actions: ['create', 'transform']
  });
  assert.equal(code.surface, 'code');
});

test('design policy exposes deep visual controls and shared intelligence', () => {
  const policy = surfaceRuntimePolicy('design');
  const profile = surfaceIntelligenceProfile('design');
  assert.equal(policy.id, 'design');
  assert.equal(policy.visualCanvas, true);
  assert.equal(policy.adaptiveVerification, true);
  assert.equal(profile.maturity, 'deep-visual');

  const catalog = modeControllerCatalog();
  assert.deepEqual(catalog.map(item => item.mode), ['normal-chat', 'code', 'research', 'design']);
});
