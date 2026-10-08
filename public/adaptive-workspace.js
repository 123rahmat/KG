/**
 * Situation-driven workspace presentation.
 *
 * This module does not own workflow decisions. The server's run state
 * remains authoritative; this only turns that state into the smallest
 * useful set of visible workspace surfaces and a clear current focus.
 */
import { state, $, element, button } from './ui-core.js';
import { taskLensFor, contextualSuggestions } from './task-lens.js';
import { agentActivitySnapshot } from './agent-activity.js';
import { workspaceCapabilities } from './normal-chat-capabilities.js';
import { workspaceProgressPanel } from './work-progress-panels.js';
import { liveWorkFocus } from './live-work-focus.js';

const SURFACE_META = {
  runs: { label: 'Normal Chat', icon: 'chat', kind: 'normal-chat' },
  code: { label: 'Code Workspace', icon: 'terminal', kind: 'code' },
  research: { label: 'Research Workspace', icon: 'explore', kind: 'research' }
};

const text = value => String(value ?? '').trim();

function lastRun() {
  return state.run ?? state.chat?.runs?.at(-1) ?? null;
}

function researchNeed(run) {
  return Boolean(run?.tasks?.some(task => ['investigate', 'tool'].includes(task.type)));
}

function currentStatus(run) {
  if (!run) return 'Ready for your next request';
  if (['complete', 'failed', 'blocked', 'exhausted', 'waiting', 'iterate'].includes(run.state)) return workPresentation(run).label;
  const task = run.tasks?.find(item => item.id === run.next);
  const id = text(task?.id || task?.type).toLowerCase();
  const title = text(task?.metadata?.title || task?.purpose);
  if (id.includes('verify') || id.includes('test')) return 'Checking the result';
  if (id.includes('investigate') || id.includes('research') || id.includes('discover')) return 'Gathering only what is needed';
  if (id.includes('code') || id.includes('build') || id.includes('implement')) return 'Working on the requested change';
  if (id.includes('plan') || id.includes('decide')) return 'Choosing the next useful action';
  if (id.includes('observe') || id.includes('assess') || id.includes('understand')) return 'Understanding the situation';
  if (id.includes('replan') || id.includes('recover') || id.includes('diagnos')) return 'Adjusting after new evidence';
  return title || 'Adapting the work to what is needed';
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

function surfaceSet() {
  return ['runs', 'code', 'research'];
}

function dispatchSurface(name) {
  if (name === 'code') {
    document.dispatchEvent(new CustomEvent('kindgleam:open-code-workspace'));
    return;
  }
  if (name === 'research') {
    document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name: 'runs', workspace: 'research' } }));
    return;
  }
  document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name } }));
}

function surfaceButton(name, active) {
  const meta = SURFACE_META[name];
  const control = button('', () => dispatchSurface(name), active ? 'adaptive-active small' : 'small');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'i');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + (name === 'runs' ? 'chat' : name));
  icon.append(use);
  control.append(icon, element('span', { text: meta.label }));
  control.dataset.surface = name;
  control.setAttribute('aria-pressed', String(active));
  return control;
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
    lens: taskLensFor(run),
    surfaces: surfaceSet(run)
  };
}

function draftNextRequest(suggestion) {
  const composer = $('goal');
  if (!composer || composer.disabled) return;
  // A follow-up is a draft, not an automatic model invocation; never erase
  // text the user has already composed.
  const existing = String(composer.value || '').trim();
  composer.value = existing ? existing + '\n' + suggestion : suggestion;
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  composer.focus({ preventScroll: false });
}

function normalChatToolStrip(data) {
  const draft = text($('goal')?.value);
  const pending = Array.isArray(state.attachments) ? state.attachments : [];
  const previous = data.run?.surface === data.workspace && Array.isArray(data.run?.adaptation?.attachments)
    ? data.run.adaptation.attachments : [];
  const selectedFiles = state.attachmentScope instanceof Set
    ? pending.filter(file => state.attachmentScope.has(file)) : pending;
  const info = workspaceCapabilities({
    goal: draft || (data.run?.surface === data.workspace ? data.run?.goal : '') || '',
    attachments: pending.length ? selectedFiles : draft ? [] : previous,
    executionTargets: state.executionConfig?.targets ?? [],
    currentSurface: data.workspace
  });
  const items = [];
  if (info.fileCount > 0) {
    items.push(element('span', { class: 'normal-chat-tool-tag', text:
      info.fileCount + ' file' + (info.fileCount === 1 ? '' : 's') + ' · preview and work here' }));
  }
  if (info.showSandbox) {
    items.push(element('span', { class: 'normal-chat-tool-tag', text:
      info.sandboxReady ? 'Isolated code sandbox available on demand'
        : 'Code sandbox not configured · code runs unavailable' }));
  }
  if (info.suggestedWorkspace) {
    const label = { code: 'Code', research: 'Research', 'normal-chat': 'Normal Chat' }[info.suggestedWorkspace];
    items.push(element('div', { class: 'workspace-switch-banner', role: 'region', 'aria-label': 'Workspace suggestion' }, [
      element('div', { class: 'workspace-switch-copy' }, [
        element('strong', { text: label + ' is a better fit for this task' }),
        element('span', { class: 'normal-chat-switch-description', text: info.suggestion }),
        info.suggestedWorkspace === 'code' && !state.workspaceSource
          ? element('small', { class: 'muted', text: 'Attach a GitHub repository in Code for project editing.' }) : null
      ]),
      button('Use ' + label + ' workspace',
        () => dispatchSurface(info.suggestedWorkspace === 'normal-chat' ? 'runs' : info.suggestedWorkspace), 'normal-chat-switch-action small')
    ]));
  }
  return items.length ? element('div', {
    class: 'normal-chat-tool-strip', 'aria-label': 'Optional file and workspace tools'
  }, items) : null;
}

function adaptiveNextActions(data) {
  if (data.workspace !== 'normal-chat') return null;
  const suggestions = contextualSuggestions(data.run);
  if (!suggestions.length) return null;
  return element('div', { class: 'adaptive-next-actions', 'aria-label': 'Optional next requests' }, [
    element('span', { class: 'adaptive-next-heading', text: 'Explore further' }),
    ...suggestions.slice(0, 2).map(suggestion => button(suggestion, () => draftNextRequest(suggestion), 'adaptive-next-action'))
  ]);
}

function taskLabel(task) {
  const labels = {
    understand: 'Understanding your request', 'discover-capabilities': 'Choosing useful tools',
    discover: 'Checking the available context', adapt: 'Adapting the approach', plan: 'Planning the work',
    respond: 'Writing your answer', prototype: 'Creating a first version', 'build-code': 'Making the code changes',
    'test-code': 'Running the code checks', investigate: 'Gathering sources',
    observe: 'Reviewing the results', reassess: 'Adjusting the next step', verify: 'Checking the result',
    deliver: 'Preparing your result', approval: 'Review the proposed action', clarify: 'Answer a question'
  };
  return text(task?.metadata?.title || labels[task?.id] || labels[task?.type] || task?.purpose || task?.id || 'Step');
}

