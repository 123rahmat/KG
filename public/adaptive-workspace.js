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
  design: { label: 'Design Workspace', icon: 'image', kind: 'design' },
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
  if (run.state === 'complete') return 'Completed and verified';
  if (run.state === 'iterate') return 'Ready — you can continue or refine the result';
  if (run.state === 'blocked') return 'Blocked — a permitted path is needed';
  if (run.state === 'waiting') return 'Waiting for your input or approval';
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
  if (run?.surface === 'design' || run?.tasks?.some(task => ['design', 'visual-design', 'image-design'].includes(task.id))) return 'design';
  if (run?.surface === 'code' || run?.tasks?.some(task => ['code', 'build-code', 'test-code'].includes(task.id))) return 'code';
  if (run?.surface === 'research' || researchNeed(run)) return 'research';
  return 'normal-chat';
}

function surfaceSet(run) {
  const surfaces = new Set(['runs']);
  const selected = ['code', 'research', 'design', 'normal-chat'].includes(state.activeSurface) ? state.activeSurface : null;
  const workspace = selected ?? activeWorkspace(run);
  if (workspace === 'code') surfaces.add('code');
  if (workspace === 'research') surfaces.add('research');
  if (workspace === 'design') surfaces.add('design');
  if (fileNeed(run)) surfaces.add('objects');
  return [...surfaces];
}

