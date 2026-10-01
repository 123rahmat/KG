import { state, $, api, notify } from './ui-core.js';

let localDirectory = null;

const EXCLUDED = new Set(['.git', 'node_modules', '.next', '.cache', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', 'target']);
const SOURCE_EXTENSIONS = new Set(['py','pyi','js','mjs','cjs','jsx','ts','tsx','json','toml','cfg','ini','yaml','yml','md','txt','rst','html','css','scss','sql','sh','c','h','cc','cxx','cpp','hh','hpp','ino','java','kt','kts','gradle','go','mod','sum','rs','lock','rb','php','cs','swift','proto','cmake','csv','xml']);
const SOURCE_NAMES = new Set(['Makefile','Dockerfile','requirements.txt','package.json','pyproject.toml','setup.cfg','README','LICENSE','go.mod','go.sum','Cargo.toml','Cargo.lock','CMakeLists.txt','build.gradle','settings.gradle','pom.xml']);
const MAX_FILES = 250;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

async function contentDigest(content) {
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sourceManifest(files) {
  const entries = [];
  for (const file of files) entries.push({ path: file.path, bytes: new TextEncoder().encode(file.content).byteLength, digest: await contentDigest(file.content) });
  const basis = entries.slice().sort((a, b) => a.path.localeCompare(b.path)).map(item => item.path + '\0' + item.digest + '\0').join('');
  return {
    contentHash: await contentDigest(basis),
    fileCount: entries.length,
    files: entries.sort((a, b) => a.path.localeCompare(b.path))
  };
}

function sourceDelta(previousManifest, nextFiles, nextManifest) {
  const previous = new Map((previousManifest?.files ?? []).map(item => [item.path, item]));
  const changed = [];
  for (const file of nextFiles) {
    const old = previous.get(file.path);
    const current = nextManifest.files.find(item => item.path === file.path);
    if (!old || old.digest !== current.digest) changed.push(file);
  }
  const currentPaths = new Set(nextFiles.map(file => file.path));
  const deletedPaths = [...previous.keys()].filter(path => !currentPaths.has(path));
  return { changedFiles: changed, deletedPaths, manifest: nextManifest };
}

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
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!SOURCE_EXTENSIONS.has(ext) && !SOURCE_NAMES.has(name)) continue;
    if (file.size > MAX_FILE_BYTES || totals.bytes + file.size > MAX_TOTAL_BYTES) continue;
    if (files.length >= MAX_FILES) continue;
    const content = await file.text();
    if (content.includes('\\0')) continue;
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
  const local = $('sourceTabLocal');
  const github = $('sourceTabGithub');
  const localPanel = $('sourcePanelLocal');
  const githubPanel = $('sourcePanelGithub');
  if (source?.kind === 'github') {
    local?.classList.remove('active');
    github?.classList.add('active');
    local?.setAttribute('aria-selected', 'false');
    github?.setAttribute('aria-selected', 'true');
    if (localPanel) localPanel.hidden = true;
    if (githubPanel) githubPanel.hidden = false;
  }
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
    localDirectory = await window.showDirectoryPicker({ mode: 'read', startIn: 'desktop' });
    const files = await folderFiles();
    const result = await api('POST', '/api/workspace/sources/local', {
      name: sourceName(),
      files,
      write: false
    });
    state.workspaceSourceId = result.source.id;
    state.workspaceSource = result.source;
    if (state.chat) state.chat.workspaceSourceId = result.source.id;
    updateSourceUI();
    renderPanelState();
    $('projectSourcesDialog')?.close();
    notify('runNotice', 'info', `Connected ${sourceName()} · ${result.manifest.fileCount} files`);
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
  const nextManifest = await sourceManifest(files);
  const delta = sourceDelta(state.workspaceSource?.metadata?.manifest ? { files: state.workspaceSource.metadata.manifest } : null, files, nextManifest);
  const result = await api('POST', `/api/workspace/sources/local/${encodeURIComponent(sourceId)}/sync`, {
    manifest: nextManifest,
    changedFiles: delta.changedFiles,
    deletedPaths: delta.deletedPaths
  });
  state.workspaceSource = result.source;
  return result;
}

export async function loadGithubRepositories() {
  const token = $('githubToken')?.value.trim();
  const status = $('githubLoadStatus');
  const repository = $('githubRepository');
  const branch = $('githubBranch');
  if (!token) {
    notify('projectSourcesNotice', 'warn', 'Enter your GitHub access token first.');
    return [];
  }
  try {
    if (status) status.textContent = 'Loading repositories…';
    const result = await api('POST', '/api/workspace/sources/github/repositories', { token });
    const repos = Array.isArray(result.repositories) ? result.repositories : [];
    const options = [Object.assign(document.createElement('option'), {
      value: '', textContent: repos.length ? 'Choose repository' : 'No repositories available'
    })];
    for (const repo of repos) {
      const option = document.createElement('option');
      option.value = repo.fullName;
      option.textContent = `${repo.fullName}${repo.private ? ' · private' : ''}`;
      option.dataset.owner = repo.owner;
      option.dataset.name = repo.name;
      option.dataset.defaultBranch = repo.defaultBranch;
      options.push(option);
    }
    repository.replaceChildren(...options);
    repository.disabled = repos.length === 0;
    if (status) status.textContent = repos.length ? `${repos.length} repositories found` : 'No accessible repositories found';
    branch.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Choose repository first' }));
    branch.disabled = true;
    const connect = $('connectGithub');
    if (connect) connect.disabled = true;
    return repos;
  } catch (error) {
    if (status) status.textContent = '';
    notify('projectSourcesNotice', 'warn', error.message || 'GitHub repositories could not be loaded.');
    return [];
  }
}

export async function loadGithubBranches() {
  const token = $('githubToken')?.value.trim();
  const selected = $('githubRepository')?.selectedOptions?.[0];
  const branch = $('githubBranch');
  const connect = $('connectGithub');
  if (!token || !selected?.dataset?.owner || !selected?.dataset?.name) {
    branch.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Select a repository first' }));
    branch.disabled = true;
    if (connect) connect.disabled = true;
    return;
  }
  try {
    const result = await api('POST', '/api/workspace/sources/github/branches', {
      token,
      owner: selected.dataset.owner,
      repo: selected.dataset.name
    });
    const branches = Array.isArray(result.branches) ? result.branches : [];
    branch.replaceChildren(
      Object.assign(document.createElement('option'), { value: '', textContent: branches.length ? 'Choose branch or tag' : 'No branches found' }),
      ...branches.map(item => Object.assign(document.createElement('option'), {
        value: item.name,
        textContent: `${item.name}${item.protected ? ' · protected' : ''}`
      }))
    );
    branch.disabled = branches.length === 0;
    if (selected.dataset.defaultBranch && branches.some(item => item.name === selected.dataset.defaultBranch)) {
      branch.value = selected.dataset.defaultBranch;
    }
    if (connect) connect.disabled = !(branch.value && selected.dataset.name);
  } catch (error) {
    notify('projectSourcesNotice', 'warn', error.message || 'GitHub branches could not be loaded.');
  }
}

export async function connectGitHub() {
  const token = $('githubToken')?.value.trim();
  const selected = $('githubRepository')?.selectedOptions?.[0];
  const ref = $('githubBranch')?.value.trim() || '';
  const owner = selected?.dataset?.owner || '';
  const repo = selected?.dataset?.name || '';
  if (!token || !owner || !repo || !ref) {
    notify('projectSourcesNotice', 'warn', 'Choose a GitHub repository and branch first.');
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
      write: $('githubWriteAccess')?.checked === true
    });
    state.workspaceSourceId = result.source.id;
    state.workspaceSource = result.source;
    if (state.chat) state.chat.workspaceSourceId = result.source.id;
    if ($('githubToken')) $('githubToken').value = '';
    updateSourceUI();
    renderPanelState();
    $('projectSourcesDialog')?.close();
    notify('runNotice', 'info', `Connected GitHub repository ${owner}/${repo} · ${ref}`);
    return result.source;
  } catch (error) {
    notify('projectSourcesNotice', 'warn', error.message || 'GitHub could not be connected.');
    return null;
  } finally {
    const button = $('connectGithub');
    if (button) button.disabled = false;
  }
}

