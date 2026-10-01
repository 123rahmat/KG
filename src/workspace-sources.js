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

const text = value => String(value ?? '').trim();
const SOURCE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const SAFE_PATH = /^(?![./ -])(?!.*\.\.)(?!.*\/[./ -])(?!.*[ /]$)[\p{L}\p{N}._/ +@-]{1,240}$/u;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_FILES = 250;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export const SOURCE_KINDS = Object.freeze(['local-folder', 'github']);

function safePath(value) {
  const path = text(value).replaceAll('\\', '/').replace(/^\.\//, '');
  return SAFE_PATH.test(path) ? path : null;
}

export function normalizeSourceFiles(files = []) {
  const list = Array.isArray(files) ? files : [];
  const map = new Map();
  let total = 0;
  for (const item of list) {
    const path = safePath(item?.path || item?.name);
    if (!path) continue;
    const content = typeof item?.content === 'string' ? item.content : '';
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`Source file is too large: ${path}`);
    if (!map.has(path)) total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error('Source snapshot is too large');
    map.set(path, content);
    if (map.size > MAX_FILES) throw new Error('Source contains too many files');
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
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
      bytes: Buffer.byteLength(file.content, 'utf8')
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
  const tree = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
    token
  );
  if (tree?.truncated === true) throw new Error('GitHub repository tree is truncated; narrow the source to a subdirectory or ref.');
  const files = [];
  let total = 0;
  for (const entry of tree?.tree ?? []) {
    if (entry?.type !== 'blob') continue;
    const path = safePath(entry.path);
    if (!path) continue;
    const size = Number(entry.size) || 0;
    if (size > MAX_FILE_BYTES || total + size > maxBytes) continue;
    const blob = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(entry.sha)}`,
      token
    );
    if (blob?.encoding !== 'base64') continue;
    const content = Buffer.from(String(blob.content ?? '').replaceAll('\\n', ''), 'base64').toString('utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES || total + bytes > maxBytes) continue;
    files.push({ path, content });
    total += bytes;
    if (files.length >= MAX_FILES) break;
  }
  return {
    source: { owner, repo, ref: resolvedRef, defaultBranch: root.default_branch, private: root.private === true, url: root.html_url },
    files: normalizeSourceFiles(files)
  };
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
