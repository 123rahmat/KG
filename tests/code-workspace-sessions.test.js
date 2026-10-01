import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspaceSessionInput } from '../src/code-workspace-sessions.js';

test('workspace session input stays scoped and bounded', () => {
  const value = normalizeWorkspaceSessionInput({
    projectId: 'project-a',
    conversationId: '01234567-89ab',
    branch: 'agent/auth-fix',
    baseRevision: 'abc123'
  });
  assert.equal(value.projectId, 'project-a');
  assert.equal(value.conversationId, '01234567-89ab');
  assert.equal(value.branch, 'agent/auth-fix');
});

test('workspace sessions reject invalid conversation identifiers', () => {
  assert.throws(() => normalizeWorkspaceSessionInput({ projectId: 'p', conversationId: 'bad' }), /Invalid conversationId/);
});
