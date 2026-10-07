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
  const multi = tasks.map(task => task?.evidence?.multiAgent).filter(Boolean).at(-1)
    ?? run?.adaptation?.multiAgent
    ?? null;
  const agentStates = Array.isArray(multi?.agentStates) ? multi.agentStates : [];
  const activeAgents = agentStates
    .filter(item => ['running', 'queued', 'working'].includes(text(item?.status).toLowerCase()))
    .map(item => text(item?.role))
    .filter(Boolean);
  const completedAgents = agentStates.filter(item => item?.status === 'complete').length;

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
    toolCount: tools.size,
    activeTool,
    executionTarget,
    permission,
    permissionTone
  };
}

function progressSegments(tasks, current) {
  return element('div', {
    class: 'work-progress-segments',
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': String(Math.max(tasks.length, 1)),
    'aria-valuenow': String(tasks.filter(task => ['complete', 'skipped'].includes(task?.status)).length),
    'aria-label': 'Server-confirmed materialized steps'
  }, tasks.length
    ? tasks.map(task => {
        const tone = taskTone(task);
        const isCurrent = current?.id === task?.id;
        return element('span', {
          class: 'work-progress-segment ' + tone + (isCurrent ? ' current' : ''),
          title: taskLabel(task) + ' · ' + (task?.status || 'pending'),
          'aria-hidden': 'true'
        });
      })
    : [element('span', { class: 'work-progress-segment pending', 'aria-hidden': 'true' })]);
}

