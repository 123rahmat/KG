/**
 * Kindgleam — browser client: Actions the AI proposed (reminders, tools, changes): shown for the person to approve or decline, then carried out by the server.
 * Part of app.js, split out by concern; app.js wires the page together.
 */

import { renderMarkdown } from './markdown.js';
import { state, $, element, button, api, notify, guard, capabilities, canEdit } from './ui-core.js';
import { growComposer, loadRuns, newChat, personalContext, renderThread, stopRun } from './app-attachments.js';
import { TERMINAL_STATES, autoDrive, copyText, governanceCard, isAutomatic, renderNextStep, resultText, runStatus, saveAnswer, stepsList, svgIcon, timeAgo, toolLabel } from './app.js';
import { selectTab } from './app-account.js';
import { applyLocalWorkspaceChanges } from './workspace-sources.js';
import { renderWorkStatus } from './adaptive-workspace.js';

const actionsLoading = new Set();

async function loadActions(runId) {
  if (actionsLoading.has(runId)) return;
  actionsLoading.add(runId);
  try {
    const { actions } = await api('GET', `/api/runs/${encodeURIComponent(runId)}/actions`);
    state.actions.set(runId, actions);
    renderThread();
  } catch {
    state.actions.set(runId, []);
  } finally {
    actionsLoading.delete(runId);
  }
}

async function decideAction(run, action, approve, control) {
  if (control) { control.disabled = true; control.textContent = approve ? 'Processing…' : 'Declining…'; }
  await guard(async () => {
    const { action: decided } = await api('POST', `/api/runs/${encodeURIComponent(run.id)}/actions/${encodeURIComponent(action.id)}`, { approve, taskId: action.taskId });
    state.actions.set(run.id, (state.actions.get(run.id) ?? []).map(item => (item.id === decided.id ? decided : item)));
    renderThread();
  }, 'runNotice');
  if (control?.isConnected) control.disabled = false;
}

function actionDetails(action) {
  if (action.tool !== 'tool.create') return null;
  const input = action.input ?? {};
  return element('dl', { class: 'action-details small' }, [
    element('dt', { text: 'Does' }), element('dd', { text: input.description ?? '' }),
    element('dt', { text: 'Written in' }), element('dd', { text: `${input.language ?? ''}${input.packages?.length ? ` with ${input.packages.join(', ')}` : ''}` }),
    element('dt', { text: 'Tests' }), element('dd', { text: input.testResult?.status === 'completed' ? `Passed in the sandbox${input.testResult.durationMs ? ` (${(input.testResult.durationMs / 1000).toFixed(1)} s)` : ''}` : 'Not run' })
  ]);
}

/** What the AI asked to do outside the chat, with Approve and Decline. */

const WRITE_BLOCKED_WORKSPACE_FILE = path => {
  const base = String(path ?? '').split('/').at(-1)?.toLowerCase() || '';
  if (base === '.npmrc' || base === '.netrc' || base === '.pypirc' || /^id_rsa(?:\.|$)/.test(base)) return true;
  if (/^\.env(?:$|\.)/.test(base) && !/^\.env\.(?:example|sample|template)$/.test(base)) return true;
  return /\.(?:pem|key|p12|pfx)$/.test(base);
};

function codeWorkspaceChanges(structured) {
  if (!structured || typeof structured !== 'object') return [];
  const changes = [];
  const manifest = new Map(
    Array.isArray(state.workspaceSource?.metadata?.manifest)
      ? state.workspaceSource.metadata.manifest.map(item => [item.path, item.digest])
      : []
  );
  for (const file of Array.isArray(structured.files) ? structured.files : []) {
    if (file?.path && !WRITE_BLOCKED_WORKSPACE_FILE(file.path)) changes.push({
      path: file.path,
      content: String(file.content ?? ''),
      ...(manifest.has(file.path) ? { beforeDigest: manifest.get(file.path) } : {})
    });
  }
  for (const path of Array.isArray(structured.delete) ? structured.delete : []) {
    if (path && !WRITE_BLOCKED_WORKSPACE_FILE(path)) changes.push({
      path,
      kind: 'delete',
      ...(manifest.has(path) ? { beforeDigest: manifest.get(path) } : {})
    });
  }
  return changes;
}

async function applyCodeWorkspace(run, structured) {
  const sourceId = state.chat?.workspaceSourceId ?? state.workspaceSourceId;
  const source = state.workspaceSource;
  const changes = codeWorkspaceChanges(structured);
  if (!sourceId || !source || !changes.length) return;
  await guard(async () => {
    if (source.kind === 'local-folder') {
      await applyLocalWorkspaceChanges(changes);
      return;
    }
    if (source.kind !== 'github') throw new Error('This project source cannot receive code changes.');
    if (source.permissions?.write !== true) throw new Error('This GitHub source is read-only. Reconnect with explicit write-back permission first.');
    const result = await api('POST', `/api/workspace/sources/${encodeURIComponent(sourceId)}/apply`, {
      confirm: 'APPLY_WORKSPACE_CHANGES',
      expectedCommitSha: source.metadata?.commitSha ?? '',
      changes,
      message: 'workspace: apply reviewed code changes'
    });
    state.workspaceSource = result.source;
    notify('runNotice', 'info', `Changes committed to ${source.repoOwner}/${source.repoName} · ${source.repoRef}`);
  }, 'runNotice');
}

function workspaceApplyCard(run, structured) {
  const source = state.workspaceSource;
  if (!source || !structured || typeof structured !== 'object') return null;
  const changes = codeWorkspaceChanges(structured);
  if (!changes.length) return null;
  const writable = source.kind === 'local-folder' || source.permissions?.write === true;
  if (!writable) {
    return element('div', { class: 'row wrap workspace-apply-actions' }, [
      element('span', { class: 'muted small', text: 'GitHub source is read-only' }),
      element('span', { class: 'muted small', text: changes.length + ' change' + (changes.length === 1 ? '' : 's') + ' ready for review' })
    ]);
  }

  const holder = element('div', { class: 'stack workspace-apply-card' });
  const confirmation = element('div', { class: 'workspace-apply-confirm stack small', hidden: true }, [
    element('strong', { text: 'Apply these reviewed changes?' }),
    element('span', { class: 'muted', text: 'The server will re-check the workspace revision before writing. Credential and private-key files remain blocked.' })
  ]);
  const review = button('Review changes', () => {
    confirmation.hidden = false;
    review.disabled = true;
    apply.focus({ preventScroll: true });
  }, 'primary small');
  const apply = button('Apply now', async event => {
    event.currentTarget.disabled = true;
    await applyCodeWorkspace(run, structured);
    holder.remove();
  }, 'primary small');
  const cancel = button('Cancel', () => {
    confirmation.hidden = true;
    review.disabled = false;
    review.focus({ preventScroll: true });
  }, 'ghost small');
  confirmation.append(element('div', { class: 'row wrap' }, [apply, cancel]));
  holder.append(
    element('div', { class: 'row wrap workspace-apply-actions' }, [
      review,
      element('span', { class: 'muted small', text: changes.length + ' change' + (changes.length === 1 ? '' : 's') + ' ready for review' })
    ]),
    confirmation
  );
  return holder;
}

