import { state, $, api, notify } from './ui-core.js';

let TerminalCtor = null;
let FitAddonCtor = null;
let terminal = null;
let fitAddon = null;
let socket = null;
let capturedChanges = [];
let currentSource = null;
let resizeObserver = null;

const esc = value => String(value ?? '');
const send = payload => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
};

function websocketUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const workspace = encodeURIComponent(state.workspaceId || '');
  const source = encodeURIComponent(state.workspaceSourceId || state.chat?.workspaceSourceId || '');
  return scheme + '://' + location.host + '/terminal?workspace=' + workspace + (source ? '&source=' + source : '');
}

function setStatus(message) {
  const node = $('terminalStatus');
  if (node) node.textContent = message;
}

function setChangeStatus(message) {
  const node = $('terminalChangeStatus');
  if (node) node.textContent = message;
}

function updateApplyButton() {
  const button = $('terminalApply');
  if (!button) return;
  const writable = (currentSource?.kind === 'github' && currentSource?.permissions?.write === true) || currentSource?.kind === 'local-folder';
  button.disabled = !capturedChanges.length || !writable;
  button.title = !writable && currentSource?.kind === 'github'
    ? 'GitHub source is read-only'
    : capturedChanges.length ? 'Apply the captured workspace changes' : 'Check for changes first';
}

async function loadTerminalLibraries() {
  if (TerminalCtor && FitAddonCtor) return;
  const terminalModule = await import('/vendor/xterm/lib/xterm.mjs');
  const fitModule = await import('/vendor/xterm-fit/lib/addon-fit.mjs');
  TerminalCtor = terminalModule.Terminal;
  FitAddonCtor = fitModule.FitAddon;
}

function disposeTerminalUi() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  try { terminal?.dispose(); } catch {}
  terminal = null;
  fitAddon = null;
}

function closeSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) send({ type: 'close' });
  try { socket?.close(); } catch {}
  socket = null;
}

async function requestChanges() {
  capturedChanges = [];
  updateApplyButton();
  setChangeStatus('Checking sandbox changes…');
  send({ type: 'changes' });
}

async function applyCapturedChanges() {
  if (!capturedChanges.length || !currentSource) return;
  const changes = capturedChanges;
  if (!confirm('Apply the captured terminal changes to the connected project?')) return;
  const source = currentSource;
  if (source.kind !== 'local-folder' && (source.kind !== 'github' || source.permissions?.write !== true)) {
    setChangeStatus('This project source is read-only.');
    return;
  }
  try {
    const payload = await api('POST', '/api/workspace/sources/' + encodeURIComponent(source.id) + '/apply', {
      confirm: 'APPLY_WORKSPACE_CHANGES',
      expectedCommitSha: source.metadata?.commitSha || '',
      changes,
      message: 'workspace: apply reviewed terminal changes'
    }, { idempotencyKey: crypto.randomUUID() });
    state.workspaceSource = payload.source;
    setChangeStatus(source.kind === 'local-folder' ? 'Changes saved to the private local-folder workspace snapshot.' : 'Changes committed to ' + source.repoOwner + '/' + source.repoName + ' · ' + source.repoRef);
    closeSocket();
    capturedChanges = [];
    updateApplyButton();
  } catch (error) {
    setChangeStatus(error.message || 'GitHub changes could not be applied.');
  }
}