/** Presentation only: never infer overall completion from an expanding graph. */
export function workPresentation(run, { driving = false, online = true, consent = false, manual = false, stopping = false } = {}) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const terminal = ['complete', 'failed', 'blocked', 'exhausted', 'iterate'].includes(run?.state);
  const current = terminal ? null : tasks.find(task => task.id === run?.next)
    ?? tasks.find(task => !['complete', 'skipped'].includes(task.status)) ?? null;
  const check = [...tasks].reverse().find(task => task.type === 'verify');
  const verdict = check?.evidence?.verdict;
  const verified = check?.status === 'complete' && (verdict?.verdict === 'pass' || verdict?.status === 'pass');
  const waiting = !terminal && (run?.state === 'waiting' || consent || manual || ['clarify', 'approval'].includes(current?.type));
  const disconnected = !terminal && !online;
  const live = !terminal && !waiting && !disconnected && !stopping
    && (driving || current?.status === 'running' || run?.state === 'running');
  const labels = {
    complete: verified ? 'Completed · verified' : 'Completed', failed: 'Stopped',
    blocked: 'This request cannot proceed', exhausted: 'Work limit reached', iterate: 'Result ready'
  };
  const label = labels[run?.state] || (stopping ? (disconnected ? 'Stop queued' : 'Stopping safely')
    : disconnected ? 'Connection lost'
    : consent ? 'Your permission is needed' : manual ? 'Waiting for your input'
      : current?.type === 'approval' ? 'Your approval is needed'
        : current?.type === 'clarify' ? 'Your answer is needed' : waiting ? 'Waiting for you'
          : live ? taskLabel(current) : run?.state === 'queued' ? 'Queued' : 'Ready for the next step');
  const required = (Array.isArray(run?.requirements?.items) ? run.requirements.items : [])
    .filter(item => item.required !== false && item.status !== 'superseded');
  const supported = required.filter(item => ['satisfied', 'verified'].includes(item.status) && Array.isArray(item.evidence) && item.evidence.length > 0);
  const percent = required.length
    ? Math.min(run?.requirements?.completionReady === true ? 100 : 99, Math.round(supported.length / required.length * 100)) : null;
  return {
    label, current, live, waiting, stopping, terminal, disconnected, verified: Boolean(verified), percent,
    completed: tasks.filter(task => task.status === 'complete').length,
    skipped: tasks.filter(task => task.status === 'skipped').length,
    tone: ['failed', 'blocked', 'exhausted'].includes(run?.state) ? 'bad'
      : waiting || disconnected ? 'warn' : run?.state === 'complete' ? 'ok' : ''
  };
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

