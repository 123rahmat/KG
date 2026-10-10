/**
 * Kindgleam — browser client: Files attached to a message: picking, uploading, previews and offline storage.
 * Part of app.js, split out by concern; app.js wires the page together.
 */

import { renderMarkdown } from './markdown.js';
import { syncThread } from './thread-view.js';
import { workPresentation } from './adaptive-workspace.js';
import { state, $, element, button, api, notify, guard, canEdit, aiConnected, clearNotice, updateConnectionUI } from './ui-core.js';
import { autoDrive, browserAdaptationContext, bytes, heading, runStatus, svgIcon, timeAgo } from './app.js';
import { assistantMessage, userMessage, welcome } from './app-actions.js';
import { loadUsage, renderUsageLimitLock, usageLimitStatus, selectTab } from './app-account.js';
import { clearDraft, readDraft, saveDraftNow, deleteOfflineFiles, loadOfflineFiles, storeOfflineFiles, writeOfflineQueue } from './app-settings.js';
import { chatNavigationModel, chatWorkStatus } from './chat-navigation-model.js';
import { syncAdaptiveWorkspace } from './adaptive-workspace.js';
import { syncActiveWorkspaceSource } from './workspace-sources.js';
import { selectedAttachments } from './attachment-selection.js';
import { renderProjectHub } from './app-projects.js';

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

function clearStagedChatAttachments(){
  // Local File objects are not a shared project context. Carrying a pending
  // upload into another conversation could accidentally send the wrong files.
  for(const file of state.attachments)releasePreview(file);
  state.attachments=[];
  state.attachmentScope=null;
  renderAttachments();
}

function consumeAttachments(files) {
  const sent = new Set(files);
  state.attachments = state.attachments.filter(file => !sent.has(file));
  for (const file of files) { releasePreview(file); state.attachmentScope?.delete(file); }
  if (!state.attachments.length) state.attachmentScope = null;
  renderAttachments();
}

function renderAttachments() {
  const list = $('attachList');
  list.hidden = state.attachments.length === 0;
  if (state.attachments.length && !(state.attachmentScope instanceof Set)) {
    state.attachmentScope = new Set(state.attachments);
  }
  const live = new Set(state.attachments);
  for (const file of [...attachmentPreviewUrls.keys()]) if (!live.has(file)) releasePreview(file);
  list.replaceChildren(...state.attachments.map((file, index) => {
    const inScope = state.attachmentScope?.has(file) === true;
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
            state.attachmentScope ??= new Set(state.attachments);
            if (event.currentTarget.checked) state.attachmentScope.add(file);
            else state.attachmentScope.delete(file);
            syncAdaptiveWorkspace();
          }
        }),
        element('span', { class: 'truncate', text: file.name })
      ]),
      element('span', { class: 'muted', text: bytes(file.size) }),
      /\.zip$/i.test(file.name)
        ? element('span', { class: 'attachment-archive-note', title: 'Archives are inspected after upload; switching workspaces is optional.', text: 'ZIP archive' })
        : null,
      element('button', {
        type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + file.name, text: '✕',
        onclick: () => {
          const removed = state.attachments[index];
          state.attachments.splice(index, 1);
          releasePreview(removed);
          state.attachmentScope?.delete(removed);
          if (!state.attachments.length) state.attachmentScope = null;
          renderAttachments();
        }
      })
    ].filter(Boolean));
  }));
  // Optional workspace suggestions react to attached files without moving
  // the conversation or uploading anything before the user presses Send.
  syncAdaptiveWorkspace();
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
    state.attachmentScope.add(file);
  }
  renderAttachments();
  $('goal').focus({ preventScroll: true });
}

