import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySurfaceBoundary,
  normalChatAllowsTask,
  surfaceRuntimePolicy
} from '../src/surface-policy.js';

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