async function openTerminal() {
  const dialog = $('terminalDialog');
  if (!dialog || !state.workspaceId) {
    notify('runNotice', 'warn', 'Choose a workspace before opening the terminal.');
    return;
  }
  try {
    await loadTerminalLibraries();
    if (!terminal) {
      terminal = new TerminalCtor({
        cursorBlink: true,
        convertEol: false,
        scrollback: 6000,
        allowTransparency: false,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        theme: {
          background: '#0b0e13',
          foreground: '#f2f4f7',
          cursor: '#f2f4f7',
          selectionBackground: '#2b3442'
        }
      });
      fitAddon = new FitAddonCtor();
      terminal.loadAddon(fitAddon);
      terminal.open($('terminalSurface'));
      terminal.onData(data => send({ type: 'input', data }));
      terminal.onBinary(data => send({ type: 'input', data }));
      terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
      resizeObserver = new ResizeObserver(() => {
        try { fitAddon.fit(); } catch {}
      });
      resizeObserver.observe($('terminalSurface'));
    } else {
      terminal.clear();
    }

    capturedChanges = [];
    currentSource = state.workspaceSource || null;
    updateApplyButton();
    setChangeStatus(currentSource?.kind === 'local-folder' ? 'Changes stay in the temporary sandbox until you explicitly save them to the private local-folder snapshot.' : 'Changes stay in the temporary sandbox until you explicitly commit them to GitHub.');
    if (!currentSource || !['github', 'local-folder'].includes(currentSource.kind)) throw new Error('Connect a project source before opening the Code Workspace terminal.');
    setStatus((currentSource.kind === 'local-folder' ? 'Local project terminal · ' : 'GitHub project terminal · ') + currentSource.name);
    dialog.showModal();
    fitAddon.fit();

    closeSocket();
    socket = new WebSocket(websocketUrl());
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      setStatus('Connected · ' + (currentSource.kind === 'local-folder' ? 'Local folder' : 'GitHub') + ' · ' + currentSource.name);
      terminal.focus();
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)); } catch {
        terminal?.writeln('\r\n[terminal] Invalid server message');
        return;
      }
      if (message.type === 'ready') {
        const sandbox = message.sandbox || {};
        terminal?.writeln('\r\nKindgleam sandbox terminal ready.\r');
        terminal?.writeln('Environment: ' + (sandbox.image || 'sandbox') + ' · network ' + (sandbox.network || 'restricted') + ' · user ' + (sandbox.user || 'unprivileged') + ' · ' + (sandbox.workspace || '/work') + '\r');
        terminal?.writeln('Project source: ' + (currentSource?.kind === 'local-folder' ? 'Local folder snapshot' : 'GitHub') + ' · temporary sandbox at /work; host filesystem access is disabled.\r');
        return;
      }
      if (message.type === 'output') {
        terminal?.write(esc(message.data));
        return;
      }
      if (message.type === 'changes') {
        capturedChanges = Array.isArray(message.changes) ? message.changes : [];
        currentSource = message.source || currentSource;
        updateApplyButton();
        setChangeStatus(
          capturedChanges.length
            ? capturedChanges.length + ' change' + (capturedChanges.length === 1 ? '' : 's') + ' ready to apply.'
            : 'No text-file changes detected.'
        );
        return;
      }
      if (message.type === 'status') {
        setStatus('Session ended · ' + String(message.status || 'limit'));
        return;
      }
      if (message.type === 'exit') {
        setStatus('Process exited' + (message.code !== null && message.code !== undefined ? ' · code ' + message.code : ''));
        return;
      }
      if (message.type === 'error') {
        terminal?.writeln('\r\n[terminal] ' + esc(message.error) + '\r');
        setChangeStatus(esc(message.error));
      }
    });
    socket.addEventListener('close', () => {
      socket = null;
      if ($('terminalDialog')?.open) setStatus('Disconnected');
    });
    socket.addEventListener('error', () => {
      setStatus('Terminal connection failed');
      setChangeStatus('The secure terminal could not be reached.');
    });
  } catch (error) {
    notify('runNotice', 'bad', error.message || 'Interactive terminal could not be opened.');
  }
}

export function initTerminal() {
  $('openTerminal')?.addEventListener('click', openTerminal);
  $('terminalClose')?.addEventListener('click', () => {
    closeSocket();
    $('terminalDialog')?.close();
  });
  $('terminalEnd')?.addEventListener('click', () => {
    closeSocket();
    $('terminalDialog')?.close();
  });
  $('terminalInterrupt')?.addEventListener('click', () => send({ type: 'interrupt' }));
  $('terminalCapture')?.addEventListener('click', () => { void requestChanges(); });
  $('terminalApply')?.addEventListener('click', () => { void applyCapturedChanges(); });
  $('terminalDialog')?.addEventListener('cancel', () => closeSocket());
  $('terminalDialog')?.addEventListener('close', () => {
    closeSocket();
    capturedChanges = [];
    updateApplyButton();
    disposeTerminalUi();
  });
  window.addEventListener('beforeunload', closeSocket);
}
