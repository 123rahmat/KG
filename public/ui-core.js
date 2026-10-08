/**
 * Shared browser core: page state, DOM and request helpers, notices, and
 * what the connected server can do. Imported by app.js and the other UI modules.
 */

export const $ = id => document.getElementById(id);

export const state = {
  principal: null,
  workspaces: [],
  workspaceId: null,
  role: 'viewer',
  run: null,
  executionConfig: null,
  localPreflight: null,
  executionTarget: '',
  localPreflightPromise: null,
  // Runs whose next AI step is waiting for the person's consent, and runs
  // the person has allowed the AI to read in this session.
  consentNeeded: new Set(),
  consented: new Set(),
  // Runs whose person chose "I'll do this step myself".
  manualOpen: new Set(),
  busy: false,
  sendWaiting: false,
  // The open chat: its conversation id, runs (oldest first) and a message
  // being sent. `driving` is the run whose AI steps are running on their own.
  chat: { id: null, runs: [], pending: null, consent: false },
  driving: null,
  drivingLabel: '',
  // Multiple chats/runs may advance concurrently. These sets are keyed by run id.
  busyRuns: new Set(),
  drivingRuns: new Set(),
  // Files chosen for the next message, and the last loaded chat list.
  attachments: [],
  attachmentScope: null,
  conversations: [],
  // Projects organize many chats without merging their private context.
  projects: [],
  activeProjectId: null,
  settings: null,
  models: null,
  voice: { recognition: null, listening: false, baseText: '' },
  network: { online: navigator.onLine !== false, reachable: true, queue: [] },
  // Client-side guard only: prevents an in-flight browser driver from starting
  // another step after the person presses Stop. The server remains authoritative.
  cancelledRuns: new Set(),
  stoppingRun: null,
  draftSaveTimer: null,
  feedbackByRun: new Map(),
  // The person can move the current conversation between adaptive workspace envelopes.
  activeSurface: 'normal-chat'
};

export function updateConnectionUI() {
  const previouslyOnline = state.network.online;
  const deviceOnline = navigator.onLine !== false;
  // The device can report a network while the server is out of reach (a
  // dead Wi-Fi, a deploy, a captive portal); the last request decides that.
  const online = deviceOnline && state.network.reachable !== false;
  state.network.online = online;
  const node = $('networkStatus');
  if (node) {
    node.className = 'connection-pill ' + (online ? 'online' : 'offline');
    // Being online is the normal case; only say something when it is not.
    node.hidden = online;
    node.replaceChildren(
      element('span', { class: 'status-dot' }),
      element('span', { text: online ? 'Online' : deviceOnline ? 'Reconnecting…' : 'Offline' })
    );
  }
  if (previouslyOnline !== online) queueMicrotask(() => document.dispatchEvent(new Event('kindgleam:connection-state')));
  const queued = state.network.queue.length;
  const draft = $('draftStatus');
  if (draft) {
    draft.textContent = queued
      ? queued + ' message' + (queued === 1 ? '' : 's') + ' waiting to send'
      : online ? 'Saved locally while you type' : 'Nothing is uploaded while offline';
    draft.className = 'draft-status' + (queued ? ' queued' : '');
    draft.hidden = online && !queued;
  }
}

/** Record whether the server answered; announce a return so waiting work resumes. */
export function markReachable(reachable) {
  const was = state.network.reachable !== false;
  state.network.reachable = reachable;
  if (was !== reachable) {
    updateConnectionUI();
    if (reachable) window.dispatchEvent(new Event('kindgleam:reconnected'));
    // Something must notice the server's return even when nothing else asks.
    else if (!probing) {
      probing = true;
      waitForConnection().finally(() => { probing = false; });
    }
  }
}

let probing = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const backoff = attempt => Math.min(8_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
// Statuses a proxy or restarting server gives while the app itself is fine.
const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504]);

function retryAfterMs(value) {
  if (!value?.trim()) return null;
  const delay = /^\d+$/.test(value.trim())
    ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : null;
}

function offlineError(cause) {
  const error = new Error('You appear to be offline. Unsent work will stay on this device and retry when the connection returns.');
  error.code = 'offline';
  error.cause = cause;
  return error;
}