export function renderThread() {
  const thread = $('thread');
  const runs = state.chat.runs;
  if (!state.run || !runs.some(run => run.id === state.run.id)) state.run = runs.at(-1) ?? null;
  const entries = [];
  if (!runs.length && !state.chat.pending) entries.push({ key: 'welcome', signature: JSON.stringify([state.executionConfig, state.activeSurface]), render: welcome });
  for (const run of runs) {
    entries.push({
      key: run.id + ':user', signature: JSON.stringify([run.goal, run.adaptation?.attachments]),
      render: () => userMessage(run.goal, run.adaptation?.attachments ?? [])
    });
    const signature = JSON.stringify([
      run, run.id === state.run?.id, state.driving === run.id, state.drivingRuns?.has(run.id), state.busyRuns?.has(run.id),
      state.consentNeeded.has(run.id), state.manualOpen.has(run.id), state.actions?.get(run.id), state.feedbackByRun?.get(run.id),
      state.role, state.executionConfig, state.workspaceSource, state.activeSurface,
      state.network.online, state.network.reachable, run.id === state.run?.id && !['complete', 'failed', 'blocked', 'exhausted', 'iterate'].includes(run.state) ? Math.floor(Date.now() / 60_000) : 0
    ]);
    entries.push({ key: run.id + ':assistant', signature, render: () => assistantMessage(run, run.id === state.run?.id) });
  }
  if (state.chat.pending) {
    entries.push({ key: 'pending:user', signature: JSON.stringify(state.chat.pending), render: () => userMessage(state.chat.pending.goal, state.chat.pending.files ?? []) });
    entries.push({ key: 'pending:assistant', signature: JSON.stringify(state.chat.pending), render: () => element('div', { class: 'msg assistant' }, [
      svgIcon('logo', 'avatar'),
      element('div', { class: 'bubble stack' }, state.chat.pending.askConsent
        ? consentCard(state.chat.pending.goal)
        : state.chat.pending.reply
          ? element('div', { class: `answer${state.chat.pending.declined ? ' declined' : ''}` }, [renderMarkdown(state.chat.pending.reply)])
          : element('div', { class: 'thinking' }, [element('span', { class: 'pulse' }), element('span', { text: state.chat.pending.status || 'Reading your message…' })]))
    ]) });
  }
  syncThread(thread, entries, state.chat.id ?? 'new:' + (state.activeProjectId ?? ''));
  announceWork();
  renderChatHead();
  highlightActiveChat();
  // The workspace bar shows what this chat's situation needs now.
  syncAdaptiveWorkspace();
  updateThreadJump();
  document.dispatchEvent(new Event('kindgleam:composer-state'));
}

function announceWork() {
  const node = $('workAnnouncer');
  const run = state.run;
  if (!node) return;
  const message = state.chat.pending && !state.chat.pending.reply ? 'Reading your message' : run ? workPresentation(run, {
    driving: state.driving === run.id || state.drivingRuns?.has(run.id) || state.busyRuns?.has(run.id),
    online: state.network.online && state.network.reachable,
    consent: state.consentNeeded.has(run.id), manual: state.manualOpen.has(run.id)
  }).label : '';
  if (node.textContent !== message) node.textContent = message;
}

function updateThreadJump() {
  const jump = $('threadJump');
  const thread = $('thread');
  if (jump && thread) jump.hidden = $('tab-runs').hidden || !state.chat.runs.length
    || thread.getBoundingClientRect().bottom < window.innerHeight - 110;
}

let scrollFrame = 0;
window.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateThreadJump(); });
}, { passive: true });
window.addEventListener('resize', updateThreadJump);
document.addEventListener('kindgleam:connection-state', () => { if (state.principal) renderThread(); });
$('threadJump')?.addEventListener('click', () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: reduce ? 'instant' : 'smooth' });
  });