function progressSnapshot(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const completed = tasks.filter(task => ['complete', 'skipped'].includes(task?.status)).length;
  const failed = tasks.filter(task => task?.status === 'failed').length;
  const active = tasks.filter(task => task?.status === 'running').length;
  const pending = Math.max(0, tasks.length - completed - failed - active);
  const attachments = Array.isArray(run?.adaptation?.attachments) ? run.adaptation.attachments : [];
  const files = Math.max(
    Number(run?.intelligence?.context?.fileCount) || 0,
    attachments.length,
    Number(run?.adaptation?.projectOverlay?.length) || 0
  );
  const images = attachments.filter(file => /^image\//i.test(String(file?.contentType ?? file?.type ?? ''))).length;
  const research = run?.adaptation?.researchWorkspace ?? {};
  const testCount = tasks.filter(task => task?.id === 'test-code' || /test|verif/i.test(String(task?.id) + ' ' + String(task?.type))).length;
  const verified = tasks.filter(task => {
    if (task?.type !== 'verify' || task?.status !== 'complete') return false;
    const verdict = task?.evidence?.verdict;
    return verdict?.verdict === 'pass' || verdict?.status === 'pass';
  }).length;
  return {
    completed, failed, active, pending,
    files, images,
    sources: Number(research.sourceCount) || 0,
    evidence: Number(research.evidenceCount) || 0,
    conflicts: Array.isArray(research.conflicts) ? research.conflicts.length : 0,
    gaps: Array.isArray(research.unresolvedQuestions) ? research.unresolvedQuestions.length : 0,
    tests: testCount,
    verified,
    depth: text(run?.intelligence?.reasoning?.depth || run?.adaptation?.resourcePlan?.control?.depth) || 'adaptive',
    scale: text(run?.adaptation?.scale || run?.intelligence?.scale) || 'task'
  };
}

function backgroundSnapshot(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const activity = agentActivitySnapshot(run);
  const activeAgents = activity.active.map(item => item.role);
  const completedAgents = activity.completed;

  const tools = new Set();
  let activeTool = '';
  for (const task of tasks) {
    for (const item of task?.evidence?.tools ?? []) {
      if (item?.tool) tools.add(text(item.tool));
      if (item?.status === 'running' || item?.outcome === 'running') activeTool = text(item.tool);
    }
  }

  const execution = [...tasks].reverse().find(task =>
    task?.evidence?.executionTarget
    || task?.evidence?.result?.executionTarget
    || task?.evidence?.receipt?.executionTarget
  );
  const executionTarget = executionLabel(execution);
  const next = tasks.find(task => task.id === run?.next) ?? null;
  const governance = run?.situationGovernance ?? run?.adaptation?.governance ?? {};
  const approvals = Array.isArray(governance?.approvals) ? governance.approvals.length : 0;
  const source = state.workspaceSource ?? {};
  const workspace = activeWorkspace(run);
  const routing = [...tasks].reverse().map(task =>
    task?.evidence?.modelRouting
    || task?.evidence?.result?.modelRouting
    || task?.evidence?.segment?.modelRouting
  ).find(Boolean) ?? null;
  const depth = text(run?.intelligence?.reasoning?.depth || run?.adaptation?.resourcePlan?.control?.depth).toLowerCase();
  const runtimeMode = routing?.tier === 'frontier'
    ? 'Deep quality'
    : routing?.tier === 'efficient'
      ? 'Efficient path'
      : /deep|thorough/.test(depth)
        ? 'Deep quality'
        : /structured|standard|focused/.test(depth) ? 'Balanced' : 'Efficient path';
  const adaptiveBudget = run?.adaptiveBudget ?? {};
  const ratios = Object.entries(adaptiveBudget?.budget ?? {}).flatMap(([key, maximum]) => {
    const remaining = adaptiveBudget?.remaining?.[key];
    const max = Number(maximum);
    return Number.isFinite(max) && max > 0 && Number.isFinite(Number(remaining))
      ? [Math.max(0, Math.min(1, Number(remaining) / max))]
      : [];
  });
  const budgetHeadroom = ratios.length ? Math.round(Math.min(...ratios) * 100) : null;
  const parallel = activity.maxParallel;

  let permission = '';
  let permissionTone = '';
  if (governance?.status === 'blocked') {
    permission = 'Blocked by policy';
    permissionTone = 'bad';
  } else if (next?.type === 'approval' || approvals) {
    permission = 'Approval needed';
    permissionTone = 'warn';
  } else if (workspace === 'code' && source?.kind === 'github') {
    permission = source?.permissions?.write === true ? 'Write access connected · approval still required' : 'Repository is read-only';
    permissionTone = source?.permissions?.write === true ? 'ok' : 'neutral';
  }

  return {
    activeAgents,
    completedAgents,
    activity,
    toolCount: tools.size,
    activeTool,
    executionTarget,
    runtimeMode,
    parallel,
    budgetHeadroom,
    permission,
    permissionTone
  };
}

// Keep the user's second-level inspection choice during poll-driven rerenders.
const activityDisclosure = new Map();
function realActivityDetails(run, focus) {
  if (!focus.showDetails) return null;
  const key = String(run?.id ?? '');
  const open = activityDisclosure.has(key) ? activityDisclosure.get(key) : true;
  const rows = focus.activity.map(entry => element('div', { class: 'work-observed-row' }, [
    element('dt', { text: entry.label }),
    element('dd', { text: entry.value })
  ]));
  const details = element('details', {
    class: 'work-observed-details', open, 'data-live-inspection': 'true'
  }, [
    element('summary', { class: 'work-observed-summary' }, [
      element('strong', { text: 'Real work activity' }),
      element('span', { class: 'small muted', text: focus.completed + ' of ' +
        focus.stageCount + ' stages recorded' })
    ]),
    element('dl', { class: 'work-observed-list',
      'aria-label': 'Saved task, execution and file information' }, rows),
    element('p', { class: 'small muted', text:
      'Only recorded activity appears here. Interactive terminal sessions open separately when requested.' })
  ]);
  details.addEventListener('toggle', () => {
    activityDisclosure.set(key, details.open);
    if (activityDisclosure.size > 64) activityDisclosure.delete(activityDisclosure.keys().next().value);
  });
  return details;
}

// Disclosure preferences survive polling without changing server-owned task state.
const stageDisclosure = new Map();
function stageDetail(run, panel, view) {
  if (!panel.stages.length) return null;
  const key = String(run?.id ?? '');
  const defaultOpen = panel.workspace !== 'normal-chat' && !view.terminal;
  const open = stageDisclosure.has(key) ? stageDisclosure.get(key) : defaultOpen;
  const detail = element('details', { class: 'work-stage-details', open }, [
    element('summary', { class: 'work-stage-summary' }, [
      element('strong', { text: 'Task stages' }),
      element('span', { class: 'small muted', text: panel.completed + ' completed · ' +
        panel.stageCount + ' recorded' })
    ]),
    element('ol', { class: 'work-stage-list', 'aria-label': 'Recorded task stages' },
      panel.stages.map(item => element('li', { class: 'work-stage-row', 'data-stage-status': item.status }, [
        element('span', { class: 'work-stage-mark', 'aria-hidden': 'true' }),
        element('span', { class: 'work-stage-name', text: item.label }),
        element('span', { class: 'work-stage-state', text: item.statusLabel + (item.evidenceAnchor ? ' · Evidence from ' + item.evidenceAnchor : '') })
      ]))),
    panel.stageCount > panel.stages.length ? element('p', {
      class: 'small muted', text: 'Showing the latest ' + panel.stages.length + ' stages'
    }) : null
  ].filter(Boolean));
  detail.addEventListener('toggle', () => {
    stageDisclosure.set(key, detail.open);
    if (stageDisclosure.size > 64) stageDisclosure.delete(stageDisclosure.keys().next().value);
  });
  return detail;
}

export function renderWorkStatus(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  if (!tasks.length) return null;
  const view = workPresentation(run, {
    driving: state.driving === run.id || state.drivingRuns?.has(run.id) || state.busyRuns?.has(run.id),
    online: state.network?.online !== false && state.network?.reachable !== false,
    consent: state.consentNeeded?.has(run.id), manual: state.manualOpen?.has(run.id),
    stopping: state.stoppingRun === run.id
  });
  const snapshot = progressSnapshot(run);
  const background = backgroundSnapshot(run);
  const workspace = ['code', 'research'].includes(state.activeSurface) ? state.activeSurface : activeWorkspace(run);
  const panel = workspaceProgressPanel(run, workspace);
  const focus = liveWorkFocus(run, {
    workspace,
    connectedGitHub: state.workspaceSource?.kind === 'github',
    offline: view.disconnected,
    stopping: view.stopping
  });
  const nextDecision = run?.adaptation?.unifiedAdaptiveWorkflow?.openWorld ?? null;
  const decisionNote = nextDecision?.action === 'approval-required'
    ? 'The next proposed action needs approval.'
    : nextDecision?.action === 'capability-gap'
      ? 'A required capability or prerequisite is unavailable.'
      : nextDecision?.action === 'budget-gate'
        ? 'Resource limits prevent optional expansion.'
        : nextDecision?.action === 'investigate' && nextDecision?.unknowns?.length
          ? nextDecision.unknowns.length + ' unresolved question' + (nextDecision.unknowns.length === 1 ? '' : 's') + ' guiding the next action'
          : nextDecision?.action === 'propose-work' && nextDecision?.next?.purpose
            ? 'Suggested next action · ' + String(nextDecision.next.purpose).slice(0, 140)
            : '';
  const backgroundItems = [
    !view.terminal ? 'Work mode · ' + background.runtimeMode : '',
    background.activeAgents.length && view.live
      ? background.activeAgents.length + ' specialist' + (background.activeAgents.length === 1 ? '' : 's') + ' working'
      : background.completedAgents ? background.completedAgents + ' specialist' + (background.completedAgents === 1 ? '' : 's') + ' contributed' : '',
    background.parallel > 1 && view.live ? 'Parallel work · up to ' + background.parallel : '',
    background.budgetHeadroom !== null && !view.terminal ? 'Work capacity · ' + background.budgetHeadroom + '% available' : '',
    background.toolCount ? background.toolCount + ' tool' + (background.toolCount === 1 ? '' : 's') + ' available' : '',
    background.executionTarget ? 'Execution · ' + background.executionTarget : ''
  ].filter(Boolean).slice(0, 5);
  const current = view.current;
  const metrics = [
    snapshot.files ? ['Files in context', String(snapshot.files)] : null,
    snapshot.sources ? ['Sources gathered', String(snapshot.sources)] : null,
    snapshot.evidence ? ['Evidence items', String(snapshot.evidence)] : null
  ].filter(Boolean);
  const meter = view.percent !== null ? element('div', {
    class: 'work-progress-meter' + (view.percent === 100 ? ' is-complete' : ''),
    role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': String(view.percent), 'aria-label': 'Required outcomes supported by evidence'
  }, [element('i', { style: { width: view.percent + '%' } })]) : null;
  const lastUpdated = new Date(run.updatedAt || run.createdAt).getTime();
  const age = Number.isFinite(lastUpdated) ? Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000)) : 0;
  const updateLabel = age < 60 ? 'Updated just now' : age < 3600 ? 'Updated ' + Math.floor(age / 60) + ' min ago' : 'Last saved update';
  const finished = tasks.filter(task => ['complete', 'skipped', 'failed'].includes(task.status)).slice(-4);
  return element('div', {
    class: 'work-timeline' + (view.disconnected ? ' is-disconnected' : ''),
    'data-work-live': String(view.live), 'aria-label': 'Adaptive workflow progress'
  }, [
    element('div', { class: 'work-timeline-head' }, [
      element('div', { class: 'work-status-summary' }, [
        element('span', { class: 'work-status-dot' + (view.live ? ' active' : ''), 'aria-hidden': 'true' }),
        element('div', { class: 'work-status-copy' }, [
          element('strong', { class: 'work-exact-line', text: focus.line }),
          element('span', { class: 'small muted', text: view.stopping
            ? (view.disconnected ? 'The stop request will be sent when the connection returns.' : 'No new step will start while the server confirms cancellation.')
            : view.disconnected
              ? 'The live view will reconnect automatically. Server work may still be running.'
              : view.terminal ? view.completed + ' step' + (view.completed === 1 ? '' : 's') + ' completed' + (view.skipped ? ' · ' + view.skipped + ' skipped' : '')
                : current?.purpose && text(current.purpose) !== view.label ? current.purpose : 'Your work continues in this conversation' })
        ])
      ]),
      element('span', { class: 'small work-status-state', text: view.stopping ? 'Stopping' : view.live ? 'Working' : view.waiting ? 'Action needed' : view.terminal ? 'Saved' : view.disconnected ? 'Offline' : 'Ready' })
    ]),
    background.permission ? element('div', { class: 'work-permission-strip ' + background.permissionTone }, [
      element('span', { class: 'work-permission-mark', 'aria-hidden': 'true' }),
      element('span', { class: 'small', text: background.permission })
    ]) : null,
    meter,
    realActivityDetails(run, focus),
    panel.stageContext && !view.terminal
      ? element('div', { class: 'work-phase-note', 'aria-label': 'Current task explanation' }, [
        element('strong', { text: panel.stageContext.title }),
        element('span', { class: 'small muted', text: panel.stageContext.detail })
      ]) : null,
    panel.cards.length ? element('dl', {
      class: 'work-focus-grid', 'aria-label': 'Relevant task information'
    }, panel.cards.map(card => element('div', { class: 'work-focus-card' }, [
      element('dt', { text: card.label }),
      element('dd', { text: card.value })
    ]))) : null,
    !view.terminal && decisionNote ? element('div', { class: 'work-update-note small muted', text: decisionNote }) : null,
    meter ? element('div', { class: 'work-progress-caption small muted', text: view.percent + '% of required outcomes supported by evidence' }) : null,
    !view.terminal && !meter ? element('div', { class: 'work-progress-caption small muted', text: view.completed ? view.completed + ' step' + (view.completed === 1 ? '' : 's') + ' completed · next action adapts as needed' : 'Only the work your request needs' }) : null,
    metrics.length ? element('div', { class: 'work-evidence-chips' }, metrics.map(([label, value]) => element('span', { class: 'work-evidence-chip', text: value + ' ' + label.toLowerCase() }))) : null,
    backgroundItems.length ? element('div', { class: 'work-background-strip', 'aria-label': 'Current work details' }, [
      ...backgroundItems.map(item => element('span', { class: 'work-background-chip small', text: item }))
    ]) : null,
    panel.fileNames.length ? element('details', {
      class: 'work-stage-details work-file-details'
    }, [
      element('summary', { class: 'work-stage-summary' }, [
        element('strong', { text: 'Files in this task' }),
        element('span', { class: 'small muted', text: panel.fileNames.length + ' listed' })
      ]),
      element('ul', { class: 'work-file-list' }, panel.fileNames.map(name =>
        element('li', { text: name })))
    ]) : null,
    stageDetail(run, panel, view),
    background.activity.roles.length ? element('details', { class: 'work-agent-details' }, [
      element('summary', { class: 'small', text: 'Specialist contributions · ' + background.activity.roles.length + ' recorded' }),
      element('p', { class: 'small muted', text: background.activity.observedParallel
        ? 'Independent specialist work ran in parallel where allowed. These are saved results, not a live activity claim.'
        : 'Saved advisory findings. The main workflow remains responsible for execution and verification.' }),
      ...background.activity.roles.slice(-8).map(agent => element('div', { class: 'work-agent-row' }, [
        element('strong', { class: 'small', text: agent.role.replace(/-/g, ' ') }),
        element('span', { class: 'small muted', text: agent.status + (agent.wave ? ' · wave ' + agent.wave : '') }),
        agent.summary ? element('span', { class: 'small work-agent-summary', text: agent.summary }) : null
      ].filter(Boolean)))
    ]) : null,
    snapshot.conflicts || snapshot.gaps ? element('div', { class: 'work-progress-alerts' }, [
      snapshot.conflicts ? element('span', { class: 'pill warn', text: snapshot.conflicts + ' evidence conflicts to resolve' }) : null,
      snapshot.gaps ? element('span', { class: 'pill warn', text: snapshot.gaps + ' open research questions' }) : null
    ].filter(Boolean)) : null,
    !view.terminal && finished.length ? element('div', { class: 'work-recent-activity' }, finished.map(task => element('div', { class: 'work-activity-row ' + taskTone(task) }, [
      element('span', { class: 'work-activity-mark', text: task.status === 'complete' ? '✓' : task.status === 'failed' ? '!' : '−', 'aria-hidden': 'true' }),
      element('span', { class: 'small', text: taskLabel(task) }),
      element('span', { class: 'small muted', text: [task.status === 'complete' ? 'Done' : task.status === 'failed' ? 'Needs attention' : 'Skipped', executionLabel(task)].filter(Boolean).join(' · ') })
    ]))) : null,
    !view.terminal && Number.isFinite(lastUpdated) ? element('div', { class: 'work-update-note small muted', text: updateLabel + (view.live && age >= 45 ? ' · this step is taking longer; awaiting the next server update' : '') }) : null
  ].filter(Boolean));
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
        detail: sourceConnected ? 'tied to the selected revision' : 'connect a repository',
        action: () => $('openProjectSources')?.click(),
        ready: sourceConnected
      },
      {
        id: 'files',
        label: 'ZIP + single-file inputs',
        detail: 'add to the current project context',
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
        detail: 'focused on useful sources',
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
            : `${evidenceCount} evidence item${evidenceCount === 1 ? '' : 's'}`,
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

function workspaceValue(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function currentTask(run) {
  if (workPresentation(run).terminal) return null;
  return run?.tasks?.find(task => task.id === run.next)
    ?? run?.tasks?.find(task => !['complete', 'skipped'].includes(task.status))
    ?? null;
}

function workspaceWorkView(run) {
  return workPresentation(run, {
    driving: state.driving === run?.id || state.drivingRuns?.has(run?.id) || state.busyRuns?.has(run?.id),
    online: state.network?.online !== false && state.network?.reachable !== false,
    consent: state.consentNeeded?.has(run?.id), manual: state.manualOpen?.has(run?.id),
    stopping: state.stoppingRun === run?.id
  });
}

const workspaceAreas = new Map();

function openWorkspaceArea(name) {
  const host = $('deepWorkspaceShell');
  const area = host?.querySelector('[data-workspace-area="' + name + '"]');
  if (!area) return;
  workspaceAreas.set(host.dataset.workspace, name);
  for (const control of host.querySelectorAll('[data-workspace-nav]')) {
    const active = control.dataset.workspaceNav === name;
    control.classList.toggle('active', active);
    if (active) control.setAttribute('aria-current', 'location');
    else control.removeAttribute('aria-current');
  }
  area.focus({ preventScroll: true });
  area.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

function workspaceNavigation(workspace, areas) {
  const selected = workspaceAreas.get(workspace) || 'overview';
  return element('nav', { class: 'deep-workspace-nav', 'aria-label': (workspace === 'code' ? 'Code' : 'Research') + ' project areas' }, areas.map(([id, label]) => {
    const control = button(label, () => openWorkspaceArea(id), (id === selected ? 'active ' : '') + 'small');
    control.dataset.workspaceNav = id;
    control.dataset.workspaceControl = 'nav:' + id;
    control.setAttribute('aria-controls', 'workspace-' + workspace + '-' + id);
    if (id === selected) control.setAttribute('aria-current', 'location');
    return control;
  }));
}

function workspaceArea(workspace, id, className) {
  return { class: className, id: 'workspace-' + workspace + '-' + id, 'data-workspace-area': id, tabindex: '-1', 'aria-label': id === 'overview' ? 'Workspace overview' : id };
}

function researchSource(source, scope) {
  const url = text(source?.url);
  const web = /^https?:\/\//i.test(url);
  return element(web ? 'a' : 'span', {
    class: 'workspace-detail-row source-row', ...(web ? { href: url, target: '_blank', rel: 'noopener noreferrer', 'data-workspace-control': scope + ':' + (source?.key || url) } : {}),
    text: source?.title || source?.provider || url || 'Source'
  });
}

/** Only observed specialist outcomes are shown; no guessed agents or waves. */
function specialistProjectSection(run, workspace) {
  const recorded = agentActivitySnapshot(run);
  const area = workspace === 'code' ? 'agents' : 'team';
  const roles = recorded.roles.slice(-8);
  const description = roles.length
    ? 'Saved specialist findings. The main workflow still owns edits, sources and verification.'
    : workspace === 'code'
      ? 'Small code changes can use a single agent. Specialist reviews appear here if they actually run.'
      : 'Independent research and citation reviews appear here if they actually run.';
  return element('section', workspaceArea(workspace, area, 'deep-workspace-card detail-card'), [
    element('div', { class: 'deep-workspace-card-head' }, [
      element('span', { class: 'mono', text: workspace === 'code' ? 'ENGINEERING SPECIALISTS' : 'RESEARCH SPECIALISTS' }),
      element('span', { class: 'small muted', text: roles.length + ' recorded' })
    ]),
    element('p', { class: 'small muted', text: description }),
    roles.length ? element('div', { class: 'workspace-detail-list' }, roles.map(item =>
      element('div', { class: 'workspace-detail-row' }, [
        element('strong', { text: item.role.replaceAll('-', ' ') }),
        element('span', { class: 'small muted', text: item.status +
          (item.wave ? ' · wave ' + item.wave : '') }),
        item.summary ? element('span', { class: 'small muted', text: item.summary }) : null
      ].filter(Boolean))
    )) : null,
    recorded.observedParallel ? element('p', { class: 'small muted',
      text: 'Parallel specialist waves were recorded for this task.' }) : null,
    recorded.adaptations.length ? element('div', {
      class: 'workspace-specialist-adjustments', 'aria-label': 'Recorded agent team adjustments'
    }, recorded.adaptations.map(change =>
      element('p', { class: 'small muted', text: (change.action === 'recruit' ? 'Recruited' : 'Reduced') +
        ' advisory capacity' + (change.wave ? ' · wave ' + change.wave : '') +
        (change.reason ? ' · ' + change.reason.replaceAll('-', ' ') : '') })
    )) : null
  ].filter(Boolean));
}

/** Shared activity view; labels and states are persisted run records, not model guesses. */
function workspaceActivitySection(run, workspace) {
  const panel = workspaceProgressPanel(run, workspace);
  return element('section', workspaceArea(workspace, 'activity', 'deep-workspace-card detail-card workspace-activity-card'), [
    element('div', { class: 'deep-workspace-card-head' }, [
      element('span', { class: 'mono', text: 'RECORDED ACTIVITY' }),
      element('span', { class: 'small muted', text: panel.completed + ' completed · ' + panel.stageCount + ' stages' })
    ]),
    panel.stages.length
      ? element('ol', { class: 'work-stage-list', 'aria-label': 'Project task progress' },
        panel.stages.map(item => element('li', {
          class: 'work-stage-row', 'data-stage-status': item.status
        }, [
          element('span', { class: 'work-stage-mark', 'aria-hidden': 'true' }),
          element('span', { class: 'work-stage-name', text: item.label }),
          element('span', { class: 'work-stage-state', text: item.statusLabel + (item.evidenceAnchor ? ' · Evidence from ' + item.evidenceAnchor : '') })
        ])))
      : element('p', { class: 'small muted', text: 'Recorded work stages will appear after a project task starts.' }),
    panel.stageCount > panel.stages.length
      ? element('p', { class: 'small muted', text: 'Displaying the latest ' + panel.stages.length + ' steps.' }) : null,
    element('p', { class: 'small muted', text: 'Statuses come from saved task records. The plan may expand as new evidence appears.' })
  ].filter(Boolean));
}

function codeWorkspaceProject(data) {
  const run = data.run;
  const view = workspaceWorkView(run);
  const source = state.workspaceSource ?? {};
  const repo = workspaceValue(source.repoFullName, source.repositoryFullName, source.repo, source.repository?.fullName, source.name) || 'No GitHub project connected';
  const revision = workspaceValue(source.commitSha, source.repoRef, source.revision, source.currentRevision, source.metadata?.commitSha, run?.adaptation?.workspaceSourceRevision, run?.adaptation?.codeWorkspace?.baseRevision) || 'Selected project revision';
  const attached = Array.isArray(run?.adaptation?.attachments) ? run.adaptation.attachments.length : state.attachments?.length ?? 0;
  const overlay = Array.isArray(run?.adaptation?.projectOverlay) ? run.adaptation.projectOverlay.length : 0;
  const task = currentTask(run);
  const tests = (run?.tasks ?? []).filter(item => item.type === 'code' || /test|verif/i.test(text(item?.id) + ' ' + text(item?.metadata?.title)));
  const lastChange = run?.adaptation?.unifiedWorkContext?.lastChange ?? {};
  const changedFiles = [
    ...(Array.isArray(lastChange?.files) ? lastChange.files : []),
    ...(Array.isArray(lastChange?.deleted) ? lastChange.deleted : [])
  ].filter(Boolean).slice(0, 12);
  const files = [...new Set([
    ...(source.metadata?.manifest ?? []).map(file => file.path),
    ...(run?.adaptation?.projectOverlay ?? []).map(file => file.path),
    ...(run?.adaptation?.attachments ?? state.attachments ?? []).map(file => file.path || file.name)
  ].map(text).filter(Boolean))];
  const verificationRows = tests.slice(-6).map(item => ({
    title: taskLabel(item),
    status: item.status || 'pending',
    summary: text(item.summary || item.evidence?.text || '').slice(0, 180)
  }));
  return [
    element('div', { class: 'deep-workspace-head code' }, [
      element('div', { class: 'deep-workspace-identity' }, [
        element('span', { class: 'deep-workspace-kicker', text: 'CODE PROJECT' }),
        element('strong', { text: repo }),
        element('span', { class: 'muted small', text: 'Revision · ' + revision })
      ]),
      element('div', {
        class: 'deep-workspace-state',
        role: 'status',
        'aria-live': 'polite',
        'data-state': run?.state || 'ready'
      }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', { text: view.terminal || view.waiting || view.disconnected ? view.label : run ? 'active' : 'ready' })
      ])
    ]),
    workspaceNavigation('code', [['overview', 'Overview'], ['activity', 'Activity'], ['files', 'Files'], ['changes', 'Changes'], ['tests', 'Tests'], ['agents', 'Specialists']]),
    element('div', workspaceArea('code', 'overview', 'deep-workspace-grid'), [
      element('section', { class: 'deep-workspace-card project-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'PROJECT' }),
          element('span', { class: 'small muted', text: source?.kind === 'github' ? 'GitHub' : attached ? 'Attached input' : 'Not connected' })
        ]),
        element('strong', { text: repo }),
        element('div', { class: 'deep-workspace-metrics' }, [
          metric('Revision', revision, true),
          metric('Attached inputs', String(attached), false),
          metric('Working inputs', String(overlay), false)
        ])
      ]),
      element('section', { class: 'deep-workspace-card work-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'CURRENT WORK' }),
          element('span', { class: 'small muted', text: task?.status || 'ready' })
        ]),
        element('strong', { text: task ? taskLabel(task) : view.label }),
        element('p', { class: 'small muted', text: run ? currentStatus(run) : 'Start a coding request to load the relevant project context.' }),
        element('div', { class: 'deep-workspace-badges' }, [
          badge('Tests', tests.length ? tests.length + ' tracked' : 'on demand'),
          badge('Write-back', source?.permissions?.write === true ? 'approval' : 'read-only'),
          badge('Specialists', 'adaptive')
        ])
      ])
    ]),
    element('div', { class: 'deep-workspace-section-grid' }, [
      workspaceActivitySection(run, 'code'),
      element('section', workspaceArea('code', 'files', 'deep-workspace-card detail-card'), [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'FILE CONTEXT' }),
          element('span', { class: 'small muted', text: files.length ? Math.min(files.length, 20) + ' of ' + files.length + ' paths' : 'no files connected' })
        ]),
        files.length ? element('div', { class: 'workspace-detail-list' }, files.slice(0, 20).map(path => element('code', { class: 'workspace-detail-row', text: path })))
          : element('p', { class: 'small muted', text: 'Connect a GitHub project or attach a ZIP or code file to build the file context.' }),
        source.metadata?.ingestion?.partial ? element('p', { class: 'small tone-warn', text: 'This snapshot is partial; some files were omitted during ingestion.' }) : null
      ].filter(Boolean)),
      element('section', workspaceArea('code', 'changes', 'deep-workspace-card detail-card'), [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'CHANGE SURFACE' }),
          element('span', { class: 'small muted', text: changedFiles.length ? changedFiles.length + ' paths' : 'no recorded change yet' })
        ]),
        changedFiles.length
          ? element('div', { class: 'workspace-detail-list' }, changedFiles.map(path => element('code', { class: 'workspace-detail-row', text: path })))
          : element('p', { class: 'small muted', text: 'The workspace will show affected paths after a code change is recorded.' })
      ]),
      element('section', workspaceArea('code', 'tests', 'deep-workspace-card detail-card'), [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'VERIFICATION' }),
          element('span', { class: 'small muted', text: verificationRows.length + ' checks' })
        ]),
        verificationRows.length
          ? element('div', { class: 'workspace-detail-list' }, verificationRows.map(item =>
              element('div', { class: 'workspace-detail-row' }, [
                element('strong', { text: item.title }),
                element('span', { class: 'muted small', text: item.status + (item.summary ? ' · ' + item.summary : '') })
              ])
            ))
          : element('p', { class: 'small muted', text: 'Testing expands when the code controller determines the change surface needs it.' })
      ]),
      specialistProjectSection(run, 'code')
    ]),
    element('div', { class: 'deep-workspace-actions' }, [
      button('GitHub project', () => $('openProjectSources')?.click(), 'small'),
      button('ZIP / code file', () => $('attachCodeInput')?.click(), 'small'),
      button('Terminal', () => $('openTerminal')?.click(), 'small'),
      button('Review changes', () => openWorkspaceArea('changes'), 'primary small')
    ])
  ];
}