function dispatchSurface(name) {
  if (name === 'design') {
    document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name: 'runs', workspace: 'design' } }));
    return;
  }
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
  const verified = tasks.filter(task => task?.type === 'verify' && task?.status === 'complete').length;
  const denominator = Math.max(1, completed + failed + active + pending);
  return {
    completed, failed, active, pending,
    coverage: Math.round((completed / denominator) * 100),
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

export function renderWorkStatus(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const visible = tasks.slice(-5);
  if (!visible.length) return null;
  const current = tasks.find(task => task.id === run.next) ?? tasks.find(task => !['complete','skipped'].includes(task.status));
  const execution = current?.evidence?.executionTarget || current?.evidence?.result?.executionTarget
    ? executionLabel(current)
    : null;
  const snapshot = progressSnapshot(run);
  const status = currentStatus(run);
  const active = run?.state === 'running' || run?.state === 'queued' || Boolean(current);
  const stats = [
    ...(snapshot.files ? [['Files', String(snapshot.files), snapshot.images ? snapshot.images + ' image' + (snapshot.images === 1 ? '' : 's') : 'working set']] : []),
    ...(snapshot.sources || snapshot.evidence ? [['Evidence', String(snapshot.evidence), snapshot.sources + ' source' + (snapshot.sources === 1 ? '' : 's')]] : []),
    ...(snapshot.tests ? [['Checks', String(snapshot.tests), snapshot.verified ? snapshot.verified + ' verified' : 'verification active']] : [])
  ];
  const meter = element('div', {
    class: 'work-progress-meter' + (run?.state === 'complete' ? ' is-complete' : ''),
    role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': String(snapshot.coverage), 'aria-label': 'Workflow graph progress'
  }, [element('i', { style: 'width:' + snapshot.coverage + '%' })]);
  return element('div', { class: 'work-timeline', 'aria-label': 'Adaptive work progress' }, [
    element('div', { class: 'work-timeline-head' }, [
      element('div', { class: 'work-status-summary' }, [
        element('span', { class: 'work-status-dot' + (active ? ' active' : ''), 'aria-hidden': 'true' }),
        element('div', { class: 'work-status-copy' }, [
          element('strong', { text: status }),
          element('span', { class: 'small muted', text: current ? 'Current focus · ' + taskLabel(current) + (execution ? ' · ' + execution : '') : 'Adaptive work status' })
        ])
      ]),
      element('span', { class: 'small muted work-status-state', text: run?.state === 'complete' ? 'Done' : run?.state === 'blocked' ? 'Blocked' : run?.state === 'waiting' ? 'Waiting' : 'Working' })
    ]),
    element('div', { class: 'work-progress-track' }, [meter]),
    stats.length
      ? element('div', { class: 'work-status-grid adaptive-progress-grid' }, stats.slice(0, 3).map(([label, value, detail]) =>
          element('div', { class: 'work-status-item' }, [
            element('span', { class: 'small muted', text: label }),
            element('strong', { text: value }),
            element('span', { class: 'small muted', text: detail })
          ])
        ))
      : null,
    snapshot.failed || snapshot.conflicts || snapshot.gaps
      ? element('div', { class: 'work-progress-alerts' }, [
          snapshot.failed ? element('span', { class: 'pill bad', text: snapshot.failed + ' step' + (snapshot.failed === 1 ? '' : 's') + ' needs attention' }) : null,
          snapshot.conflicts ? element('span', { class: 'pill warn', text: snapshot.conflicts + ' evidence conflict' + (snapshot.conflicts === 1 ? '' : 's') }) : null,
          snapshot.gaps ? element('span', { class: 'pill warn', text: snapshot.gaps + ' open research gap' + (snapshot.gaps === 1 ? '' : 's') }) : null
        ].filter(Boolean))
      : null,
    element('details', { class: 'work-timeline-details' }, [
      element('summary', { class: 'small', text: 'Work details' }),
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
    ])
  ].filter(Boolean));
}
function capabilityItems(data) {
  const run = data.run;
  const source = state.workspaceSource;
function designWorkspaceState() {
  state.designWorkspace ??= {
    selected: null,
    previewing: false,
    objects: [
      { id: 'design-title', kind: 'text', x: 80, y: 70, width: 420, height: 64, text: 'Your design', fontSize: 34 },
      { id: 'design-card', kind: 'rect', x: 80, y: 170, width: 520, height: 260, text: '' }
    ]
  };
  state.designWorkspace.objects ??= [];
  state.designWorkspace.previewing ??= false;
  return state.designWorkspace;
}

function designCanvasNode(item, selectedId, rerender) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'design-canvas-object ' + item.kind + (item.id === selectedId ? ' selected' : '');
  node.style.left = item.x + 'px';
  node.style.top = item.y + 'px';
  node.style.width = item.width + 'px';
  node.style.height = item.height + 'px';
  if (item.kind === 'text') {
    node.textContent = item.text || 'Text';
    node.style.fontSize = (item.fontSize || 24) + 'px';
  } else if (item.kind === 'circle') {
    node.textContent = '';
  } else {
    node.textContent = item.text || '';
  }
  node.addEventListener('click', event => {
    event.stopPropagation();
    const design = designWorkspaceState();
    design.selected = item.id;
    rerender();
  });
  return node;
}

function designWorkspaceProject(data) {
  const design = designWorkspaceState();
  const selected = design.objects.find(item => item.id === design.selected) ?? null;
  const attachedImages = [
    ...(Array.isArray(data.run?.adaptation?.attachments) ? data.run.adaptation.attachments : []),
    ...(Array.isArray(state.attachments) ? state.attachments : [])
  ].filter(item => /^image\\//i.test(String(item?.contentType ?? item?.type ?? '')));
  const redraw = () => renderDeepWorkspaceShell();

  const canvas = element('div', { class: 'design-canvas', role: 'application', 'aria-label': 'Design canvas' }, [
    element('div', { class: 'design-canvas-grid', 'aria-hidden': 'true' })
  ]);
  canvas.addEventListener('click', () => {
    design.selected = null;
    redraw();
  });
  for (const item of design.objects) canvas.append(designCanvasNode(item, design.selected, redraw));

  const addObject = kind => {
    const id = 'design-' + kind + '-' + crypto.randomUUID().slice(0, 8);
    const defaults = kind === 'text'
      ? { x: 90, y: 470, width: 380, height: 60, text: 'New text', fontSize: 24 }
      : kind === 'circle'
        ? { x: 640, y: 180, width: 160, height: 160, text: '' }
        : { x: 650, y: 380, width: 220, height: 140, text: '' };
    design.objects.push({ id, kind, ...defaults });
    design.selected = id;
    redraw();
  };

  const updateSelected = (key, value) => {
    if (!selected) return;
    const number = Number(value);
    selected[key] = Number.isFinite(number) ? number : value;
    redraw();
  };

  return [
    element('div', { class: 'deep-workspace-head design' }, [
      element('div', { class: 'deep-workspace-identity' }, [
        element('span', { class: 'deep-workspace-kicker', text: 'DESIGN WORKSPACE' }),
        element('strong', { text: data.run?.goal || 'Visual design studio' }),
        element('span', { class: 'muted small', text: 'Canvas · assets · composition · preview' })
      ]),
      element('div', { class: 'deep-workspace-state' }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', { text: data.run?.state === 'complete' ? 'verified' : data.run ? 'active' : 'ready' })
      ])
    ]),
    element('div', { class: 'design-studio-toolbar' }, [
      button('Select', () => {}, 'primary small'),
      button('Text', () => addObject('text'), 'small'),
      button('Rectangle', () => addObject('rect'), 'small'),
      button('Circle', () => addObject('circle'), 'small'),
      button('Add assets', () => $('attachBtn')?.click(), 'small'),
      design.previewing
        ? button('Exit preview', () => { design.previewing = false; redraw(); }, 'primary small')
        : null,
      !design.previewing ? button('Generate / edit', () => {
        $('goal')?.focus({ preventScroll: false });
        if (!$('goal').value.trim()) $('goal').value = 'Generate or edit the visual for this design.';
      }, 'small') : null,
      !design.previewing ? button('Preview', () => { design.previewing = true; redraw(); }, 'small') : null
    ].filter(Boolean)),
    element('div', { class: 'design-studio-layout' }, [
      element('aside', { class: 'design-assets-panel' }, [
        element('div', { class: 'design-panel-head' }, [element('strong', { text: 'Assets' }), element('span', { class: 'small muted', text: attachedImages.length + ' image' + (attachedImages.length === 1 ? '' : 's') })]),
        attachedImages.length
          ? element('div', { class: 'design-asset-grid' }, attachedImages.slice(0, 12).map(asset =>
              element('div', { class: 'design-asset-tile' }, [
                element('img', { src: '/api/objects/' + encodeURIComponent(asset.id) + '/content?preview=1', alt: asset.name || 'Design asset', loading: 'lazy' }),
                element('span', { class: 'small truncate', text: asset.name || 'Image' })
              ])
            ))
          : element('div', { class: 'design-panel-empty', text: 'Attach images or files to use them here.' })
      ]),
      element('section', { class: 'design-canvas-panel' }, [
        element('div', { class: 'design-canvas-head' }, [
          element('span', { class: 'mono', text: 'CANVAS' }),
          element('span', { class: 'small muted', text: design.objects.length + ' objects · editable' })
        ]),
        canvas
      ]),
      element('aside', { class: 'design-inspector' }, [
        element('div', { class: 'design-panel-head' }, [element('strong', { text: 'Inspector' }), element('span', { class: 'small muted', text: selected ? selected.kind : 'nothing selected' })]),
        selected ? element('div', { class: 'design-inspector-fields' }, [
          ['x', selected.x], ['y', selected.y], ['width', selected.width], ['height', selected.height],
          ...(selected.kind === 'text' ? [['fontSize', selected.fontSize || 24]] : [])
        ].map(([key, value]) => fieldInput(key, value, updateSelected))) : element('div', { class: 'design-panel-empty', text: 'Select an object to edit its geometry.' }),
        selected ? button('Delete object', () => {
          design.objects = design.objects.filter(item => item.id !== selected.id);
          design.selected = null;
          redraw();
        }, 'danger small') : null
      ])
    ]),
    element('div', { class: 'deep-workspace-actions design' }, [
      button('Research visual direction', () => document.dispatchEvent(new CustomEvent('kindgleam:select-surface', { detail: { name: 'runs', workspace: 'research' } })), 'small'),
      button('Implement in Code', () => document.dispatchEvent(new CustomEvent('kindgleam:open-code-workspace')), 'small'),
      button('Attach asset', () => $('attachBtn')?.click(), 'small'),
      button('Ask the adaptive designer', () => $('goal')?.focus({ preventScroll: false }), 'primary small')
    ])
  ];
}

function fieldInput(key, value, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.value = String(value ?? 0);
  input.setAttribute('aria-label', key);
  input.addEventListener('change', () => onChange(key, input.value));
  return element('label', { class: 'design-inspector-field' }, [
    element('span', { class: 'small muted', text: key }),
    input
  ]);
}

  if (data.workspace === 'design') {
    const run = data.run;
    const required = new Set((run?.capabilities?.required ?? []).map(text));
    return [
      { id:'canvas', label:'Canvas', detail:'editable composition', action:()=>renderDeepWorkspaceShell(), ready:true },
      { id:'assets', label:'Assets', detail:'images and visual inputs', action:()=>$('attachBtn')?.click(), ready:true },
      { id:'generate', label:'Generate / edit', detail:required.has('image-generation') ? 'needed for this run' : 'on demand', action:()=>{ $('goal')?.focus({preventScroll:false}); }, ready:true },
      { id:'preview', label:'Preview', detail:'check the current visual result', action:()=>document.dispatchEvent(new CustomEvent('kindgleam:preview-design')), ready:true },
      { id:'research', label:'Research direction', detail:'switch only when evidence is needed', action:()=>document.dispatchEvent(new CustomEvent('kindgleam:select-surface',{detail:{name:'runs',workspace:'research'}})), ready:true },
      { id:'implementation', label:'Code implementation', detail:'move to Code when software is required', action:()=>document.dispatchEvent(new CustomEvent('kindgleam:open-code-workspace')), ready:true }
    ];
  }
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

function workspaceValue(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function currentTask(run) {
  return run?.tasks?.find(task => task.id === run.next)
    ?? run?.tasks?.find(task => !['complete', 'skipped'].includes(task.status))
    ?? null;
}

function codeWorkspaceProject(data) {
  const run = data.run;
  const source = state.workspaceSource ?? {};
  const repo = workspaceValue(source.repoFullName, source.repositoryFullName, source.repo, source.repository?.fullName, source.name) || 'No GitHub project connected';
  const revision = workspaceValue(source.commitSha, source.repoRef, source.revision, source.currentRevision, source.metadata?.commitSha, run?.adaptation?.workspaceSourceRevision, run?.adaptation?.codeWorkspace?.baseRevision) || 'Revision selected by workspace';
  const attached = Array.isArray(run?.adaptation?.attachments) ? run.adaptation.attachments.length : state.attachments?.length ?? 0;
  const overlay = Array.isArray(run?.adaptation?.projectOverlay) ? run.adaptation.projectOverlay.length : 0;
  const task = currentTask(run);
  const tests = (run?.tasks ?? []).filter(item => item.type === 'code' || /test|verif/i.test(text(item?.id) + ' ' + text(item?.metadata?.title)));
  return [
    element('div', { class: 'deep-workspace-head code' }, [
      element('div', { class: 'deep-workspace-identity' }, [
        element('span', { class: 'deep-workspace-kicker', text: 'CODE PROJECT' }),
        element('strong', { text: repo }),
        element('span', { class: 'muted small', text: 'Revision · ' + revision })
      ]),
      element('div', { class: 'deep-workspace-state' }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', { text: run?.state === 'complete' ? 'verified' : run ? 'active' : 'ready' })
      ])
    ]),
    element('nav', { class: 'deep-workspace-nav', 'aria-label': 'Code project areas' }, [
      button('Overview', () => {}, 'active small'),
      button('Files', () => $('attachBtn')?.click(), 'small'),
      button('Changes', () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 'small'),
      button('Tests', () => $('openTerminal')?.click(), 'small')
    ]),
    element('div', { class: 'deep-workspace-grid' }, [
      element('section', { class: 'deep-workspace-card project-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'PROJECT' }),
          element('span', { class: 'small muted', text: source?.kind === 'github' ? 'GitHub' : attached ? 'Attached input' : 'Not connected' })
        ]),
        element('strong', { text: repo }),
        element('div', { class: 'deep-workspace-metrics' }, [
          metric('Revision', revision, true),
          metric('Attached inputs', String(attached), false),
          metric('Working overlay', String(overlay), false)
        ])
      ]),
      element('section', { class: 'deep-workspace-card work-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'CURRENT WORK' }),
          element('span', { class: 'small muted', text: task?.status || 'ready' })
        ]),
        element('strong', { text: taskLabel(task) }),
        element('p', { class: 'small muted', text: run ? currentStatus(run) : 'Start a coding request to build the project context.' }),
        element('div', { class: 'deep-workspace-badges' }, [
          badge('Tests', tests.length ? tests.length + ' tracked' : 'on demand'),
          badge('Write-back', source?.permissions?.write === true ? 'approval' : 'read-only'),
          badge('Agents', 'adaptive')
        ])
      ])
    ]),
    element('div', { class: 'deep-workspace-actions' }, [
      button('GitHub project', () => $('openProjectSources')?.click(), 'small'),
      button('ZIP / code file', () => $('attachCodeInput')?.click(), 'small'),
      button('Terminal', () => $('openTerminal')?.click(), 'small'),
      button('Review changes', () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 'primary small')
    ])
  ];
}