/** Called with every fresh copy of a run from the server. */
export function renderRun(run) {
  if (!run) return;
  const active=Boolean(state.chat.id && (
    state.chat.id===run.conversationId
    || (!run.conversationId && state.chat.id===run.id)
  ));
  const index=active?state.chat.runs.findIndex(item=>item.id===run.id):-1;
  if(index>=0)state.chat.runs[index]=run;
  else if(active)state.chat.runs.push(run);
  // A blank new chat must never absorb background output from an older
  // Code/Research conversation merely because it has no ID yet.
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

let openChatEpoch=0;
let chatListEpoch=0;
export function newChat(options={}) {
  openChatEpoch++;
  if(options?.skipSave!==true)saveDraftNow();
  if(['code','research','normal-chat'].includes(options?.surface))
    state.activeSurface=options.surface;
  clearStagedChatAttachments();
  if ($('tab-runs').hidden) selectTab('runs');
  state.chat = { id: null, runs: [], pending: null, consent: state.settings.consent, workspaceSourceId: null, projectId: state.activeProjectId ?? null };
  state.workspaceSourceId = null;
  state.workspaceSource = null;
  if (state.usage) state.usage.context = null;
  $('shareRun').checked = state.settings.share;
  $('goal').value=readDraft()?.text??'';
  growComposer();
  state.run = null;
  // Background run drivers continue but do not hold the new chat's stop
  // button or composer hostage.
  state.driving=null;
  state.drivingLabel='';
  clearNotice('runNotice');
  renderUsageLimitLock();
  document.body.classList.remove('chats-open');
  renderThread();
  $('goal').focus({ preventScroll: true });
}

export async function loadRuns(){
  const epoch=++chatListEpoch;
  const workspace=state.workspaceId;
  const projectId=state.activeProjectId??null;
  const surface=$('chatSurfaceFilter')?.value??'all';
  const status=$('chatStatusFilter')?.value??'all';
  const search=String($('chatSearch')?.value??'').trim().slice(0,160);
  const params=new URLSearchParams({limit:'100'});
  if(projectId)params.set('projectId',projectId);
  if(surface!=='all')params.set('surface',surface);
  if(status!=='all')params.set('status',status);
  if(search)params.set('search',search);
  const {conversations}=await api('GET','/api/conversations?'+params.toString());
  // Background polls from an old project/workspace must never replace the
  // visible chat list after a quick selection or account/workspace switch.
  if(epoch!==chatListEpoch||workspace!==state.workspaceId
    ||projectId!==(state.activeProjectId??null)
    ||surface!==($('chatSurfaceFilter')?.value??'all')
    ||status!==($('chatStatusFilter')?.value??'all')
    ||search!==String($('chatSearch')?.value??'').trim().slice(0,160))return;
  state.conversations=Array.isArray(conversations)?conversations:[];
  renderChatList();
  if(state.chat)renderChatHead();
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
  research: 'Research'
});

export function renderChatList(){
  const list=$('runList');
  const query=$('chatSearch')?.value??'';
  const surface=$('chatSurfaceFilter')?.value??'all';
  const status=$('chatStatusFilter')?.value??'all';
  const enriched=state.conversations.map(chat=>({
    ...chat,
    projectName:state.projects.find(project=>project.id===chat.projectId)?.name??''
  }));
  const navigation=chatNavigationModel(enriched,{
    projectId:state.activeProjectId,surface,status,query
  });
  const summary=$('chatListSummary');
  if(summary)summary.textContent=navigation.shown+' shown · '
    +navigation.coding+' Code · '+navigation.research+' Research · '
    +navigation.needsAction+' need attention'
    +(navigation.loaded>=100?' · 100 matching chats loaded':'');
  list.replaceChildren();
  if(!navigation.chats.length){
    list.append(element('div',{class:'empty small',text:navigation.isFiltered
      ?'No chats match these filters. Adjust the project, workspace or status.'
      :'No chats yet. Start a Code or Research conversation.'}));
    return;
  }
  let lastGroup='';
  for(const chat of navigation.chats){
    const group=dateGroup(chat.updatedAt);
    if(group!==lastGroup){
      list.append(element('div',{class:'list-group',text:group}));
      lastGroup=group;
    }
    const [statusText,tone]=runStatus({state:chat.state});
    const statusGroup=chatWorkStatus(chat);
    const projectName=chat.projectName;
    list.append(element('div',{class:'run-row',
      'data-chat-status':statusGroup,
      'data-chat-surface':chat.surface},[
      element('button',{
        class:'run-item',type:'button','data-run':chat.id,
        title:chat.title+' · '+timeAgo(chat.updatedAt),
        onclick:()=>openChat(chat.id)
      },[
        element('span',{class:'run-item-goal',text:chat.title}),
        element('span',{class:'run-item-meta'},[
          tone==='warn'||tone==='bad'
            ?element('span',{class:'run-item-status'},[
              element('span',{class:'dot '+(tone==='bad'?'bad':'warn')}),
              element('span',{text:statusText})
            ])
            :element('span',{text:timeAgo(chat.updatedAt)}),
          Number(chat.messages)>1?element('span',{text:String(chat.messages)+' messages'}):null,
          CHAT_SURFACE_LABELS[chat.surface]
            ?element('span',{class:'run-item-surface',text:CHAT_SURFACE_LABELS[chat.surface]}):null,
          projectName&&!state.activeProjectId
            ?element('span',{class:'run-item-project',text:projectName}):null,
          chat.shared?element('span',{class:'run-item-shared',
            title:'Shared with workspace'},svgIcon('users')):null
        ].filter(Boolean))
      ]),
      element('button',{class:'run-delete',type:'button',title:'Delete chat',
        'aria-label':'Delete chat: '+chat.title,
        onclick:event=>{event.stopPropagation();deleteChat(chat);}},
        [svgIcon('trash')])
    ]));
  }
  highlightActiveChat();
}