export async function applyLocalWorkspaceChanges(changes = []) {
  if (!localDirectory) throw new Error('Choose the local project folder again before applying changes.');
  const permission = await localDirectory.queryPermission?.({ mode: 'readwrite' });
  if (permission !== 'granted') {
    const requested = await localDirectory.requestPermission?.({ mode: 'readwrite' });
    if (requested !== 'granted') throw new Error('Write permission was not granted for the local folder.');
  }
  const safePath = value => {
    const path = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (!path || path.startsWith('/') || path.includes('..') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid local workspace path.');
    }
    return path;
  };
  const getParent = async path => {
    const parts = path.split('/');
    parts.pop();
    let dir = localDirectory;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    return { dir, name: path.split('/').at(-1) };
  };
  const list = Array.isArray(changes) ? changes : [];
  const descriptors = [];
  for (const change of list) {
    const path = safePath(change?.path);
    const { dir, name } = await getParent(path);
    descriptors.push({ change, path, dir, name });
  }
  for (const { change, path, dir, name } of descriptors) {
    const base = path.split('/').at(-1).toLowerCase();
    if (
      base === '.npmrc' || base === '.netrc' || base === '.pypirc' ||
      /^\.env(?:$|\.)/.test(base) && !/^\.env\.(?:example|sample|template)$/.test(base) ||
      /^id_rsa(?:\.|$)/.test(base) || /\.(?:pem|key|p12|pfx)$/.test(base)
    ) throw new Error('Local write-back may not modify credential or private-key files.');
    if (change?.kind === 'delete' || change?.delete === true) {
      await dir.removeEntry(name).catch(error => {
        if (error?.name !== 'NotFoundError') throw error;
      });
      continue;
    }
    const handle = await dir.getFileHandle(name, { create: true });
    if (change?.beforeDigest) {
      const current = await handle.getFile().catch(() => null);
      if (!current) throw new Error('Local workspace changed before applying ' + path);
      const currentDigest = await contentDigest(await current.text());
      if (currentDigest !== change.beforeDigest) throw new Error('Local file changed before applying ' + path);
    }
    const writable = await handle.createWritable();
    try {
      await writable.write(String(change?.content ?? ''));
    } finally {
      await writable.close();
    }
  }
  const result = await syncLocalFolder();
  notify('runNotice', 'info', result?.unchanged ? 'Local folder already contained these changes.' : 'Changes applied to the local project.');
  return result;
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
  const tabLocal = $('sourceTabLocal');
  const tabGithub = $('sourceTabGithub');
  const localPanel = $('sourcePanelLocal');
  const githubPanel = $('sourcePanelGithub');
  const repoButton = $('loadGithubRepositories');
  const repoSelect = $('githubRepository');
  const branchSelect = $('githubBranch');
  const selectSourceTab = tab => {
    const localActive = tab === 'local';
    tabLocal?.classList.toggle('active', localActive);
    tabGithub?.classList.toggle('active', !localActive);
    tabLocal?.setAttribute('aria-selected', String(localActive));
    tabGithub?.setAttribute('aria-selected', String(!localActive));
    if (localPanel) { localPanel.hidden = !localActive; localPanel.classList.toggle('active', localActive); }
    if (githubPanel) { githubPanel.hidden = localActive; githubPanel.classList.toggle('active', !localActive); }
  };
  open?.addEventListener('click', () => { renderPanelState(); updateSourceUI(); dialog?.showModal(); });
  close?.addEventListener('click', () => dialog?.close());
  tabLocal?.addEventListener('click', () => selectSourceTab('local'));
  tabGithub?.addEventListener('click', () => selectSourceTab('github'));
  local?.addEventListener('click', () => openLocalFolder());
  repoButton?.addEventListener('click', () => loadGithubRepositories());
  repoSelect?.addEventListener('change', () => loadGithubBranches());
  branchSelect?.addEventListener('change', () => {
    const connect = $('connectGithub');
    if (connect) connect.disabled = !branchSelect.value;
  });
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
