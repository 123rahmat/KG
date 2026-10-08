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

test('comparison requests suggest a table without forcing extra agents', () => {
  const profile = normalChatTaskProfile({ goal: 'Compare these options and trade-offs' });
  assert.equal(profile.presentation.mode, 'comparison');
  assert.equal(profile.presentation.showTableWhenUseful, true);
  assert.equal(profile.agentPolicy, 'one-model-first-recruit-only-when-useful');
});

test('educational reasoning suggests worked examples', () => {
  const profile = normalChatTaskProfile({ goal: 'Teach me to solve calculus problems' });
  assert.equal(profile.domain, 'education');
  assert.equal(profile.presentation.mode, 'worked-example');
  assert.equal(profile.presentation.showWorkedExample, true);
});

test('file edits suggest file progress, while deep reasoning remains optional', () => {
  const profile = normalChatTaskProfile({
    goal: 'Edit and reconcile these two documents',
    attachments: ['a.docx', 'b.docx']
  });
  assert.equal(profile.presentation.mode, 'file-workflow');
  assert.equal(profile.presentation.showFileProgress, true);
  assert.equal(profile.presentation.allowDeepReasoning, false);
});

test('visual requests stay native to Chat with preview intent', () => {
  const profile = normalChatTaskProfile({ goal: 'Create a flowchart of the process' });
  assert.equal(profile.presentation.mode, 'visual-first');
  assert.equal(profile.presentation.showVisualWhenUseful, true);
  assert.equal(profile.suggestedTransition, null);
});
