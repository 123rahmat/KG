import { state, $, api, notify } from './ui-core.js';

let localDirectory = null;

const EXCLUDED = new Set(['.git', 'node_modules', '.next', '.cache', 'dist', 'build', 'coverage']);
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

async function readDirectory(handle, prefix = '', files = [], totals = { bytes: 0 }) {
  for await (const [name, entry] of handle.entries()) {
    if (EXCLUDED.has(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      await readDirectory(entry, path, files, totals);
      continue;
    }
    if (entry.kind !== 'file') continue;
    const file = await entry.getFile();
    if (totals.bytes + file.size > MAX_TOTAL_BYTES) throw new Error('The selected folder is larger than the workspace source limit.');
    if (files.length >= MAX_FILES) throw new Error('The selected folder contains too many files.');
    const content = await file.text();
    files.push({ path, content });
    totals.bytes += file.size;
  }
  return files;
}

async function folderFiles() {
  if (!localDirectory) return [];
  return readDirectory(localDirectory);
}

function sourceName() {
  return localDirectory?.name || 'Local folder';
}

function updateSourceUI() {
  const sync = $('syncWorkspaceSource');
  const status = $('workspaceSourceStatus');
  const source = state.workspaceSource;
  if (sync) {
    sync.hidden = !source;
    sync.textContent = source?.kind === 'github' ? 'Sync GitHub' : 'Sync folder';
  }
  if (status) status.textContent = source
    ? `${source.kind === 'github' ? 'GitHub' : 'Local'} · ${source.name || 'Project source'}`
    : 'No project connected';
  renderPanelState();
}

function renderPanelState() {
  const source = state.workspaceSource;
  const localMeta = $('localFolderMeta');
  const localSync = $('syncLocalFolderFromPanel');
  if (localMeta) localMeta.textContent = localDirectory
    ? `${source?.kind === 'local-folder' ? source.name : localDirectory.name} · connected`
    : 'No folder selected';
  if (localSync) localSync.hidden = !localDirectory || source?.kind !== 'local-folder';
}

export async function openLocalFolder() {
  if (!window.showDirectoryPicker) {
    notify('projectSourcesNotice', 'warn', 'This browser does not support direct folder access. Use the file attachment flow instead.');
    return null;
  }
  try {
    localDirectory = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'desktop' });
    const files = await folderFiles();
    const result = await api('POST', '/api/workspace/sources/local', {
      name: sourceName(),
      files,
      write: true
    });
    state.workspaceSourceId = result.source.id;
    state.workspaceSource = result.source;
    if (state.chat) state.chat.workspaceSourceId = result.source.id;
    updateSourceUI();
    renderPanelState();
    notify('projectSourcesNotice', 'info', `Connected ${sourceName()} · ${result.manifest.fileCount} files`);
    return result.source;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    notify('projectSourcesNotice', 'warn', error.message || 'The local folder could not be opened.');
    return null;
  }
}

export async function syncLocalFolder() {
  const sourceId = state.chat?.workspaceSourceId ?? state.workspaceSourceId;
  if (!localDirectory || !sourceId) return null;
  const files = await folderFiles();
  const result = await api('POST', `/api/workspace/sources/local/${encodeURIComponent(sourceId)}/sync`, { files });
  state.workspaceSource = result.source;
  return result;
}

export async function connectGitHub() {
  const token = $('githubToken')?.value.trim();
  const owner = $('githubOwner')?.value.trim();
  const repo = $('githubRepo')?.value.trim();
  const ref = $('githubRef')?.value.trim() || '';
  if (!token || !owner || !repo) {
    notify('projectSourcesNotice', 'warn', 'Enter the GitHub credential, owner, and repository.');
    return null;
  }
  try {
    const button = $('connectGithub');
    if (button) button.disabled = true;
    const result = await api('POST', '/api/workspace/sources/github', {
      token,
      owner,
      repo,
      ref,
      write: false
    });
    state.workspaceSourceId = result.source.id;
    state.workspaceSource = result.source;
    if (state.chat) state.chat.workspaceSourceId = result.source.id;
    if ($('githubToken')) $('githubToken').value = '';
    updateSourceUI();
    renderPanelState();
    notify('projectSourcesNotice', 'info', `Connected GitHub repository ${owner}/${repo} · ${result.manifest.fileCount} files`);
    return result.source;
  } catch (error) {
    notify('projectSourcesNotice', 'warn', error.message || 'GitHub could not be connected.');
    return null;
  } finally {
    const button = $('connectGithub');
    if (button) button.disabled = false;
  }
}

export async function syncActiveWorkspaceSource() {
  const sourceId = state.chat?.workspaceSourceId ?? state.workspaceSourceId;
  if (!sourceId) return null;
  if (state.workspaceSource?.kind === 'local-folder') return syncLocalFolder();
  return api('POST', `/api/workspace/sources/${encodeURIComponent(sourceId)}/sync`)
    .then(result => {
      state.workspaceSource = result.source;
      updateSourceUI();
      return result;
    });
}

export async function initWorkspaceSources() {
  updateSourceUI();
  const dialog = $('projectSourcesDialog');
  const open = $('openProjectSources');
  const close = $('projectSourcesClose');
  const local = $('openLocalFolder');
  const github = $('connectGithub');
  const localSync = $('syncLocalFolderFromPanel');
  const sync = $('syncWorkspaceSource');
  open?.addEventListener('click', () => dialog?.showModal());
  close?.addEventListener('click', () => dialog?.close());
  local?.addEventListener('click', () => openLocalFolder());
  github?.addEventListener('click', () => connectGitHub());
  localSync?.addEventListener('click', async () => {
    try {
      const result = await syncLocalFolder();
      if (result) {
        renderPanelState();
        updateSourceUI();
        notify('projectSourcesNotice', 'info', result.unchanged ? 'Local folder is already up to date.' : 'Local folder synchronized.');
      }
    } catch (error) {
      notify('projectSourcesNotice', 'warn', error.message || 'Local folder synchronization failed.');
    }
  });
  sync?.addEventListener('click', async () => {
    try {
      const result = await syncActiveWorkspaceSource();
      if (result) notify('projectSourcesNotice', 'info', result.unchanged ? 'Project source is already up to date.' : 'Project source synchronized.');
    } catch (error) {
      notify('projectSourcesNotice', 'warn', error.message || 'Project source synchronization failed.');
    }
  });
}
