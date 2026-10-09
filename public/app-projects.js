/**
 * Project Hub — human-facing organization for many parallel workstreams.
 *
 * Projects organize chats and workspace activity. They do not own workflow
 * decisions; the server run/project stores remain authoritative.
 */
import { state, $, element, button, api, notify } from './ui-core.js';

const text = value => String(value ?? '').trim();
const SURFACE_LABELS = Object.freeze({
  'normal-chat': 'Chat',
  code: 'Code',
  research: 'Research'
});

function projectById(id) {
  return state.projects.find(project => project.id === id) ?? null;
}

export function renderProjectHub() {
  const select = $('projectSelect');
  const summary = $('projectSummary');
  if (!select || !summary) return;

  const projects = Array.isArray(state.projects) ? state.projects : [];
  const active = projects.filter(project => project.state === 'active');
  const selected = state.activeProjectId && projectById(state.activeProjectId) ? state.activeProjectId : '';
  state.activeProjectId = selected || null;

  select.replaceChildren(
    element('option', { value: '', text: 'All projects' }),
    ...active.map(project => element('option', { value: project.id, text: project.name }))
  );
  select.value = state.activeProjectId ?? '';

  const selectedProject = projectById(state.activeProjectId);
  const activeCount = active.reduce((sum, project) => sum + project.activeRuns, 0);
  summary.textContent = selectedProject
    ? [SURFACE_LABELS[selectedProject.defaultSurface] ?? 'Chat',
       selectedProject.conversations + ' chat' + (selectedProject.conversations === 1 ? '' : 's'),
       selectedProject.activeRuns ? selectedProject.activeRuns + ' active' : 'Ready'].join(' · ')
    : active.length
      ? active.length + ' project' + (active.length === 1 ? '' : 's') + ' · ' +
        activeCount + ' active workstream' + (activeCount === 1 ? '' : 's')
      : 'Keep related chats together without merging their private context.';

  renderProjectManageList();
}

function renderProjectManageList() {
  const list = $('projectManageList');
  if (!list) return;
  const projects = Array.isArray(state.projects) ? state.projects : [];
  list.replaceChildren(...(projects.length
    ? projects.map(project => element('div', { class: 'project-manage-row' }, [
        element('div', { class: 'project-manage-main' }, [
          element('strong', { text: project.name }),
          element('span', { class: 'small muted', text: [
            SURFACE_LABELS[project.defaultSurface] ?? 'Chat',
            project.conversations + ' chat' + (project.conversations === 1 ? '' : 's')
          ].join(' · ') })
        ]),
        project.state === 'archived'
          ? element('span', { class: 'small muted', text: 'Archived' })
          : button('Archive', () => archiveProject(project), 'small')
      ]))
    : [element('div', { class: 'empty small', text: 'No projects yet.' })]));
}

async function archiveProject(project) {
  if (!project?.id) return;
  try {
    await api('POST', '/api/projects/' + encodeURIComponent(project.id) + '/archive', {});
    if (state.activeProjectId === project.id) state.activeProjectId = null;
    await loadProjects();
    notify('runNotice', 'ok', 'Project archived. Its chats and artifacts were not deleted.');
  } catch (error) {
    notify('runNotice', 'bad', error.message);
  }
}

export async function loadProjects() {
  if (!state.principal || !state.workspaceId) return [];
  const response = await api('GET', '/api/projects?limit=100');
  state.projects = Array.isArray(response.projects) ? response.projects : [];
  renderProjectHub();
  return state.projects;
}

function closeProjectDialog() {
  const dialog = $('projectDialog');
  if (dialog?.open) dialog.close();
}

function openProjectDialog() {
  const dialog = $('projectDialog');
  if (dialog && !dialog.open) dialog.showModal();
  renderProjectManageList();
  $('projectName')?.focus({ preventScroll: true });
}

async function createProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('projectCreate');
  const name = text($('projectName')?.value);
  const description = text($('projectDescription')?.value);
  const defaultSurface = text($('projectSurface')?.value) || 'normal-chat';
  const visibility = $('projectShared')?.checked ? 'workspace' : 'private';
  if (!name) {
    notify('projectNotice', 'warn', 'Give the project a name.');
    $('projectName')?.focus();
    return;
  }
  submit.disabled = true;
  try {
    const response = await api('POST', '/api/projects', {
      name, description, defaultSurface, visibility
    }, { idempotencyKey: crypto.randomUUID() });
    await loadProjects();
    state.activeProjectId = response.project.id;
    renderProjectHub();
    form.reset();
    closeProjectDialog();
    document.dispatchEvent(new CustomEvent('kindgleam:project-selected', {
      detail: { projectId: response.project.id }
    }));
  } catch (error) {
    notify('projectNotice', 'bad', error.message);
  } finally {
    submit.disabled = false;
  }
}

export function initProjectHub() {
  $('newProject')?.addEventListener('click', openProjectDialog);
  $('projectManage')?.addEventListener('click', openProjectDialog);
  $('projectDialogClose')?.addEventListener('click', closeProjectDialog);
  $('projectForm')?.addEventListener('submit', createProject);
  $('projectSelect')?.addEventListener('change', event => {
    state.activeProjectId = text(event.currentTarget.value) || null;
    renderProjectHub();
    document.dispatchEvent(new CustomEvent('kindgleam:project-selected', {
      detail: { projectId: state.activeProjectId }
    }));
  });
}
