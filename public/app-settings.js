/**
 * Kindgleam — browser client: Personal settings: stored locally for speed, synced to the account; the offline message queue and drafts.
 * Part of app.js, split out by concern; app.js wires the page together.
 */

import { state, $, api, updateConnectionUI } from './ui-core.js';

/* ---------------------------------------------------------------- settings */

// Personal settings are cached locally for responsiveness and synchronized to
// the authenticated account when possible; the server remains authoritative.
const SETTINGS_KEY = 'kindgleam.settings';
export const OFFLINE_QUEUE_KEY = 'kindgleam.offline.queue';
const DRAFT_KEY = 'kindgleam.draft';
const OFFLINE_DB_NAME = 'kindgleam-offline';
const OFFLINE_DB_VERSION = 1;
const OFFLINE_FILE_STORE = 'files';
let offlineDbPromise = null;

// The product was renamed: what this browser saved under the earlier name
// (settings, draft, queued messages and their files) moves to the new one once.
const LEGACY_PREFIX = 'general-ai';
export function adoptLegacy(storage, key) {
  try {
    const legacyKey = key.replace(/^kindgleam/, LEGACY_PREFIX);
    const legacy = storage.getItem(legacyKey);
    if (legacy !== null && storage.getItem(key) === null) storage.setItem(key, legacy);
    if (legacy !== null) storage.removeItem(legacyKey);
  } catch {}
}
adoptLegacy(localStorage, SETTINGS_KEY);
adoptLegacy(localStorage, DRAFT_KEY);
adoptLegacy(sessionStorage, OFFLINE_QUEUE_KEY);
export const DEFAULT_SETTINGS = {
  language: '', style: '', length: '', country: '', about: '',
  consent: false, share: false, theme: '', enterSends: true,
  autonomy: 'assist', adaptiveIntensity: 'standard', adaptiveDepth: 'standard',
  capabilityInvestment: 'ask', allowAdaptiveExpansion: false,
  reducedMotion: false, highContrast: false,
  notifications: true, externalContext: 'ask',
  voiceInput: true, voiceLanguage: '', offlineQueue: true, crossChatMemory: false
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    const settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
    // Migrate the old all-memory switch to the new cross-chat-only control.
    // Checked on what was saved: the defaults already carry crossChatMemory.
    if (saved?.crossChatMemory === undefined && typeof saved?.memory === 'boolean') {
      settings.crossChatMemory = saved.memory;
    }
    delete settings.memory;
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
}

export function setSaveState(label, tone = '') {
  const node = $('settingsSaveState');
  if (!node) return;
  node.textContent = label;
  node.className = 'save-state' + (tone ? ' ' + tone : '');
}

function readOfflineQueue() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(OFFLINE_QUEUE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter(item => item && typeof item.goal === 'string') : [];
  } catch { return []; }
}

export function writeOfflineQueue() {
  try {
    const persisted = state.network.queue.slice(-20).map(item => {
      const { _hydratedFiles, ...safeItem } = item;
      return {
        ...safeItem,
      files: Array.isArray(item.files) ? item.files.map(file => ({
        name: file.name, type: file.type || 'application/octet-stream', size: file.size, lastModified: file.lastModified || 0
      })) : []
      };
    });
    sessionStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(persisted));
  } catch {}
}

function openOfflineDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (offlineDbPromise) return offlineDbPromise;
  offlineDbPromise = new Promise(resolve => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_FILE_STORE)) {
        db.createObjectStore(OFFLINE_FILE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => adoptLegacyFiles(request.result).then(() => resolve(request.result));
    request.onerror = () => resolve(null);
  });
  return offlineDbPromise;
}

