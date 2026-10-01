/**
 * External project sources for the intelligent workspace.
 *
 * Local folders are browser-granted sources: the browser chooses a directory
 * and syncs only the selected files. GitHub is an authenticated source using
 * a user-supplied fine-grained token stored encrypted at rest.
 *
 * This module never exposes credentials to model prompts or workspace files.
 */

import crypto from 'node:crypto';
import { encryptJson, decryptField } from './data-protection.js';
import { workspacePath } from './workspace-path.js';

const text = value => String(value ?? '').trim();
const SOURCE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_FILES = 250;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_TREE_ENTRIES = 20_000;

const SOURCE_EXTENSIONS = new Set(['py','pyi','js','mjs','cjs','jsx','ts','tsx','json','toml','cfg','ini','yaml','yml','md','txt','rst','html','css','scss','sql','sh','c','h','cc','cxx','cpp','hh','hpp','java','kt','kts','gradle','go','mod','sum','rs','rb','php','cs','swift','proto','cmake','csv','xml']);
const SOURCE_NAMES = new Set(['Makefile','Dockerfile','requirements.txt','package.json','pyproject.toml','setup.cfg','README','LICENSE','go.mod','go.sum','Cargo.toml','Cargo.lock','CMakeLists.txt','build.gradle','settings.gradle','pom.xml']);
const EXCLUDED_DIRS = new Set(['.git','node_modules','.next','.cache','dist','build','coverage','.venv','venv','__pycache__','.pytest_cache','target','vendor']);

function isUsefulSourcePath(path) {
  const parts = text(path).split('/');
  if (parts.some(part => EXCLUDED_DIRS.has(part))) return false;
  const name = parts.at(-1) ?? '';
  if (SOURCE_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export const SOURCE_KINDS = Object.freeze(['local-folder', 'github']);

function safePath(value) {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return workspacePath(path);
}

export function normalizeSourceFiles(files = []) {
  const list = Array.isArray(files) ? files : [];
  const map = new Map();
  let total = 0;
  for (const item of list) {
    const path = safePath(item?.path || item?.name);
    if (!path) continue;
    const content = typeof item?.content === 'string' ? item.content : '';
    if (content.includes('\0')) throw new Error(`Source file contains invalid binary data: ${path}`);
    const bytes = Buffer.byteLength(content, 'utf8');
    const previous = map.get(path);
    if (bytes > MAX_FILE_BYTES) throw new Error(`Source file is too large: ${path}`);
    if (previous) total -= Buffer.byteLength(previous, 'utf8');
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error('Source snapshot is too large');
    map.set(path, content);
    if (map.size > MAX_FILES) throw new Error('Source contains too many files');
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
}

export function workspaceReviewDigest(source, changes = []) {
  const revision = source?.metadata?.commitSha ?? source?.metadata?.contentHash ?? null;
  const normalized = (Array.isArray(changes) ? changes : []).map(change => ({
    path: safePath(change?.path),
    kind: change?.kind === 'delete' || change?.delete === true ? 'delete' : 'upsert',
    content: change?.kind === 'delete' || change?.delete === true ? null : String(change?.content ?? ''),
    beforeDigest: text(change?.beforeDigest) || null
  })).sort((a,b) => String(a.path).localeCompare(String(b.path)) || a.kind.localeCompare(b.kind));
  const basis = JSON.stringify({ sourceId: text(source?.id), sourceRevision: text(revision), changes: normalized });
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex');
}

export function sourceManifest(files = []) {
  const normalized = normalizeSourceFiles(files);
  const digest = crypto.createHash('sha256');
  for (const file of normalized) digest.update(file.path).update('\0').update(file.content).update('\0');
  return {
    contentHash: digest.digest('hex'),
    fileCount: normalized.length,
    files: normalized.map(file => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      digest: crypto.createHash('sha256').update(file.content, 'utf8').digest('hex')
    }))
  };
}

export function assertGitHubRepo(owner, repo) {
  if (!GITHUB_REPO.test(text(owner)) || !GITHUB_REPO.test(text(repo))) {
    throw new Error('GitHub owner and repository names are invalid');
  }
}

export function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${text(token)}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Kindgleam-Workspace'
  };
}

async function githubJson(fetchImpl, url, token, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...githubHeaders(token), ...(init.headers ?? {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `GitHub request failed (${response.status})`);
    error.status = response.status;
    error.github = true;
    throw error;
  }
  return body;
}

export async function githubListRepositories({ fetchImpl = fetch, token, page = 1 } = {}) {
  const safePage = Math.max(1, Math.min(100, Number(page) || 1));
  return githubJson(fetchImpl, `https://api.github.com/user/repos?per_page=100&page=${safePage}&sort=updated`, token);
}