function researchWorkspaceProject(data) {
  const run = data.run;
  const research = run?.adaptation?.researchWorkspace ?? {};
  const sourceCount = Number(research.sourceCount ?? 0);
  const evidenceCount = Number(research.evidenceCount ?? 0);
  const unresolved = Array.isArray(research.unresolvedQuestions) ? research.unresolvedQuestions.length : Number(research.unresolvedCount ?? 0);
  const conflicts = Array.isArray(research.conflicts) ? research.conflicts.length : Number(research.conflictCount ?? 0);
  const task = currentTask(run);
  const sourceStatus = sourceCount ? sourceCount + ' tracked' : 'not started';
  const evidenceStatus = conflicts ? conflicts + ' conflicts' : evidenceCount ? evidenceCount + ' ledger items' : 'awaiting evidence';
  return [
    element('div', { class: 'deep-workspace-head research' }, [
      element('div', { class: 'deep-workspace-identity' }, [
        element('span', { class: 'deep-workspace-kicker', text: 'RESEARCH PROJECT' }),
        element('strong', { text: research.activeQuestion || run?.goal || 'Research dossier' }),
        element('span', { class: 'muted small', text: workspaceValue(research.status, 'evidence-first investigation') })
      ]),
      element('div', { class: 'deep-workspace-state' }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', { text: run?.state === 'complete' ? 'synthesized' : run ? 'investigating' : 'ready' })
      ])
    ]),
    element('nav', { class: 'deep-workspace-nav', 'aria-label': 'Research project areas' }, [
      button('Overview', () => {}, 'active small'),
      button('Sources', () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 'small'),
      button('Evidence', () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 'small'),
      button('Gaps', () => $('goal')?.focus({ preventScroll: false }), 'small')
    ]),
    element('div', { class: 'deep-workspace-grid' }, [
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
        element('strong', { text: taskLabel(task) || 'Evidence-driven next step' }),
        element('p', { class: 'small muted', text: currentStatus(run) }),
        element('div', { class: 'deep-workspace-badges' }, [
          badge('Evidence', evidenceStatus),
          badge('Open gaps', String(unresolved)),
          badge('Conflicts', String(conflicts))
        ])
      ])
    ]),
    element('div', { class: 'deep-workspace-actions' }, [
      button('Search + gather', () => $('goal')?.focus({ preventScroll: false }), 'primary small'),
      button('Review sources', () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 'small'),
      button('Review evidence', () => $('thread')?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 'small'),
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
  const active = data.workspace === 'code' || data.workspace === 'research' || data.workspace === 'design';
  host.hidden = !active;
  if (!active) {
    host.replaceChildren();
    return;
  }
  host.dataset.workspace = data.workspace;
  host.dataset.previewing = data.workspace === 'design' ? String(Boolean(designWorkspaceState().previewing)) : 'false';
  host.replaceChildren(...(data.workspace === 'code' ? codeWorkspaceProject(data) : data.workspace === 'research' ? researchWorkspaceProject(data) : designWorkspaceProject(data)));
}
function renderCapabilityDock() {
  const dock = $('workspaceCapabilityDock');
  const list = $('workspaceCapabilityList');
  const title = $('workspaceCapabilityTitle');
  const hint = $('workspaceCapabilityHint');
  if (!dock || !list) return;
  const data = adaptiveWorkspaceState();
  const active = data.workspace === 'code' || data.workspace === 'research' || data.workspace === 'design';
  dock.hidden = !active;
  if (!active) {
    list.replaceChildren();
    return;
  }
  title.textContent = data.workspace === 'code' ? 'Code Workspace' : data.workspace === 'research' ? 'Research Workspace' : 'Design Workspace';
  hint.textContent = 'Adaptive tools for this work';
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
  renderDeepWorkspaceShell();
  renderCapabilityDock();

  const data = adaptiveWorkspaceState();
  const selected = ['code', 'research', 'design'].includes(state.activeSurface)
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