async function deleteChat(chat) {
  if (!confirm(`Delete "${String(chat.title).slice(0, 80)}"? Its messages and steps are removed for good.`)) return;
  await guard(async () => {
    await api('DELETE', `/api/conversations/${encodeURIComponent(chat.id)}`);
    if (state.chat.id === chat.id) {clearDraft();newChat({skipSave:true});}
    await loadRuns();
    notify('runNotice', 'ok', 'Chat deleted.');
  }, 'runNotice');
}

export async function openChat(id){
  if($('tab-runs').hidden)selectTab('runs');
  const epoch=++openChatEpoch;
  const workspace=state.workspaceId;
  saveDraftNow();
  await guard(async()=>{
    const {runs}=await api('GET','/api/conversations/'+encodeURIComponent(id));
    // A slower response from another click cannot steal the visible chat.
    if(epoch!==openChatEpoch||workspace!==state.workspaceId)return;
    clearStagedChatAttachments();
    const latest=runs.at(-1)??null;
    const latestSource=latest?.adaptation?.attachments?.find(item=>item?.sourceId)
      ??latest?.adaptation?.attachments?.find(item=>item?.sourceKind);
    const chatProjectId=latest?.projectId??null;
    // Do not silently replace an explicit "All projects" navigation filter.
    // The chat's own project stays attached to subsequent messages.
    state.chat={
      id,runs,pending:null,
      workspaceSourceId:latest?.adaptation?.workspaceSourceId??latestSource?.sourceId??null,
      projectId:chatProjectId,
      consent:runs.some(run=>run.adaptation?.privacy?.consent?.modelProvider===true)
    };
    state.workspaceSourceId=state.chat.workspaceSourceId;
    state.workspaceSource=state.workspaceSourceId&&latestSource
      ? {id:state.workspaceSourceId,kind:latestSource.sourceKind??'github',
          name:latestSource.sourceName??latestSource.name}
      :null;
    const surface=latest?.surface??latest?.adaptation?.primarySurface;
    state.activeSurface=['code','research'].includes(surface)?surface:'normal-chat';
    renderProjectHub();
    for(const run of runs)if(state.chat.consent)state.consented.add(run.id);
    state.run=latest;
    state.driving=latest && state.drivingRuns?.has(latest.id)?latest.id:null;
    state.drivingLabel='';
    $('goal').value=readDraft()?.text??'';
    growComposer();
    document.body.classList.remove('chats-open');
    if(state.usage)state.usage.context=null;
    renderThread();
    loadUsage();
  },'runNotice');
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
        ? { includeArtifacts: selectedAttachments(state.attachments, state.attachmentScope).map(file => file.name) }
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

async function uploadAttachments(files, visibility, workspaceId = state.workspaceId) {
  const ids = [];
  for (const file of files) {
    const object = await api('POST', '/api/objects', {
      name: file.name,
      type: 'attachment',
      contentType: file.type || 'application/octet-stream',
      content: await fileToBase64(file),
      encoding: 'base64',
      visibility
    }, { workspaceId, idempotencyKey: crypto.randomUUID(), timeoutMs: 120_000 });
    ids.push(object.id);
  }
  return ids;
}

async function createRunFromQueuedItem(item) {
  const visibility = item.visibility === 'workspace' ? 'workspace' : 'private';
  const attachments = Array.isArray(item.attachmentIds) ? [...item.attachmentIds] : [];
  const files = await loadOfflineFiles(item);
  for (let index = attachments.length; index < files.length; index += 1) {
    const uploaded = await uploadAttachments([files[index]], visibility, item.workspaceId);
    attachments.push(...uploaded);
    item.attachmentIds = attachments;
    state.network.queue = state.network.queue.map(entry => entry.id === item.id ? item : entry);
    writeOfflineQueue();
  }
  return api('POST', '/api/runs', {
    goal: item.goal,
    conversationId: item.conversationId,
    projectId: Object.hasOwn(item, 'projectId') ? item.projectId : state.activeProjectId ?? null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(item.context ?? personalContext()),
    adaptiveControl: item.adaptiveControl ?? personalContext().adaptiveControl,
    activeSurface: item.activeSurface ?? state.activeSurface ?? 'normal-chat',
    creationMode: item.creationMode ?? null,
    attachments,
    ...(item.workspaceSourceId ? { workspaceSourceId: item.workspaceSourceId } : {}),
    visibility,
    privacyConsent: { modelProvider: item.modelConsent ?? state.chat.consent }
  }, { workspaceId: item.workspaceId, idempotencyKey: item.idempotencyKey });
}

async function queueOfflineMessage(goal, files, visibility, idempotencyKey, submission, chat) {
  const item = {
    id: crypto.randomUUID(),
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    context: submission.context,
    adaptiveControl: submission.context.adaptiveControl,
    goal,
    conversationId: chat.id,
    workspaceId: submission.workspaceId,
    projectId: submission.projectId,
    visibility,
    workspaceSourceId: submission.workspaceSourceId,
    activeSurface: submission.activeSurface,
    creationMode: submission.creationMode,
    modelConsent: submission.modelConsent,
    attachmentIds: [],
    files
  };
  state.network.queue.push(item);
  writeOfflineQueue();
  await storeOfflineFiles(item);
  chat.pending = {
    goal,
    reply: 'Queued on this device. I will send it automatically when the connection returns.',
    files: files.map(file => file.name),
    offline: true
  };
  if (state.chat === chat && state.workspaceId === submission.workspaceId) consumeAttachments(files);
  updateConnectionUI();
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
    if (state.workspaceId !== currentWorkspace) return;
    if (navigator.onLine === false || item.workspaceId !== currentWorkspace) continue;
    try {
      const run = await createRunFromQueuedItem(item);
      state.network.queue = state.network.queue.filter(entry => entry.id !== item.id);
      writeOfflineQueue();
      await deleteOfflineFiles(item.id);
      if (state.workspaceId === currentWorkspace && state.chat.id === item.conversationId) {
        if (state.chat.pending?.offline && state.chat.pending.goal === item.goal) state.chat.pending = null;
        state.chat.runs.push(run);
        state.run = run;
        renderThread();
      }
      updateConnectionUI();
      if (state.workspaceId === currentWorkspace) await autoDrive(run);
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
      if (state.workspaceId === currentWorkspace && state.chat.id === item.conversationId && state.chat.pending?.offline && state.chat.pending.goal === item.goal) {
        state.chat.pending = { goal: item.goal, reply: error.message, files: item.files?.map(file => file.name) ?? [] };
        renderThread();
      }
    }
  }
}

