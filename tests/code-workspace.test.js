import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkspacePatch, classifyWorkspaceFile, createWorkspaceState, createWorkspaceChatContext, normalizeWorkspaceFiles, selectWorkspaceContext, workspaceDiff, workspaceImpact, workspaceRevision } from '../src/code-workspace.js';

test('workspace revisions are deterministic for the same project state', () => {
  const files = [{ path: 'src/app.js', content: 'export const x = 1;' }];
  const a = workspaceRevision({ projectId: 'p1', files, author: 'ai', message: 'change' });
  const b = workspaceRevision({ projectId: 'p1', files, author: 'ai', message: 'change' });
  assert.equal(a.id, b.id);
  assert.equal(a.contentHash, b.contentHash);
});

test('patches produce explicit diffs and preserve unrelated files', () => {
  const before = [
    { path: 'src/a.js', content: 'a' },
    { path: 'src/b.js', content: 'b' }
  ];
  const after = applyWorkspacePatch(before, [
    { path: 'src/a.js', kind: 'modified', after: 'aa' },
    { path: 'src/c.js', kind: 'added', after: 'c' },
    { path: 'src/b.js', kind: 'deleted' }
  ]);
  assert.deepEqual(workspaceDiff(before, after).map(x => [x.path, x.kind]), [
    ['src/a.js', 'modified'], ['src/b.js', 'deleted'], ['src/c.js', 'added']
  ]);
});

test('context selection prioritizes changed, relevant and test/config files', () => {
  const files = [
    { path: 'src/auth/session.js', content: 'x' },
    { path: 'src/other.js', content: 'x' },
    { path: 'tests/auth.test.js', content: 'x' },
    { path: 'package.json', content: 'x' }
  ];
  const selected = selectWorkspaceContext(files, { changedPaths: ['src/auth/session.js'], query: 'auth', maxFiles: 3 });
  assert.equal(selected[0].path, 'src/auth/session.js');
  assert.ok(selected.some(file => file.path === 'tests/auth.test.js'));
});

test('impact tells the workflow when targeted and full verification are needed', () => {
  const impact = workspaceImpact(
    [{ path: 'src/a.js', content: 'a' }],
    [{ path: 'src/a.js', content: 'b' }, { path: 'package.json', content: '{}' }]
  );
  assert.equal(impact.codeChanged, true);
  assert.equal(impact.configChanged, true);
  assert.equal(impact.requiresTargetedTests, true);
  assert.equal(impact.requiresFullVerification, true);
});

test('workspace state is compact and content-addressed', () => {
  const state = createWorkspaceState({ projectId: 'p', revisionId: 'r', files: [{ path: 'README.md', content: 'hello' }], task: { id: 'code', title: 'Fix it' } });
  assert.equal(state.projectId, 'p');
  assert.equal(state.revisionId, 'r');
  assert.equal(state.fileCount, 1);
  assert.equal(state.clean, true);
  assert.equal(classifyWorkspaceFile('tests/foo.test.js'), 'test');
  assert.equal(classifyWorkspaceFile('package.json'), 'config');
  assert.equal(classifyWorkspaceFile('src/foo.js'), 'code');
});


test('every code workspace chat has an explicit isolated memory scope and adaptive multi-agent policy', () => {
  const chat = createWorkspaceChatContext({
    conversationId: 'chat-12345678',
    multiAgentMode: 'auto',
    maxAgents: 8
  });
  assert.equal(chat.conversationId, 'chat-12345678');
  assert.deepEqual(chat.memory, {
    scope: 'conversation',
    alwaysOn: true,
    crossChat: 'user-controlled',
    note: 'Chat-local memory is isolated to this conversation; cross-chat recall never happens implicitly.'
  });
  assert.equal(chat.multiAgent.mode, 'auto');
  assert.equal(chat.multiAgent.maxAgents, 8);
  assert.equal(chat.multiAgent.adaptive, true);
  assert.equal(chat.multiAgent.serverOrchestrated, true);
  assert.equal(chat.multiAgent.advisoryOnly, true);
});

test('workspace chat rejects an invalid conversation scope instead of silently sharing memory', () => {
  assert.throws(() => createWorkspaceChatContext({ conversationId: '../other-chat' }), /conversationId/);
});

test('duplicate paths are charged against the final content size, not the first occurrence', () => {
  const limits = { maxFileBytes: 12, maxTotalBytes: 20, maxFiles: 100 };
  assert.doesNotThrow(() => normalizeWorkspaceFiles([
    { path: 'a.js', content: '1234567890' },
    { path: 'b.js', content: '1234567890' },
    { path: 'a.js', content: 'x' }
  ], limits));
  assert.throws(
    () => normalizeWorkspaceFiles([
      { path: 'a.js', content: '1234567890' },
      { path: 'b.js', content: '1234567890' },
      { path: 'c.js', content: '1234567890' }
    ], limits),
    /Workspace exceeds its total file-size limit/
  );
  assert.doesNotThrow(() => normalizeWorkspaceFiles([
    { path: 'a.js', content: '1234567890' },
    { path: 'b.js', content: '123456789' },
    { path: 'a.js', content: 'x' }
  ], limits));
});

test('context selection never returns more bytes than its hard budget', () => {
  const files = [
    { path: 'changed.js', content: 'x'.repeat(20_000) },
    { path: 'tests/changed.test.js', content: 'y'.repeat(20_000) }
  ];
  const selected = selectWorkspaceContext(files, { changedPaths: ['changed.js'], maxFiles: 2, maxBytes: 2048 });
  assert.equal(selected.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0), 2048);
});
