import { state, $, api, notify } from './ui-core.js';

function updateSourceUI() {
  const sync = $('syncWorkspaceSource');
  const status = $('workspaceSourceStatus');
  const source = state.workspaceSource;
  if (sync) { sync.hidden = !source; sync.textContent = 'Sync GitHub'; }
  if (status) {
    const base = source ? `GitHub · ${source.name || 'GitHub repository'}` : 'Connect a GitHub repository to start project work';
    const ingestion = source?.metadata?.ingestion;
    status.textContent = ingestion?.partial
      ? `${base} · incomplete (${Number(ingestion.skippedCount) || 0} files omitted)`
      : base;
  }
}

export async function loadGithubRepositories() {
  const token = $('githubToken')?.value.trim();
  const status = $('githubLoadStatus');
  const repository = $('githubRepository');
  const branch = $('githubBranch');
  if (!token) { notify('projectSourcesNotice', 'warn', 'Enter your GitHub access token first.'); return []; }
  try {
    if (status) status.textContent = 'Loading repositories…';
    const result = await api('POST', '/api/workspace/sources/github/repositories', { token });
    const repos = Array.isArray(result.repositories) ? result.repositories : [];
    const options = [Object.assign(document.createElement('option'), { value: '', textContent: repos.length ? 'Choose repository' : 'No repositories available' })];
    for (const repo of repos) {
      const option = document.createElement('option');
      option.value = repo.fullName;
      option.textContent = `${repo.fullName}${repo.private ? ' · private' : ''}`;
      option.dataset.owner = repo.owner; option.dataset.name = repo.name; option.dataset.defaultBranch = repo.defaultBranch;
      options.push(option);
    }
    repository?.replaceChildren(...options);
    if (repository) repository.disabled = repos.length === 0;
    if (status) status.textContent = repos.length ? `${repos.length} repositories found` : 'No accessible repositories found';
    branch?.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Choose repository first' }));
    if (branch) branch.disabled = true;
    const connect = $('connectGithub'); if (connect) connect.disabled = true;
    return repos;
  } catch (error) {
    if (status) status.textContent = '';
    notify('projectSourcesNotice', 'warn', error.message || 'Couldn’t load your GitHub repositories. Check access and try again.');
    return [];
  }
}

export async function loadGithubBranches() {
  const token = $('githubToken')?.value.trim();
  const selected = $('githubRepository')?.selectedOptions?.[0];
  const branch = $('githubBranch');
  const connect = $('connectGithub');
  if (!token || !selected?.dataset?.owner || !selected?.dataset?.name) {
    branch?.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'Select a repository first' }));
    if (branch) branch.disabled = true; if (connect) connect.disabled = true; return;
  }
  try {
    const result = await api('POST', '/api/workspace/sources/github/branches', { token, owner: selected.dataset.owner, repo: selected.dataset.name });
    const branches = Array.isArray(result.branches) ? result.branches : [];
    branch?.replaceChildren(
      Object.assign(document.createElement('option'), { value: '', textContent: branches.length ? 'Choose branch or tag' : 'No branches found' }),
      ...branches.map(item => Object.assign(document.createElement('option'), { value: item.name, textContent: `${item.name}${item.protected ? ' · protected' : ''}` }))
    );
    if (branch) branch.disabled = branches.length === 0;
    if (selected.dataset.defaultBranch && branches.some(item => item.name === selected.dataset.defaultBranch)) branch.value = selected.dataset.defaultBranch;
    if (connect) connect.disabled = !branch?.value;
  } catch (error) { notify('projectSourcesNotice', 'warn', error.message || 'Couldn’t load branches for this repository. Check access and try again.'); }
}

export async function connectGitHub() {
  const token = $('githubToken')?.value.trim();
  const selected = $('githubRepository')?.selectedOptions?.[0];
  const ref = $('githubBranch')?.value.trim() || '';
  const repoPath = $('githubRepoPath')?.value.trim() || '';
  const owner = selected?.dataset?.owner || ''; const repo = selected?.dataset?.name || '';
  if (!token || !owner || !repo || !ref) { notify('projectSourcesNotice', 'warn', 'Choose a GitHub repository and branch first.'); return null; }
  try {
    const button = $('connectGithub'); if (button) button.disabled = true;
    const result = await api('POST', '/api/workspace/sources/github', { token, owner, repo, ref, repoPath, write: $('githubWriteAccess')?.checked === true });
    state.workspaceSourceId = result.source.id; state.workspaceSource = result.source;
    if (state.chat) state.chat.workspaceSourceId = result.source.id;
    if ($('githubToken')) $('githubToken').value = '';
    updateSourceUI(); $('projectSourcesDialog')?.close();
    notify('runNotice', 'info', `Connected GitHub repository ${owner}/${repo} · ${ref}`);
    return result.source;
  } catch (error) {
    notify('projectSourcesNotice', 'warn', error.message || 'Couldn’t connect to GitHub. Check access and try again.'); return null;
  } finally { const button = $('connectGithub'); if (button) button.disabled = false; }
}

export async function syncActiveWorkspaceSource() {
  const sourceId = state.chat?.workspaceSourceId ?? state.workspaceSourceId;
  if (!sourceId) return null;
  if (state.workspaceSource?.kind !== 'github') {
    state.workspaceSource = null; state.workspaceSourceId = null;
    if (state.chat) state.chat.workspaceSourceId = null;
    updateSourceUI(); return null;
  }
  return api('POST', `/api/workspace/sources/${encodeURIComponent(sourceId)}/sync`).then(result => {
    state.workspaceSource = result.source; updateSourceUI(); return result;
  });
}

export async function initWorkspaceSources() {
  updateSourceUI();
  const dialog = $('projectSourcesDialog'); const open = $('openProjectSources'); const close = $('projectSourcesClose');
  const github = $('connectGithub'); const sync = $('syncWorkspaceSource'); const repoButton = $('loadGithubRepositories');
  const repoSelect = $('githubRepository'); const branchSelect = $('githubBranch');
  open?.addEventListener('click', () => dialog?.showModal()); close?.addEventListener('click', () => dialog?.close());
  repoButton?.addEventListener('click', () => loadGithubRepositories()); repoSelect?.addEventListener('change', () => loadGithubBranches());
  branchSelect?.addEventListener('change', () => { if (github) github.disabled = !branchSelect.value; });
  github?.addEventListener('click', () => connectGitHub());
  sync?.addEventListener('click', async () => {
    try { const result = await syncActiveWorkspaceSource(); if (result) notify('projectSourcesNotice', 'info', result.unchanged ? 'GitHub repository is already up to date.' : 'GitHub repository synchronized.'); }
    catch (error) { notify('projectSourcesNotice', 'warn', error.message || 'Couldn’t refresh the GitHub project. Check access and try again.'); }
  });
}