export async function sendMessage(text) {
  if (!canEdit()) return;
  if (usageLimitStatus()) {
    renderUsageLimitLock();
    return;
  }
  const files = selectedAttachments(state.attachments, state.attachmentScope);
  const context = personalContext();
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
  const chat = state.chat;
  const submission = {
    context, workspaceId: state.workspaceId,
    projectId: state.activeProjectId ?? chat.projectId ?? null,
    workspaceSourceId: chat.workspaceSourceId ?? state.workspaceSourceId ?? null,
    activeSurface: state.activeSurface ?? 'normal-chat',
    creationMode: $('adaptiveCreateStrip')?.dataset.mode ?? null,
    modelConsent: chat.consent
  };

  if (navigator.onLine === false && state.settings.offlineQueue) {
    $('goal').value = '';
    clearDraft();
    state.sendWaiting = true;
    try { await queueOfflineMessage(goal, files, visibility, undefined, submission, chat); }
    finally { state.sendWaiting = false; document.dispatchEvent(new Event('kindgleam:composer-state')); }
    growComposer();
    return;
  }

  chat.pending = {
    goal, reply: '', files: files.map(file => file.name),
    status: files.length ? 'Preparing ' + files.length + ' selected file' + (files.length === 1 ? '' : 's') + '…' : 'Preparing your request…'
  };
  state.sendWaiting = true;
  document.dispatchEvent(new Event('kindgleam:composer-state'));
  $('goal').value = '';
  clearDraft();
  growComposer();
  renderThread();

  const attachments = [];
  const idempotencyKey = crypto.randomUUID();
  try {
    if (navigator.onLine !== false && submission.workspaceSourceId) {
      if (chat.pending) chat.pending.status = 'Checking the selected project source…';
      if (state.chat === chat) renderThread();
      await syncActiveWorkspaceSource({ sourceId: submission.workspaceSourceId, workspaceId: submission.workspaceId, chat }).catch(error => notify('runNotice', 'warn', error.message || 'Couldn’t refresh the connected project source.'));
    }
    for (const [index, file] of files.entries()) {
      if (chat.pending) chat.pending.status = 'Uploading selected file ' + (index + 1) + ' of ' + files.length + ' · ' + file.name.slice(0, 75);
      if (state.chat === chat) renderThread();
      const uploaded = await uploadAttachments([file], visibility, submission.workspaceId);
      attachments.push(...uploaded);
    }
    if (chat.pending) chat.pending.status = 'Creating your task…';
    if (state.chat === chat) renderThread();
    const run = await api('POST', '/api/runs', {
      goal,
      conversationId: chat.id,
      projectId: submission.projectId,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...context,
      attachments,
      ...(submission.workspaceSourceId ? { workspaceSourceId: submission.workspaceSourceId } : {}),
      activeSurface: submission.activeSurface,
      creationMode: submission.creationMode,
      visibility,
      privacyConsent: { modelProvider: submission.modelConsent }
    }, { workspaceId: submission.workspaceId, idempotencyKey });
    chat.pending = null;
    chat.projectId = run.projectId ?? submission.projectId;
    if (state.chat === chat && state.workspaceId === submission.workspaceId) {
      consumeAttachments(files);
      state.run = run;
    }
    if (submission.modelConsent) state.consented.add(run.id);
    chat.runs.push(run);
    state.cancelledRuns?.delete(run.id);
    renderThread();
    loadRuns().catch(() => {});
    if (state.workspaceId === submission.workspaceId) await autoDrive(run);
    loadRuns().catch(() => {});
  } catch (error) {
    if (error.code === 'usage-limit-reached') {
      chat.pending = null;
      if (state.chat === chat && !$('goal').value) $('goal').value = goal;
      renderThread();
      await loadUsage();
      renderUsageLimitLock();
      return;
    }
    if ((error.code === 'offline' || error.transient || navigator.onLine === false) && state.settings.offlineQueue) {
      // Same key as the attempt: if the server did get it, the retry
      // returns that chat turn instead of starting a second one.
      await queueOfflineMessage(goal, files, visibility, idempotencyKey, submission, chat);
      const queued = state.network.queue.at(-1);
      if (queued) queued.attachmentIds = [...attachments];
      writeOfflineQueue();
      chat.pending = {
        goal,
        reply: 'Connection lost. Your message is queued locally and will retry automatically.',
        files: files.map(file => file.name),
        offline: true
      };
      updateConnectionUI();
      renderThread();
      return;
    }
    chat.pending = {
      goal,
      reply: error.code === 'needs-input' && Array.isArray(error.detail?.questions)
        ? `Could you tell me a bit more? ${error.detail.questions.join(' ')}`
        : error.code === 'usage-policy'
          ? [error.message, ...(error.payload?.alternatives ?? []).map(item => `- ${item}`)].join('\n')
          : error.message,
      ...(error.code === 'usage-policy' ? { declined: true } : {})
    };
    renderThread();
  } finally {
    state.sendWaiting = false;
    document.dispatchEvent(new Event('kindgleam:composer-state'));
  }
}

