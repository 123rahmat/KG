import test from 'node:test';
import assert from 'node:assert/strict';
import { githubHeaders, normalizeSourceFiles, sourceManifest } from '../src/workspace-sources.js';

test('workspace source files normalize safely and deterministically', () => {
  const files = normalizeSourceFiles([
    { path: 'src\\app.js', content: 'a' },
    { path: './README.md', content: 'readme' },
    { path: 'src/app.js', content: 'replacement' },
    { path: '../secret.txt', content: 'no' }
  ]);
  assert.deepEqual(files, [
    { path: 'README.md', content: 'readme' },
    { path: 'src/app.js', content: 'replacement' }
  ]);
  const a = sourceManifest(files);
  const b = sourceManifest([...files].reverse());
  assert.equal(a.contentHash, b.contentHash);
  assert.equal(a.fileCount, 2);
});

test('GitHub requests carry the intended API headers', () => {
  const headers = githubHeaders('example');
  assert.equal(headers.authorization, 'Bearer example');
  assert.equal(headers.accept, 'application/vnd.github+json');
  assert.equal(headers['x-github-api-version'], '2022-11-28');
});
