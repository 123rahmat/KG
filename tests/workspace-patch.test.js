import test from 'node:test';
import assert from 'node:assert/strict';
import { applySurgicalChanges, changeSetDigest, contentDigest } from '../src/workspace-patch.js';
import { workspaceContentHash } from '../src/code-workspace.js';

test('surgical range patches require the expected pre-image and preserve unrelated files', () => {
  const files = [
    { path: 'src/a.js', content: 'const a = 1;\nconst b = 2;\n' },
    { path: 'src/b.js', content: 'export const b = 3;\n' }
  ];
  const baseHash = workspaceContentHash(files);
  const expected = contentDigest(files[0].content);
  const result = applySurgicalChanges(files, [{
    path: 'src/a.js',
    kind: 'range',
    startLine: 2,
    endLine: 2,
    expectedDigest: expected,
    replacement: 'const b = 4;'
  }], { expectedContentHash: baseHash });
  assert.equal(result.files.find(f => f.path === 'src/a.js').content, 'const a = 1;\nconst b = 4;\n');
  assert.equal(result.files.find(f => f.path === 'src/b.js').content, files[1].content);
  assert.ok(changeSetDigest(result.changed.map(path => ({ path }))));
});

test('stale workspace changes are rejected', () => {
  const files = [{ path: 'src/a.js', content: 'const a = 1;\n' }];
  assert.throws(() => applySurgicalChanges(files, [{
    path: 'src/a.js',
    kind: 'range',
    startLine: 1,
    endLine: 1,
    expectedDigest: contentDigest(files[0].content),
    replacement: 'const a = 2;'
  }], { expectedContentHash: workspaceContentHash([{ path: 'src/a.js', content: 'const a = 9;\n' }]) }), error => error.code === 'stale-workspace');
});
