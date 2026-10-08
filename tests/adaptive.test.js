import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAdaptiveContext, inspectGoal, discoverCapabilityRequirements
} from '../src/adaptive.js';

test('ordinary conversation stays a single chat surface', () => {
  const context = resolveAdaptiveContext('Explain recursion.', {
    runtimeMode: 'hosted',
    workspaceType: 'personal'
  });
  assert.deepEqual(context.surfaces, ['chat']);
  assert.equal(context.primarySurface, 'chat');
  assert.equal(context.audience, 'individual');
  assert.equal(context.runtime.storage, 'hosted');
  assert.ok(context.governance);
  assert.ok(['ready', 'review'].includes(context.governance.status));
  assert.equal(context.governance.ethics.transparencyRequired, true);
});

test('compound coding and project-file goals compose one adaptive workspace', () => {
  const context = resolveAdaptiveContext(
    'Build Python code and modify an existing MATLAB file.',
    { runtimeMode: 'hybrid', workspaceType: 'enterprise' }
  );
  assert.ok(context.surfaces.includes('code'));
  assert.ok(!context.surfaces.includes('simulation'), 'there is no simulation surface');
  assert.equal(context.compound, true);
  assert.equal(context.primarySurface, 'code');
  assert.equal(context.audience, 'enterprise');
  assert.equal(context.runtime.storage, 'local+hosted');
  assert.ok(context.connectors.includes('general-ai-sandbox'));
  assert.ok(context.connectors.includes('local-agent'));
  assert.ok(context.resourcePlan.selected.capabilities.includes('code-generation'));
  assert.ok(!context.resourcePlan.selected.capabilities.some(id => /simulat/.test(id)));
  assert.equal(context.governance.verification.evidenceRequired, true);
});

test('local deployments are local-first without changing the workflow', () => {
  const context = resolveAdaptiveContext('Build a small tool.', {
    runtimeMode: 'local',
    workspaceType: 'personal'
  });
  assert.equal(context.runtime.storage, 'local');
  assert.equal(context.runtime.execution, 'local-first');
});


test('unknown or novel goals trigger open-world investigation and capability discovery', () => {
  const goal = 'Invent a mechanism for an unfamiliar problem that has never existed before and determine how it could be tested.';
  const analysis = inspectGoal(goal);
  assert.equal(analysis.openWorld, true);
  assert.equal(analysis.unknownSituation, true);
  assert.equal(analysis.investigationNeeded, true);

  const requirements = discoverCapabilityRequirements(goal, analysis);
  assert.ok(requirements.some(item => item.id === 'capability-discovery'));
  assert.ok(requirements.some(item => item.id === 'adaptive-execution' && item.dynamic));
});


test('invention goals compile an explicit cross-domain invention loop', () => {
  const context = resolveAdaptiveContext('Invent a new mechanism for an unfamiliar process.');
  assert.ok(context.requirements.includes('invention'));
  assert.ok(context.requirements.includes('hypothesis-generation'));
  assert.ok(context.requirements.includes('concept-evaluation'));
  assert.ok(context.requirements.includes('experiment-design'));
  assert.equal(context.openWorld, true);
  assert.ok(context.requirements.some(id => ['capability-discovery','adaptive-execution'].includes(id)));
  assert.ok(context.surfaceDescriptors.every(surface => ['chat','code','research'].includes(surface.id)));
});


test('user-controlled adaptive depth changes the active working budget', () => {
  const brief = resolveAdaptiveContext('Build and test a Python API.', {
    adaptiveControl: { depth: 'brief' }
  });
  const thorough = resolveAdaptiveContext('Build and test a Python API.', {
    adaptiveControl: { depth: 'thorough' }
  });
  assert.equal(brief.resourcePlan.control.depth, 'brief');
  assert.equal(thorough.resourcePlan.control.depth, 'thorough');
  assert.equal(brief.resourcePlan.userControlled, true);
  assert.ok(brief.resourcePlan.budget.maxCapabilities < thorough.resourcePlan.budget.maxCapabilities);
});

test('missing capability investment stays a proposal until the user chooses it', () => {
  const context = resolveAdaptiveContext(
    'Invent an unfamiliar capability for a system that has never existed before.',
    { adaptiveControl: { capabilityInvestment: 'ask' } }
  );
  assert.equal(context.resourcePlan.implementation.investment.decision, 'user-choice-required');
  assert.equal(context.resourcePlan.implementation.investment.automatic, false);
});

test('classifier need controls the inferred requested depth without overriding an explicit user depth', () => {
  const hints = {
    actions: ['answer'],
    signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
    unknownSituation: false,
    confidence: 0.9,
    need: { deliverable: 'the answer', form: 'explanation', depth: 'thorough' }
  };
  const inferred = resolveAdaptiveContext('Explain this concept.', { classifierHints: hints });
  const explicit = resolveAdaptiveContext('Explain this concept.', {
    classifierHints: hints,
    adaptiveControl: { depth: 'brief' }
  });
  assert.equal(inferred.resourcePlan.control.depth, 'thorough');
  assert.equal(explicit.resourcePlan.control.depth, 'brief');
  assert.equal(explicit.goalModel.need.depth, 'thorough');
});


test('explicit artifact scope is a strict whitelist', () => {
  const context = resolveAdaptiveContext('Summarize the attached material.', {
    files: ['important.pdf', 'unrelated.pdf'],
    adaptiveControl: { includeArtifacts: ['important.pdf'] }
  });
  assert.deepEqual(context.resourcePlan.selected.artifacts, ['important.pdf']);
  assert.ok(context.resourcePlan.omitted.artifacts.includes('unrelated.pdf'));
});

test('authorized adaptive expansion increases scope by one depth level only', () => {
  const context = resolveAdaptiveContext(
    'Build and test a new software tool from an unfamiliar requirement.',
    { adaptiveControl: { depth: 'brief', allowAdaptiveExpansion: true } }
  );
  assert.equal(context.resourcePlan.control.depth, 'standard');
  assert.equal(context.resourcePlan.expansion.expanded, true);
  assert.equal(context.resourcePlan.expansion.fromDepth, 'brief');
});