function actionCards(run) {
  const proposed = run.tasks.some(task => (task.evidence?.tools ?? []).some(item => item.outcome === 'proposed'));
  if (!proposed) return null;
  const actions = state.actions.get(run.id);
  if (!actions) { loadActions(run.id); return null; }
  if (!actions.length) return null;
  return element('div', { class: 'action-cards' }, actions.map(action => {
    const [icon, label] = toolLabel(action.tool);
    const status = {
      proposed: ['Awaiting approval', 'warn'], running: ['Running…', ''], done: ['Completed', 'ok'],
      failed: ['Failed', 'bad'], declined: ['Declined', '']
    }[action.status] ?? [action.status, ''];
    const result = action.status === 'done' && action.result
      ? element('p', { class: 'small muted', text: action.result.note ?? action.result.tool ?? 'Execution completed.' })
      : action.status === 'failed' ? element('p', { class: 'small action-error', text: action.result?.error ?? 'The action failed.' }) : null;
    return element('div', { class: `action-card ${action.status}` }, [
      element('div', { class: 'action-card-head' }, [
        element('span', { class: 'action-icon' }, [svgIcon(icon)]),
        element('div', {}, [element('strong', { text: action.summary || label }), element('span', { class: 'small muted', text: label })]),
        element('span', { class: `pill ${status[1]}`, text: status[0] })
      ]),
      actionDetails(action),
      result,
      action.status === 'proposed' && canEdit() ? element('div', { class: 'row wrap' }, [
        button('Approve', event => decideAction(run, action, true, event.currentTarget), 'primary small'),
        button('Decline', event => decideAction(run, action, false, event.currentTarget), 'ghost small')
      ]) : null
    ].filter(Boolean));
  }));
}

/**
 * What the AI did to reach the answer: the tools it used and the sources it
 * cited. Sources already written in the answer are not repeated.
 */
function toolTrail(run, answer = '') {
  const used = new Map();
  const sources = new Map();
  let remembered = 0;
  for (const task of run.tasks) {
    remembered = Math.max(remembered, Number(task.evidence?.remembered) || 0);
    for (const item of task.evidence?.tools ?? []) {
      const key = item.outcome === 'ok' ? item.tool : `${item.tool}:${item.outcome}`;
      const entry = used.get(key) ?? { ...item, count: 0 };
      entry.count += 1;
      used.set(key, entry);
    }
    for (const source of task.evidence?.citations ?? []) if (source?.url && !answer.includes(source.url)) sources.set(source.url, source);
  }
  // Whether the check looked the facts up on the web, and what it found.
  const factCheck = [...run.tasks].reverse().find(task => task.type === 'verify' && task.evidence?.verdict?.grounding)?.evidence.verdict;
  // What running the code showed: its tests, and how many fixes it took.
  const codeRun = run.tasks.find(task => task.id === 'test-code' && task.evidence?.result)?.evidence.result;
  const codeOutput = codeRun?.output && typeof codeRun.output === 'object' ? codeRun.output : codeRun;
  const repairs = (run.adaptation?.codeRepairs ?? []).filter(item => Number(item.attempt) === Number(run.attempt)).length;
  if (!used.size && !sources.size && !remembered && !factCheck && !codeOutput && !repairs) return null;
  const chips = [...used.values()].map(item => {
    const [icon, label] = toolLabel(item.tool);
    const failed = item.outcome !== 'ok';
    const text = item.outcome === 'proposed' ? `Proposed: ${label.toLowerCase()}`
      : item.outcome === 'not-ready' ? `Could not: ${label.toLowerCase()}`
        : failed ? `${label} (failed)` : `${label}${item.count > 1 && !item.tool.startsWith('memory.') ? ` ×${item.count}` : ''}`;
    return element('span', { class: `tool-chip${failed ? ' muted' : ''}`, title: item.why || item.error || '' }, [svgIcon(icon), element('span', { text })]);
  });
  // Say when earlier chats shaped this answer; Settings shows exactly what.
  if (remembered && !used.has('memory.save')) {
    chips.unshift(element('span', { class: 'tool-chip', title: 'From Settings → Personalization → Memory' }, [svgIcon('memory'), element('span', { text: 'Used what you told me before' })]));
  }
  if (codeOutput) {
    const tests = codeOutput.testSummary;
    const text = tests?.total === 0 ? 'Ran without tests' : tests ? `Tests: ${tests.passed} of ${tests.total} passed`
      : codeOutput.tested === false ? 'Ran without tests' : null;
    if (text) chips.push(element('span', { class: `tool-chip${tests && !tests.failed ? '' : ' muted'}` }, [svgIcon('check'), element('span', { text })]));
  }
  if (repairs) {
    chips.push(element('span', { class: 'tool-chip', title: 'A failed run went back with its error output for a targeted fix.' },
      [svgIcon('check'), element('span', { text: run.tasks.some(task => task.id === 'test-code' && task.status === 'complete')
        ? `Fixed after ${repairs} failed run${repairs === 1 ? '' : 's'}`
        : `Fixing the code (round ${repairs})` })]));
  }
  if (factCheck) {
    const checkedOnline = factCheck.grounding.checkedAgainstWeb === true;
    const passed = factCheck.verdict === 'pass';
    const text = passed
      ? (checkedOnline ? 'Facts checked on the web'
        : factCheck.grounding.sources?.length ? 'Checked against its sources' : 'Checked')
      : 'The check found problems';
    const title = passed ? (factCheck.warnings ?? []).join('\n') : (factCheck.problems ?? []).slice(0, 5).join('\n');
    chips.push(element('span', { class: `tool-chip${passed ? '' : ' muted'}`, title }, [svgIcon('check'), element('span', { text })]));
  }
  const links = [...sources.values()].slice(0, 8).map(source => {
    let host = source.url;
    try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch { /* keep the raw address */ }
    return element('a', { class: 'source-link', href: source.url, target: '_blank', rel: 'noopener noreferrer', title: source.url, text: source.title || host });
  });
  return element('div', { class: 'tool-trail' }, [
    chips.length ? element('div', { class: 'tool-chips' }, chips) : null,
    links.length ? element('div', { class: 'source-links' }, [element('span', { class: 'small muted', text: 'Sources' }), ...links]) : null
  ].filter(Boolean));
}

