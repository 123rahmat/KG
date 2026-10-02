/**
 * Mature project workspace primitives.
 *
 * The workspace is the source of truth for code work: revisions are immutable,
 * changes are explicit, paths are normalized, and task context is selected
 * from the smallest useful set of files. This module is deliberately pure so
 * it can be used by HTTP routes, background workers and tests without giving
 * the model direct ownership of project state.
 */
import crypto from 'node:crypto';
import { workspacePath } from './workspace-path.js';

const text = value => String(value ?? '').trim();

export function safeWorkspacePath(value) {
  const raw = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return workspacePath(raw);
}

const CONVERSATION_ID = /^[A-Za-z0-9-]{8,64}$/;

export const CODE_WORKSPACE_MAX_AGENTS = 11;

export function createWorkspaceChatContext({
  conversationId = null,
  multiAgentMode = 'auto',
  maxAgents = CODE_WORKSPACE_MAX_AGENTS
} = {}) {
  const id = text(conversationId);
  if (id && !CONVERSATION_ID.test(id)) {
    throw new Error('Workspace chat conversationId must be 8-64 letters, digits or dashes');
  }
  const mode = ['auto', 'always', 'off'].includes(text(multiAgentMode)) ? text(multiAgentMode) : 'auto';
  const limit = Math.max(1, Math.min(CODE_WORKSPACE_MAX_AGENTS, Number(maxAgents) || CODE_WORKSPACE_MAX_AGENTS));
  return Object.freeze({
    conversationId: id || null,
    memory: {
      scope: id ? 'conversation' : 'unavailable',
      alwaysOn: Boolean(id),
      crossChat: 'user-controlled',
      note: 'Chat-local memory is isolated to this conversation; cross-chat recall never happens implicitly.'
    },
    multiAgent: {
      mode,
      maxAgents: limit,
      adaptive: true,
      serverOrchestrated: true,
      advisoryOnly: true
    }
  });
}


export const WORKSPACE_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxChangedFiles: 500,
  maxContextFiles: 40,
  maxContextBytes: 80_000
});


export function normalizeWorkspaceFiles(files = [], limits = WORKSPACE_LIMITS) {
  const source = Array.isArray(files) ? files : Object.entries(files ?? {}).map(([path, content]) => ({ path, content }));
  const map = new Map();
  let totalBytes = 0;
  for (const item of source) {
    const path = safeWorkspacePath(item?.path ?? item?.name);
    if (!path) continue;
    const content = String(item?.content ?? item?.text ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > limits.maxFileBytes) throw new Error(`Workspace file exceeds ${limits.maxFileBytes} bytes: ${path}`);
    const previous = map.get(path);
    if (previous !== undefined) totalBytes -= Buffer.byteLength(previous, 'utf8');
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) throw new Error('Workspace exceeds its total file-size limit');
    map.set(path, content);
    if (map.size > limits.maxFiles) throw new Error('Workspace exceeds its file-count limit');
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
}

export function workspaceContentHash(files = []) {
  const normalized = normalizeWorkspaceFiles(files);
  const hash = crypto.createHash('sha256');
  for (const file of normalized) {
    hash.update(file.path, 'utf8').update('\0', 'utf8').update(file.content, 'utf8').update('\0', 'utf8');
  }
  return hash.digest('hex');
}

export function workspaceRevision({ projectId, parentRevisionId = null, files = [], author = 'system', message = '' } = {}) {
  const normalized = normalizeWorkspaceFiles(files);
  const contentHash = workspaceContentHash(normalized);
  const revisionId = crypto.createHash('sha256')
    .update(text(projectId)).update('\0')
    .update(text(parentRevisionId)).update('\0')
    .update(contentHash).update('\0')
    .update(text(author)).update('\0')
    .update(text(message)).digest('hex').slice(0, 32);
  return Object.freeze({
    id: revisionId,
    projectId: text(projectId) || null,
    parentRevisionId: text(parentRevisionId) || null,
    contentHash,
    fileCount: normalized.length,
    author: text(author) || 'system',
    message: text(message),
    files: normalized
  });
}