function researchWorkspaceProject(data) {
  const run = data.run;
  const view = workspaceWorkView(run);
  const research = run?.adaptation?.researchWorkspace ?? {};
  const sourceCount = Number(research.sourceCount ?? 0);
  const evidenceCount = Number(research.evidenceCount ?? 0);
  const unresolved = Array.isArray(research.unresolvedQuestions) ? research.unresolvedQuestions.length : Number(research.unresolvedCount ?? 0);
  const conflicts = Array.isArray(research.conflicts) ? research.conflicts.length : Number(research.conflictCount ?? 0);
  const task = currentTask(run);
  const sourceStatus = sourceCount ? sourceCount + ' tracked' : 'not started';
  const evidenceStatus = conflicts ? conflicts + ' conflicts' : evidenceCount ? evidenceCount + ' evidence items' : 'awaiting evidence';
  const sources = Array.isArray(research.sourceSet) ? research.sourceSet.slice(0, 8) : [];
  const evidenceLedger = Array.isArray(research.evidenceLedger) ? research.evidenceLedger.slice(0, 8) : [];
  const gaps = Array.isArray(research.unresolvedQuestions) ? research.unresolvedQuestions.slice(0, 6) : [];

  return [
    element('div', { class: 'deep-workspace-head research' }, [
      element('div', { class: 'deep-workspace-identity' }, [
        element('span', { class: 'deep-workspace-kicker', text: 'RESEARCH PROJECT' }),
        element('strong', { text: research.activeQuestion || run?.goal || 'Research project' }),
        element('span', { class: 'muted small', text: workspaceValue(research.status, 'Evidence-first investigation') })
      ]),
      element('div', {
        class: 'deep-workspace-state',
        role: 'status',
        'aria-live': 'polite',
        'data-state': run?.state || 'ready'
      }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', {
          text: view.terminal || view.waiting || view.disconnected ? view.label : run ? 'investigating' : 'ready'
        })
      ])
    ]),
    workspaceNavigation('research', [['overview', 'Overview'], ['activity', 'Activity'], ['sources', 'Sources'], ['evidence', 'Evidence'], ['gaps', 'Gaps'], ['team', 'Team']]),
    element('div', workspaceArea('research', 'overview', 'deep-workspace-grid'), [
      element('section', { class: 'deep-workspace-card project-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'SOURCE SET' }),
          element('span', { class: 'small muted', text: sourceStatus })
        ]),
        element('strong', { text: research.rootQuestion || research.activeQuestion || run?.goal || 'Research question' }),
        element('div', { class: 'deep-workspace-metrics' }, [
          metric('Sources', String(sourceCount), false),
          metric('Evidence', String(evidenceCount), false),
          metric('History', String(Array.isArray(research.history) ? research.history.length : 0), false)
        ])
      ]),
      element('section', { class: 'deep-workspace-card work-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'INVESTIGATION' }),
          element('span', { class: 'small muted', text: task?.status || 'ready' })
        ]),
        element('strong', { text: task ? taskLabel(task) : view.label }),
        element('p', { class: 'small muted', text: currentStatus(run) }),
        element('div', { class: 'deep-workspace-badges' }, [
          badge('Evidence', evidenceStatus),
          badge('Open gaps', String(unresolved)),
          badge('Conflicts', String(conflicts))
        ])
      ])
    ]),
    element('div', { class: 'deep-workspace-section-grid' }, [
      workspaceActivitySection(run, 'research'),
      element('section', workspaceArea('research', 'sources', 'deep-workspace-card detail-card'), [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'SOURCE LEDGER' }),
          element('span', { class: 'small muted', text: sources.length + ' visible' })
        ]),
        sources.length
          ? element('div', { class: 'workspace-detail-list' }, sources.map(source => researchSource(source, 'sources')))
          : element('p', { class: 'small muted', text: 'Sources appear here as research evidence is gathered.' })
      ]),
      element('section', workspaceArea('research', 'evidence', 'deep-workspace-card detail-card'), [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'EVIDENCE LEDGER' }),
          element('span', { class: 'small muted', text: evidenceLedger.length + ' visible' })
        ]),
        evidenceLedger.length
          ? element('div', { class: 'workspace-detail-list' }, evidenceLedger.map((item, index) =>
              element('div', { class: 'workspace-detail-row' }, [
                element('strong', { text: text(item.summary).slice(0, 240) }),
                element('span', { class: 'muted small', text: (item.sourceKeys?.length || 0) + ' linked source' + ((item.sourceKeys?.length || 0) === 1 ? '' : 's') }),
                ...((item.sourceKeys ?? []).map(key => (research.sourceSet ?? []).find(source => source.key === key)).filter(Boolean).map(source => researchSource(source, 'evidence:' + (item.id || index))))
              ])
            ))
          : element('p', { class: 'small muted', text: 'Evidence is added only when the research step produces traceable findings.' })
      ]),
      element('section', workspaceArea('research', 'gaps', 'deep-workspace-card detail-card'), [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'OPEN GAPS' }),
          element('span', { class: 'small muted', text: gaps.length ? 'needs attention' : 'none recorded' })
        ]),
        gaps.length
          ? element('div', { class: 'workspace-detail-list' }, gaps.map(gap => element('div', { class: 'workspace-detail-row', text: gap })))
          : element('p', { class: 'small muted', text: 'No unresolved research questions are currently recorded.' })
      ]),
      specialistProjectSection(run, 'research')
    ]),
    element('div', { class: 'deep-workspace-actions' }, [
      button('Search + gather', () => $('goal')?.focus({ preventScroll: false }), 'primary small'),
      button('Review sources', () => openWorkspaceArea('sources'), 'small'),
      button('Review evidence', () => openWorkspaceArea('evidence'), 'small'),
      button('Add research direction', () => $('goal')?.focus({ preventScroll: false }), 'small')
    ])
  ];
}