const CODE_EXTENSIONS = { python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', json: 'json', html: 'html', css: 'css', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', go: 'go', rust: 'rs', php: 'php', ruby: 'rb', kotlin: 'kt', swift: 'swift', yaml: 'yaml', markdown: 'md', csv: 'csv' };

function downloadText(name, content, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = element('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Buttons on a code block in an answer. */
function codeBlockActions(block) {
  const copy = element('button', { type: 'button', class: 'md-code-button', text: 'Copy' });
  copy.addEventListener('click', async () => {
    copy.textContent = (await copyText(block.text)) ? 'Copied' : 'Copy failed';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  });
  const download = element('button', { type: 'button', class: 'md-code-button', text: 'Download' });
  download.addEventListener('click', () => downloadText(`code.${CODE_EXTENSIONS[block.language] ?? 'txt'}`, block.text));
  return [copy, download];
}

// Code longer than this is shown trimmed until the person expands it.
const CODE_PREVIEW_LINES = 18;
// With this many code blocks in one answer, only the first starts open.
const MANY_BLOCKS = 3;

/**
 * Code blocks fold: each has a chevron to hide or show it, a long one shows
 * its first lines until expanded, and in an answer with several files only
 * the first starts open. What the person chose is kept across re-renders.
 */
function foldCodeBlocks(root) {
  state.codeFolds ??= new Map();
  const blocks = [...root.querySelectorAll('.md-code')];
  blocks.forEach((block, index) => {
    const code = block.querySelector('pre code')?.textContent ?? '';
    const lines = code.replace(/\n$/, '').split('\n').length;
    const key = `${lines}:${code.length}:${code.slice(0, 120)}`;
    const saved = state.codeFolds.get(key) ?? {};
    const closed = saved.closed ?? (blocks.length >= MANY_BLOCKS && index > 0);
    const long = lines > CODE_PREVIEW_LINES;
    let expanded = saved.expanded ?? false;
    const bar = block.querySelector('.md-code-bar');
    const size = element('span', { class: 'md-code-size', text: `${lines} line${lines === 1 ? '' : 's'}` });
    bar.querySelector('.md-code-lang')?.after(size);
    const toggle = element('button', { type: 'button', class: 'md-code-button md-code-fold' }, svgIcon('chevron', 'i fold-chevron'));
    const more = long ? element('button', { type: 'button', class: 'md-code-more' }) : null;
    const apply = () => {
      const isClosed = block.classList.contains('closed');
      toggle.setAttribute('aria-expanded', String(!isClosed));
      toggle.setAttribute('aria-label', isClosed ? 'Show this code' : 'Hide this code');
      toggle.title = isClosed ? 'Show code' : 'Hide code';
      block.classList.toggle('clamped', long && !expanded);
      if (more) more.textContent = expanded ? 'Show less' : `Show all ${lines} lines`;
      state.codeFolds.set(key, { closed: isClosed, expanded });
    };
    block.classList.toggle('closed', closed);
    toggle.addEventListener('click', () => { block.classList.toggle('closed'); apply(); });
    // The header opens a folded block too, not only the small chevron.
    bar.addEventListener('click', event => {
      if (block.classList.contains('closed') && !event.target.closest('button')) { block.classList.remove('closed'); apply(); }
    });
    more?.addEventListener('click', () => {
      expanded = !expanded;
      apply();
      if (!expanded) block.scrollIntoView({ block: 'nearest' });
    });
    bar.querySelector('.md-code-actions')?.append(toggle);
    if (more) block.append(more);
    apply();
  });
  return root;
}

/** An answer, read as Markdown and built as DOM nodes (never as HTML). */
function answerBlock(text) {
  const body = element('div', { class: 'answer' }, [renderMarkdown(text, { codeActions: codeBlockActions })]);
  foldCodeBlocks(body);
  return element('div', { class: 'stack answer-wrap' }, [body]);
}

/** Code a step wrote, as the Markdown an answer shows. */
/** Whether a build step's output has code: one source file or a project's files. */
export const hasCode = structured => Boolean(structured?.source || (Array.isArray(structured?.files) && structured.files.length) || (Array.isArray(structured?.delete) && structured.delete.length));

export function codeMarkdown(structured) {
  const language = String(structured.language ?? '').toLowerCase();
  const fence = source => '```' + language + '\n' + String(source).replace(/\n?$/, '\n') + '```';
  // A project: each file under its path, tests last.
  const files = Array.isArray(structured.files) ? structured.files.filter(file => file?.path) : [];
  const isTest = path => /(^|\/)test[^/]*\.py$|\.test\.(mjs|cjs|js)$/.test(path);
  const ordered = [...files.filter(file => !isTest(file.path)), ...files.filter(file => isTest(file.path))];
  return [
    ...(files.length ? [`**${files.length} file${files.length === 1 ? '' : 's'}**${structured.entry ? ` · runs from \`${structured.entry}\`` : ''}`] : []),
    ...(Array.isArray(structured.delete) && structured.delete.length ? [`**Deleted:** ${structured.delete.map(path => '`' + path + '`').join(', ')}`] : []),
    ...ordered.map(file => `\`${file.path}\`\n\n${fence(file.content ?? '')}`),
    structured.source ? fence(structured.source) : '',
    structured.tests ? `**Tests**\n\n${fence(structured.tests)}` : '',
    Array.isArray(structured.packages) && structured.packages.length ? `Libraries: ${structured.packages.map(item => '`' + item + '`').join(', ')}` : ''
  ].filter(Boolean).join('\n\n');
}

function iconButton(name, label, onclick, className = '') {
  return element('button', {
    class: `icon-action ${className}`.trim(),
    type: 'button',
    'aria-label': label,
    title: label,
    onclick
  }, svgIcon(name));
}

async function restartRun(run, mode = 'retry') {
  if (!run || !canEdit() || state.driving) return;
  await guard(async () => {
    const conversationId = state.chat.id ?? run.conversationId ?? crypto.randomUUID();
    state.chat.id = conversationId;
    const originalAttachments = Array.isArray(run.adaptation?.attachments)
      ? run.adaptation.attachments.map(item => item?.id).filter(Boolean)
      : [];
    const newRun = await api('POST', '/api/runs', {
      goal: run.goal,
      conversationId,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...personalContext(),
      attachments: originalAttachments,
      visibility: run.visibility === 'workspace' ? 'workspace' : ($('shareRun').checked ? 'workspace' : 'private'),
      privacyConsent: { modelProvider: state.chat.consent },
      retryOf: run.id,
      retryMode: mode
    }, { idempotencyKey: crypto.randomUUID() });
    state.chat.runs.push(newRun);
    state.run = newRun;
    renderThread();
    await autoDrive(newRun);
    await loadRuns();
  }, 'runNotice');
}

function answerActions(run, text) {
  if (!text) return null;
  return element('div', { class: 'row msg-actions answer-actions' }, [
    iconButton('copy', 'Copy answer', async event => {
      // Kept before the await: currentTarget is cleared once the event ends.
      const control = event.currentTarget;
      const ok = await copyText(text);
      if (ok) {
        control.classList.add('done');
        control.setAttribute('aria-label', 'Copied');
        control.title = 'Copied';
        control.replaceChildren(svgIcon('check'));
        setTimeout(() => {
          if (!control.isConnected) return;
          control.classList.remove('done');
          control.setAttribute('aria-label', 'Copy answer');
          control.title = 'Copy answer';
          control.replaceChildren(svgIcon('copy'));
        }, 1200);
      } else notify('runNotice', 'warn', 'Copying is blocked by the browser. Select the text instead.');
    }),
    canEdit() ? iconButton('retry', 'Retry answer', () => restartRun(run, 'retry')) : null,
    canEdit() ? iconButton('sparkle', 'Regenerate answer', () => restartRun(run, 'regenerate')) : null,
    canEdit() ? iconButton('download', 'Save answer to Files', () => guard(
      () => saveAnswer(text, run.id), 'runNotice'
    )) : null,
    iconButton('flag', 'Report this answer', event => openReport(run, event.currentTarget.closest('.answer-actions')))
  ].filter(Boolean));
}

const REPORT_REASONS = [['harmful', 'Harmful or unsafe'], ['wrong', 'Wrong or made up'], ['unfair', 'Unfair or biased'], ['privacy', 'Privacy problem'], ['other', 'Something else']];

/** Report an answer to the workspace's admins, inline under it. */
function openReport(run, actions) {
  if (!actions || actions.nextElementSibling?.classList.contains('report-form')) return;
  const reason = element('select', { 'aria-label': 'Why are you reporting this answer?' },
    REPORT_REASONS.map(([value, label]) => element('option', { value, text: label })));
  const note = element('textarea', { rows: '2', maxlength: '1000', placeholder: 'Additional details (optional)', 'aria-label': 'Details' });
  const form = element('div', { class: 'report-form stack' }, [
    element('strong', { text: 'Report this answer' }),
    element('span', { class: 'small muted', text: 'Workspace administrators receive the report with the associated answer for review.' }),
    reason, note,
    element('div', { class: 'row wrap' }, [
      button('Send report', async event => {
        event.currentTarget.disabled = true;
        await guard(async () => {
          await api('POST', `/api/runs/${run.id}/report`, { reason: reason.value, note: note.value });
          form.replaceChildren(element('span', { class: 'small', text: 'Report submitted.' }));
        }, 'runNotice');
      }, 'primary small'),
      button('Cancel', () => form.remove(), 'ghost small')
    ])
  ]);
  actions.after(form);
  reason.focus();
}

export async function renderReports() {
  const result = await api('GET', '/api/reports').catch(() => null);
  const list = $('reportList');
  if (!result) { list.replaceChildren(element('li', { class: 'muted small', text: 'Reports could not be loaded.' })); return; }
  const summary = $('declinedSummary');
  summary.hidden = !result.canReview;
  if (result.canReview) {
    summary.replaceChildren(result.declined?.length
      ? element('span', { class: 'small', text: `Declined in the last 30 days: ${result.declined.map(item => `${item.category.replace(/-/g, ' ')} (${item.count})`).join(', ')}. Only the kind of request is kept, never its text.` })
      : element('span', { class: 'small muted', text: 'No requests were declined in the last 30 days.' }));
  }
  $('reportsLead').textContent = result.canReview ? 'Answers people in this workspace reported.' : 'Answers you reported.';
  if (!result.reports.length) { list.replaceChildren(element('li', { class: 'muted small', text: 'No reports.' })); return; }
  const reasonLabel = Object.fromEntries(REPORT_REASONS);
  list.replaceChildren(...result.reports.map(report => element('li', { class: `report-item ${report.status}` }, [
    element('div', { class: 'stack' }, [
      element('strong', { text: `${reasonLabel[report.reason] ?? report.reason} · ${report.status}` }),
      report.note ? element('span', { class: 'small', text: report.note }) : null,
      report.excerpt ? element('div', { class: 'report-excerpt small' }, [renderMarkdown(report.excerpt.slice(0, 800))]) : null,
      element('span', { class: 'small muted', text: timeAgo(report.createdAt) })
    ]),
    result.canReview && report.status === 'open' ? element('div', { class: 'report-actions' }, [
      button('Resolved', () => reviewReport(report.id, 'resolved'), 'ghost small'),
      button('Dismiss', () => reviewReport(report.id, 'dismissed'), 'ghost small')
    ]) : null
  ])));
}

async function reviewReport(id, status) {
  await guard(async () => { await api('POST', `/api/reports/${encodeURIComponent(id)}`, { status }); await renderReports(); }, 'runNotice');
}

/** The plan before the work: its size, what it brings and leaves out, and why. */
/**
 * A section of a chat answer that folds away under its header, with a
 * chevron that turns when it opens. Whether it is open survives the
 * thread re-rendering while work runs.
 */
function section(run, key, { className, summary, open: openByDefault, label }, body) {
  state.openSections ??= new Map();
  const id = `${run.id}:${key}`;
  const open = state.openSections.has(id) ? state.openSections.get(id) : openByDefault;
  const details = element('details', { class: `fold ${className}`, ...(open ? { open: true } : {}) }, [
    element('summary', { class: 'fold-head', 'aria-label': label }, [
      ...[].concat(summary),
      svgIcon('chevron', 'i fold-chevron')
    ]),
    ...[].concat(body)
  ]);
  details.addEventListener('toggle', () => state.openSections.set(id, details.open));
  return details;
}

function planBriefCard(brief, run = null) {
  const list = (items, mark) => element('ul', { class: 'brief-list' }, items.map(item =>
    element('li', {}, [element('span', { class: `brief-mark ${mark}`, text: mark === 'bring' ? '+' : '−' }), element('strong', { text: item.label }), element('span', { class: 'muted', text: ` — ${item.why}` })])));
  const body = [
    ...(brief.bring?.length ? [element('div', { class: 'brief-heading small muted', text: 'Bringing in' }), list(brief.bring, 'bring')] : []),
    ...(brief.leaveOut?.length ? [element('div', { class: 'brief-heading small muted', text: 'Leaving out' }), list(brief.leaveOut, 'leave')] : [])
  ];
  // Shown on its own while the work runs: it folds like the other sections.
  if (run) {
    return section(run, 'brief', {
      className: 'plan-brief', open: true, label: `Plan: ${brief.headline}`,
      summary: element('span', { class: 'plan-brief-title', text: brief.headline })
    }, body);
  }
  return element('div', { class: 'plan-brief' }, [element('div', { class: 'plan-brief-title', text: brief.headline }), ...body]);
}

function requirementsCard(run) {
  const model = run?.requirements;
  const items = Array.isArray(model?.items) ? model.items : [];
  if (!items.length) return null;
  const visible = items.filter(item => item.status !== 'superseded').slice(0, 10);
  const currentId = model.nextRequirementId;
  const progressValue = Number(model.overallProgress);
  const progress = Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : 0;
  return section(run, 'requirements', {
    className: 'requirements-card', label: `Requirements, ${progress}% done`,
    // Open while the work runs; folded once it has finished.
    open: !TERMINAL_STATES.includes(run.state),
    summary: element('div', { class: 'requirements-head' }, [
      element('div', {}, [
        element('strong', { text: 'Requirements' }),
        element('span', { class: 'muted small', text: model.completionReady ? 'All required outcomes verified' : 'Live evidence progress' })
      ]),
      element('strong', { class: 'requirements-percent', text: progress + '%' })
    ])
  }, [
    element('div', { class: 'requirements-meter', 'aria-hidden': 'true' }, [
      element('i', { style: { width: progress + '%' } })
    ]),
    element('div', { class: 'requirements-list' }, visible.map(item => {
      const active = item.id === currentId;
      const mark = item.status === 'satisfied' || item.status === 'verified' ? '✓'
        : item.status === 'blocked' || item.status === 'failed' ? '!'
        : active ? '●' : '○';
      return element('div', { class: 'requirement-row', 'data-current': String(active), 'data-status': item.status }, [
        element('span', { class: 'requirement-mark', text: mark }),
        element('div', { class: 'requirement-main' }, [
          element('div', { class: 'requirement-label', text: item.requirement }),
          element('div', { class: 'requirement-meta muted small', text: item.status.replace(/-/g, ' ') + ' · ' + item.progress + '%' })
        ])
      ]);
    }))
  ]);
}

function workDetailsCard(run) {
  const situation = run?.situation ?? {};
  const intelligence = run?.adaptation?.unifiedIntelligence ?? run?.adaptation?.unifiedIntelligence;
  const meta = intelligence?.metaReasoning ?? run?.adaptation?.metaReasoning ?? {};
  const resource = run?.adaptation?.resourceDecision ?? meta?.resourceDecision ?? intelligence?.resourceDecision ?? {};
  const next = Array.isArray(run?.tasks) ? run.tasks.find(task => task.id === run.next) : null;
  const multi = Array.isArray(run?.tasks)
    ? run.tasks.map(task => task.evidence?.multiAgent).filter(Boolean).at(-1)
    : null;
  const agentStates = Array.isArray(multi?.agentStates) ? multi.agentStates : [];
  const source = state.workspaceSource;
  const execution = Array.isArray(run?.tasks)
    ? [...run.tasks].reverse().map(task => ({
        target: task.evidence?.executionTarget ?? task.evidence?.result?.executionTarget ?? null,
        sandbox: task.evidence?.result?.output?.sandbox ?? task.evidence?.result?.sandbox ?? null
      })).find(item => item.target || item.sandbox)
    : null;
  const verificationTask = Array.isArray(run?.tasks) ? [...run.tasks].reverse().find(task => task.type === 'verify') : null;
  const changed = new Set();
  for (const task of run?.tasks ?? []) {
    for (const file of task.evidence?.structured?.files ?? []) if (file?.path) changed.add(file.path);
    for (const file of task.evidence?.result?.changedFiles ?? []) if (typeof file === 'string') changed.add(file);
  }
  const rows = [
    situation.title || situation.summary ? ['Situation', String(situation.title || situation.summary)] : null,
    run?.adaptation?.scale || intelligence?.scale ? ['Scope', String(run?.adaptation?.scale || intelligence?.scale)] : null,
    Number.isFinite(Number(run?.adaptation?.complexity ?? intelligence?.complexity)) ? ['Complexity', String(Number(run?.adaptation?.complexity ?? intelligence?.complexity).toFixed(2))] : null,
    resource?.effort ? ['Effort', String(resource.effort)] : null,
    next ? ['Why now', String(next.purpose || next.metadata?.title || next.id)] : null,
    execution?.target ? ['Execution', String(execution.target === 'general-ai-sandbox' ? 'Kindgleam sandbox' : execution.target)] : null,
    execution?.sandbox?.runtime ? ['Sandbox', String(execution.sandbox.runtime) + ' · network ' + String(execution.sandbox.network || 'none')] : null,
    source ? ['Workspace', [source.name, source.repoRef || source.repoName].filter(Boolean).join(' · ') || source.kind] : null,
    source?.metadata?.commitSha ? ['Revision', String(source.metadata.commitSha).slice(0, 12)] : null,
    agentStates.length ? ['Specialists', agentStates.map(item => String(item.role || '') + (item.confidence != null ? ' · ' + Number(item.confidence).toFixed(2) : '')).filter(Boolean).join(' · ')] : null,
    verificationTask ? ['Verification', verificationTask.status === 'complete' ? 'Completed' : String(verificationTask.status || 'pending')] : null,
    changed.size ? ['Changes', [...changed].slice(0, 12).join(' · ') + (changed.size > 12 ? ' · +' + (changed.size - 12) + ' more' : '')] : null
  ].filter(Boolean);
  if (!rows.length) return null;
  return section(run, 'details', {
    className: 'work-details-card',
    open: false,
    label: 'Detailed work information',
    summary: element('div', { class: 'work-details-head' }, [
      element('strong', { text: 'Work details' }),
      element('span', { class: 'muted small', text: 'Current server-confirmed scope, execution, evidence and workspace state' })
    ])
  }, [
    element('dl', { class: 'work-details-grid' }, rows.flatMap(([label, value]) => [
      element('dt', { class: 'small muted', text: label }),
      element('dd', { class: 'small', text: value })
    ])),
    meta?.evidenceState?.unknowns?.length ? element('p', { class: 'small muted', text: 'Open unknowns: ' + meta.evidenceState.unknowns.slice(0, 4).join(' · ') }) : null
  ].filter(Boolean));
}

export function workStatusCard(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const total = tasks.length;
  const done = tasks.filter(task => ['complete', 'skipped'].includes(task.status)).length;
  const failed = tasks.filter(task => task.status === 'failed').length;
  const waiting = tasks.some(task => ['waiting', 'approval'].includes(task.status));
  const next = tasks.find(task => task.id === run.next) ?? tasks.find(task => !['complete', 'skipped'].includes(task.status)) ?? null;
  const current = next?.metadata?.title || next?.purpose || next?.id || (run.state === 'complete' ? 'Verified result' : 'Adapting the workflow');
  const multi = tasks.map(task => task.evidence?.multiAgent).filter(Boolean).at(-1) ?? run.adaptation?.multiAgent ?? null;
  const agentStates = Array.isArray(multi?.agentStates) ? multi.agentStates : [];
  const agents = agentStates.filter(item => item?.status === 'complete').map(item => item.role).filter(Boolean);
  const execution = [...tasks].reverse().map(task => ({
    task,
    target: task.evidence?.executionTarget ?? task.evidence?.result?.executionTarget ?? task.evidence?.receipt?.executionTarget ?? null,
    result: task.evidence?.result ?? null
  })).find(item => item.target || item.result);
  const output = execution?.result?.output && typeof execution.result.output === 'object' ? execution.result.output : execution?.result;
  const tests = output?.testSummary;
  const changed = new Set();
  for (const task of tasks) {
    for (const file of task.evidence?.structured?.files ?? []) if (file?.path) changed.add(file.path);
    for (const file of task.evidence?.result?.changedFiles ?? []) if (typeof file === 'string') changed.add(file);
  }
  const verificationTask = [...tasks].reverse().find(task => task.type === 'verify');
  const verification = verificationTask?.status === 'complete'
    ? (verificationTask.evidence?.verdict?.verdict === 'pass' || verificationTask.evidence?.verdict?.status === 'pass' ? 'Verified' : 'Checked')
    : verificationTask ? 'Verification in progress' : 'Not required yet';
  const status = run.state === 'complete'
    ? 'Finished'
    : run.state === 'blocked'
      ? 'Blocked by policy'
      : run.state === 'waiting'
        ? 'Waiting for you'
        : run.state === 'iterate'
          ? 'Ready to refine'
          : 'Working';
  const tone = run.state === 'blocked' || failed ? 'bad' : waiting || run.state === 'waiting' ? 'warn' : run.state === 'complete' ? 'ok' : '';
  const details = [
    ['Now', current],
    execution?.target ? ['Execution', execution.target === 'general-ai-sandbox' ? 'Kindgleam sandbox' : execution.target.replaceAll('-', ' ')] : null,
    agents.length ? ['Specialists', agents.join(' · ')] : null,
    tests ? ['Tests', (tests.passed ?? 0) + '/' + (tests.total ?? 0) + ' passed' + (tests.failed ? ' · ' + tests.failed + ' failed' : '')] : null,
    ['Verification', verification],
    changed.size ? ['Changes', changed.size + ' file' + (changed.size === 1 ? '' : 's') + ' touched'] : null
  ].filter(Boolean);
  return element('details', { class: 'work-status-card ' + tone, open: run.state !== 'complete' }, [
    element('summary', { class: 'work-status-summary' }, [
      element('span', { class: 'work-status-mark', 'aria-hidden': 'true' }),
      element('div', { class: 'work-status-head' }, [
        element('strong', { text: 'Work status' }),
        element('span', { class: 'small muted', text: status + ' · ' + done + '/' + Math.max(total, 1) + ' steps' })
      ]),
      element('span', { class: 'work-status-now', text: current })
    ]),
    element('div', { class: 'work-status-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(Math.max(total, 1)), 'aria-valuenow': String(done) }, [
      element('i', { style: { width: (total ? Math.min(100, (done / total) * 100) : run.state === 'complete' ? 100 : 6) + '%' } })
    ]),
    element('div', { class: 'work-status-grid' }, details.map(([label, value]) =>
      element('div', { class: 'work-status-item' }, [
        element('span', { class: 'small muted', text: label }),
        element('strong', { class: 'small', text: value })
      ]))),
    renderWorkStatus(run),
    workDetailsCard(run),
    failed ? element('p', { class: 'work-status-warning small', text: failed + ' step' + (failed === 1 ? '' : 's') + ' failed; failure evidence is available for repair or replanning.' }) : null
  ].filter(Boolean));
}

// The server creates these options from the current situation. This view is
// deliberately read-only: choosing an approach remains evidence-led in the
// workflow, never a client-side planning decision.
function brainstormCard(run) {
  const root = run?.adaptation?.unifiedIntelligence?.metaReasoning
    ?? run?.tasks?.find(task => task.id === 'understand')?.metadata?.metaReasoning
    ?? null;
  const brainstorm = root?.brainstorm;
  const options = Array.isArray(root?.alternatives) ? root.alternatives.slice(0, 3) : [];
  if (!brainstorm?.enabled || !options.length) return null;
  const selected = String(brainstorm.selectedInitial ?? '');
  return section(run, 'approach', {
    className: 'brainstorm-card',
    open: !TERMINAL_STATES.includes(run.state),
    label: 'Approach options grounded in the current situation',
    summary: element('div', { class: 'brainstorm-head' }, [
      element('div', {}, [
        element('strong', { text: 'Approach' }),
        element('span', { class: 'muted small', text: 'Options, trade-offs, and the evidence needed before changing course' })
      ]),
      element('span', { class: 'brainstorm-count small', text: String(options.length) + ' options' })
    ])
  }, [
    element('p', { class: 'brainstorm-principle small muted', text: brainstorm.principle }),
    element('div', { class: 'brainstorm-options' }, options.map(option =>
      element('article', { class: 'brainstorm-option', 'data-selected': String(option.id === selected) }, [
        element('div', { class: 'brainstorm-option-title' }, [
          element('strong', { text: option.id === selected ? 'Current path: ' + option.id.replace(/-/g, ' ') : option.id.replace(/-/g, ' ') }),
          ...(option.id === selected ? [element('span', { class: 'brainstorm-current small', text: 'selected from current evidence' })] : [])
        ]),
        element('p', { text: option.strategy }),
        element('p', { class: 'small muted', text: 'Use when: ' + option.whenBest }),
        element('p', { class: 'small muted', text: 'Trade-off: ' + option.tradeOff }),
        element('p', { class: 'small brainstorm-evidence', text: 'Check first: ' + (option.evidenceNeeded ?? []).join(' · ') })
      ])
    ))
  ]);
}


export function assistantMessage(run, active) {
  const parts = [];
  const text = resultText(run);
  const driving = state.driving === run.id;
  if (run.workflow !== 'direct' || !text) {
    const done = run.tasks.filter(task => task.status === 'complete' || task.status === 'skipped').length;
    const heading = TERMINAL_STATES.includes(run.state)
      ? 'Worked through ' + done + ' created step' + (done === 1 ? '' : 's')
      : run.tasks.length + ' step' + (run.tasks.length === 1 ? '' : 's') + ' created · ' + done + ' done · next adapts from evidence';
    parts.push(section(run, 'steps', {
      className: 'plan', open: false, label: `${heading}. Show or hide the steps`,
      summary: element('span', { class: 'small', text: heading })
    }, stepsList(run)));
  }
  // The plan, told before the work: what is brought in and why, what is
  // left out and why. Shown openly until the result arrives, then kept in
  // the details under the steps.
  const requirements = requirementsCard(run);
  if (requirements) parts.push(requirements);
  const brainstorm = brainstormCard(run);
  if (brainstorm) parts.push(brainstorm);
  const showBrief = run.brief && !text && !TERMINAL_STATES.includes(run.state);
  const brief = run.brief ? planBriefCard(run.brief, showBrief ? run : null) : null;
  if (brief) {
    const plan = parts.find(part => part?.classList?.contains('plan'));
    if (showBrief) parts.splice(plan ? parts.indexOf(plan) + 1 : parts.length, 0, brief);
    else if (plan) plan.append(brief);
  }
  // A capability the situation needs but nothing here provides.
  const investment = (run.adaptation?.adaptiveSnapshot?.resourcePlan ?? run.adaptation?.resourcePlan)?.implementation?.investment;
  if (investment?.decision === 'user-choice-required' && investment.capabilities?.length) {
    const plan = parts.find(part => part?.classList?.contains('plan'));
    const holder = plan ?? section(run, 'situation', { className: 'plan', open: false, label: 'Situation details', summary: element('span', { class: 'small', text: 'Situation details' }) }, []);
    if (!plan) parts.push(holder);
    holder.append(element('div', { class: 'adaptive-scope-note small muted' }, [
      element('strong', { text: 'Missing capability: ' }),
      element('span', { text: investment.capabilities.join(', ') + '. No new capability is being built automatically.' })
    ]));
  }
  // Governance shows in the details when it asks for something: extra care,
  // a review, or a block. A plain "ready" stays out of the way.
  const governance = run?.situationGovernance ?? run?.adaptation?.governance;
  if (governance && governance.status !== 'ready' && !run.adaptation?.safetyAdaptive) {
    const plan = parts.find(part => part?.classList?.contains('plan'));
    const holder = plan ?? section(run, 'situation', { className: 'plan', open: false, label: 'Situation details', summary: element('span', { class: 'small', text: 'Situation details' }) }, []);
    if (!plan) parts.push(holder);
    const card = governanceCard(run);
    if (card) holder.append(card);
  }
  const notHere = run.adaptation?.notAvailableHere ?? [];
  if (notHere.length) {
    parts.push(element('p', { class: 'limit-note', text: 'Running code is not set up here, so you will get the code and steps to run it yourself.' }));
  }
  parts.push(workStatusCard(run));
  if (text) parts.push(answerBlock(text));
  const trail = toolTrail(run, text);
  if (trail) parts.push(trail);
  const proposals = actionCards(run);
  if (proposals) parts.push(proposals);
  // Code written along the way is part of the answer, not a hidden step.
  const code = [...run.tasks].reverse().find(task => task.id === 'build-code' && hasCode(task.evidence?.structured));
  let actionText = text;
  if (code) {
    const codeText = codeMarkdown(code.evidence.structured);
    if (codeText !== text) {
      parts.push(answerBlock(codeText));
      actionText ||= codeText;
    }
    const applyCard = workspaceApplyCard(run, code.evidence.structured);
    if (applyCard) parts.push(applyCard);
  }
  if (actionText) parts.push(answerActions(run, actionText));
  if (driving) {
    parts.push(element('div', { class: 'thinking' }, [
      element('span', { class: 'pulse' }),
      element('span', { text: `${state.drivingLabel || 'Working'}…` })
    ]));
  } else if (run.state === 'complete') {
    if (!text) parts.push(element('p', { class: 'muted small', text: 'Finished.' }));
  } else if (TERMINAL_STATES.includes(run.state)) {
    const [status] = runStatus(run);
    parts.push(element('p', { class: 'muted small', text: run.state === 'blocked'
      ? `Not allowed by your organisation’s policy: ${run.capabilities.blocked.join(', ')}.`
      : `${status}.` }));
  } else if (active) {
    if (isAutomatic(run)) {
      parts.push(button('Continue', () => autoDrive(run), 'primary'));
    } else {
      const card = renderNextStep(run);
      if (card) parts.push(card);
    }
    if (canEdit()) {
      parts.push(element('div', { class: 'row msg-actions' }, [
        button('Stop this', () => { if (confirm('Stop this work? This cannot be undone.')) stopRun('stopped by user'); }, 'ghost small danger-text')
      ]));
    }
  } else {
    const delivered = run.state === 'iterate' && !run.tasks.some(task => task.status === 'failed');
    parts.push(element('div', { class: 'row wrap' }, [
      element('span', { class: 'muted small', text: delivered ? 'Result delivered.' : 'Left unfinished.' }),
      button('Resume', () => { state.run = run; renderThread(); }, 'small')
    ]));
  }
  return element('div', { class: 'msg assistant' }, [
    svgIcon('logo', 'avatar'),
    element('div', { class: 'bubble stack' }, parts)
  ]);
}


// Everyday suggestions. `needs` names what must be connected for it to work.
const SUGGESTIONS = [
  // What Kindgleam is best at comes first.
  { group: 'Learn', icon: 'explore', featured: true, description: 'A tutor that explains at your level, step by step, then checks you understood.', needs: 'ai', items: [
    ['Teach me step by step', 'Teach me how to solve quadratic equations, step by step. I am in grade 10. Check that I understand before moving on.'],
    ['Quiz me', 'Quiz me with 10 questions on the causes of World War I. Ask one at a time and tell me if I am right.'],
    ['Check my answer', 'Here is my answer to a physics problem. Do not just give the solution: tell me where I went wrong. '],
    ['Study plan', 'My chemistry exam is in 3 weeks. Make a study plan and remind me each evening.'],
    ['Explain simply', 'Explain how compound interest works, simply, with one example.'],
    ['Translate', 'Translate this into Urdu, keeping the tone polite: ']
  ] },
  { group: 'Business ideas', icon: 'card', featured: true, description: 'Check an idea: customers, market with sources, competitors, pricing and a 12-month projection.', needs: 'ai', items: [
    ['Check my idea', 'Check my business idea: a home tutoring app for students in Lahore. Who are the customers, the competitors, the pricing, the risks, and what should I test first?'],
    ['12-month projection', 'Project 12 months for a small bakery: 300,000 start-up cost, 40 new customers a month growing 5%, 2,000 per customer a month, 800 cost per customer, 150,000 fixed costs a month.'],
    ['Find my customers', 'Who exactly would pay for weekend coding classes for school students, and how do I reach them?'],
    ['Pitch outline', 'Write a one-page pitch outline for my idea: ']
  ] },
  { group: 'Code', icon: 'run', featured: true, description: 'Write, explain, review, fix, run and test code.', full: 'runCode',
    limited: 'Write, explain, review and fix code. Running code is not set up here, so you get code and steps to run it yourself.', needs: 'ai', items: [
    ['Write code', 'Write a Python function that removes duplicate emails from a list, with tests.'],
    ['Fix a bug', 'This code gives an error. Find the cause and fix it: '],
    ['Review my code', 'Review this code for bugs, security problems and readability: '],
    ['Explain code', 'Explain what this code does, line by line: '],
    ['Write and test code', 'Write a Python function that checks if a word is a palindrome, and test it.', 'runCode']
  ] },
  { group: 'Write', icon: 'chat', description: 'Emails, messages, letters and posts, or make your own text clearer.', needs: 'ai', items: [
    ['Write an email', 'Write a short, polite email to my landlord asking them to fix the heater this week.'],
    ['Improve my text', 'Make this clearer and friendlier, and keep it short: '],
    ['Write a cover letter', 'Write a cover letter for a junior accountant job. My experience: '],
    ['Write a message', 'Help me write a kind message to a friend who is going through a hard time.']
  ] },
  { group: 'Plan', icon: 'activity', description: 'Plans for your week, meals, trips and money.', needs: 'ai', items: [
    ['Plan my week', 'Help me plan my week. My main tasks are: '],
    ['Meal plan', 'Make a simple, cheap vegetarian meal plan for 5 days with a shopping list.'],
    ['Trip plan', 'Plan a 3-day trip to Lahore on a small budget.'],
    ['Budget', 'Help me make a monthly budget. My income is … and my main costs are …']
  ] },
  { group: 'Work', icon: 'building', description: 'Meeting notes, reports, interview prep and customer replies.', needs: 'ai', items: [
    ['Meeting summary', 'Turn these meeting notes into a short summary with action items: '],
    ['Prepare for an interview', 'Help me prepare for a job interview for a sales role: likely questions and good answers.'],
    ['Write a report', 'Draft a one-page report on our quarterly sales. Key numbers: '],
    ['Reply to a customer', 'Write a calm, helpful reply to a customer whose order arrived late.']
  ] },
  { group: 'Files', icon: 'files', description: 'Attach documents, notes, CSV or code and ask about them.', needs: 'ai', attach: true, items: [
    ['Summarise a document', 'Summarise the attached file in 5 bullet points.'],
    ['Find key points', 'What are the most important points and dates in the attached file?'],
    ['Check my CV', 'Review the attached CV and suggest improvements.'],
    ['Explain a spreadsheet', 'Explain what the attached CSV file shows, in simple words.']
  ] },
  { group: 'Research', icon: 'explore', description: 'Searches the web and shows where each fact came from.', needs: 'research', items: [
    ['Latest evidence', 'Research what the latest evidence says about the health effects of intermittent fasting.'],
    ['Compare products', 'Research and compare the three most popular budget smartphones this year.'],
    ['Check a claim', 'Is it true that drinking coffee dehydrates you? Check reliable sources.'],
    ['Find options', 'Research free online courses for learning basic accounting.']
  ] }
];

/** Groups and cards this workspace can really do; nothing else is shown. */
function availableSuggestions() {
  const can = capabilities();
  return SUGGESTIONS
    .filter(group => can[group.needs])
    .map(group => ({
      ...group,
      description: group.full && !can[group.full] ? group.limited : group.description,
      items: group.items.filter(([, , needs]) => !needs || can[needs])
    }));
}

/** Start a new chat from a picked suggestion. */
function startFromSuggestion(group, prompt) {
  newChat();
  $('goal').value = prompt;
  growComposer();
  $('goal').focus({ preventScroll: true });
  if (group.attach && !state.attachments.length) $('attachInput').click();
}

/** Explore: every capability with its suggestions, to pick from. */
export function renderExplore() {
  const groups = availableSuggestions();
  const host = $('exploreList');
  if (!groups.length) {
    host.replaceChildren(element('p', { class: 'muted', text: 'No AI is connected to this workspace yet, so there is nothing to suggest. An administrator can connect one in the server settings.' }));
    return;
  }
  host.replaceChildren(...groups.map(group => element('section', { class: 'explore-group' }, [
    element('div', { class: 'explore-head' }, [
      element('span', { class: 'explore-icon', 'aria-hidden': 'true' }, [svgIcon(group.icon)]),
      element('div', {}, [
        element('h2', { text: group.group }),
        element('p', { class: 'muted small', text: group.description })
      ])
    ]),
    element('div', { class: 'examples' }, group.items.map(([label, prompt]) => element('button', {
      class: 'chip', type: 'button', onclick: () => startFromSuggestion(group, prompt)
    }, [element('span', { class: 'chip-title', text: label }), element('span', { class: 'chip-text', text: prompt })])))
  ])));
}

export function welcome() {
  const groups = availableSuggestions();
  if (!groups.length) {
    return element('div', { class: 'welcome stack' }, [
      element('h1', { text: 'What would you like to work on?' }),
      element('p', { class: 'muted', text: 'No reasoning model is connected to this workspace. Work can still be completed manually; an administrator can configure a model for automated reasoning.' })
    ]);
  }
  state.suggestionGroup = groups.some(group => group.group === state.suggestionGroup) ? state.suggestionGroup : groups[0].group;
  const current = groups.find(group => group.group === state.suggestionGroup);
  return element('div', { class: 'welcome stack' }, [
    element('h1', { text: 'What would you like to work on?' }),
    element('p', { class: 'muted', text: 'Describe the question, task, or outcome you need. The workspace adapts its reasoning, evidence, tools, verification, and execution path to the work.' }),
    element('div', { class: 'categories', role: 'tablist', 'aria-label': 'Suggestions' }, groups.map(group => element('button', {
      type: 'button', role: 'tab', class: `category${group.featured ? ' featured' : ''}`, 'aria-selected': String(group.group === current.group),
      onclick: () => { state.suggestionGroup = group.group; renderThread(); }
    }, [svgIcon(group.icon, 'i category-icon'), element('span', { text: group.group })]))),
    element('div', { class: 'examples' }, current.items.map(([label, prompt]) => element('button', {
      class: 'chip', type: 'button',
      onclick: () => {
        $('goal').value = prompt;
        growComposer();
        $('goal').focus({ preventScroll: true });
        if (current.attach && !state.attachments.length) $('attachInput').click();
      }
    }, [element('span', { class: 'chip-title', text: label }), element('span', { class: 'chip-text', text: prompt })]))),
    element('button', { type: 'button', class: 'link see-all', text: 'View available capabilities →', onclick: () => selectTab('explore') })
  ]);
}

export function userMessage(text, fileNames = []) {
  return element('div', { class: 'msg user' }, element('div', { class: 'user-stack' }, [
    fileNames.length ? element('div', { class: 'file-chips' }, fileNames.map(name =>
      element('span', { class: 'file-chip', text: `📄 ${name}` }))) : null,
    element('div', { class: 'bubble', text })
  ]));
}

/** Start-up work of this part, run by app.js at the point it always ran. */
export function initActions() {
  /* ------------------------------------------------ proposed actions */

  state.actions = new Map();
}
