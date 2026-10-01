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

export async function openLocalFolder() {
  if (!window.showDirectoryPicker) {
    notify('runNotice', 'warn', 'This browser does not support direct folder access. Use the normal file attachment flow instead.');
    return null;
  }
  try {
    localDirectory = await window.showDirectoryPicker({ mode: 'readwrite' });
    const files = await folderFiles();
    const result = await api('POST', '/api/workspace/sources/local', {
      name: sourceName(),
      files,
      write: true
    });
    state.workspaceSourceId = result.source.id;
    state.workspaceSource = result.source;
    notify('runNotice', 'info', `Connected ${sourceName()} · ${result.manifest.fileCount} files`);
    return result.source;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    notify('runNotice', 'warn', error.message || 'The local folder could not be opened.');
    return null;
  }
}

export async function syncLocalFolder() {
  if (!localDirectory || !state.workspaceSourceId) return null;
  const files = await folderFiles();
  const result = await api('POST', `/api/workspace/sources/local/${encodeURIComponent(state.workspaceSourceId)}/sync`, { files });
  state.workspaceSource = result.source;
  return result;
}

export async function connectGitHub() {
  const token = window.prompt('Paste a GitHub fine-grained token for this workspace. It is sent over HTTPS and stored encrypted; it is never placed in chat memory.');
  if (!token) return null;
  const owner = window.prompt('GitHub owner or organization name');
  const repo = window.prompt('GitHub repository name');
  if (!owner || !repo) return null;
  const ref = window.prompt('Branch or tag (optional; default branch will be used if blank)') || '';
  try {
    const result = await api('POST', '/api/workspace/sources/github', {
      token,
      owner,
      repo,
      ref,
      write: false
    });
    state.workspaceSourceId = result.source.id;
    state.workspaceSource = result.source;
    notify('runNotice', 'info', `Connected GitHub repository ${owner}/${repo}`);
    return result.source;
  } catch (error) {
    notify('runNotice', 'warn', error.message || 'GitHub could not be connected.');
    return null;
  }
}

export async function syncActiveWorkspaceSource() {
  if (!state.workspaceSourceId) return null;
  if (state.workspaceSource?.kind === 'local-folder') return syncLocalFolder();
  return api('POST', `/api/workspace/sources/${encodeURIComponent(state.workspaceSourceId)}/sync`)
    .then(result => {
      state.workspaceSource = result.source;
      return result;
    });
}

export async function initWorkspaceSources() {
  const local = $('openLocalFolder');
  const github = $('connectGithub');
  const sync = $('syncWorkspaceSource');
  local?.addEventListener('click', () => openLocalFolder());
  github?.addEventListener('click', () => connectGitHub());
  sync?.addEventListener('click', async () => {
    try {
      const result = await syncActiveWorkspaceSource();
      if (result) notify('runNotice', 'info', result.unchanged ? 'Workspace source is already up to date.' : 'Workspace source synchronized.');
    } catch (error) {
      notify('runNotice', 'warn', error.message || 'Workspace source synchronization failed.');
    }
  });
}
