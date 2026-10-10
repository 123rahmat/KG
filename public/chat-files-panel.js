/**
 * The two sliding views at the top of every conversation.
 * Files are fetched only from the authenticated, conversation-scoped API.
 * A global workspace file list is NEVER used as a shortcut.
 */
import { $, state, api, element, downloadUrl } from './ui-core.js';
import { previewButton, previewKind } from './artifact-preview.js';

const group = Object.freeze([
  { id:'attachment', label:'Attached files', empty:'No attachments in this conversation.' },
  { id:'artifact', label:'Artifacts & saved results', empty:'No saved artifacts in this conversation.' }
]);
let activeRequest = 0;
let lastLoaded = '';
let lastConversation = '';
const text = value => String(value ?? '').trim();
const sizeLabel = size => {
  const n = Math.max(0, Number(size) || 0);
  return n < 1024 ? n + ' B' : n < 1048576
    ? (n / 1024).toFixed(1) + ' KB'
    : (n / 1048576).toFixed(1) + ' MB';
};
const typeLabel = object => {
  const name = text(object?.name);
  const extension = name.includes('.') ? name.split('.').at(-1).slice(0, 8).toUpperCase() : '';
  return extension || text(object?.contentType).split('/').at(-1).toUpperCase() || 'FILE';
};
const currentKey = () => state.workspaceId + ':' + (state.chat?.id ?? 'new')
  + ':' + (state.chat?.runs ?? []).map(run => run.id).join('|');

function itemRow(item) {
  const title = text(item.name) || 'Untitled file';
  const node = element('article', { class:'chat-file-item' }, [
    element('span', { class:'chat-file-icon', 'aria-hidden':'true', text:typeLabel(item).slice(0, 5) }),
    element('div', { class:'chat-file-info' }, [
      element('strong', { class:'chat-file-name', text:title, title }),
      element('span', { class:'small muted', text:[
        sizeLabel(item.size),
        item.createdAt && !Number.isNaN(Date.parse(item.createdAt))
          ? new Date(item.createdAt).toLocaleDateString() : null
      ].filter(Boolean).join(' · ') })
    ]),
    element('div', { class:'chat-file-actions' }, [
      previewKind(item) ? previewButton(item) : null,
      element('a', {
        class:'btn small', href:downloadUrl('/api/objects/' + encodeURIComponent(item.id) + '/content'),
        download:'', text:'Download', 'aria-label':'Download ' + title
      })
    ])
  ]);
  return node;
}

function showFiles(files, truncated) {
  const content = $('chatFilesContent');
  if (!content) return;
  const all = Array.isArray(files) ? files : [];
  const counter = $('chatFilesCount');
  if (counter) {
    counter.hidden = !all.length;
    counter.textContent = String(all.length) + (truncated ? '+' : '');
  }
  content.replaceChildren(
    ...group.map(section => {
      const selected = all.filter(file => file.category === section.id);
      return element('section', { class:'chat-file-group', 'aria-label':section.label }, [
        element('h3', { class:'chat-file-group-title', text:section.label + ' · ' + selected.length }),
        ...(selected.length ? selected.map(itemRow)
          : [element('p', { class:'small muted', text:section.empty })])
      ]);
    }),
    truncated ? element('p', { class:'small muted', role:'status',
      text:'Only the 500 newest files are shown. Older files remain in the workspace Files page.' }) : null
  );
}

async function fetchFiles({ force = false } = {}) {
  if (state.chatView !== 'files') return;
  const conversation = state.chat?.id;
  const key = currentKey();
  const container = $('chatFilesContent');
  if (!container) return;
  if (!state.chat?.runs?.length || !conversation) {
    lastLoaded = key;
    showFiles([],false);
    return;
  }
  if (!force && lastLoaded === key) return;
  const ticket = ++activeRequest;
  const workspace = state.workspaceId;
  container.replaceChildren(element('p', { class:'small muted', role:'status', text:'Loading files attached to this chat…' }));
  try {
    const data = await api('GET','/api/conversations/' + encodeURIComponent(conversation) + '/files',
      undefined, { workspaceId:workspace });
    if (ticket !== activeRequest || state.workspaceId !== workspace
        || state.chat?.id !== conversation || state.chatView !== 'files') return;
    if (data?.conversationId !== conversation || !Array.isArray(data?.files))
      throw new Error('Unexpected files response');
    lastLoaded = currentKey();
    showFiles(data.files, data.truncated === true);
  } catch (error) {
    if (ticket !== activeRequest || state.chat?.id !== conversation || state.chatView !== 'files') return;
    container.replaceChildren(element('div', { class:'chat-file-empty' }, [
      element('p', { text:error.message || 'Unable to load this chat’s files.' }),
      element('button', { class:'small', type:'button', text:'Retry', onclick:() => fetchFiles({force:true}) })
    ]));
  }
}

/** Keep switches and panel semantics synchronized with the visible chat. */
export function syncChatView() {
  const view = state.chatView === 'files' ? 'files' : 'chat';
  const switcher = $('chatViewSwitch');
  if (!switcher) return;
  switcher.dataset.view = view;
  const chatTab = $('chatViewMessages');
  const filesTab = $('chatViewFiles');
  chatTab?.setAttribute('aria-selected', String(view === 'chat'));
  filesTab?.setAttribute('aria-selected', String(view === 'files'));
  chatTab.tabIndex = view === 'chat' ? 0 : -1;
  filesTab.tabIndex = view === 'files' ? 0 : -1;
  const host = $('tab-runs');
  if (host) host.dataset.chatView = view;
  const filesPanel = $('chatFilesPanel');
  if (filesPanel) filesPanel.hidden = view !== 'files';
  if (view === 'files') void fetchFiles();
}

/** A different conversation always starts in Chat, never another chat's files. */
export function resetChatView() {
  ++activeRequest;
  lastLoaded = '';
  lastConversation = state.chat?.id ?? '';
  state.chatView = 'chat';
  syncChatView();
}

export function setChatView(view) {
  if (!['chat','files'].includes(view)) return;
  if (state.chatView !== view) ++activeRequest;
  state.chatView = view;
  if (view === 'files') lastLoaded = '';
  syncChatView();
  // syncChatView already loads the selected Files panel exactly once.
}

export function initChatFilesPanel() {
  $('chatViewMessages')?.addEventListener('click', () => setChatView('chat'));
  $('chatViewFiles')?.addEventListener('click', () => setChatView('files'));
  $('refreshChatFiles')?.addEventListener('click', () => fetchFiles({ force:true }));
  $('chatViewSwitch')?.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const dest = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'files'
      : state.chatView === 'chat' ? 'files' : 'chat';
    setChatView(dest);
    $(dest === 'files' ? 'chatViewFiles' : 'chatViewMessages')?.focus();
  });
  document.addEventListener('kindgleam:chat-files-updated', () => {
    lastLoaded = '';
    if (state.chatView === 'files') void fetchFiles({ force:true });
  });
  syncChatView();
}

/** Rendering a new run or opening a different chat invalidates old results. */
export function notifyChatFilesChanged() {
  const current = state.chat?.id ?? '';
  if (lastConversation !== current) {
    ++activeRequest;
    lastLoaded = '';
    lastConversation = current;
  }
  syncChatView();
}