function metric(label, value, mono = false) {
  return element('div', { class: 'deep-workspace-metric' }, [
    element('span', { class: 'small muted', text: label }),
    element('b', { class: mono ? 'mono' : '', text: value })
  ]);
}

function badge(label, value) {
  return element('span', { class: 'deep-workspace-badge' }, [
    element('b', { text: label }),
    element('span', { text: value })
  ]);
}

function renderDeepWorkspaceShell() {
  const host = $('deepWorkspaceShell');
  if (!host) return;
  const data = adaptiveWorkspaceState();
  const active = data.workspace === 'code' || data.workspace === 'research';
  host.hidden = !active;
  if (!active) {
    host.replaceChildren();
    return;
  }
  const focused = host.contains(document.activeElement) ? document.activeElement : null;
  const controlKey = focused?.dataset.workspaceControl;
  const areaKey = focused?.dataset.workspaceArea;
  host.dataset.workspace = data.workspace;
  host.replaceChildren(...(data.workspace === 'code' ? codeWorkspaceProject(data) : researchWorkspaceProject(data)));
  for (const control of host.querySelectorAll('.deep-workspace-actions button')) control.dataset.workspaceControl = 'action:' + control.textContent;
  if (controlKey) [...host.querySelectorAll('[data-workspace-control]')].find(control => control.dataset.workspaceControl === controlKey)?.focus({ preventScroll: true });
  else if (areaKey) host.querySelector('[data-workspace-area="' + areaKey + '"]')?.focus({ preventScroll: true });
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
  hint.textContent = data.workspace === 'code'
    ? 'Project tools appear only when the current change needs them'
    : 'Research tools appear only when the current investigation needs them';
  list.replaceChildren(...capabilityItems(data).map(item => {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'workspace-capability';
    control.disabled = !item.action;
    control.title = item.detail;
    control.dataset.ready = String(item.ready);
    control.replaceChildren(
      element('span', { class: 'workspace-capability-dot', 'aria-hidden': 'true' }),
      element('span', { class: 'workspace-capability-copy' }, [
        element('strong', { text: item.label }),
        element('small', { text: item.detail })
      ])
    );
    control.addEventListener('click', item.action);
    return control;
  }));
}

