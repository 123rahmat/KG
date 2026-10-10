/**
 * The two sliding views at the top of every conversation.
 * Files are fetched only from the authenticated, conversation-scoped API.
 * A global workspace file list is NEVER used as a shortcut.
 */
import { $, state, api, element, downloadUrl, canEdit } from './ui-core.js';
import { previewButton, previewKind } from './artifact-preview.js';
import { addAttachments, fileToBase64 } from './app-attachments.js';

const group = Object.freeze([
  { id:'attachment', label:'Attached files', empty:'No attachments in this conversation.' },
  { id:'artifact', label:'Artifacts & saved results', empty:'No saved artifacts in this conversation.' }
]);
let activeRequest = 0;
let lastLoaded = '';
let pendingKey = '';
let lastConversation = '';
let uploading = false;
const MAX_FILES_AT_ONCE = 10;
const MAX_DEVICE_FILE_BYTES = 5 * 1024 * 1024;
const staged = () => Array.isArray(state.attachments) ? state.attachments : [];
const selected = () => state.chat?.chatFileIds instanceof Set
  ? state.chat.chatFileIds : new Set();
export const selectedChatUploadIds = () => [...selected()];

function fileSelection() {
  if (!(state.chat?.chatFileIds instanceof Set)) state.chat.chatFileIds = new Set();
  return state.chat.chatFileIds;
}

function uploadStatus(message, bad = false) {
  const node = $('chatFilesUploadStatus');
  if (node) {
    node.textContent = message || '';
    node.classList.toggle('bad', bad);
  }
}

function renderPending() {
  const pane = $('chatFilesPending');
  if (!pane) return;
  const files = staged();
  pane.hidden = !files.length;
  if (!files.length) {
    pane.replaceChildren();
    return;
  }
  pane.replaceChildren(
    element('h3', { text:'Selected for the next message · ' + files.length }),
    element('p', { class:'small muted',
      text:'These files are selected on this device. They will upload when you send your next message.' }),
    ...files.map(file => element('div', {class:'small chat-pending-file',text:
      file.name + ' · ' + sizeLabel(file.size)})),
    element('button', {type:'button',class:'small',text:'Go to Chat and send',
      onclick:() => {
        setChatView('chat');
        $('goal')?.focus({preventScroll:true});
      }})
  );
}

/**
 * Upload local PDFs, docs, images, datasets, code, ZIPs, or other supported
 * byte files. GitHub is not required. Existing owned chats save at once.
 * New chats stage until the first message creates an authoritative run ID.
 */
async function uploadFromDevice(fileList) {
  if (uploading) return;
  const all = [...(fileList ?? [])];
  if (!all.length) return;
  if (!canEdit() || !state.principal || !state.workspaceId) {
    uploadStatus('You need editing permission to upload files.', true);
    return;
  }
  if (all.length > MAX_FILES_AT_ONCE) {
    uploadStatus('Choose no more than 10 files at a time.', true);
    return;
  }
  const tooBig = all.find(file => file.size > MAX_DEVICE_FILE_BYTES);
  if (tooBig) {
    uploadStatus(tooBig.name + ' exceeds the current 5 MB per-file limit.', true);
    return;
  }
  const run = state.chat?.runs?.at(-1);
  if (!run) {
    addAttachments(all, { focus:false });
    renderPending();
    uploadStatus('Selected on your device. Write and send a chat message to upload these files.');
    return;
  }
  if (run.principalId !== state.principal.id || run.workspaceId !== state.workspaceId) {
    uploadStatus('Only the owner can upload files into this conversation. Open your own chat.', true);
    return;
  }
  uploading = true;
  const uploadButton = $('chatFilesUpload');
  if (uploadButton) uploadButton.disabled = true;
  const chatId = state.chat.id;
  const workspaceId = state.workspaceId;
  const saved = [];
  try {
    for (const file of all) {
      uploadStatus('Uploading ' + file.name + '…');
      const object = await api('POST','/api/objects',{
        type:'attachment',
        name:file.name,
        contentType:file.type || 'application/octet-stream',
        content: await fileToBase64(file),
        encoding:'base64',
        visibility:run.visibility === 'workspace' ? 'workspace' : 'private',
        provenance:{source:'chat-upload',runId:run.id}
      },{workspaceId,idempotencyKey:crypto.randomUUID(),timeoutMs:120_000});
      saved.push(object.id);
    }
    // An in-flight upload must never add a selected file to a different chat.
    if (state.workspaceId === workspaceId && state.chat?.id === chatId) {
      for (const id of saved) fileSelection().add(id);
      lastLoaded = '';
      uploadStatus(saved.length + ' file' + (saved.length === 1 ? '' : 's')
        + ' uploaded to this chat. Selected for your next AI message.');
      if (state.chatView === 'files') await fetchFiles({force:true});
    }
  } catch (error) {
    uploadStatus((saved.length ? saved.length + ' uploaded; ' : '')
      + (error.message || 'Upload failed'), true);
    // A partial batch still has persistent files; never make them invisible.
    if (state.workspaceId === workspaceId && state.chat?.id === chatId) {
      for (const id of saved) fileSelection().add(id);
      lastLoaded = '';
      if (state.chatView === 'files') await fetchFiles({force:true});
    }
  } finally {
    uploading = false;
    if (uploadButton) uploadButton.disabled = false;
  }
}

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
      item.category === 'attachment'
        ? element('label', {class:'chat-file-use'}, [
            element('input', {
              type:'checkbox',checked:selected().has(item.id),
              'aria-label':'Use ' + title + ' with the next AI message',
              onchange:event => {
                if (event.currentTarget.checked) fileSelection().add(item.id);
                else selected().delete(item.id);
              }
            }),
            element('span', {text:'Use with next message'})
          ])
        : null,
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
  if (!force && (lastLoaded === key || pendingKey === key)) return;
  const ticket = ++activeRequest;
  pendingKey = key;
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
  } finally {
    if (ticket === activeRequest) pendingKey = '';
  }
}

/** Keep switches and panel semantics synchronized with the visible chat. */
export function syncChatView() {
  const view = state.chatView === 'files' ? 'files' : 'chat';
  renderPending();
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
  pendingKey = '';
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
  $('chatFilesUpload')?.addEventListener('click', () => $('chatFilesUploadInput')?.click());
  $('chatFilesUploadInput')?.addEventListener('change', event => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    void uploadFromDevice(files);
  });
  document.addEventListener('kindgleam:staged-files-changed', renderPending);
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
