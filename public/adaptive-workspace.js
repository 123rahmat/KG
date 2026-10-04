/**
 * Situation-driven workspace presentation.
 *
 * This module does not own workflow decisions. The server's run state
 * remains authoritative; this only turns that state into the smallest
 * useful set of visible workspace surfaces and a clear current focus.
 */
import { state, $, element, button } from './ui-core.js';

const SURFACE_META = {
  runs: { label: 'Normal Chat', icon: 'chat', kind: 'normal-chat' },
  code: { label: 'Code Workspace', icon: 'terminal', kind: 'code' },
  research: { label: 'Research Workspace', icon: 'explore', kind: 'research' },
  objects: { label: 'Files', icon: 'files', kind: 'files' }
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

function activeWorkspace(run) {
  if (run?.surface === 'code' || run?.tasks?.some(task => ['code', 'build-code', 'test-code'].includes(task.id))) return 'code';
  if (run?.surface === 'research' || researchNeed(run)) return 'research';
  return 'normal-chat';
}

function surfaceSet(run) {
  const surfaces = new Set(['runs']);
  const workspace = activeWorkspace(run);
  if (workspace === 'code') surfaces.add('code');
  if (workspace === 'research') surfaces.add('research');
  if (fileNeed(run)) surfaces.add('objects');
  return [...surfaces];
}

function dispatchSurface(name) {
  if (name === 'code') {
    document.dispatchEvent(new CustomEvent('kindgleam:open-code-workspace'));
    return;
  }
  if (name === 'research') {
    document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name: 'explore', workspace: 'research' } }));
    return;
  }
  document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name } }));
}

function surfaceButton(name, active) {
  const meta = SURFACE_META[name];
  return button(meta.label, () => dispatchSurface(name), active ? 'adaptive-active small' : 'small');
}

export function adaptiveWorkspaceState() {
  const run = lastRun();
  const selected = ['code', 'research', 'normal-chat'].includes(state.activeSurface) ? state.activeSurface : null;
  const workspace = selected ?? activeWorkspace(run);
  return {
    run,
    focus: runFocus(run),
    status: currentStatus(run),
    workspace,
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
function capabilityItems(data) {
  const run = data.run;
  const source = state.workspaceSource;
  if (data.workspace === 'code') {
    const sourceConnected = source?.kind === 'github' || Boolean(run?.adaptation?.workspaceSourceId);
    const required = new Set(
      (run?.capabilities?.required ?? []).map(text)
    );
    return [
      {
        id: 'github',
        label: sourceConnected ? 'GitHub connected' : 'GitHub project',
        detail: sourceConnected ? 'revision-bound' : 'connect a repository',
        action: () => $('openProjectSources')?.click(),
        ready: sourceConnected
      },
      {
        id: 'files',
        label: 'ZIP + single-file inputs',
        detail: 'combine into one project',
        action: () => $('attachBtn')?.click(),
        ready: true
      },
      {
        id: 'terminal',
        label: 'Terminal',
        detail: required.has('code-execution') ? 'available for this run' : 'open when execution is needed',
        action: () => $('openTerminal')?.click(),
        ready: sourceConnected && Boolean($('openTerminal'))
      },
      {
        id: 'verify',
        label: 'Tests + verification',
        detail: 'driven by the active change',
        action: () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
        ready: Boolean(run)
      },
      {
        id: 'writeback',
        label: 'Review + GitHub write-back',
        detail: source?.permissions?.write === true ? 'explicit approval required' : 'read-only until enabled',
        action: () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
        ready: sourceConnected
      }
    ];
  }
  if (data.workspace === 'research') {
    const evidence = run?.adaptation?.researchWorkspace;
    const sourceCount = Number(evidence?.sourceCount ?? 0);
    const evidenceCount = Number(evidence?.evidenceCount ?? 0);
    return [
      {
        id: 'question',
        label: 'Research question',
        detail: evidence?.activeQuestion || run?.goal || 'define the question',
        action: () => {
          $('goal')?.focus({ preventScroll: false });
          $('goal')?.select();
        },
        ready: Boolean(run?.goal)
      },
      {
        id: 'search',
        label: 'Search + gather',
        detail: 'only justified sources',
        action: () => $('goal')?.focus({ preventScroll: false }),
        ready: true
      },
      {
        id: 'sources',
        label: 'Source set',
        detail: `${sourceCount} tracked source${sourceCount === 1 ? '' : 's'}`,
        action: () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
        ready: sourceCount > 0
      },
      {
        id: 'evidence',
        label: 'Evidence + gaps',
        detail: evidence?.status === 'needs-resolution'
          ? 'conflicts need resolution'
          : evidence?.status === 'needs-evidence'
            ? 'more evidence may be needed'
            : `${evidenceCount} ledger item${evidenceCount === 1 ? '' : 's'}`,
        action: () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
        ready: evidenceCount > 0
      },
      {
        id: 'citations',
        label: 'Citations + provenance',
        detail: 'claims remain traceable to sources',
        action: () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
        ready: sourceCount > 0
      }
    ];
  }
  return [];
}

function renderCapabilityDock() {
  const dock = $('workspaceCapabilityDock');
  const list = $('workspaceCapabilityList');
  const title = $('workspaceCapabilityTitle');
  const hint = $('workspaceCapabilityHint');
  if (!dock || !list) return;
  const data = adaptiveWorkspaceState();
  const active = data.workspace === 'code' || data.workspace === 'research';
  dock.hidden = !active;
  if (!active) {
    list.replaceChildren();
    return;
  }
  title.textContent = data.workspace === 'code' ? 'Code Workspace' : 'Research Workspace';
  hint.textContent = 'Adaptive tools for this work';
  list.replaceChildren(...capabilityItems(data).map(item => {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'workspace-capability';
    control.disabled = !item.action;
    control.title = item.detail;
    control.dataset.ready = String(item.ready);
    control.innerHTML = `<span class="workspace-capability-dot" aria-hidden="true"></span><span class="workspace-capability-copy"><strong>${item.label}</strong><small>${item.detail}</small></span>`;
    control.addEventListener('click', item.action);
    return control;
  }));
}

export function renderAdaptiveWorkspace(host, mode = 'chat') {
  if (!host) return;
  const data = adaptiveWorkspaceState();
  const surfaces = data.surfaces;

  const workspaceLabel = SURFACE_META[data.workspace === 'normal-chat' ? 'runs' : data.workspace]?.label ?? 'Normal Chat';
  host.replaceChildren(
    element('div', { class: 'adaptive-workspace-main' }, [
      element('span', { class: 'adaptive-workspace-dot' }),
      element('div', { class: 'adaptive-workspace-copy' }, [
        element('span', { class: 'adaptive-workspace-kicker', text: workspaceLabel }),
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
  renderCapabilityDock();

  const data = adaptiveWorkspaceState();
  const selected = state.activeSurface === 'code' || state.activeSurface === 'research'
    ? state.activeSurface
    : data.workspace;
  document.body.dataset.adaptiveWorkspace = selected;
  const sourceBar = $('workspaceSourceBar');
  if (sourceBar) sourceBar.hidden = selected !== 'code';
  const createStrip = $('adaptiveCreateStrip');
  if (createStrip) createStrip.hidden = selected !== 'normal-chat';
  for (const name of Object.keys(SURFACE_META)) {
    const tab = document.querySelector('#tabs [data-tab="' + name + '"]');
    if (!tab) continue;
    const active = data.surfaces.includes(name);
    tab.dataset.adaptiveNeeded = String(active);
    tab.title = active ? SURFACE_META[name].label + ' · needed for this situation' : SURFACE_META[name].label;
  }
}
