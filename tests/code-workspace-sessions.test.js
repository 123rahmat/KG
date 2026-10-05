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

test('Code Workspace normalization is bounded and leaves source authorization to the store', () => {
  assert.equal(normalizeWorkspaceSessionInput({ projectId: 'p' }).sourceId, null);
  assert.equal(
    normalizeWorkspaceSessionInput({ sourceId: 'github-source-1', projectId: 'p' }).sourceId,
    'github-source-1'
  );
});


test('scratch Code Workspace sessions are explicitly scoped without a GitHub source', () => {
  const input = normalizeWorkspaceSessionInput({
    projectId: 'scratch-project-1',
    conversationId: 'scratch-chat-1',
    metadata: { kind: 'scratch' }
  });
  assert.equal(input.sourceId, null);
  assert.equal(input.projectId, 'scratch-project-1');
  assert.equal(input.metadata.kind, 'scratch');
});