export async function githubListBranches({ fetchImpl = fetch, token, owner, repo, page = 1 } = {}) {
  assertGitHubRepo(owner, repo);
  const safePage = Math.max(1, Math.min(100, Number(page) || 1));
  return githubJson(
    fetchImpl,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${safePage}`,
    token
  );
}

export async function githubReadRepository({
  fetchImpl = fetch, token, owner, repo, ref = null, maxBytes = MAX_TOTAL_BYTES
} = {}) {
  assertGitHubRepo(owner, repo);
  const root = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token
  );
  const resolvedRef = text(ref) || text(root.default_branch) || 'main';
  const revision = await githubResolveRevision({ fetchImpl, token, owner, repo, ref: resolvedRef });
  if (!revision.sha) throw new Error('GitHub repository revision could not be resolved');
  // Resolve the ref once, then read the tree from that immutable commit SHA.
  // Using the moving branch/tag name here creates a TOCTOU race where the
  // snapshot metadata and file contents can come from different revisions.
  const tree = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(revision.sha)}?recursive=1`,
    token
  );
  if (tree?.truncated === true) throw new Error('GitHub repository tree is truncated; narrow the source to a subdirectory or ref.');
  if (!Array.isArray(tree?.tree) || tree.tree.length > MAX_TREE_ENTRIES) {
    throw new Error('GitHub repository tree is too large for a safe workspace snapshot; narrow the source to a subdirectory or ref.');
  }
  const files = [];
  let total = 0;
  for (const entry of tree?.tree ?? []) {
    if (entry?.type !== 'blob') continue;
    const path = safePath(entry.path);
    if (!path || !isUsefulSourcePath(path)) continue;
    const size = Number(entry.size) || 0;
    if (size > MAX_FILE_BYTES || total + size > maxBytes) continue;
    const blob = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(entry.sha)}`,
      token
    );
    if (blob?.encoding !== 'base64') continue;
    let content;
    try {
      const bytesValue = Buffer.from(String(blob.content ?? '').replaceAll('\\n', ''), 'base64');
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytesValue);
    } catch {
      throw new Error('GitHub source contains invalid UTF-8 data: ' + path);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES || total + bytes > maxBytes) continue;
    files.push({ path, content });
    total += bytes;
    if (files.length >= MAX_FILES) break;
  }
  return {
    source: { owner, repo, ref: resolvedRef, defaultBranch: root.default_branch, private: root.private === true, url: root.html_url, commitSha: revision.sha, treeSha: revision.treeSha },
    files: normalizeSourceFiles(files)
  };
}


export async function githubResolveRevision({ fetchImpl = fetch, token, owner, repo, ref } = {}) {
  assertGitHubRepo(owner, repo);
  const name = text(ref);
  if (!name) throw new Error('GitHub ref is required');
  const commit = await githubJson(
    fetchImpl,
    'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/commits/' + encodeURIComponent(name),
    token
  );
  return {
    ref: name,
    sha: text(commit?.sha) || null,
    treeSha: text(commit?.commit?.tree?.sha) || null
  };
}

export async function githubApplyChanges({
  fetchImpl = fetch, token, owner, repo, ref, expectedCommitSha, changes = [], message = 'workspace: apply changes'
} = {}) {
  assertGitHubRepo(owner, repo);
  const revision = await githubResolveRevision({ fetchImpl, token, owner, repo, ref });
  if (text(expectedCommitSha) && revision.sha !== text(expectedCommitSha)) {
    const error = new Error('GitHub branch changed since this workspace revision was loaded.');
    error.code = 'stale-github-revision';
    throw error;
  }
  if (!revision.sha || !revision.treeSha) throw new Error('GitHub repository revision could not be resolved');
  const list = Array.isArray(changes) ? changes : [];
  if (list.length > 500) throw new Error('Too many GitHub changes in one operation');
  const elements = [];
  const seenPaths = new Set();
  for (const change of list) {
    const path = safePath(change?.path);
    if (!path) throw new Error('GitHub change path is invalid');
    if (seenPaths.has(path)) throw new Error('GitHub change set contains duplicate paths: ' + path);
    seenPaths.add(path);
    if (change?.kind && change.kind !== 'delete' && change.kind !== 'upsert') {
      throw new Error('GitHub write-back accepts only full-file upserts and deletes.');
    }
    if (change?.kind === 'delete' || change?.delete === true) {
      elements.push({ path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const content = String(change?.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('GitHub changed file is too large: ' + path);
    if (text(change?.beforeDigest)) {
      const expected = text(change.beforeDigest);
      if (!/^[0-9a-f]{64}$/i.test(expected)) throw new Error('GitHub pre-image digest is invalid: ' + path);
    }
    const blob = await githubJson(
      fetchImpl,
      'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/git/blobs',
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, encoding: 'utf-8' })
      }
    );
    if (!text(blob?.sha)) throw new Error('GitHub did not return a blob for ' + path);
    elements.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  if (!elements.length) return { unchanged: true, commitSha: revision.sha, ref: revision.ref };

  // The workspace snapshot may intentionally omit generated, binary, or
  // over-budget files. Never let a later write silently turn one of those
  // existing upstream files into a "new" file. Resolve the exact immutable
  // tree again and require an explicit pre-image for every existing path.
  const currentTree = await githubJson(
    fetchImpl,
    'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/git/trees/' + encodeURIComponent(revision.sha) + '?recursive=1',
    token
  );
  if (currentTree?.truncated === true || !Array.isArray(currentTree?.tree) || currentTree.tree.length > MAX_TREE_ENTRIES) {
    throw new Error('GitHub repository tree is too large for a safe workspace write; narrow the source to a smaller repository or ref.');
  }
  const upstreamPaths = new Set(
    currentTree.tree
      .filter(entry => entry?.type === 'blob')
      .map(entry => safePath(entry.path))
      .filter(Boolean)
  );
  for (const change of list) {
    const path = safePath(change?.path);
    if (!path || !upstreamPaths.has(path)) continue;
    if (!text(change?.beforeDigest)) {
      const error = new Error('An explicit pre-image digest is required before overwriting an existing GitHub file: ' + path);
      error.code = 'github-preimage-required';
      throw error;
    }
  }

  const tree = await githubJson(
    fetchImpl,
    'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/git/trees',
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_tree: revision.treeSha, tree: elements })
    }
  );
  const commit = await githubJson(
    fetchImpl,
    'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/git/commits',
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text(message) || 'workspace: apply changes', tree: tree.sha, parents: [revision.sha] })
    }
  );
  const newSha = text(commit?.sha);
  if (!newSha) throw new Error('GitHub did not return the new commit SHA');
  await githubJson(
    fetchImpl,
    'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/git/refs/heads/' + encodeURIComponent(revision.ref),
    token,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha: newSha, force: false })
    }
  );
  return { unchanged: false, commitSha: newSha, treeSha: text(tree?.sha) || null, parentSha: revision.sha, ref: revision.ref, changedFiles: list.map(item => safePath(item?.path)).filter(Boolean) };
}

export async function githubWriteFile({
  fetchImpl = fetch, token, owner, repo, path, content, ref = null, message
} = {}) {
  assertGitHubRepo(owner, repo);
  const safe = safePath(path);
  if (!safe) throw new Error('GitHub file path is invalid');
  const encodedPath = safe.split('/').map(encodeURIComponent).join('/');
  const branch = text(ref) || 'main';
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  let sha = null;
  try {
    const existing = await githubJson(fetchImpl, `${base}?ref=${encodeURIComponent(branch)}`, token);
    sha = text(existing?.sha) || null;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const payload = {
    message: text(message) || `workspace: update ${safe}`,
    content: Buffer.from(String(content ?? ''), 'utf8').toString('base64'),
    branch
  };
  if (sha) payload.sha = sha;
  return githubJson(fetchImpl, base, token, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

export async function githubDeleteFile({
  fetchImpl = fetch, token, owner, repo, path, ref = null, message
} = {}) {
  assertGitHubRepo(owner, repo);
  const safe = safePath(path);
  if (!safe) throw new Error('GitHub file path is invalid');
  const branch = text(ref) || 'main';
  const encodedPath = safe.split('/').map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  const existing = await githubJson(fetchImpl, `${base}?ref=${encodeURIComponent(branch)}`, token);
  return githubJson(fetchImpl, base, token, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: text(message) || `workspace: delete ${safe}`,
      sha: existing.sha,
      branch
    })
  });
}

export function encryptSourceCredentials(key, token) {
  if (!key) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for source credentials');
  return encryptJson(key, 'workspace-source-credentials-v1', { token: text(token) });
}

export function decryptSourceCredentials(key, encrypted) {
  if (!key || !encrypted) return null;
  const raw = decryptField(key, 'workspace-source-credentials-v1', encrypted);
  try {
    return text(JSON.parse(raw)?.token) || null;
  } catch {
    return null;
  }
}

export function sourcePublic(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    providerKey: row.provider_key ?? null,
    repoOwner: row.repo_owner ?? null,
    repoName: row.repo_name ?? null,
    repoRef: row.repo_ref ?? null,
    snapshotObjectId: row.snapshot_object_id ?? null,
    permissions: row.permissions ?? {},
    metadata: row.metadata ?? {},
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createSourceId() {
  return crypto.randomUUID();
}

export function assertSourceId(value) {
  const id = text(value);
  if (!SOURCE_ID.test(id)) throw new Error('Invalid workspace source id');
  return id;
}
