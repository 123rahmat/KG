import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkspacePatch, classifyWorkspaceFile, createWorkspaceState, selectWorkspaceContext, workspaceDiff, workspaceImpact, workspaceRevision } from '../src/code-workspace.js';

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
