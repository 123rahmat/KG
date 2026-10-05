import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeContextScope,
  memoryScopePolicy,
  skillActivationPolicy,
  buildUniversalContextContract
} from '../src/universal-context.js';

test('universal context keeps session and project scopes explicit', () => {
  const scope = normalizeContextScope({
    principalId: 'user-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    conversationId: 'chat-1'
  });
  assert.equal(scope.valid, true);
  const memory = memoryScopePolicy({ scope, crossChatMemory: false });
  assert.deepEqual(memory.layers, ['session', 'project']);
});

test('cross-chat memory expands scope only when enabled', () => {
  const scope = normalizeContextScope({ principalId: 'u', workspaceId: 'w' });
  assert.deepEqual(memoryScopePolicy({ scope, crossChatMemory: false }).layers, ['session']);
  assert.deepEqual(memoryScopePolicy({ scope, crossChatMemory: true }).layers, ['session', 'user']);
});

test('skills are universally available but policy and budgets constrain activation', () => {
  const result = skillActivationPolicy({
    requestedSkills: ['coding'],
    candidateSkills: ['testing', 'security-review', 'research'],
    deniedSkills: ['research'],
    maxSkills: 2,
    verificationRequired: true
  });
  assert.deepEqual(result.selected, ['coding', 'testing']);
  assert.equal(result.evidenceMode, 'required');
  assert.ok(result.omitted.some(item => item.name === 'research'));
});

test('universal contract preserves continuity and server authority', () => {
  const result = buildUniversalContextContract({
    goal: 'continue the project',
    principalId: 'u',
    workspaceId: 'w',
    projectId: 'p',
    conversationId: 'c',
    crossChatMemory: true,
    candidateSkills: ['coding'],
    verificationRequired: true,
    uncertainty: 0.8
  });
  assert.equal(result.valid, true);
  assert.equal(result.contextDepth, 'broad');
  assert.equal(result.continuity.project, true);
  assert.equal(result.skills.availability, 'universal');
  assert.equal(result.safety.skillBoundary.includes('never grants'), true);
});
