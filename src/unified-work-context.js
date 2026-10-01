/**
 * Unified work context.
 *
 * Workflow, files and code are one situation-owned context. The workflow
 * decides what is needed; files are the evidence/artifacts in that context;
 * code is an editable artifact living in the same context. No separate
 * "coding mode" owns project state.
 */

import crypto from 'node:crypto';
import { createWorkspaceState, workspaceContentHash, createWorkspaceChatContext } from './code-workspace.js';

const text = value => String(value ?? '').trim();

const safePath = value => {
  const p = text(value);
  return p && !p.includes('..') && !p.startsWith('/') && !p.startsWith('\\') ? p : null;
};

export function projectIdentity(project = null, attachments = []) {
  const p = project && typeof project === 'object' ? project : {};
  const explicit = text(p.id || p.key || p.root || p.path || p.name);
  const names = (Array.isArray(attachments) ? attachments : [])
    .map(item => text(typeof item === 'string' ? item : item?.name || item?.path))
    .filter(Boolean).sort();
  const basis = explicit || (names.length ? names.join('|') : '');
  const key = basis
    ? crypto.createHash('sha256').update(basis, 'utf8').digest('hex').slice(0, 24)
    : null;
  return {
    key,
    source: explicit ? 'project' : names.length ? 'attachments' : 'none'
  };
}

export function buildUnifiedWorkContext({
  goal = '',
  project = null,
  attachments = [],
  files = [],
  projectOverlay = [],
  situation = null,
  currentState = null,
  identityOverride = null,
  revision = 0,
  lastChange = null,
  conversationId = null,
  multiAgent = null
} = {}) {
  const derivedIdentity = projectIdentity(project, attachments);
  const identity = identityOverride && identityOverride.key
    ? { key: text(identityOverride.key), source: text(identityOverride.source) || 'preserved' }
    : derivedIdentity;
  const attachmentManifest = (Array.isArray(attachments) ? attachments : []).map(item => ({
    id: text(item?.id),
    name: text(item?.name || item?.path),
    format: text(item?.format),
    readable: item?.readable !== false
  })).filter(item => item.name);

  const fileManifest = (Array.isArray(files) ? files : [])
    .map(item => typeof item === 'string'
      ? { path: safePath(item) }
      : { path: safePath(item?.path || item?.name), type: text(item?.type || item?.format) })
    .filter(item => item.path);

  const overlay = (Array.isArray(projectOverlay) ? projectOverlay : [])
    .map(item => ({ path: safePath(item?.path), deleted: item?.content === null }))
    .filter(item => item.path);

  const codePaths = fileManifest.map(item => item.path).filter(path =>
    /\.(?:c|cc|cpp|h|hpp|cs|go|java|js|jsx|ts|tsx|mjs|cjs|py|rs|rb|php|swift|kt|kts|sql|sh|html|css|json|toml|ya?ml)$/i.test(path)
  );

  const workspaceFiles = fileManifest.map(item => ({ path: item.path, content: '' }));
  const projectRevision = text(project?.revisionId || project?.revision || '') || null;
  const workspace = createWorkspaceState({
    projectId: identity.key,
    revisionId: projectRevision,
    files: workspaceFiles,
    task: { id: situation?.phase || null, title: situation?.title || goal }
  });
  const contentHash = workspaceContentHash(workspaceFiles);
  const chat = createWorkspaceChatContext({
    conversationId,
    multiAgentMode: multiAgent?.mode ?? multiAgent?.multiAgent ?? 'auto',
    maxAgents: multiAgent?.maxAgents ?? 5
  });

  return {
    contract: 'kindgleam-unified-work-context-v2',
    unified: true,
    revision: Math.max(0, Number(revision) || 0),
    lastChange: lastChange && typeof lastChange === 'object' ? {
      kind: text(lastChange.kind) || 'material-change',
      files: Array.isArray(lastChange.files) ? lastChange.files.filter(Boolean).slice(0, 50) : [],
      deleted: Array.isArray(lastChange.deleted) ? lastChange.deleted.filter(Boolean).slice(0, 50) : []
    } : null,
    identity: {
      key: identity.key,
      source: identity.source,
      isolated: Boolean(identity.key)
    },
    chat,
    workspace: {
      ...workspace,
      projectName: text(project?.name),
      contentHash,
      dirty: Boolean(lastChange && ((lastChange.files?.length ?? 0) || (lastChange.deleted?.length ?? 0))),
      overlayCount: overlay.length,
      codeFileCount: codePaths.length
    },
    goal: text(goal),
    workflow: {
      ownsContext: true,
      stageAware: true,
      readBeforeWrite: true,
      writeBackAfterChange: true,
      verifyAfterMaterialChange: true,
      replanOnMaterialChange: true
    },
    filesystem: {
      scope: 'active-workspace-and-project',
      attachments: attachmentManifest,
      files: fileManifest,
      overlay: overlay.map(item => item.path),
      deleted: overlay.filter(item => item.deleted).map(item => item.path)
    },
    code: {
      enabled: codePaths.length > 0 || overlay.length > 0 || Boolean(project),
      paths: [...new Set(codePaths)],
      editablePaths: [...new Set([...codePaths, ...overlay.map(item => item.path)])],
      stateSource: 'unified-work-context',
      executionMustUseContext: true
    },
    situation: {
      risk: text(situation?.risk),
      phase: text(situation?.phase),
      successCriteria: Array.isArray(situation?.successCriteria) ? situation.successCriteria.slice(0, 20) : [],
      currentState: currentState ?? situation?.state?.current ?? null
    }
  };
}

export function applyWorkChange(context, { files = [], deleted = [] } = {}) {
  const base = context && typeof context === 'object' ? context : buildUnifiedWorkContext();
  const nextFiles = new Map((base.filesystem?.files ?? []).map(file => [file.path, file]));
  for (const path of (Array.isArray(deleted) ? deleted : [])) {
    const safe = safePath(path);
    if (safe) nextFiles.delete(safe);
  }
  for (const file of (Array.isArray(files) ? files : [])) {
    const path = safePath(file?.path || file?.name);
    if (path) nextFiles.set(path, { path, type: text(file?.type || file?.format) });
  }
  const next = buildUnifiedWorkContext({
    goal: base.goal,
    attachments: base.filesystem?.attachments ?? [],
    files: [...nextFiles.values()],
    projectOverlay: [
      ...(base.filesystem?.overlay ?? [])
        .filter(path => !(base.filesystem?.deleted ?? []).includes(path))
        .map(path => ({ path })),
      ...(base.filesystem?.deleted ?? []).map(path => ({ path, content: null })),
      ...(Array.isArray(deleted) ? deleted.map(path => ({ path, content: null })) : [])
    ],
    situation: base.situation,
    identityOverride: base.identity,
    revision: Number(base.revision ?? 0) + 1,
    lastChange: {
      kind: 'code-or-file-change',
      files: (Array.isArray(files) ? files : []).map(file => safePath(file?.path || file?.name)).filter(Boolean),
      deleted: (Array.isArray(deleted) ? deleted : []).map(safePath).filter(Boolean)
    }
  });
  return next;
}
