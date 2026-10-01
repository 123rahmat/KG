import test from 'node:test';
import assert from 'node:assert/strict';
import { githubApplyChanges, githubHeaders, githubListBranches, githubListRepositories, githubReadRepository, normalizeSourceFiles, sourceManifest, workspaceReviewDigest } from '../src/workspace-sources.js';
import { workspacePath } from '../src/workspace-path.js';

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

test('source normalization keeps legitimate dotfiles and rejects binary content', () => {
  assert.deepEqual(
    normalizeSourceFiles([
      { path: '.gitignore', content: 'node_modules/' },
      { path: '.github/workflows/ci.yml', content: 'name: CI' },
      { path: 'src\\app.js', content: 'ok' },
      { path: './README.md', content: 'readme' },
      { path: 'src/../secret.txt', content: 'blocked' }
    ]),
    [
      { path: '.github/workflows/ci.yml', content: 'name: CI' },
      { path: '.gitignore', content: 'node_modules/' },
      { path: 'README.md', content: 'readme' },
      { path: 'src/app.js', content: 'ok' }
    ]
  );
  assert.throws(() => normalizeSourceFiles([{ path: 'src/app.js', content: 'bad\0binary' }]), /invalid binary data/);
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


test('GitHub snapshots report importer omissions instead of pretending the project is complete', async () => {
  const huge = 'x'.repeat(256 * 1024 + 1);
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/repos/demo/app')) {
      return new Response(JSON.stringify({ default_branch: 'main', private: true, html_url: 'https://github.com/demo/app' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/git/trees/base123?recursive=1')) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { type: 'blob', path: 'src/huge.js', size: huge.length, sha: 'huge' },
          { type: 'blob', path: 'src/app.js', size: 1, sha: 'app' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/git/blobs/app')) {
      return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('a').toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('omitted blob should not be downloaded');
  };
  const result = await githubReadRepository({ fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main' });
  assert.equal(result.ingestion.partial, true);
  assert.equal(result.ingestion.skippedCount, 1);
  assert.equal(result.ingestion.skippedExamples[0].reason, 'file-too-large');
  assert.deepEqual(result.files, [{ path: 'src/app.js', content: 'a' }]);
});

test('GitHub subdirectories map to workspace-root paths', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/repos/demo/app')) return new Response(JSON.stringify({ default_branch: 'main', private: true, html_url: 'https://github.com/demo/app' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/git/trees/base123?recursive=1')) return new Response(JSON.stringify({
      truncated: false,
      tree: [
        { type: 'blob', path: 'apps/service/src/main.js', size: 1, sha: 'main' },
        { type: 'blob', path: 'README.md', size: 1, sha: 'readme' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/git/blobs/main')) return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from('x').toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('out-of-scope file should not be fetched');
  };
  const result = await githubReadRepository({ fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main', repoPath: 'apps/service' });
  assert.equal(result.source.repoPath, 'apps/service');
  assert.deepEqual(result.files, [{ path: 'src/main.js', content: 'x' }]);
});

test('GitHub repository snapshots read the immutable resolved commit', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/repos/demo/app')) {
      return new Response(JSON.stringify({ default_branch: 'main', private: true, html_url: 'https://github.com/demo/app' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/git/trees/main')) {
      throw new Error('moving ref was used instead of the resolved commit');
    }
    if (url.includes('/git/trees/base123?recursive=1')) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [{ type: 'blob', path: 'src/app.js', size: 23, sha: 'blob123' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/git/blobs/blob123')) {
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('export const ok = true;\n').toString('base64')
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const result = await githubReadRepository({
    fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main'
  });
  assert.equal(result.source.commitSha, 'base123');
  assert.equal(result.source.treeSha, 'tree123');
  assert.deepEqual(result.files, [{ path: 'src/app.js', content: 'export const ok = true;\n' }]);
  assert.ok(calls.some(call => call.url.includes('/git/trees/base123?recursive=1')));
});
test('GitHub snapshots reject oversized trees before downloading blobs', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/repos/demo/app')) {
      return new Response(JSON.stringify({ default_branch: 'main', private: true, html_url: 'https://github.com/demo/app' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/git/trees/base123?recursive=1')) {
      return new Response(JSON.stringify({ truncated: false, tree: Array.from({ length: 20_001 }, (_, i) => ({ type: 'blob', path: `src/${i}.js`, size: 1, sha: `blob${i}` })) }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error('blob download should not happen');
  };
  await assert.rejects(
    () => githubReadRepository({ fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main' }),
    /tree is too large/
  );
});

test('GitHub snapshots reject invalid UTF-8 instead of replacing source bytes', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/repos/demo/app')) {
      return new Response(JSON.stringify({ default_branch: 'main', private: true, html_url: 'https://github.com/demo/app' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/git/trees/base123?recursive=1')) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [{ type: 'blob', path: 'src/bad.js', size: 2, sha: 'badblob' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/git/blobs/badblob')) {
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: Buffer.from([0xc3, 0x28]).toString('base64')
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected GitHub call');
  };
  await assert.rejects(
    () => githubReadRepository({ fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main' }),
    /invalid UTF-8/
  );
});

test('GitHub write-back rejects overwriting an existing unsnapshotted file', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/commits/main')) return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/git/trees/base123?recursive=1')) return new Response(JSON.stringify({
      truncated: false,
      tree: [{ type: 'blob', path: 'src/excluded.js', size: 10, sha: 'blob-excluded' }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error('blob/commit writes must not happen after the pre-image rejection');
  };
  await assert.rejects(
    () => githubApplyChanges({
      fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main', expectedCommitSha: 'base123',
      changes: [{ path: 'src/excluded.js', content: 'replacement' }]
    }),
    error => error.code === 'github-preimage-required'
  );
});

test('workspace deletion paths use the same canonical traversal boundary', () => {
  assert.equal(workspacePath('src/file.js'), 'src/file.js');
  assert.equal(workspacePath('src/../file.js'), null);
  assert.equal(workspacePath('../file.js'), null);
});

test('GitHub write-back rejects ambiguous change sets', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(
    () => githubApplyChanges({
      fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main', expectedCommitSha: 'base123',
      changes: [
        { path: 'src/app.js', content: 'a' },
        { path: 'src/app.js', content: 'b' }
      ]
    }),
    /duplicate paths/
  );
  await assert.rejects(
    () => githubApplyChanges({
      fetchImpl, token: 'secret', owner: 'demo', repo: 'app', ref: 'main', expectedCommitSha: 'base123',
      changes: [{ path: 'src/app.js', kind: 'range', content: 'bad' }]
    }),
    /only full-file upserts and deletes/
  );
});

test('workspace review digests are canonical and change when content changes', () => {
  const source = { id: 'source-1', metadata: { contentHash: 'base' } };
  const a = workspaceReviewDigest(source, [{ path: 'b.js', content: 'b', beforeDigest: '2'.repeat(64) }, { path: 'a.js', content: 'a', beforeDigest: '1'.repeat(64) }]);
  const b = workspaceReviewDigest(source, [{ path: 'a.js', content: 'a', beforeDigest: '1'.repeat(64) }, { path: 'b.js', content: 'b', beforeDigest: '2'.repeat(64) }]);
  const c = workspaceReviewDigest(source, [{ path: 'a.js', content: 'changed', beforeDigest: '1'.repeat(64) }, { path: 'b.js', content: 'b', beforeDigest: '2'.repeat(64) }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('GitHub write-back builds one revision and rejects stale bases', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/commits/main')) {
      return new Response(JSON.stringify({ sha: 'base123', commit: { tree: { sha: 'tree123' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/git/trees/base123?recursive=1')) {
      return new Response(JSON.stringify({ truncated: false, tree: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/git/blobs')) return new Response(JSON.stringify({ sha: 'blob123' }), { status: 201, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/git/trees')) return new Response(JSON.stringify({ sha: 'newtree123' }), { status: 201, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/git/commits')) return new Response(JSON.stringify({ sha: 'commit123' }), { status: 201, headers: { 'content-type': 'application/json' } });
    if (url.includes('/git/refs/heads/main')) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const result = await githubApplyChanges({
    fetchImpl,
    token: 'secret',
    owner: 'demo',
    repo: 'app',
    ref: 'main',
    expectedCommitSha: 'base123',
    changes: [{ path: 'src/app.js', content: 'export const ok = true;' }],
    message: 'workspace: reviewed change'
  });
  assert.equal(result.commitSha, 'commit123');
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 3);
  assert.equal(calls.at(-1).init.method, 'PATCH');

  await assert.rejects(
    () => githubApplyChanges({
      fetchImpl,
      token: 'secret',
      owner: 'demo',
      repo: 'app',
      ref: 'main',
      expectedCommitSha: 'other',
      changes: [{ path: 'src/app.js', content: 'changed' }]
    }),
    error => error.code === 'stale-github-revision'
  );
});
