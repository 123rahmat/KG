/**
 * Situation-driven workspace presentation.
 *
 * This module does not own workflow decisions. The server's run state
 * remains authoritative; this only turns that state into the smallest
 * useful set of visible workspace surfaces and a clear current focus.
 */
import { state, $, element, button } from './ui-core.js';

const SURFACE_META = {
  runs: { label: 'Chat', icon: 'chat' },
  objects: { label: 'Files', icon: 'files' },
  explore: { label: 'Explore', icon: 'explore' }
};

const text = value => String(value ?? '').trim();

function lastRun() {
  return state.run ?? state.chat?.runs?.at(-1) ?? null;
}

function fileNeed(run) {
  if (state.attachments?.length) return true;
  if (!run) return false;
  return run.surface === 'files'
    || run.tasks?.some(task => ['artifact-work', 'code'].includes(task.id) || task.type === 'code');
}

function researchNeed(run) {
  return Boolean(run?.tasks?.some(task => ['investigate', 'tool'].includes(task.type)));
}

function currentStatus(run) {
  if (!run) return 'Ready for your next request';
  if (run.state === 'complete') return 'Result verified and ready';
  if (run.state === 'iterate') return 'Result ready — an improvement can continue from here';
  if (run.state === 'blocked') return 'Waiting for a permitted path';
  if (run.state === 'waiting') return 'Waiting for the next requirement or approval';
  const task = run.tasks?.find(item => item.id === run.next);
  return task?.metadata?.title || task?.purpose || 'Adapting the workflow to the situation';
}

function runFocus(run) {
  const situation = run?.situation ?? {};
  const classification = run?.adaptation?.classification ?? {};
  return text(situation.title || classification.title || run?.goal) || 'Current situation';
}

function surfaceSet(run) {
  const surfaces = new Set(['runs']);
  if (fileNeed(run)) surfaces.add('objects');
  if (researchNeed(run)) surfaces.add('explore');
  return [...surfaces];
}

function dispatchSurface(name) {
  document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name } }));
}

function surfaceButton(name, active) {
  const meta = SURFACE_META[name];
  return button(meta.label, () => dispatchSurface(name), active ? 'adaptive-active small' : 'small');
}

export function adaptiveWorkspaceState() {
  const run = lastRun();
  return {
    run,
    focus: runFocus(run),
    status: currentStatus(run),
    surfaces: surfaceSet(run)
  };
}

function taskLabel(task) {
  return text(task?.metadata?.title || task?.purpose || task?.id || task?.type || 'Step');
}

function taskTone(task) {
  if (task?.status === 'complete') return 'ok';
  if (task?.status === 'failed') return 'bad';
  if (['waiting', 'approval'].includes(task?.status)) return 'warn';
  if (task?.status === 'running') return 'active';
  return 'pending';
}

function executionLabel(task) {
  const target = text(task?.evidence?.executionTarget || task?.evidence?.result?.executionTarget || task?.evidence?.receipt?.executionTarget);
  if (!target) return null;
  if (target === 'general-ai-sandbox') return 'Sandbox';
  if (target === 'local') return 'Local';
  if (target === 'builtin-research') return 'Research';
  if (target === 'builtin-tools') return 'Built-in tool';
  if (target === 'generic-tool-router') return 'Tool runner';
  return target.replaceAll('-', ' ');
}

export function renderWorkStatus(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const visible = tasks.slice(-6);
  if (!visible.length) return null;
  const current = tasks.find(task => task.id === run.next) ?? tasks.find(task => !['complete','skipped'].includes(task.status));
  const execution = current?.evidence?.executionTarget || current?.evidence?.result?.executionTarget
    ? executionLabel(current)
    : null;
  return element('div', { class: 'work-timeline', 'aria-label': 'Work progress' }, [
    element('div', { class: 'work-timeline-head' }, [
      element('span', { class: 'small muted', text: 'Live workflow' }),
      current ? element('span', { class: 'small', text: 'Next · ' + taskLabel(current) + (execution ? ' · ' + execution : '') }) : element('span', { class: 'small muted', text: run.state === 'complete' ? 'All work finished' : 'No pending step' })
    ]),
    element('div', { class: 'work-timeline-list' }, visible.map(task => {
      const tone = taskTone(task);
      const exec = executionLabel(task);
      return element('div', { class: 'work-timeline-item ' + tone }, [
        element('span', { class: 'work-timeline-dot', 'aria-hidden': 'true' }),
        element('div', { class: 'work-timeline-copy' }, [
          element('strong', { class: 'small', text: taskLabel(task) }),
          element('span', { class: 'small muted', text: [task.status || 'pending', exec].filter(Boolean).join(' · ') })
        ]),
        task.status === 'failed' ? element('span', { class: 'small work-timeline-flag', text: 'Needs attention' }) : null
      ].filter(Boolean));
    }))
  ]);
}
export function renderAdaptiveWorkspace(host, mode = 'chat') {
  if (!host) return;
  const data = adaptiveWorkspaceState();
  const surfaces = data.surfaces;

  host.replaceChildren(
    element('div', { class: 'adaptive-workspace-main' }, [
      element('span', { class: 'adaptive-workspace-dot' }),
      element('div', { class: 'adaptive-workspace-copy' }, [
        element('span', { class: 'adaptive-workspace-kicker', text: 'Current work' }),
        element('strong', { class: 'truncate', text: data.focus }),
        element('span', { class: 'muted small truncate', text: data.status })
      ])
    ]),
    element('div', { class: 'adaptive-workspace-surfaces', role: 'toolbar', 'aria-label': 'Adaptive workspace surfaces' },
      surfaces.map(name => surfaceButton(name, mode === 'chat' && name === 'runs')))
  );
  host.dataset.surfaceCount = String(surfaces.length);
  host.dataset.mode = mode;
}

export function syncAdaptiveWorkspace() {
  renderAdaptiveWorkspace($('adaptiveWorkspaceBar'), 'chat');

  const data = adaptiveWorkspaceState();
  for (const name of Object.keys(SURFACE_META)) {
    const tab = document.querySelector('#tabs [data-tab="' + name + '"]');
    if (!tab) continue;
    const active = data.surfaces.includes(name);
    tab.dataset.adaptiveNeeded = String(active);
    tab.title = active ? SURFACE_META[name].label + ' · needed for this situation' : SURFACE_META[name].label;
  }
}