/** Lightweight controller for the selected run. Rendered from real server state;
 * buttons only invoke existing actions, and never fabricate completion. */
function runControlStrip(data) {
  const run = data.run;
  if (!run || !Array.isArray(run.tasks) || !run.tasks.length) return null;
  const view = workPresentation(run, {
    driving: state.driving === run.id || state.drivingRuns?.has(run.id) || state.busyRuns?.has(run.id),
    online: state.network?.online !== false && state.network?.reachable !== false,
    consent: state.consentNeeded?.has(run.id),
    manual: state.manualOpen?.has(run.id),
    stopping: state.stoppingRun === run.id
  });
  const active = !view.terminal && !view.waiting && !view.stopping
    && (view.live || run.state === 'queued');
  if (!active && !view.waiting && !view.disconnected) return null;
  const focus = liveWorkFocus(run, {
    workspace: data.workspace,
    connectedGitHub: state.workspaceSource?.kind === 'github',
    offline: view.disconnected, stopping: view.stopping
  });
  const showDetails = () => {
    // Only navigate to existing, server-backed progress records.
    const cards = [...document.querySelectorAll('#thread .work-status-card')];
    const card = cards.at(-1);
    if (!card) return;
    const detail = card.querySelector('[data-live-inspection]');
    if (detail) detail.open = true;
    card.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  };
  const controls = [button('Details', showDetails, 'adaptive-running-button')];
  if (focus.allowTerminal && $('openTerminal')) {
    controls.push(button('Terminal', () => $('openTerminal')?.click(), 'adaptive-running-button'));
  }
  if (active && state.run?.id === run.id) controls.push(button('Stop', () => {
    document.dispatchEvent(new CustomEvent('kindgleam:stop-current-run', { detail: { runId: run.id } }));
  }, 'adaptive-running-button stop'));
  return element('div', {
    class: 'adaptive-running-strip', 'data-running': String(view.live),
    'data-work-kind': focus.surface, 'aria-label': 'Exact current task and controls'
  }, [
    element('span', { class: 'adaptive-running-dot', 'aria-hidden': 'true' }),
    element('strong', { class: 'adaptive-running-line', text: focus.line,
      title: focus.line, role: 'status', 'aria-live': 'polite' }),
    element('div', { class: 'adaptive-running-buttons' }, controls)
  ]);
}

