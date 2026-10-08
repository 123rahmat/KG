import test from 'node:test';
import assert from 'node:assert/strict';
import { normalChatTaskProfile } from '../src/normal-chat-task-profile.js';

test('everyday request stays on direct NormalChat path', () => {
  const profile = normalChatTaskProfile({ goal: 'Hello, how are you?' });
  assert.equal(profile.workspace, 'normal-chat');
  assert.equal(profile.domain, 'everyday');
  assert.equal(profile.reasoningDepth, 'direct');
  assert.equal(profile.suggestedTransition, null);
});

test('demanding education remains in Chat with deep reasoning', () => {
  const profile = normalChatTaskProfile({ goal: 'Teach me calculus: prove this difficult theorem step by step' });
  assert.equal(profile.domain, 'education');
  assert.equal(profile.reasoningDepth, 'deep');
  assert.ok(profile.contextPriorities.includes('worked-examples'));
});

test('multiple file edits prioritize consistency and artifact integrity', () => {
  const profile = normalChatTaskProfile({
    goal: 'Edit the budget in these files and keep figures consistent',
    attachments: ['budget.xlsx', 'plan.docx']
  });
  assert.equal(profile.domain, 'file-work');
  assert.ok(profile.contextPriorities.includes('cross-file-consistency'));
  assert.ok(profile.contextPriorities.includes('artifact-integrity'));
  assert.equal(profile.verification, 'check-observable-claims-and-artifacts');
});

test('visual generation requires a rendered preview and verification', () => {
  const profile = normalChatTaskProfile({ goal: 'Create an infographic diagram' });
  assert.equal(profile.domain, 'visual-creation');
  assert.ok(profile.contextPriorities.includes('rendered-preview'));
  assert.equal(profile.verification, 'check-observable-claims-and-artifacts');
});

test('file-backed chart task prioritizes attachments and visual preview', () => {
  const profile = normalChatTaskProfile({ goal: 'Build a chart from this CSV', attachments: ['data.csv'] });
  assert.equal(profile.domain, 'file-work');
  assert.ok(profile.contextPriorities.includes('selected-attachments'));
  assert.ok(profile.contextPriorities.includes('rendered-preview'));
});

test('task profiles never authorize tools or workspace transitions', () => {
  const profile = normalChatTaskProfile({ goal: 'Run code in terminal to edit multiple files', complexity: 1 });
  assert.equal(profile.toolPolicy, 'just-in-time-authorized-only');
  assert.equal(profile.agentPolicy, 'one-model-first-recruit-only-when-useful');
  assert.equal(profile.serverAuthorityRequired, true);
  assert.equal(profile.suggestedTransition, null);
  assert.ok(Object.isFrozen(profile.contextPriorities));
});