// The compact activity strip uses exactly the same stop pathway as the composer.
document.addEventListener('kindgleam:stop-current-run', event => {
  const id = event?.detail?.runId;
  if (!id || state.run?.id !== id) return;
  void stopRun('stopped by user');
});

export async function stopRun(reason) {
  const run = state.run;
  if (!run || state.stoppingRun === run.id) return;
  state.cancelledRuns ??= new Set();
  state.cancelledRuns.add(run.id);
  state.stoppingRun = run.id;
  state.driving = null;
  state.drivingLabel = 'Stopping — no new steps will start';
  state.drivingRuns?.delete(run.id);
  state.busyRuns?.delete(run.id);
  state.network.interruptedRunId = run.id;
  document.dispatchEvent(new Event('kindgleam:composer-state'));
  renderThread();
  try {
    const stopped = await api('POST', `/api/runs/${run.id}/fail`, { reason: reason || 'stopped by user' }, { idempotencyKey: crypto.randomUUID() });
    state.stoppingRun = null;
    state.network.interruptedRunId = null;
    renderRun(stopped);
    await loadRuns();
  } catch (error) {
    if (error.code === 'offline' || error.transient || navigator.onLine === false) {
      notify('runNotice', 'warn', 'Stopping is queued. Your work stays stopped and will be finalized when the connection returns.');
      updateConnectionUI();
      renderThread();
      return;
    }
    state.stoppingRun = null;
    state.cancelledRuns.delete(run.id);
    notify('runNotice', 'bad', error.message || 'Could not stop this work.');
    renderThread();
  }
}