export function renderAdaptiveWorkspace(host, mode = 'chat') {
  if (!host) return;
  const data = adaptiveWorkspaceState();
  const surfaces = data.surfaces;

  const workspaceLabel = SURFACE_META[data.workspace === 'normal-chat' ? 'runs' : data.workspace]?.label ?? 'Normal Chat';
  // Workspace controls retain focus while their status text updates.
  const controls = host.querySelector('.adaptive-workspace-surfaces') ?? element('div', {
    class: 'adaptive-workspace-surfaces', role: 'toolbar', 'aria-label': 'Adaptive workspace surfaces'
  }, surfaces.map(name => surfaceButton(name, data.workspace === (name === 'runs' ? 'normal-chat' : name))));
  const focus = controls.contains(document.activeElement) ? document.activeElement : null;
  const actionFocus = host.contains(document.activeElement) && document.activeElement?.classList?.contains('adaptive-running-button')
    ? document.activeElement.textContent : null;
  for (const control of controls.querySelectorAll('[data-surface]')) {
    const active = data.workspace === (control.dataset.surface === 'runs' ? 'normal-chat' : control.dataset.surface);
    control.classList.toggle('adaptive-active', active);
    control.setAttribute('aria-pressed', String(active));
  }
  host.replaceChildren(
    element('div', { class: 'adaptive-workspace-main' }, [
      element('span', { class: 'adaptive-workspace-dot' }),
      element('div', { class: 'adaptive-workspace-copy' }, [
        element('span', { class: 'adaptive-workspace-kicker', text: data.workspace === 'normal-chat' && data.run
          ? 'Normal Chat · ' + data.lens.label : workspaceLabel }),
        element('strong', { class: 'truncate', text: data.focus }),
        element('span', { class: 'muted small truncate', text: data.status, role: 'status', 'aria-live': 'polite' }),
        data.workspace === 'normal-chat' && data.run
          ? element('span', { class: 'adaptive-lens-hint muted small', text: data.lens.hint }) : null
      ])
    ]),
    controls,
    runControlStrip(data),
    normalChatToolStrip(data),
    adaptiveNextActions(data)
  );
  if (focus) focus.focus({ preventScroll: true });
  else if (actionFocus) [...host.querySelectorAll('.adaptive-running-button')].find(node => node.textContent === actionFocus)?.focus({ preventScroll: true });
  host.dataset.surfaceCount = String(surfaces.length);
  host.dataset.mode = mode;
  host.dataset.workspace = data.workspace;
  host.setAttribute('aria-label', workspaceLabel + ' · ' + data.status);
}

export function syncAdaptiveWorkspace() {
  renderAdaptiveWorkspace($('adaptiveWorkspaceBar'), 'chat');
  renderDeepWorkspaceShell();
  renderCapabilityDock();

  const data = adaptiveWorkspaceState();
  const selected = ['code', 'research'].includes(state.activeSurface)
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

// Update lightweight workspace suggestions while the person types.
// This never starts a model call or alters the current workspace.
if (typeof document !== 'undefined') {
  document.addEventListener('input', event => {
    if (event.target?.id === 'goal') {
      renderAdaptiveWorkspace($('adaptiveWorkspaceBar'), 'chat');
    }
  });
}