export function renderWorkStatus(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  if (!tasks.length) return null;

  const current = tasks.find(task => task.id === run.next)
    ?? tasks.find(task => !['complete', 'skipped'].includes(task.status))
    ?? null;
  const snapshot = progressSnapshot(run);
  const background = backgroundSnapshot(run);
  const connectionLost = state.network?.online === false || state.network?.reachable === false;
  const workspace = activeWorkspace(run);
  const workspaceLabel = workspace === 'code' ? 'Code' : workspace === 'research' ? 'Research' : 'NormalChat';

  const stats = workspace === 'code'
    ? [
        ['Files', String(snapshot.files), snapshot.images ? snapshot.images + ' image' + (snapshot.images === 1 ? '' : 's') : 'working set'],
        ['Checks', String(snapshot.tests), snapshot.verified ? snapshot.verified + ' verified' : 'adaptive verification'],
        ['Steps', snapshot.completed + '/' + Math.max(tasks.length, 1), snapshot.pending ? snapshot.pending + ' materialized next' : 'current set covered']
      ]
    : workspace === 'research'
      ? [
          ['Sources', String(snapshot.sources), 'tracked evidence sources'],
          ['Evidence', String(snapshot.evidence), snapshot.conflicts ? snapshot.conflicts + ' conflict' + (snapshot.conflicts === 1 ? '' : 's') : 'traceable findings'],
          ['Open gaps', String(snapshot.gaps), snapshot.gaps ? 'still being resolved' : 'none recorded']
        ]
      : [
          ['Steps', snapshot.completed + '/' + Math.max(tasks.length, 1), 'server-confirmed'],
          ...(background.toolCount ? [['Tools', String(background.toolCount), background.activeTool ? 'using ' + background.activeTool : 'used when needed']] : []),
          ['Verification', snapshot.verified ? 'Passed' : snapshot.tests ? 'Active' : 'Adaptive', snapshot.verified ? 'evidence checked' : 'only when justified']
        ];

  const backgroundItems = [
    background.activeAgents.length
      ? background.activeAgents.length + ' specialist' + (background.activeAgents.length === 1 ? '' : 's') + ' working'
      : background.completedAgents
        ? background.completedAgents + ' specialist' + (background.completedAgents === 1 ? '' : 's') + ' contributed'
        : '',
    background.toolCount ? background.toolCount + ' tool' + (background.toolCount === 1 ? '' : 's') + ' in scope' : '',
    background.executionTarget ? 'Execution · ' + background.executionTarget : ''
  ].filter(Boolean);

  const visible = tasks.slice(-6);
  return element('div', {
    class: 'work-timeline' + (connectionLost ? ' is-disconnected' : ''),
    'aria-label': 'Adaptive workflow progress'
  }, [
    connectionLost
      ? element('div', { class: 'work-connection-banner', role: 'status', 'aria-live': 'polite' }, [
          element('span', { class: 'work-connection-dot', 'aria-hidden': 'true' }),
          element('div', {}, [
            element('strong', { text: 'Connection lost — background work is still protected' }),
            element('span', { class: 'small muted', text: 'The server keeps the job state. The live view reconnects automatically when the connection returns.' })
          ])
        ])
      : null,

    background.permission
      ? element('div', {
          class: 'work-permission-strip ' + background.permissionTone,
          role: background.permissionTone === 'warn' || background.permissionTone === 'bad' ? 'status' : undefined
        }, [
          element('span', { class: 'work-permission-mark', 'aria-hidden': 'true' }),
          element('span', { class: 'small', text: background.permission })
        ])
      : null,

    progressSegments(tasks, current),

    element('div', { class: 'work-progress-caption' }, [
      element('span', { class: 'small muted', text: workspaceLabel + ' · ' + snapshot.completed + ' completed materialized step' + (snapshot.completed === 1 ? '' : 's') }),
      element('span', { class: 'small muted', text: snapshot.active ? 'Working now' : snapshot.pending ? 'Next step adapts from evidence' : 'No unnecessary work queued' })
    ]),

    element('div', { class: 'work-status-grid adaptive-progress-grid' }, stats.slice(0, 3).map(([label, value, detail]) =>
      element('div', { class: 'work-status-item' }, [
        element('span', { class: 'small muted', text: label }),
        element('strong', { text: value }),
        element('span', { class: 'small muted', text: detail })
      ])
    )),

    backgroundItems.length
      ? element('div', { class: 'work-background-strip', 'aria-label': 'Background activity' }, [
          element('span', { class: 'small muted work-background-label', text: 'Background' }),
          ...backgroundItems.map(item => element('span', { class: 'work-background-chip small', text: item }))
        ])
      : null,

    snapshot.failed || snapshot.conflicts || snapshot.gaps
      ? element('div', { class: 'work-progress-alerts' }, [
          snapshot.failed ? element('span', { class: 'pill bad', text: snapshot.failed + ' step' + (snapshot.failed === 1 ? '' : 's') + ' needs attention' }) : null,
          snapshot.conflicts ? element('span', { class: 'pill warn', text: snapshot.conflicts + ' evidence conflict' + (snapshot.conflicts === 1 ? '' : 's') }) : null,
          snapshot.gaps ? element('span', { class: 'pill warn', text: snapshot.gaps + ' open research gap' + (snapshot.gaps === 1 ? '' : 's') }) : null
        ].filter(Boolean))
      : null,

    element('details', { class: 'work-timeline-details' }, [
      element('summary', { class: 'small', text: 'Background activity and completed steps' }),
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
      element('div', {
        class: 'deep-workspace-state',
        role: 'status',
        'aria-live': 'polite',
        'data-state': run?.state || 'ready'
      }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', {
          text: run?.state === 'complete' ? 'verified'
            : run?.state === 'waiting' ? 'waiting'
              : run?.state === 'blocked' ? 'blocked'
                : run ? 'active' : 'ready'
        })
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
      element('div', {
        class: 'deep-workspace-state',
        role: 'status',
        'aria-live': 'polite',
        'data-state': run?.state || 'ready'
      }, [
        element('i', { 'aria-hidden': 'true' }),
        element('span', {
          text: run?.state === 'complete' ? 'synthesized'
            : run?.state === 'waiting' ? 'waiting'
              : run?.state === 'blocked' ? 'blocked'
                : run ? 'investigating' : 'ready'
        })
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
  const active = data.workspace === 'code' || data.workspace === 'research';
  host.hidden = !active;
  if (!active) {
    host.replaceChildren();
    return;
  }
  host.dataset.workspace = data.workspace;
  host.replaceChildren(...(data.workspace === 'code' ? codeWorkspaceProject(data) : researchWorkspaceProject(data)));
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
        element('span', { class: 'muted small truncate', text: data.status, role: 'status', 'aria-live': 'polite' })
      ])
    ]),
    element('div', { class: 'adaptive-workspace-surfaces', role: 'toolbar', 'aria-label': 'Adaptive workspace surfaces' },
      surfaces.map(name => surfaceButton(name, data.workspace === (name === 'runs' ? 'normal-chat' : name))))
  );
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
