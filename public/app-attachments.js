/**
 * Kindgleam — browser client: Files attached to a message: picking, uploading, previews and offline storage.
 * Part of app.js, split out by concern; app.js wires the page together.
 */

import { renderMarkdown } from './markdown.js';
import { state, $, element, button, api, notify, guard, aiConnected, clearNotice, updateConnectionUI } from './ui-core.js';
import { autoDrive, browserAdaptationContext, bytes, heading, runStatus, svgIcon, timeAgo } from './app.js';
import { assistantMessage, userMessage, welcome } from './app-actions.js';
import { loadUsage, renderUsageLimitLock, usageLimitStatus, selectTab } from './app-account.js';
import { clearDraft, deleteOfflineFiles, loadOfflineFiles, storeOfflineFiles, writeOfflineQueue } from './app-settings.js';
import { syncAdaptiveWorkspace } from './adaptive-workspace.js';
import { syncActiveWorkspaceSource } from './workspace-sources.js';

/* ------------------------------------------------------------- attachments */

const MAX_ATTACH_FILES = 10;
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
const attachmentPreviewUrls = new Map();

function isImageAttachment(file) {
  return /^image\/(?:png|jpe?g|webp|gif)$/i.test(String(file?.type ?? ''));
}

function previewUrl(file) {
  if (!isImageAttachment(file)) return null;
  if (!attachmentPreviewUrls.has(file)) attachmentPreviewUrls.set(file, URL.createObjectURL(file));
  return attachmentPreviewUrls.get(file);
}

function releasePreview(file) {
  const url = attachmentPreviewUrls.get(file);
  if (!url) return;
  URL.revokeObjectURL(url);
  attachmentPreviewUrls.delete(file);
}

function releaseAllPreviews() {
  for (const url of attachmentPreviewUrls.values()) URL.revokeObjectURL(url);
  attachmentPreviewUrls.clear();
}

function renderAttachments() {
  const list = $('attachList');
  list.hidden = state.attachments.length === 0;
  if (state.attachments.length && !(state.attachmentScope instanceof Set)) {
    state.attachmentScope = new Set(state.attachments.map(file => file.name));
  }
  const live = new Set(state.attachments);
  for (const file of [...attachmentPreviewUrls.keys()]) if (!live.has(file)) releasePreview(file);
  list.replaceChildren(...state.attachments.map((file, index) => {
    const inScope = state.attachmentScope?.has(file.name) === true;
    const imageUrl = previewUrl(file);
    const image = imageUrl
      ? element('img', { class: 'attachment-thumb', src: imageUrl, alt: 'Preview of ' + file.name, loading: 'lazy', decoding: 'async' })
      : null;
    return element('span', { class: 'file-chip removable attachment-scope-chip' }, [
      image,
      element('label', { class: 'attachment-scope', title: 'Use this file for this request' }, [
        element('input', {
          type: 'checkbox',
          checked: inScope,
          'aria-label': 'Use ' + file.name + ' for this request',
          onchange: event => {
            state.attachmentScope ??= new Set(state.attachments.map(item => item.name));
            if (event.currentTarget.checked) state.attachmentScope.add(file.name);
            else state.attachmentScope.delete(file.name);
          }
        }),
        element('span', { class: 'truncate', text: file.name })
      ]),
      element('span', { class: 'muted', text: bytes(file.size) }),
      element('button', {
        type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + file.name, text: '✕',
        onclick: () => {
          const removed = state.attachments[index];
          state.attachments.splice(index, 1);
          releasePreview(removed);
          state.attachmentScope?.delete(file.name);
          if (!state.attachments.length) state.attachmentScope = null;
          renderAttachments();
        }
      })
    ].filter(Boolean));
  }));
}

export function addAttachments(fileList) {
  for (const file of fileList) {
    if (state.attachments.length >= MAX_ATTACH_FILES) {
      notify('runNotice', 'warn', `You can attach up to ${MAX_ATTACH_FILES} files to one message.`);
      break;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      notify('runNotice', 'warn', `${file.name} is larger than ${bytes(MAX_ATTACH_BYTES)} and was not attached.`);
      continue;
    }
    state.attachments.push(file);
    state.attachmentScope ??= new Set();
    state.attachmentScope.add(file.name);
  }
  renderAttachments();
  $('goal').focus({ preventScroll: true });
}

