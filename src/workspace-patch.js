/**
 * Revision-safe, surgical workspace changes.
 *
 * A patch names the exact base revision/content it was produced from.
 * Existing files can be changed by line range with an expected pre-image
 * hash; stale patches are rejected instead of silently overwriting newer work.
 */
import crypto from 'node:crypto';
import { normalizeWorkspaceFiles, safeWorkspacePath, WORKSPACE_LIMITS } from './code-workspace.js';

const text = value => String(value ?? '');
const sha256 = value => crypto.createHash('sha256').update(text(value), 'utf8').digest('hex');

const WRITE_BLOCKED_PATH = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|\.npmrc|\.netrc|\.pypirc|id_rsa(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/i;

export function contentDigest(content) {
  return sha256(content);
}

export function changeSetDigest(changes = []) {
  const normalized = (Array.isArray(changes) ? changes : []).map(change => ({
    path: safeWorkspacePath(change?.path),
    kind: change?.kind === 'delete' || change?.delete === true ? 'delete' : change?.kind === 'range' ? 'range' : 'upsert',
    beforeDigest: text(change?.beforeDigest) || null,
    afterDigest: change?.content == null ? null : contentDigest(change.content)
  })).filter(item => item.path).sort((a,b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return sha256(JSON.stringify(normalized));
}

function assertExpectedBase(files, expectedContentHash) {
  if (!expectedContentHash) return;
  const current = sha256(normalizeWorkspaceFiles(files).map(file => file.path + '\0' + file.content + '\0').join(''));
  if (current !== expectedContentHash) {
    const error = new Error('Workspace changed since this patch was prepared.');
    error.code = 'stale-workspace';
    throw error;
  }
}

export function normalizeChangeSet(changes = []) {
  const list = Array.isArray(changes) ? changes : [];
  if (list.length > WORKSPACE_LIMITS.maxChangedFiles) throw new Error('Workspace change-set is too large');
  const seen = new Set();
  return list.map(change => {
    const path = safeWorkspacePath(change?.path);
    if (!path) throw new Error('Workspace change-set contains an invalid path');
    if (WRITE_BLOCKED_PATH.test(path)) throw new Error('Workspace changes may not write credential or private-key files');
    const kind = change?.kind === 'delete' || change?.delete === true
      ? 'delete'
      : change?.kind === 'range'
        ? 'range'
        : 'upsert';
    if (kind !== 'range' && seen.has(path)) throw new Error('Workspace change-set contains duplicate path: ' + path);
    if (kind !== 'range') seen.add(path);
    if (kind === 'upsert') {
      const content = String(change?.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > WORKSPACE_LIMITS.maxFileBytes) throw new Error('Changed file is too large: ' + path);
      return { path, kind, content, beforeDigest: text(change?.beforeDigest) || null };
    }
    if (kind === 'delete') return { path, kind, beforeDigest: text(change?.beforeDigest) || null };
    const startLine = Number(change?.startLine);
    const endLine = Number(change?.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new Error('Invalid range for ' + path);
    }
    return {
      path, kind, startLine, endLine,
      expectedDigest: text(change?.expectedDigest),
      replacement: String(change?.replacement ?? '')
    };
  });
}

export function applySurgicalChanges(files = [], changes = [], { expectedContentHash = null } = {}) {
  const base = normalizeWorkspaceFiles(files);
  assertExpectedBase(base, expectedContentHash);
  const map = new Map(base.map(file => [file.path, file.content]));
  const normalized = normalizeChangeSet(changes);
  const grouped = new Map();

  for (const change of normalized) {
    if (change.kind === 'range') {
      const current = map.get(change.path);
      if (current === undefined) throw new Error('Cannot patch missing file: ' + change.path);
      if (change.expectedDigest && contentDigest(current) !== change.expectedDigest) {
        const error = new Error('Patch pre-image changed: ' + change.path);
        error.code = 'stale-file';
        throw error;
      }
      const list = grouped.get(change.path) ?? [];
      list.push(change);
      grouped.set(change.path, list);
      continue;
    }
    if (change.beforeDigest && map.has(change.path) && contentDigest(map.get(change.path)) !== change.beforeDigest) {
      const error = new Error('Patch pre-image changed: ' + change.path);
      error.code = 'stale-file';
      throw error;
    }
    if (change.kind === 'delete') map.delete(change.path);
    else map.set(change.path, change.content);
  }

  for (const [path, ranges] of grouped) {
    let content = map.get(path);
    const source = content.split(/\r?\n/);
    const ordered = [...ranges].sort((a,b) => b.startLine - a.startLine || b.endLine - a.endLine);
    let previousStart = Infinity;
    for (const patch of ordered) {
      if (patch.endLine >= previousStart) throw new Error('Overlapping patch ranges in ' + path);
      previousStart = patch.startLine;
      source.splice(patch.startLine - 1, patch.endLine - patch.startLine + 1, ...patch.replacement.split(/\r?\n/));
    }
    content = source.join('\n');
    if (Buffer.byteLength(content, 'utf8') > WORKSPACE_LIMITS.maxFileBytes) throw new Error('Patched file is too large: ' + path);
    map.set(path, content);
  }

  const result = normalizeWorkspaceFiles([...map].map(([path, content]) => ({ path, content })));
  return {
    files: result,
    changed: normalized.map(change => change.path).filter((path, index, list) => list.indexOf(path) === index),
    digest: changeSetDigest(normalized)
  };
}