export function workspaceDiff(before = [], after = []) {
  const left = new Map(normalizeWorkspaceFiles(before).map(file => [file.path, file.content]));
  const right = new Map(normalizeWorkspaceFiles(after).map(file => [file.path, file.content]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  for (const path of paths) {
    if (!left.has(path)) changes.push({ path, kind: 'added', before: null, after: right.get(path) });
    else if (!right.has(path)) changes.push({ path, kind: 'deleted', before: left.get(path), after: null });
    else if (left.get(path) !== right.get(path)) changes.push({ path, kind: 'modified', before: left.get(path), after: right.get(path) });
  }
  return changes;
}

export function applyWorkspacePatch(files = [], patch = []) {
  const map = new Map(normalizeWorkspaceFiles(files).map(file => [file.path, file.content]));
  const changes = Array.isArray(patch) ? patch : [];
  if (changes.length > WORKSPACE_LIMITS.maxChangedFiles) throw new Error('Workspace patch is too large');
  for (const change of changes) {
    const path = safeWorkspacePath(change?.path);
    if (!path) throw new Error('Workspace patch contains an invalid path');
    if (change.kind === 'deleted' || change.delete === true) map.delete(path);
    else map.set(path, String(change.after ?? change.content ?? ''));
  }
  return normalizeWorkspaceFiles([...map].map(([path, content]) => ({ path, content })));
}

const CODE = /\.(?:c|cc|cpp|cxx|h|hpp|hh|cs|go|java|js|jsx|ts|tsx|mjs|cjs|py|rs|rb|php|swift|kt|kts|sql|sh|html|css|json|toml|ya?ml)$/i;
const TEST = /(^|\/)(test[^/]*|[^/]*_test|[^/]*\.test|[^/]*\.spec)\.[^.]+$/i;
const CONFIG = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(?:\.kts)?|tsconfig\.json|vite\.config\.[^/]+)$/i;

export function classifyWorkspaceFile(path) {
  const name = text(path);
  if (TEST.test(name)) return 'test';
  if (CONFIG.test(name)) return 'config';
  if (CODE.test(name)) return 'code';
  return 'asset';
}

/** Return the minimum useful context for a task without changing project state. */
export function selectWorkspaceContext(files = [], { changedPaths = [], query = '', maxFiles = WORKSPACE_LIMITS.maxContextFiles, maxBytes = WORKSPACE_LIMITS.maxContextBytes } = {}) {
  const normalized = normalizeWorkspaceFiles(files);
  const changed = new Set(changedPaths.map(safeWorkspacePath).filter(Boolean));
  const needle = text(query).toLowerCase();
  const scored = normalized.map(file => {
    const lower = file.path.toLowerCase();
    let score = 0;
    if (changed.has(file.path)) score += 1000;
    if (needle && lower.includes(needle)) score += 500;
    if (TEST.test(file.path)) score += 100;
    if (CONFIG.test(file.path)) score += 80;
    if (CODE.test(file.path)) score += 50;
    if (file.path.split('/').length <= 2) score += 10;
    return { ...file, score };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const utf8Prefix = (value, limit) => {
    const raw = Buffer.from(String(value ?? ''), 'utf8');
    if (raw.byteLength <= limit) return raw.toString('utf8');
    let end = Math.max(0, Number(limit) || 0);
    while (end > 0 && (raw[end] & 0b11000000) === 0b10000000) end -= 1;
    return raw.subarray(0, end).toString('utf8');
  };
  const selected = [];
  let bytes = 0;
  for (const file of scored) {
    if (selected.length >= maxFiles) break;
    const size = Buffer.byteLength(file.content, 'utf8');
    const remaining = Math.max(0, maxBytes - bytes);
    if (!remaining) break;
    if (size > remaining) {
      if (!selected.length) {
        const content = utf8Prefix(file.content, remaining);
        if (!content) break;
        selected.push({ ...file, content });
        bytes += Buffer.byteLength(content, 'utf8');
      }
      continue;
    }
    selected.push(file);
    bytes += size;
  }
  return selected.map(({ score, ...file }) => file);
}

/** Explain what a proposed change affects so the workflow can choose checks. */
export function workspaceImpact(before = [], after = []) {
  const changes = workspaceDiff(before, after);
  const paths = changes.map(change => change.path);
  const testsChanged = paths.some(path => classifyWorkspaceFile(path) === 'test');
  const configChanged = paths.some(path => classifyWorkspaceFile(path) === 'config');
  const codeChanged = paths.some(path => classifyWorkspaceFile(path) === 'code');
  return {
    changes,
    changedFiles: paths,
    counts: {
      added: changes.filter(c => c.kind === 'added').length,
      modified: changes.filter(c => c.kind === 'modified').length,
      deleted: changes.filter(c => c.kind === 'deleted').length
    },
    codeChanged,
    testsChanged,
    configChanged,
    requiresTargetedTests: codeChanged || testsChanged || configChanged,
    requiresFullVerification: configChanged || changes.some(c => c.kind === 'deleted')
  };
}

export function createWorkspaceState({ projectId, revisionId = null, files = [], task = null } = {}) {
  const normalized = normalizeWorkspaceFiles(files);
  return Object.freeze({
    projectId: text(projectId) || null,
    revisionId: text(revisionId) || null,
    contentHash: workspaceContentHash(normalized),
    fileCount: normalized.length,
    task: task && typeof task === 'object' ? { id: text(task.id) || null, title: text(task.title) || null } : null,
    clean: true
  });
}
