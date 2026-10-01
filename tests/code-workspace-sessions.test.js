import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspaceSessionInput } from '../src/code-workspace-sessions.js';
test('workspace session input is bounded', () => {
  const v = normalizeWorkspaceSessionInput({ projectId: 'p', conversationId: '01234567-89ab', branch: 'agent/auth-fix', baseRevision: 'r1' });
  assert.equal(v.projectId, 'p'); assert.equal(v.conversationId, '01234567-89ab');
});
test('workspace session rejects malformed conversation id', () => {
  assert.throws(() => normalizeWorkspaceSessionInput({ projectId: 'p', conversationId: 'bad' }), /Invalid conversationId/);
});