// Files queued offline under the earlier name move into the new database, then
// the old database is removed. Only runs when the old database exists.
async function adoptLegacyFiles(db) {
  const legacyName = `${LEGACY_PREFIX}-offline`;
  try {
    const known = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    if (!known.some(entry => entry.name === legacyName)) return;
    const old = await new Promise(resolve => {
      const request = indexedDB.open(legacyName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    const rows = old?.objectStoreNames.contains(OFFLINE_FILE_STORE) ? await new Promise(resolve => {
      const request = old.transaction(OFFLINE_FILE_STORE, 'readonly').objectStore(OFFLINE_FILE_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve([]);
    }) : [];
    old?.close();
    if (rows.length) await new Promise(resolve => {
      const tx = db.transaction(OFFLINE_FILE_STORE, 'readwrite');
      for (const row of rows) tx.objectStore(OFFLINE_FILE_STORE).put(row);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
    indexedDB.deleteDatabase(legacyName);
  } catch {}
}

export async function storeOfflineFiles(item) {
  const db = await openOfflineDb();
  if (!db || !Array.isArray(item.files) || !item.files.length) return;
  await new Promise(resolve => {
    const tx = db.transaction(OFFLINE_FILE_STORE, 'readwrite');
    const store = tx.objectStore(OFFLINE_FILE_STORE);
    for (let index = 0; index < item.files.length; index += 1) {
      const file = item.files[index];
      store.put({
        key: `${item.id}:${index}`,
        itemId: item.id,
        index,
        blob: file,
        name: file.name,
        type: file.type || 'application/octet-stream',
        lastModified: file.lastModified || 0
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export async function loadOfflineFiles(item) {
  if (Array.isArray(item._hydratedFiles)) return item._hydratedFiles;
  const db = await openOfflineDb();
  if (!db) return [];
  const records = await new Promise(resolve => {
    const tx = db.transaction(OFFLINE_FILE_STORE, 'readonly');
    const store = tx.objectStore(OFFLINE_FILE_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result.filter(row => row.itemId === item.id).sort((a, b) => a.index - b.index));
    request.onerror = () => resolve([]);
  });
  const files = records.map(row => {
    try { return new File([row.blob], row.name, { type: row.type, lastModified: row.lastModified }); }
    catch { return row.blob; }
  });
  item._hydratedFiles = files;
  return files;
}

export async function deleteOfflineFiles(itemId) {
  const db = await openOfflineDb();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(OFFLINE_FILE_STORE, 'readwrite');
    const store = tx.objectStore(OFFLINE_FILE_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const row of request.result) if (row.itemId === itemId) store.delete(row.key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export async function clearOfflineFiles() {
  const db = await openOfflineDb();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(OFFLINE_FILE_STORE, 'readwrite');
    tx.objectStore(OFFLINE_FILE_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export function readDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
    return saved && typeof saved.text === 'string' ? saved : null;
  } catch { return null; }
}

function writeDraft(value) {
  try {
    if (!String(value).trim()) sessionStorage.removeItem(DRAFT_KEY);
    else sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
      text: String(value).slice(0, 20000), workspaceId: state.workspaceId, at: Date.now()
    }));
  } catch {}
}

export function clearDraft() {
  clearTimeout(state.draftSaveTimer);
  try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
}


export function saveDraftSoon() {
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(() => {
    writeDraft($('goal')?.value ?? '');
    updateConnectionUI();
  }, 180);
}

export function applyTheme() {
  const theme = state.settings.theme;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (state.settings.highContrast) document.documentElement.dataset.contrast = 'high';
  else delete document.documentElement.dataset.contrast;
  if (state.settings.reducedMotion) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
}

export async function loadPreferences() {
  try {
    const payload = await api('GET', '/api/preferences', undefined, { workspace: false });
    if (payload?.settings && typeof payload.settings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...state.settings, ...payload.settings };
      saveSettings();
      applyTheme();
    }
  } catch {}
}

let preferenceSaveTimer = null;
let pendingPreferencePatch = {};
export function persistPreferencePatch(key, value) {
  if (!state.principal) return;
  pendingPreferencePatch[key] = value;
  clearTimeout(preferenceSaveTimer);
  setSaveState('Saving…', 'saving');
  preferenceSaveTimer = setTimeout(async () => {
    const patch = { ...pendingPreferencePatch };
    pendingPreferencePatch = {};
    try {
      await api('PATCH', '/api/preferences', patch, { workspace: false });
      setSaveState('Synced', 'ok');
    } catch {
      setSaveState('Saved locally', 'warn');
    }
  }, 300);
}

/** Start-up work of this part, run by app.js at the point it always ran. */
export function initSettings() {
  state.network.queue = readOfflineQueue();
  state.settings = loadSettings();
  applyTheme();
}
