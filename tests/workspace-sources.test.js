import test from 'node:test';
import assert from 'node:assert/strict';
import { githubHeaders, githubListBranches, githubListRepositories, normalizeSourceFiles, sourceManifest } from '../src/workspace-sources.js';

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


test('GitHub repository and branch discovery uses POST-safe server-side helpers', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(
      url.includes('/branches?') ? [{ name: 'main', protected: true }] : [{ id: 1, full_name: 'demo/app', default_branch: 'main', private: true, owner: { login: 'demo' }, name: 'app' }]
    ), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const repos = await githubListRepositories({ fetchImpl, token: 'secret' });
  const branches = await githubListBranches({ fetchImpl, token: 'secret', owner: 'demo', repo: 'app' });
  assert.equal(repos[0].full_name, 'demo/app');
  assert.equal(branches[0].name, 'main');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, 'Bearer secret');
  assert.ok(!calls[1].url.includes('secret'));
});