export function renderThread() {
  const thread = $('thread');
  const runs = state.chat.runs;
  if (!state.run || !runs.some(run => run.id === state.run.id)) state.run = runs.at(-1) ?? null;
  const children = [];
  if (!runs.length && !state.chat.pending) children.push(welcome());
  for (const run of runs) {
    children.push(userMessage(run.goal, run.adaptation?.attachments ?? []));
    children.push(assistantMessage(run, run.id === state.run?.id));
  }
  if (state.chat.pending) {
    children.push(userMessage(state.chat.pending.goal, state.chat.pending.files ?? []));
    children.push(element('div', { class: 'msg assistant' }, [
      svgIcon('logo', 'avatar'),
      element('div', { class: 'bubble stack' }, state.chat.pending.askConsent
        ? consentCard(state.chat.pending.goal)
        : state.chat.pending.reply
          ? element('div', { class: `answer${state.chat.pending.declined ? ' declined' : ''}` }, [renderMarkdown(state.chat.pending.reply)])
          : element('div', { class: 'thinking' }, [element('span', { class: 'pulse' }), element('span', { text: 'Reading your message…' })]))
    ]));
  }
  thread.replaceChildren(...children);
  renderChatHead();
  highlightActiveChat();
  // The workspace bar shows what this chat's situation needs now.
  syncAdaptiveWorkspace();
  const composer = $('composer');
  if (composer.getBoundingClientRect().top > window.innerHeight - 40) composer.scrollIntoView({ block: 'end' });
}

/** Called with every fresh copy of a run from the server. */
export function renderRun(run) {
  if (!run) return;
  const index = state.chat.runs.findIndex(item => item.id === run.id);
  if (index >= 0) state.chat.runs[index] = run;
  else if (state.chat.id === run.conversationId || !state.chat.id) state.chat.runs.push(run);
  const active = !state.chat.id || state.chat.id === run.conversationId;
  if (active) {
    state.run = run;
    renderThread();
  } else {
    // Background work in another chat updates the list/state without stealing focus.
    loadRuns().catch(() => {});
  }
}

/** The open chat's title and a few plain details above the thread. */
export function renderChatHead() {
  const runs = state.chat.runs;
  const first = runs[0]?.goal ?? state.chat.pending?.goal ?? '';
  const listed = state.conversations?.find(chat => chat.id === state.chat.id);
  const title = listed?.title || first;
  $('chatHeadText').hidden = !title;
  $('mobileTitle').textContent = title || 'Kindgleam';
  if (!title) return;
  $('chatTitle').textContent = title;
  $('chatTitle').title = title;
  const count = runs.length + (state.chat.pending ? 1 : 0);
  const shared = runs.some(run => run.visibility === 'workspace');
  const updated = runs.at(-1)?.updatedAt ?? runs.at(-1)?.createdAt ?? listed?.updatedAt;
  const [statusText, tone] = runs.length ? runStatus(runs.at(-1)) : ['', ''];
  $('chatMeta').replaceChildren(...[
    element('span', { class: 'chat-meta-item' }, [svgIcon('chat'), element('span', { text: `${count} message${count === 1 ? '' : 's'}` })]),
    element('span', { class: 'chat-meta-item' }, [svgIcon(shared ? 'users' : 'lock'), element('span', { text: shared ? 'Shared' : 'Private' })]),
    updated ? element('span', { class: 'chat-meta-item', text: timeAgo(updated) }) : null,
    tone === 'warn' ? element('span', { class: 'pill warn', text: statusText }) : null,
    contextChip()
  ].filter(Boolean));
}

/** How full the model's context was on this chat's latest reply. */
function contextChip() {
  const context = state.usage?.context;
  if (!context?.used || !context.limit) return null;
  const level = context.percent >= 80 ? 'high' : context.percent >= 50 ? 'mid' : 'low';
  const meter = element('span', { class: 'context-meter', 'aria-hidden': 'true' }, [element('i')]);
  meter.firstChild.style.width = `${Math.max(3, context.percent)}%`;
  return element('span', {
    class: 'chat-meta-item context-chip', 'data-level': level,
    title: `The last reply read ${context.used.toLocaleString()} of ${context.limit.toLocaleString()} tokens the model can hold at once.${context.percent >= 80 ? ' Start a new chat soon so older parts are not dropped.' : ''}`
  }, [meter, element('span', { text: `Context ${context.percent}%` })]);
}

