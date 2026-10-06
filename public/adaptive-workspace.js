/**
 * Situation-driven workspace presentation.
 *
 * This module does not own workflow decisions. The server's run state
 * remains authoritative; this only turns that state into the smallest
 * useful set of visible workspace surfaces and a clear current focus.
 */
import { state, $, element, button, api, notify } from './ui-core.js';

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
  // All four operating envelopes stay reachable. "Needed" is communicated by
  // the active surface and adaptive status, not by hiding a workspace the
  // person may intentionally choose for the next step.
  const surfaces = new Set(['runs', 'design', 'code', 'research']);
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
  const selected = ['code', 'research', 'design', 'normal-chat'].includes(state.activeSurface) ? state.activeSurface : null;
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
  if (!tasks.length) return null;

  const current = tasks.find(task => task.id === run.next)
    ?? tasks.find(task => !['complete', 'skipped'].includes(task.status))
    ?? null;
  const snapshot = progressSnapshot(run);
  const status = currentStatus(run);
  const active = ['running', 'queued'].includes(run?.state) || Boolean(current);
  const connectionLost = state.network?.online === false || state.network?.reachable === false;
  const doneLabel = snapshot.completed
    ? snapshot.completed + ' done'
    : 'Just started';
  const liveLabel = current
    ? 'Current focus · ' + taskLabel(current)
    : run?.state === 'complete'
      ? 'All required work is complete'
      : 'Adapting the next step';
  const stats = [
    ['Progress', snapshot.completed + '/' + Math.max(tasks.length, snapshot.completed + snapshot.active), doneLabel],
    ...(snapshot.files ? [['Files', String(snapshot.files), snapshot.images ? snapshot.images + ' image' + (snapshot.images === 1 ? '' : 's') : 'working set']] : []),
    ...(snapshot.sources || snapshot.evidence ? [['Evidence', String(snapshot.evidence), snapshot.sources + ' source' + (snapshot.sources === 1 ? '' : 's')]] : []),
    ...(snapshot.tests ? [['Checks', String(snapshot.tests), snapshot.verified ? snapshot.verified + ' verified' : 'verification active']] : [])
  ].slice(0, 3);

  const meter = element('div', {
    class: 'work-progress-meter' + (run?.state === 'complete' ? ' is-complete' : ''),
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(snapshot.coverage),
    'aria-label': 'Materialized workflow coverage'
  }, [element('i', { style: 'width:' + snapshot.coverage + '%' })]);

  const visible = tasks.slice(-5);
  return element('div', {
    class: 'work-timeline' + (connectionLost ? ' is-disconnected' : ''),
    'aria-label': 'Adaptive work progress'
  }, [
    element('div', { class: 'work-timeline-head' }, [
      element('div', { class: 'work-status-summary' }, [
        element('span', { class: 'work-status-dot' + (active ? ' active' : ''), 'aria-hidden': 'true' }),
        element('div', { class: 'work-status-copy' }, [
          element('strong', { text: status }),
          element('span', { class: 'small muted', text: liveLabel })
        ])
      ]),
      element('span', {
        class: 'small work-status-state',
        text: run?.state === 'complete' ? 'Done' : run?.state === 'blocked' ? 'Blocked' : run?.state === 'waiting' ? 'Waiting' : 'Live'
      })
    ]),
    connectionLost
      ? element('div', { class: 'work-connection-banner', role: 'status', 'aria-live': 'polite' }, [
          element('span', { class: 'work-connection-dot', 'aria-hidden': 'true' }),
          element('div', {}, [
            element('strong', { text: 'Connection lost' }),
            element('span', { class: 'small muted', text: 'Your work is kept on the server. Reconnecting will resume the live view automatically.' })
          ])
        ])
      : null,
    element('div', { class: 'work-progress-track' }, [meter]),
    element('div', { class: 'work-progress-hint small muted', text: 'Coverage reflects only work materialized so far; the workflow can expand or contract as evidence changes.' }),
    element('div', { class: 'work-progress-caption' }, [
      element('span', { class: 'small muted', text: snapshot.coverage >= 100 ? 'Current work set complete' : snapshot.completed ? snapshot.completed + ' materialized step' + (snapshot.completed === 1 ? '' : 's') + ' finished' : 'Starting' }),
      element('span', { class: 'small muted', text: snapshot.active ? 'Working now' : snapshot.pending ? 'Next step adapts from evidence' : 'No unnecessary work queued' })
    ]),
    element('div', { class: 'work-status-grid adaptive-progress-grid' }, stats.map(([label, value, detail]) =>
      element('div', { class: 'work-status-item' }, [
        element('span', { class: 'small muted', text: label }),
        element('strong', { text: value }),
        element('span', { class: 'small muted', text: detail })
      ])
    )),
    snapshot.failed || snapshot.conflicts || snapshot.gaps
      ? element('div', { class: 'work-progress-alerts' }, [
          snapshot.failed ? element('span', { class: 'pill bad', text: snapshot.failed + ' step' + (snapshot.failed === 1 ? '' : 's') + ' needs attention' }) : null,
          snapshot.conflicts ? element('span', { class: 'pill warn', text: snapshot.conflicts + ' evidence conflict' + (snapshot.conflicts === 1 ? '' : 's') }) : null,
          snapshot.gaps ? element('span', { class: 'pill warn', text: snapshot.gaps + ' open research gap' + (snapshot.gaps === 1 ? '' : 's') }) : null
        ].filter(Boolean))
      : null,
    element('details', { class: 'work-timeline-details' }, [
      element('summary', { class: 'small', text: 'See work already completed' }),
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
function designDefaults() {
  return {
    version: 1,
    canvas: { width: 1200, height: 720, background: '#ffffff' },
    guides: { grid: 24, snap: true, showGrid: true },
    selected: null,
    previewing: false,
    objects: [
      { id: 'design-title', kind: 'text', x: 80, y: 70, width: 420, height: 64, text: 'Your design', fontSize: 34, z: 2, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#15171c' },
      { id: 'design-card', kind: 'rect', x: 80, y: 170, width: 520, height: 260, text: '', z: 1, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#eef2ff' }
    ]
  };
}

function clampDesignNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalizeDesignState(input = {}) {
  const base = designDefaults();
  const source = input && typeof input === 'object' ? input : {};
  const canvas = source.canvas && typeof source.canvas === 'object' ? source.canvas : {};
  const objects = Array.isArray(source.objects) ? source.objects.slice(0, 256) : base.objects;
  return {
    version: 1,
    canvas: {
      width: clampDesignNumber(canvas.width, 320, 4096, base.canvas.width),
      height: clampDesignNumber(canvas.height, 240, 4096, base.canvas.height),
      background: String(canvas.background || base.canvas.background).slice(0, 32)
    },
    guides: {
      grid: clampDesignNumber(source.guides?.grid, 4, 128, base.guides.grid),
      snap: source.guides?.snap !== false,
      showGrid: source.guides?.showGrid !== false
    },
    selected: String(source.selected || ''),
    previewing: source.previewing === true,
    objects: objects.map((item, index) => ({
      id: String(item?.id || 'design-object-' + index).slice(0, 80),
      kind: ['text', 'rect', 'circle', 'image'].includes(item?.kind) ? item.kind : 'rect',
      x: clampDesignNumber(item?.x, -4096, 4096, 0),
      y: clampDesignNumber(item?.y, -4096, 4096, 0),
      width: clampDesignNumber(item?.width, 8, 4096, 160),
      height: clampDesignNumber(item?.height, 8, 4096, 100),
      text: String(item?.text || '').slice(0, 2000),
      fontSize: clampDesignNumber(item?.fontSize, 6, 320, 24),
      z: clampDesignNumber(item?.z, -10000, 10000, index),
      rotation: clampDesignNumber(item?.rotation, -360, 360, 0),
      opacity: clampDesignNumber(item?.opacity, 0, 1, 1),
      visible: item?.visible !== false,
      locked: item?.locked === true,
      fill: String(item?.fill || '#eef2ff').slice(0, 32),
      assetId: String(item?.assetId || '').slice(0, 80),
      assetName: String(item?.assetName || '').slice(0, 200)
    }))
  };
}

let hydratedDesignRunId = null;
let hydratingDesignRunId = null;
let designSaveTimer = null;

function designWorkspaceState() {
  if (!state.designWorkspace) state.designWorkspace = designDefaults();
  state.designWorkspace = normalizeDesignState(state.designWorkspace);
  return state.designWorkspace;
}

function ensureDesignStateLoaded(runId) {
  if (!runId || hydratedDesignRunId === runId || hydratingDesignRunId === runId) return;
  state.designWorkspace = designDefaults();
  hydratingDesignRunId = runId;
  api('GET', '/api/runs/' + encodeURIComponent(runId) + '/design-state', undefined, { timeoutMs: 8_000 })
    .then(payload => {
      if (hydratingDesignRunId !== runId) return;
      state.designWorkspace = normalizeDesignState(payload?.state ?? {});
      hydratedDesignRunId = runId;
      renderDeepWorkspaceShell();
    })
    .catch(() => {
      // The design remains locally usable if the server is temporarily offline.
      hydratedDesignRunId = runId;
    })
    .finally(() => {
      if (hydratingDesignRunId === runId) hydratingDesignRunId = null;
    });
}

function persistDesignState(runId) {
  if (!runId) return;
  const snapshot = JSON.parse(JSON.stringify(normalizeDesignState(designWorkspaceState())));
  clearTimeout(designSaveTimer);
  designSaveTimer = setTimeout(() => {
    api('PUT', '/api/runs/' + encodeURIComponent(runId) + '/design-state', { state: snapshot }, {
      timeoutMs: 10_000,
      idempotencyKey: 'design-' + runId + '-' + crypto.randomUUID()
    }).catch(() => {
      // The next mutation will retry; offline work remains in this tab.
    });
  }, 300);
}

function designCanvasNode(item, selectedId, rerender, canvas) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'design-canvas-object ' + item.kind + (item.id === selectedId ? ' selected' : '');
  node.disabled = item.locked;
  node.style.left = item.x + 'px';
  node.style.top = item.y + 'px';
  node.style.width = item.width + 'px';
  node.style.height = item.height + 'px';
  node.style.zIndex = String(item.z + 10000);
  node.style.opacity = String(item.visible ? item.opacity : 0);
  node.style.transform = 'rotate(' + item.rotation + 'deg)';
  node.style.background = item.kind === 'text' || item.kind === 'image' ? 'transparent' : item.fill;
  if (item.kind === 'text') {
    node.textContent = item.text || 'Text';
    node.style.fontSize = item.fontSize + 'px';
    node.style.color = item.fill;
  } else if (item.kind === 'circle') {
    node.textContent = '';
  } else if (item.kind === 'image' && item.assetId) {
    const image = element('img', {
      src: '/api/objects/' + encodeURIComponent(item.assetId) + '/content?preview=1',
      alt: item.assetName || 'Design asset',
      draggable: 'false'
    });
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.objectFit = 'cover';
    image.style.pointerEvents = 'none';
    node.append(image);
  } else {
    node.textContent = item.text || '';
  }

  let drag = null;
  node.addEventListener('pointerdown', event => {
    if (item.locked || designWorkspaceState().previewing) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const design = designWorkspaceState();
    design.selected = item.id;
    drag = { pointerId: event.pointerId, x: item.x, y: item.y, clientX: event.clientX, clientY: event.clientY, sx: rect.width / design.canvas.width, sy: rect.height / design.canvas.height };
    node.setPointerCapture?.(event.pointerId);
  });
  node.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rawX = drag.x + (event.clientX - drag.clientX) / Math.max(drag.sx, 0.01);
    const rawY = drag.y + (event.clientY - drag.clientY) / Math.max(drag.sy, 0.01);
    const current = designWorkspaceState();
    const grid = current.guides.snap ? current.guides.grid : 1;
    item.x = clampDesignNumber(Math.round(rawX / grid) * grid, -4096, 4096, item.x);
    item.y = clampDesignNumber(Math.round(rawY / grid) * grid, -4096, 4096, item.y);
    node.style.left = item.x + 'px';
    node.style.top = item.y + 'px';
  });
  node.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    persistDesignState(lastRun()?.id);
    rerender(true);
  });
  node.addEventListener('pointercancel', () => { drag = null; });

  node.addEventListener('click', event => {
    event.stopPropagation();
    const design = designWorkspaceState();
    design.selected = item.id;
    rerender(true);
  });
  return node;
}

function escapeSvg(value) {
  return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

async function buildDesignSvg(design) {
  const imageData = new Map();
  for (const item of design.objects.filter(candidate => candidate.kind === 'image' && candidate.assetId)) {
    const url = '/api/objects/' + encodeURIComponent(item.assetId) + '/content?preview=1';
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) continue;
      const blob = await response.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      imageData.set(item.assetId, 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary));
    } catch {}
  }
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + design.canvas.width + '" height="' + design.canvas.height + '" viewBox="0 0 ' + design.canvas.width + ' ' + design.canvas.height + '">',
    '<rect width="100%" height="100%" fill="' + escapeSvg(design.canvas.background) + '"/>'
  ];
  for (const item of [...design.objects].sort((a,b) => a.z - b.z)) {
    if (!item.visible || item.opacity <= 0) continue;
    const transform = 'rotate(' + item.rotation + ' ' + (item.x + item.width / 2) + ' ' + (item.y + item.height / 2) + ')';
    const opacity = ' opacity="' + item.opacity + '"';
    if (item.kind === 'text') {
      parts.push('<text x="' + item.x + '" y="' + (item.y + item.fontSize) + '" font-size="' + item.fontSize + '" fill="' + escapeSvg(item.fill) + '"' + opacity + ' transform="' + transform + '">' + escapeSvg(item.text || 'Text') + '</text>');
    } else if (item.kind === 'circle') {
      parts.push('<circle cx="' + (item.x + item.width / 2) + '" cy="' + (item.y + item.height / 2) + '" r="' + Math.min(item.width, item.height) / 2 + '" fill="' + escapeSvg(item.fill) + '"' + opacity + ' transform="' + transform + '"/>');
    } else if (item.kind === 'image' && imageData.has(item.assetId)) {
      parts.push('<image x="' + item.x + '" y="' + item.y + '" width="' + item.width + '" height="' + item.height + '" href="' + imageData.get(item.assetId) + '" preserveAspectRatio="xMidYMid slice"' + opacity + ' transform="' + transform + '"/>');
    } else {
      parts.push('<rect x="' + item.x + '" y="' + item.y + '" width="' + item.width + '" height="' + item.height + '" rx="10" fill="' + escapeSvg(item.fill) + '"' + opacity + ' transform="' + transform + '"/>');
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

async function exportDesignSvg(design) {
  const svg = await buildDesignSvg(design);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'kindgleam-design.svg';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveDesignSvg(design, runId) {
  if (!runId) return;
  const svg = await buildDesignSvg(design);
  let binary = '';
  const bytes = new TextEncoder().encode(svg);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const saved = await api('POST', '/api/objects', {
    name: 'design-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.svg',
    type: 'design-export',
    contentType: 'image/svg+xml',
    content: btoa(binary),
    encoding: 'base64',
    visibility: runId && lastRun()?.visibility === 'workspace' ? 'workspace' : 'private',
    provenance: {
      source: 'design-workspace-export',
      runId,
      canvas: { width: design.canvas.width, height: design.canvas.height },
      objectCount: design.objects.length
    }
  }, { timeoutMs: 30_000, idempotencyKey: 'design-export-' + crypto.randomUUID() });
  document.dispatchEvent(new CustomEvent('kindgleam:object-created', { detail: { object: saved, runId } }));
}

function duplicateDesignObject(design, selected) {
  if (!selected) return;
  const copy = { ...selected, id: 'design-object-' + crypto.randomUUID().slice(0, 8), x: selected.x + 24, y: selected.y + 24, z: Math.max(...design.objects.map(item => item.z), 0) + 1 };
  design.objects.push(copy);
  design.selected = copy.id;
}

function designWorkspaceProject(data) {
  const design = designWorkspaceState();
  ensureDesignStateLoaded(data.run?.id);
  const selected = design.objects.find(item => item.id === design.selected) ?? null;
  const attachedImages = [
    ...(Array.isArray(data.run?.adaptation?.attachments) ? data.run.adaptation.attachments : []),
    ...(Array.isArray(state.attachments) ? state.attachments : [])
  ].filter(item => /^image\//i.test(String(item?.contentType ?? item?.type ?? '')));
  const redraw = (save = false) => {
    if (save) persistDesignState(data.run?.id || lastRun()?.id);
    renderDeepWorkspaceShell();
  };

  const canvas = element('div', { class: 'design-canvas', role: 'application', 'aria-label': 'Design canvas' }, [
    element('div', { class: 'design-canvas-grid', 'aria-hidden': 'true' })
  ]);
  canvas.style.width = design.canvas.width + 'px';
  canvas.style.height = design.canvas.height + 'px';
  canvas.style.background = design.canvas.background;
  canvas.dataset.grid = design.guides.showGrid ? 'on' : 'off';
  canvas.style.setProperty('--design-grid-size', design.guides.grid + 'px');
  canvas.addEventListener('click', () => {
    design.selected = null;
    redraw(true);
  });
  for (const item of [...design.objects].sort((a,b) => a.z - b.z)) {
    canvas.append(designCanvasNode(item, design.selected, redraw, canvas));
  }

  const addObject = kind => {
    const id = 'design-' + kind + '-' + crypto.randomUUID().slice(0, 8);
    const topZ = Math.max(...design.objects.map(item => item.z), 0) + 1;
    const defaults = kind === 'text'
      ? { x: 90, y: 470, width: 380, height: 60, text: 'New text', fontSize: 24, fill: '#15171c' }
      : kind === 'circle'
        ? { x: 640, y: 180, width: 160, height: 160, fill: '#6366f1', text: '' }
        : { x: 650, y: 380, width: 220, height: 140, fill: '#eef2ff', text: '' };
    design.objects.push({ id, kind, ...defaults, z: topZ, rotation: 0, opacity: 1, visible: true, locked: false });
    design.selected = id;
    redraw(true);
  };
  const addImage = asset => {
    if (!asset?.id) return;
    const id = 'design-image-' + crypto.randomUUID().slice(0, 8);
    design.objects.push({
      id, kind: 'image', x: 120, y: 120, width: 360, height: 240,
      text: '', fontSize: 24, z: Math.max(...design.objects.map(item => item.z), 0) + 1,
      rotation: 0, opacity: 1, visible: true, locked: false,
      fill: '#ffffff', assetId: asset.id, assetName: asset.name || 'Image'
    });
    design.selected = id;
    redraw(true);
  };
  const updateSelected = (key, value) => {
    if (!selected) return;
    if (['x','y','width','height','fontSize','z','rotation','opacity'].includes(key)) {
      const bounds = key === 'opacity' ? [0,1] : key === 'fontSize' ? [6,320] : key === 'rotation' ? [-360,360] : [-4096,4096];
      selected[key] = clampDesignNumber(value, bounds[0], bounds[1], selected[key]);
    } else {
      selected[key] = String(value ?? '').slice(0, key === 'text' ? 2000 : 200);
    }
    persistDesignState(data.run?.id || lastRun()?.id);
    renderDeepWorkspaceShell();
  };
  const moveLayer = direction => {
    if (!selected) return;
    const ordered = [...design.objects].sort((a,b) => a.z - b.z);
    const index = ordered.findIndex(item => item.id === selected.id);
    const target = ordered[index + direction];
    if (!target) return;
    const z = selected.z;
    selected.z = target.z;
    target.z = z;
    persistDesignState(data.run?.id || lastRun()?.id);
    renderDeepWorkspaceShell();
  };
  const align = how => {
    if (!selected) return;
    if (how === 'left') selected.x = 0;
    if (how === 'center') selected.x = (design.canvas.width - selected.width) / 2;
    if (how === 'right') selected.x = design.canvas.width - selected.width;
    if (how === 'top') selected.y = 0;
    if (how === 'middle') selected.y = (design.canvas.height - selected.height) / 2;
    if (how === 'bottom') selected.y = design.canvas.height - selected.height;
    persistDesignState(data.run?.id || lastRun()?.id);
    renderDeepWorkspaceShell();
  };
  return [
    element('div', { class: 'deep-workspace-head design' }, [
      element('div', { class: 'deep-workspace-identity' }, [
        element('span', { class: 'deep-workspace-kicker', text: 'DESIGN WORKSPACE' }),
        element('strong', { text: data.run?.goal || 'Visual design studio' }),
        element('span', { class: 'muted small', text: design.objects.length + ' objects · durable canvas state' })
      ]),
      element('div', { class: 'deep-workspace-state' }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', { text: data.run?.state === 'complete' ? 'verified' : data.run ? 'active' : 'ready' })
      ])
    ]),
    element('div', { class: 'design-studio-toolbar' }, [
      button('Select', () => { design.selected = null; renderDeepWorkspaceShell(); }, 'small'),
      button('Text', () => addObject('text'), 'small'),
      button('Rectangle', () => addObject('rect'), 'small'),
      button('Circle', () => addObject('circle'), 'small'),
      button('Duplicate', () => { duplicateDesignObject(design, selected); persistDesignState(data.run?.id); renderDeepWorkspaceShell(); }, 'small'),
      button('Bring forward', () => moveLayer(1), 'small'),
      button('Send backward', () => moveLayer(-1), 'small'),
      button('Add assets', () => $('attachBtn')?.click(), 'small'),
      button(design.guides.snap ? 'Snap on' : 'Snap off', () => {
        design.guides.snap = !design.guides.snap;
        persistDesignState(data.run?.id);
        renderDeepWorkspaceShell();
      }, 'small'),
      button(design.guides.showGrid ? 'Grid on' : 'Grid off', () => {
        design.guides.showGrid = !design.guides.showGrid;
        persistDesignState(data.run?.id);
        renderDeepWorkspaceShell();
      }, 'small'),
      !design.previewing ? button('Save SVG to Files', () => saveDesignSvg(design, data.run?.id)
        .then(() => notify('runNotice', 'ok', 'Design SVG saved to Files.'))
        .catch(error => notify('runNotice', 'warn', error?.message || 'Design export could not be saved.')), 'small') : null,
      !design.previewing ? button('Preview', () => { design.previewing = true; persistDesignState(data.run?.id); redraw(false); }, 'small') : button('Exit preview', () => { design.previewing = false; persistDesignState(data.run?.id); redraw(false); }, 'primary small'),
      !design.previewing ? button('Export SVG', () => exportDesignSvg(design), 'small') : null
    ].filter(Boolean)),
    element('div', { class: 'design-studio-layout' }, [
      element('aside', { class: 'design-assets-panel' }, [
        element('div', { class: 'design-panel-head' }, [
          element('strong', { text: 'Assets' }),
          element('span', { class: 'small muted', text: attachedImages.length + ' image' + (attachedImages.length === 1 ? '' : 's') })
        ]),
        attachedImages.length
          ? element('div', { class: 'design-asset-grid' }, attachedImages.slice(0, 24).map(asset =>
              element('button', { class: 'design-asset-tile', type: 'button', title: 'Place on canvas: ' + (asset.name || 'Image'), onclick: () => addImage(asset) }, [
                element('img', {
                  src: '/api/objects/' + encodeURIComponent(asset.id) + '/content?preview=1',
                  alt: asset.name || 'Design asset',
                  loading: 'lazy'
                }),
                element('span', { class: 'small truncate', text: asset.name || 'Image' })
              ])
            ))
          : element('div', { class: 'design-panel-empty', text: 'Attach images or files to place them on the canvas.' }),
        element('div', { class: 'design-layer-section' }, [
          element('div', { class: 'design-panel-head' }, [
            element('strong', { text: 'Layers' }),
            element('span', { class: 'small muted', text: design.objects.length + ' objects' })
          ]),
          element('div', { class: 'design-layer-list' }, [...design.objects].sort((a,b) => b.z - a.z).map(layer => {
            const active = layer.id === design.selected;
            return element('button', {
              class: 'design-layer-row' + (active ? ' selected' : ''),
              type: 'button',
              title: layer.locked ? 'Locked layer' : 'Select layer',
              onclick: () => { design.selected = layer.id; renderDeepWorkspaceShell(); }
            }, [
              element('span', { class: 'design-layer-kind', text: layer.kind }),
              element('span', { class: 'design-layer-name', text: layer.assetName || layer.text || layer.kind }),
              element('span', { class: 'design-layer-state', text: (layer.locked ? 'locked ' : '') + (layer.visible ? '' : 'hidden') })
            ]);
          }))
        ])
      ]),
      element('section', { class: 'design-canvas-panel' }, [
        element('div', { class: 'design-canvas-head' }, [
          element('span', { class: 'mono', text: 'CANVAS' }),
          element('span', { class: 'small muted', text: design.canvas.width + ' × ' + design.canvas.height })
        ]),
        canvas
      ]),
      element('aside', { class: 'design-inspector' }, [
        element('div', { class: 'design-panel-head' }, [
          element('strong', { text: 'Inspector' }),
          element('span', { class: 'small muted', text: selected ? selected.kind : 'canvas' })
        ]),
        selected ? element('div', { class: 'design-inspector-fields' }, [
          ...[['x', selected.x], ['y', selected.y], ['width', selected.width], ['height', selected.height], ['rotation', selected.rotation], ['opacity', selected.opacity], ['z', selected.z]].map(([key, value]) => fieldInput(key, value, updateSelected)),
          ...(selected.kind === 'text' ? [['fontSize', selected.fontSize]] : []).map(([key, value]) => fieldInput(key, value, updateSelected)),
          element('label', { class: 'design-inspector-check' }, [
            element('span', { text: 'Visible' }),
            element('input', { type: 'checkbox', checked: selected.visible, onchange: () => { selected.visible = !selected.visible; persistDesignState(data.run?.id); renderDeepWorkspaceShell(); } })
          ]),
          element('label', { class: 'design-inspector-check' }, [
            element('span', { text: 'Locked' }),
            element('input', { type: 'checkbox', checked: selected.locked, onchange: () => { selected.locked = !selected.locked; persistDesignState(data.run?.id); renderDeepWorkspaceShell(); } })
          ]),
          element('label', {}, [
            element('span', { text: 'Fill / text color' }),
            element('input', { type: 'text', value: selected.fill, maxlength: '32', onchange: event => updateSelected('fill', event.target.value) })
          ])
        ]) : element('div', { class: 'design-panel-empty', text: 'Select an object, or edit the canvas below.' }),
        element('div', { class: 'design-align-tools' }, ['left','center','right','top','middle','bottom'].map(how => button(how, () => align(how), 'small'))),
        element('hr', { class: 'design-inspector-rule' }),
        element('div', { class: 'design-inspector-fields' }, [
          fieldInput('canvas.width', design.canvas.width, (_, value) => { design.canvas.width = clampDesignNumber(value, 320, 4096, design.canvas.width); persistDesignState(data.run?.id); renderDeepWorkspaceShell(); }),
          fieldInput('canvas.height', design.canvas.height, (_, value) => { design.canvas.height = clampDesignNumber(value, 240, 4096, design.canvas.height); persistDesignState(data.run?.id); renderDeepWorkspaceShell(); }),
          element('label', {}, [
            element('span', { text: 'Canvas background' }),
            element('input', { type: 'text', value: design.canvas.background, maxlength: '32', onchange: event => { design.canvas.background = event.target.value.slice(0,32); persistDesignState(data.run?.id); renderDeepWorkspaceShell(); } })
          ])
        ]),
        selected ? button('Delete object', () => {
          design.objects = design.objects.filter(item => item.id !== selected.id);
          design.selected = null;
          persistDesignState(data.run?.id);
          renderDeepWorkspaceShell();
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
  input.step = key === 'opacity' ? '0.05' : '1';
  input.value = String(value ?? 0);
  input.setAttribute('aria-label', key);
  input.addEventListener('change', () => onChange(key, input.value));
  return element('label', { class: 'design-inspector-field' }, [
    element('span', { class: 'small muted', text: key }),
    input
  ]);
}

function capabilityItems(data) {
  const run = data.run;
  const source = state.workspaceSource;


  if (data.workspace === 'design') {
    const run = data.run;
    const required = new Set((run?.capabilities?.required ?? []).map(text));
    return [
      { id:'canvas', label:'Canvas', detail:'editable composition', action:()=>renderDeepWorkspaceShell(), ready:true },
      { id:'assets', label:'Assets', detail:'images and visual inputs', action:()=>$('attachBtn')?.click(), ready:true },
      { id:'generate', label:'Generate / edit', detail:required.has('image-generation') ? 'needed for this run' : 'on demand', action:()=>{ $('goal')?.focus({preventScroll:false}); }, ready:true },
      { id:'preview', label:'Preview', detail:'check the current visual result', action:()=>{ designWorkspaceState().previewing = true; renderDeepWorkspaceShell(); }, ready:true },
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
  const lastChange = run?.adaptation?.unifiedWorkContext?.lastChange ?? {};
  const changedFiles = [
    ...(Array.isArray(lastChange?.files) ? lastChange.files : []),
    ...(Array.isArray(lastChange?.deleted) ? lastChange.deleted : [])
  ].filter(Boolean).slice(0, 12);
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
    element('div', { class: 'deep-workspace-section-grid' }, [
      element('section', { class: 'deep-workspace-card detail-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'CHANGE SURFACE' }),
          element('span', { class: 'small muted', text: changedFiles.length ? changedFiles.length + ' paths' : 'no recorded change yet' })
        ]),
        changedFiles.length
          ? element('div', { class: 'workspace-detail-list' }, changedFiles.map(path => element('code', { class: 'workspace-detail-row', text: path })))
          : element('p', { class: 'small muted', text: 'The workspace will show affected paths after a code change is recorded.' })
      ]),
      element('section', { class: 'deep-workspace-card detail-card' }, [
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
  const sources = Array.isArray(research.sourceSet) ? research.sourceSet.slice(0, 8) : [];
  const evidenceLedger = Array.isArray(research.evidenceLedger) ? research.evidenceLedger.slice(0, 8) : [];
  const gaps = Array.isArray(research.unresolvedQuestions) ? research.unresolvedQuestions.slice(0, 6) : [];

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
    element('div', { class: 'deep-workspace-section-grid' }, [
      element('section', { class: 'deep-workspace-card detail-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'SOURCE LEDGER' }),
          element('span', { class: 'small muted', text: sources.length + ' visible' })
        ]),
        sources.length
          ? element('div', { class: 'workspace-detail-list' }, sources.map(source =>
              element('a', {
                class: 'workspace-detail-row source-row',
                href: source.url || '#',
                target: source.url ? '_blank' : undefined,
                rel: source.url ? 'noopener noreferrer' : undefined,
                text: source.title || source.provider || source.url || 'Source'
              })
            ))
          : element('p', { class: 'small muted', text: 'Sources appear here as research evidence is gathered.' })
      ]),
      element('section', { class: 'deep-workspace-card detail-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'EVIDENCE LEDGER' }),
          element('span', { class: 'small muted', text: evidenceLedger.length + ' visible' })
        ]),
        evidenceLedger.length
          ? element('div', { class: 'workspace-detail-list' }, evidenceLedger.map(item =>
              element('div', { class: 'workspace-detail-row' }, [
                element('strong', { text: text(item.summary).slice(0, 240) }),
                element('span', { class: 'muted small', text: (item.sourceKeys?.length || 0) + ' linked source' + ((item.sourceKeys?.length || 0) === 1 ? '' : 's') })
              ])
            ))
          : element('p', { class: 'small muted', text: 'Evidence is added only when the research step produces traceable findings.' })
      ]),
      element('section', { class: 'deep-workspace-card detail-card' }, [
        element('div', { class: 'deep-workspace-card-head' }, [
          element('span', { class: 'mono', text: 'OPEN GAPS' }),
          element('span', { class: 'small muted', text: gaps.length ? 'needs attention' : 'none recorded' })
        ]),
        gaps.length
          ? element('div', { class: 'workspace-detail-list' }, gaps.map(gap => element('div', { class: 'workspace-detail-row', text: gap })))
          : element('p', { class: 'small muted', text: 'No unresolved research questions are currently recorded.' })
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
      surfaces.map(name => surfaceButton(name, data.workspace === (name === 'runs' ? 'normal-chat' : name))))
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