async function requestOnce(method, path, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    // Reading the body is part of the request: a connection can drop mid-way.
    try {
      const raw = response.status === 204 ? '' : await response.text();
      return { response, raw };
    } catch (bodyError) {
      // Headers may already forbid an early retry even if the body drops.
      return { response, raw: '', bodyError };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the API. Reads, and writes carrying an Idempotency-Key, are retried
 * with backoff when the connection drops, a request hangs, or the server is
 * briefly unavailable; the server replays a write it already did, so a retry
 * never does the work twice. Other writes are tried once.
 */
export async function api(method, path, body, { workspace = true, workspaceId = state.workspaceId, idempotencyKey = '', timeoutMs = 30_000, retries } = {}) {
  method = String(method).toUpperCase();
  const headers = { 'x-kindgleam-client': 'web' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (workspace && workspaceId) headers['x-workspace-id'] = workspaceId;
  const safe = method === 'GET' || Boolean(idempotencyKey);
  const budget = retries === undefined || !Number.isFinite(Number(retries)) ? 3 : Math.max(0, Math.min(5, Math.floor(Number(retries))));
  const attempts = 1 + (safe ? budget : 0);

  for (let attempt = 0; ; attempt += 1) {
    const last = attempt + 1 >= attempts;
    let result;
    try {
      result = await requestOnce(method, path, headers, body, timeoutMs);
    } catch (error) {
      markReachable(false);
      if (!last && navigator.onLine !== false) { await sleep(backoff(attempt)); continue; }
      throw offlineError(error);
    }
    const { response, raw } = result;
    if (response.status === 204) { markReachable(true); return null; }
    let payload;
    let parsed = false;
    try { payload = JSON.parse(raw); parsed = true; } catch { /* Invalid JSON is never a successful API result. */ }
    const problem = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    // An HTML error page or an unlabelled 5xx comes from something in front
    // of the app, not the app; treat it as the server being out of reach.
    const invalidSuccess = response.ok && !parsed;
    const transient = invalidSuccess || TRANSIENT_STATUS.has(response.status) && (!parsed || !problem.code || ['rate-limited', 'rate-limit-unavailable', 'idempotency-in-progress'].includes(problem.code))
      || (response.status === 409 && problem.code === 'idempotency-in-progress');
    if (!transient || response.status === 429 || response.status === 409) markReachable(true);
    const after = retryAfterMs(response.headers.get('retry-after'));
    if (transient && !last && (after === null || after <= 30_000)) {
      await sleep(after ?? backoff(attempt));
      continue;
    }
    if (!response.ok || invalidSuccess) {
      const error = new Error(invalidSuccess ? 'The server returned an invalid API response. Please try again.' : problem.error || (transient ? 'Kindgleam is briefly unavailable. Please try again in a moment.' : `Request failed (${response.status})`));
      error.status = response.status;
      error.code = invalidSuccess ? 'invalid-api-response' : problem.code || (transient ? 'server-unavailable' : undefined);
      error.transient = transient;
      error.detail = problem.detail;
      error.payload = problem;
      if (result.bodyError) error.cause = result.bodyError;
      if (after !== null) error.retryAfterMs = after;
      if (response.status === 401 && state.principal && workspace) window.dispatchEvent(new Event('kindgleam:signed-out'));
      throw error;
    }
    return payload;
  }
}

/** Resolve once the server answers again: on the reconnect or online event, or by probing with backoff. */
export async function waitForConnection() {
  for (let attempt = 0; ; attempt += 1) {
    if (navigator.onLine !== false && state.network.reachable !== false) return;
    await new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        window.removeEventListener('online', done);
        window.removeEventListener('kindgleam:reconnected', done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(15_000, 1_000 * 2 ** attempt));
      window.addEventListener('online', done);
      window.addEventListener('kindgleam:reconnected', done);
    });
    if (navigator.onLine === false) continue;
    // Another request may have reached the server while this one slept.
    if (state.network.reachable !== false) return;
    try {
      const { response } = await requestOnce('GET', '/api/health', {}, undefined, 8_000);
      markReachable(response.ok);
    } catch {
      markReachable(false);
    }
  }
}

export function notify(target, kind, message) {
  const node = $(target);
  node.hidden = !message;
  node.className = `notice ${kind}`;
  node.textContent = message ?? '';
}

export const clearNotice = target => notify(target, 'info', '');

export async function guard(work, target = 'notice', describe = () => null) {
  try {
    clearNotice(target);
    await work();
  } catch (error) {
    const described = describe(error);
    notify(target, described || error.status === 403 || error.status === 409 ? 'warn' : 'bad', described || error.message);
  }
}

/**
 * Whether a link or source address is safe to put in the page. Addresses can
 * come from AI answers and web research, so anything that could run code
 * (javascript:, data:, vbscript:, …) is refused everywhere, not per call.
 */
export function safeUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) return false;
  if (/^[/?#]/.test(url) && !url.startsWith('//')) return true;
  // Browsers ignore control characters and spaces inside a scheme
  // ("java\tscript:"), so they are dropped before the scheme is judged.
  const compact = [...url].filter(char => char.charCodeAt(0) > 0x20).join('');
  return /^(https?:|mailto:|blob:)/i.test(compact);
}

export function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value ?? '');
    // Assigned through CSSOM, never as a style attribute: the page runs under
    // style-src 'self', which refuses inline styles.
    // A string is read as declarations; assigning one to the style object
    // throws and takes the whole render down with it.
    else if (key === 'style') {
      if (typeof value === 'string') node.style.cssText = value;
      else Object.assign(node.style, value);
    }
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if ((key === 'href' || key === 'src' || key === 'action' || key === 'formaction') && !safeUrl(value)) continue;
    else if (value === true) node.setAttribute(key, '');
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}


/** A link the browser can download directly: it names the workspace, since links cannot send headers. */
export const downloadUrl = path => `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(state.workspaceId ?? '')}`;

export const aiConnected = () => state.executionConfig?.reasoning?.configured === true;

export const canEdit = () => state.role !== 'viewer';

export const configuredTargets = taskType => (state.executionConfig?.targets ?? [])
  .filter(target => target.taskTypes.includes(taskType) && target.configured);

export function button(text, onclick, className = '') {
  return element('button', { class: className, text, type: 'button', onclick });
}

/** What this workspace can really do, so nothing is offered that cannot work. */
export function capabilities() {
  return {
    ai: aiConnected(),
    research: configuredTargets('investigate').length > 0,
    runCode: configuredTargets('code').length > 0
  };
}