function highlightActiveChat() {
  for (const item of $('runList').querySelectorAll('[data-run]')) {
    item.setAttribute('aria-current', String(item.dataset.run === state.chat.id));
  }
}

/** The message box grows with what is typed, up to a limit set in CSS. */
export function growComposer() {
  const box = $('goal');
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

export function newChat() {
  if ($('tab-runs').hidden) selectTab('runs');
  state.chat = { id: null, runs: [], pending: null, consent: state.settings.consent, workspaceSourceId: null };
  state.workspaceSourceId = null;
  state.workspaceSource = null;
  if (state.usage) state.usage.context = null;
  $('shareRun').checked = state.settings.share;
  clearDraft();
  state.run = null;
  clearNotice('runNotice');
  renderUsageLimitLock();
  document.body.classList.remove('chats-open');
  renderThread();
  $('goal').focus({ preventScroll: true });
}

export async function loadRuns() {
  const { conversations } = await api('GET', '/api/conversations?limit=100');
  state.conversations = conversations;
  renderChatList();
  if (state.chat) renderChatHead();
}

function dateGroup(value) {
  const day = 86_400_000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const at = new Date(value).getTime();
  if (at >= startOfToday) return 'Today';
  if (at >= startOfToday - day) return 'Yesterday';
  if (at >= startOfToday - 7 * day) return 'Previous 7 days';
  return 'Older';
}

const CHAT_SURFACE_LABELS = Object.freeze({
  'normal-chat': 'Chat',
  code: 'Code',
  research: 'Research',
  design: 'Design'
});

export function renderChatList() {
  const list = $('runList');
  const query = $('chatSearch').value.trim().toLowerCase();
  const chats = state.conversations.filter(chat => !query || String(chat.title).toLowerCase().includes(query));
  list.replaceChildren();
  if (!chats.length) {
    list.append(element('div', { class: 'empty small', text: query ? 'No chats match your search.' : 'No chats yet.' }));
    return;
  }
  let lastGroup = '';
  for (const chat of chats) {
    const group = dateGroup(chat.updatedAt);
    if (group !== lastGroup) {
      list.append(element('div', { class: 'list-group', text: group }));
      lastGroup = group;
    }
    // Each chat shows a short detail line; one waiting for the person says so.
    const [statusText, tone] = runStatus({ state: chat.state });
    list.append(element('div', { class: 'run-row' }, [element('button', {
      class: 'run-item', type: 'button', 'data-run': chat.id, title: `${chat.title} · ${timeAgo(chat.updatedAt)}`, onclick: () => openChat(chat.id)
    }, [
      element('span', { class: 'run-item-goal', text: chat.title }),
      element('span', { class: 'run-item-meta' }, [
        tone === 'warn'
          ? element('span', { class: 'run-item-status' }, [element('span', { class: 'dot warn' }), element('span', { text: statusText })])
          : element('span', { text: timeAgo(chat.updatedAt) }),
        Number(chat.messages) > 1 ? element('span', { text: String(chat.messages) + ' messages' }) : null,
        CHAT_SURFACE_LABELS[chat.surface] ? element('span', { class: 'run-item-surface', text: CHAT_SURFACE_LABELS[chat.surface] }) : null,
        chat.shared ? element('span', { class: 'run-item-shared', title: 'Shared with workspace' }, svgIcon('users')) : null
      ])
    ]), element('button', {
      class: 'run-delete', type: 'button', title: 'Delete chat', 'aria-label': `Delete chat: ${chat.title}`,
      onclick: event => { event.stopPropagation(); deleteChat(chat); }
    }, [svgIcon('trash')])]));
  }
  highlightActiveChat();
}

async function deleteChat(chat) {
  if (!confirm(`Delete "${String(chat.title).slice(0, 80)}"? Its messages and steps are removed for good.`)) return;
  await guard(async () => {
    await api('DELETE', `/api/conversations/${encodeURIComponent(chat.id)}`);
    if (state.chat.id === chat.id) newChat();
    await loadRuns();
    notify('runNotice', 'ok', 'Chat deleted.');
  }, 'runNotice');
}

export async function openChat(id) {
  if ($('tab-runs').hidden) selectTab('runs');
  await guard(async () => {
    const { runs } = await api('GET', `/api/conversations/${encodeURIComponent(id)}`);
    const latestSource = runs.at(-1)?.adaptation?.attachments?.find(item => item?.sourceId)
      ?? runs.at(-1)?.adaptation?.attachments?.find(item => item?.sourceKind);
    state.chat = {
      id,
      runs,
      pending: null,
      workspaceSourceId: runs.at(-1)?.adaptation?.workspaceSourceId ?? latestSource?.sourceId ?? null,
      consent: runs.some(run => run.adaptation?.privacy?.consent?.modelProvider === true)
    };
    if (state.chat.workspaceSourceId) {
      state.workspaceSourceId = state.chat.workspaceSourceId;
      state.workspaceSource = latestSource
        ? { id: state.chat.workspaceSourceId, kind: latestSource.sourceKind ?? 'github', name: latestSource.sourceName ?? latestSource.name }
        : null;
    }
    for (const run of runs) if (state.chat.consent) state.consented.add(run.id);
    state.run = runs.at(-1) ?? null;
    document.body.classList.remove('chats-open');
    if (state.usage) state.usage.context = null;
    renderThread();
    loadUsage();
  }, 'runNotice');
}

/** Ask the person once per chat before the AI reads it. */
function consentCard(goal) {
  return element('div', { class: 'step-card stack' }, [
    ...heading('Allow the AI to read this chat?', 'Your messages in this chat are sent to the AI provider so it can answer. Nothing is sent until you allow it. Kindgleam keeps each chat’s own memory automatically. Cross-chat memory is separate and can be turned on or off in Settings → Personalization.'),
    element('div', { class: 'row wrap' }, [
      button('Allow', () => { state.chat.consent = true; state.chat.pending = null; sendMessage(goal); }, 'primary'),
      button('Not now', () => { state.chat.pending = { goal, reply: 'Okay. Nothing was sent. You can allow it any time by sending the message again.' }; renderThread(); })
    ])
  ]);
}

/** The person's own settings, sent with every message as context. */
export function personalContext() {
  const settings = state.settings;
  const browser = browserAdaptationContext();
  const externalContext = settings.externalContext !== 'deny';
  return {
    language: settings.language || browser.language,
    skillLevel: settings.style,
    jurisdiction: externalContext ? settings.country.trim() : '',
    preferences: [
      ...browser.preferences,
      ...(settings.length ? [settings.length === 'concise' ? 'short answers' : 'detailed answers'] : []),
      ...(settings.autonomy ? ['autonomy: ' + settings.autonomy] : []),
      ...(settings.adaptiveIntensity ? ['adaptive intensity: ' + settings.adaptiveIntensity] : []),
      ...(settings.adaptiveDepth ? ['adaptive depth: ' + settings.adaptiveDepth] : []),
      ...(settings.capabilityInvestment ? ['capability investment: ' + settings.capabilityInvestment] : []),
      ...(externalContext && settings.about.trim() ? ['About me: ' + settings.about.trim().slice(0, 400)] : [])
    ],
    adaptiveControl: {
      ...(state.attachments.length && state.attachmentScope instanceof Set
        ? { includeArtifacts: [...state.attachmentScope] }
        : {}),
      depth: settings.adaptiveDepth || 'standard',
      intensity: settings.adaptiveIntensity || 'standard',
      capabilityInvestment: settings.capabilityInvestment || 'ask',
      allowAdaptiveExpansion: settings.allowAdaptiveExpansion === true
    }
  };
}

export async function fileToBase64(file) {
  const view = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // Chunked so a large file cannot blow the argument limit of fromCharCode.
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function uploadAttachments(files, visibility) {
  const ids = [];
  for (const file of files) {
    const object = await api('POST', '/api/objects', {
      name: file.name,
      type: 'attachment',
      contentType: file.type || 'application/octet-stream',
      content: await fileToBase64(file),
      encoding: 'base64',
      visibility
    }, { idempotencyKey: crypto.randomUUID(), timeoutMs: 120_000 });
    ids.push(object.id);
  }
  return ids;
}

async function createRunFromQueuedItem(item) {
  const visibility = item.visibility === 'workspace' ? 'workspace' : 'private';
  const attachments = Array.isArray(item.attachmentIds) ? [...item.attachmentIds] : [];
  const files = await loadOfflineFiles(item);
  for (let index = attachments.length; index < files.length; index += 1) {
    const uploaded = await uploadAttachments([files[index]], visibility);
    attachments.push(...uploaded);
    item.attachmentIds = attachments;
    state.network.queue = state.network.queue.map(entry => entry.id === item.id ? item : entry);
    writeOfflineQueue();
  }
  return api('POST', '/api/runs', {
    goal: item.goal,
    conversationId: item.conversationId,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...personalContext(),
    adaptiveControl: item.adaptiveControl ?? personalContext().adaptiveControl,
    activeSurface: item.activeSurface ?? state.activeSurface ?? 'normal-chat',
    attachments,
    ...(item.workspaceSourceId ? { workspaceSourceId: item.workspaceSourceId } : {}),
    visibility,
    privacyConsent: { modelProvider: state.chat.consent }
  }, { idempotencyKey: item.idempotencyKey });
}

async function queueOfflineMessage(goal, files, visibility, idempotencyKey = crypto.randomUUID()) {
  state.chat.id ??= crypto.randomUUID();
  const item = {
    id: crypto.randomUUID(),
    idempotencyKey,
    adaptiveControl: personalContext().adaptiveControl,
    goal,
    conversationId: state.chat.id,
    workspaceId: state.workspaceId,
    visibility,
    workspaceSourceId: state.chat.workspaceSourceId ?? state.workspaceSourceId ?? null,
    activeSurface: state.activeSurface ?? 'normal-chat',
    attachmentIds: [],
    files
  };
  state.network.queue.push(item);
  writeOfflineQueue();
  await storeOfflineFiles(item);
  state.chat.pending = {
    goal,
    reply: 'Queued on this device. I will send it automatically when the connection returns.',
    files: files.map(file => file.name),
    offline: true
  };
  state.attachments = [];
  releaseAllPreviews();
  renderAttachments();
  updateConnectionUI();
  clearDraft();
  renderThread();
}

let flushing = false;

export async function flushOfflineQueue() {
  if (!state.principal || navigator.onLine === false || state.driving || !state.settings.offlineQueue) return;
  if (flushing) return;
  flushing = true;
  try { await flushQueuedItems(); } finally { flushing = false; }
}

async function flushQueuedItems() {
  const currentWorkspace = state.workspaceId;
  for (const item of [...state.network.queue]) {
    await loadOfflineFiles(item);
    if (navigator.onLine === false || item.workspaceId !== currentWorkspace) continue;
    try {
      const run = await createRunFromQueuedItem(item);
      state.network.queue = state.network.queue.filter(entry => entry.id !== item.id);
      writeOfflineQueue();
      await deleteOfflineFiles(item.id);
      if (state.chat.pending?.offline && state.chat.pending.goal === item.goal) state.chat.pending = null;
      if (state.chat.id === item.conversationId) {
        state.chat.runs.push(run);
        state.run = run;
        renderThread();
      }
      updateConnectionUI();
      await autoDrive(run);
    } catch (error) {
      // A temporary failure keeps the message for the next reconnect; only
      // a definite refusal (bad request, policy, access) removes it.
      if (error.code === 'offline' || error.transient || navigator.onLine === false || error.status >= 500) {
        updateConnectionUI();
        return;
      }
      state.network.queue = state.network.queue.filter(entry => entry.id !== item.id);
      writeOfflineQueue();
      await deleteOfflineFiles(item.id);
      if (state.chat.pending?.offline && state.chat.pending.goal === item.goal) {
        state.chat.pending = { goal: item.goal, reply: error.message, files: item.files?.map(file => file.name) ?? [] };
        renderThread();
      }
    }
  }
}

export async function sendMessage(text) {
  if (usageLimitStatus()) {
    renderUsageLimitLock();
    return;
  }
  const files = [...state.attachments];
  const goal = String(text ?? '').trim()
    || (files.length ? `Please look at the attached file${files.length > 1 ? 's' : ''}.` : '');
  if (!goal || state.sendWaiting) return;
  state.chat.consent ||= state.settings.consent;
  if (aiConnected() && !state.chat.consent) {
    // A second message while the consent question is open joins the first,
    // so nothing the person typed is dropped.
    const earlier = state.chat.pending?.askConsent ? state.chat.pending.goal : '';
    state.chat.pending = { goal: earlier ? `${earlier}\n\n${goal}` : goal, reply: '', askConsent: true };
    $('goal').value = '';
    clearDraft();
    renderThread();
    return;
  }

  const visibility = $('shareRun').checked ? 'workspace' : 'private';
  state.chat.id ??= crypto.randomUUID();

  const chatSourceId = state.chat.workspaceSourceId ?? state.workspaceSourceId ?? null;
  if (navigator.onLine !== false && chatSourceId) {
    state.workspaceSourceId = chatSourceId;
    await syncActiveWorkspaceSource().catch(error => notify('runNotice', 'warn', error.message || 'Workspace source synchronization failed.'));
  }

  if (navigator.onLine === false && state.settings.offlineQueue) {
    $('goal').value = '';
    await queueOfflineMessage(goal, files, visibility);
    growComposer();
    return;
  }

  state.chat.pending = { goal, reply: '', files: files.map(file => file.name) };
  $('goal').value = '';
  growComposer();
  renderThread();

  const attachments = [];
  const idempotencyKey = crypto.randomUUID();
  try {
    for (const file of files) {
      const uploaded = await uploadAttachments([file], visibility);
      attachments.push(...uploaded);
    }
    const run = await api('POST', '/api/runs', {
      goal,
      conversationId: state.chat.id,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...personalContext(),
      attachments,
      ...(chatSourceId ? { workspaceSourceId: chatSourceId } : {}),
      activeSurface: state.activeSurface ?? 'normal-chat',
      creationMode: $('adaptiveCreateStrip')?.dataset.mode ?? null,
      visibility,
      privacyConsent: { modelProvider: state.chat.consent }
    }, { idempotencyKey });
    state.chat.pending = null;
    state.attachments = [];
    state.attachmentScope = null;
    releaseAllPreviews();
    renderAttachments();
    clearDraft();
    if (state.chat.consent) state.consented.add(run.id);
    state.chat.runs.push(run);
    state.run = run;
    renderThread();
    loadRuns().catch(() => {});
    await autoDrive(run);
    loadRuns().catch(() => {});
  } catch (error) {
    if (error.code === 'usage-limit-reached') {
      state.chat.pending = null;
      $('goal').value = goal;
      renderThread();
      await loadUsage();
      renderUsageLimitLock();
      return;
    }
    if ((error.code === 'offline' || error.transient || navigator.onLine === false) && state.settings.offlineQueue) {
      // Same key as the attempt: if the server did get it, the retry
      // returns that chat turn instead of starting a second one.
      await queueOfflineMessage(goal, files, visibility, idempotencyKey);
      const queued = state.network.queue.at(-1);
      if (queued) queued.attachmentIds = [...attachments];
      writeOfflineQueue();
      state.chat.pending = {
        goal,
        reply: 'Connection lost. Your message is queued locally and will retry automatically.',
        files: files.map(file => file.name),
        offline: true
      };
      updateConnectionUI();
      renderThread();
      return;
    }
    state.chat.pending = {
      goal,
      reply: error.code === 'needs-input' && Array.isArray(error.detail?.questions)
        ? `Could you tell me a bit more? ${error.detail.questions.join(' ')}`
        : error.code === 'usage-policy'
          ? [error.message, ...(error.payload?.alternatives ?? []).map(item => `- ${item}`)].join('\n')
          : error.message,
      ...(error.code === 'usage-policy' ? { declined: true } : {})
    };
    renderThread();
  }
}

export async function stopRun(reason) {
  if (!state.run) return;
  await guard(async () => {
    renderRun(await api('POST', `/api/runs/${state.run.id}/fail`, { reason }));
    await loadRuns();
  }, 'runNotice');
}
