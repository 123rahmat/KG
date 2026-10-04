import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySurfaceBoundary,
  normalChatAllowsTask,
  surfaceRuntimePolicy,
  SURFACE_WORKSPACE_CONTRACTS
} from '../src/surface-policy.js';
import { resolveAdaptiveContext } from '../src/adaptive.js';

test('normal chat stays adaptive but medium-depth', () => {
  const decision = classifySurfaceBoundary('Explain this diagram step by step.', {
    attachments: [{ name: 'diagram.png' }],
    flags: { file: true },
    actions: ['answer']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.redirect, false);
  assert.equal(surfaceRuntimePolicy('normal-chat').maxDepth, 'medium');
});

test('explicit coding work is routed out of normal chat', () => {
  const decision = classifySurfaceBoundary('Debug this GitHub repository and fix the failing tests.', {
    activeSurface: 'normal-chat',
    flags: { code: true },
    actions: ['answer', 'transform']
  });
  assert.equal(decision.surface, 'code');
  assert.equal(decision.redirect, true);
  assert.equal(normalChatAllowsTask({ goal: 'Debug this GitHub repository and fix the failing tests.' }).allowed, false);
});

test('deep research is routed out of normal chat', () => {
  const decision = classifySurfaceBoundary('Do a comprehensive literature review with sources and citations.', {
    activeSurface: 'normal-chat',
    flags: { research: true },
    actions: ['answer', 'investigate']
  });
  assert.equal(decision.surface, 'research');
  assert.equal(decision.redirect, true);
});

test('code explanation remains normal chat while code work routes out', () => {
  const decision = classifySurfaceBoundary('Explain this code step by step.', {
    activeSurface: 'normal-chat', flags: { code: true }, actions: ['answer']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.redirect, false);
});

test('medium analysis remains normal chat', () => {
  const decision = classifySurfaceBoundary('Compare these two explanations and tell me which is easier for a beginner.', {
    activeSurface: 'normal-chat',
    flags: {},
    actions: ['answer']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.complexity, 'medium');
});


test('each workspace exposes a distinct operating contract over the same intelligence', () => {
  assert.equal(SURFACE_WORKSPACE_CONTRACTS['normal-chat'].mode, 'conversation-first');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.code.mode, 'repository-engineering');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.research.mode, 'evidence-first-investigation');
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.code.agentPolicy.includes('immutable revision'), true);
  assert.equal(SURFACE_WORKSPACE_CONTRACTS.research.verificationPolicy.includes('observed facts'), true);
});

test('active workspace context is preserved and compound work exposes only the supporting workspace', () => {
  const code = classifySurfaceBoundary('Explain this function and fix the repository tests.', {
    activeSurface: 'code',
    flags: { code: true },
    actions: ['answer', 'transform']
  });
  assert.equal(code.surface, 'code');
  assert.equal(code.redirect, false);

  const adaptive = resolveAdaptiveContext('Research the current dependency release and then update the repository.', {
    activeSurface: 'code',
    attachedCode: true,
    files: [{ name: 'package.json' }],
    attachments: [{ name: 'package.json' }]
  });
  assert.equal(adaptive.primarySurface, 'code');
  assert.ok(adaptive.adaptiveSnapshot.resourcePlan.selected.surfaces.includes('code'));
  assert.ok(adaptive.adaptiveSnapshot.resourcePlan.selected.surfaces.includes('research'));
});


test('selected Code Workspace remains stable for context-dependent follow-ups', () => {
  const decision = classifySurfaceBoundary('Why did that fail?', {
    activeSurface: 'code',
    flags: {},
    actions: ['answer']
  });
  assert.equal(decision.surface, 'code');
  assert.equal(decision.transition, 'stay');
  assert.equal(decision.redirect, false);
});

test('selected Research Workspace remains stable for context-dependent follow-ups', () => {
  const decision = classifySurfaceBoundary('Summarize the strongest finding so far.', {
    activeSurface: 'research',
    flags: {},
    actions: ['answer']
  });
  assert.equal(decision.surface, 'research');
  assert.equal(decision.transition, 'stay');
  assert.equal(decision.redirect, false);
});

test('explicit cross-mode intent switches the operating workspace', () => {
  const research = classifySurfaceBoundary('Switch to Research Workspace and verify the current dependency release.', {
    activeSurface: 'code',
    flags: { research: true },
    actions: ['answer', 'investigate']
  });
  assert.equal(research.surface, 'research');
  assert.equal(research.transition, 'switch');
  assert.equal(research.redirect, true);

  const code = classifySurfaceBoundary('Open the Code Workspace and fix the failing test.', {
    activeSurface: 'research',
    flags: { code: true },
    actions: ['answer', 'transform']
  });
  assert.equal(code.surface, 'code');
  assert.equal(code.transition, 'switch');
  assert.equal(code.redirect, true);
});

test('adaptive context exposes exactly three public operating modes', () => {
  const context = resolveAdaptiveContext('Research the current dependency release and then update the repository.', {
    activeSurface: 'code',
    attachedCode: true,
    files: [{ name: 'package.json' }],
    attachments: [{ name: 'package.json' }]
  });
  assert.deepEqual(context.adaptiveSnapshot.modeRouting.publicModes, ['normal-chat', 'code', 'research']);
  assert.equal(context.adaptiveSnapshot.modeRouting.primary, 'code');
  assert.ok(context.adaptiveSnapshot.modeRouting.supporting.includes('research'));
});


test('Normal Chat remains the general adaptive mode for non-deep workspace work', () => {
  const contract = SURFACE_WORKSPACE_CONTRACTS['normal-chat'];
  assert.match(contract.objective, /general adaptive operating mode/i);
  assert.match(contract.creationPolicy, /planning|analysis|file understanding/i);
  assert.match(contract.escalationPolicy, /otherwise continue adapting inside Normal Chat/i);

  const decision = classifySurfaceBoundary('Help me plan a business launch and organize the work.', {
    activeSurface: 'normal-chat',
    flags: {},
    actions: ['answer', 'create']
  });
  assert.equal(decision.surface, 'normal-chat');
  assert.equal(decision.redirect, false);
});
