/**
 * Interactive workspace terminal.
 *
 * Browser clients get a real PTY, but the PTY only owns a disposable Docker
 * sandbox. No host shell, host environment, credentials, network or Docker
 * socket is exposed. The workspace snapshot is the initial /work tree.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { parseCookies, sessionCookieName } from './http/context.js';
import { assertSourceId, normalizeSourceFiles, sourceManifest } from './workspace-sources.js';
import { contentDigest } from './workspace-patch.js';

const TERMINAL_PATH = '/terminal';
const MAX_WS_MESSAGE_BYTES = 128 * 1024;
const MAX_COLS = 240;
const MAX_ROWS = 120;
const MIN_COLS = 20;
const MIN_ROWS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHUNK = 64 * 1024;
const MAX_CONTROL_MESSAGES_PER_SECOND = 30;
const ACCESS_RECHECK_MS = 30_000;
const SENSITIVE_TERMINAL_PATH = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|\.npmrc|\.netrc|\.pypirc|id_rsa(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.next', '.cache', 'dist', 'build', 'coverage',
  '.venv', 'venv', '__pycache__', '.pytest_cache', 'target', '.cargo',
  '.rustup', '.npm'
]);

const text = value => String(value ?? '').trim();

export function terminalOriginAllowed(req, config) {
  const origin = text(req.headers.origin);
  if (config.production && !origin) return false;
  if (!origin) return true;
  if (config.publicUrl) {
    try { return origin === new URL(config.publicUrl).origin; } catch { return false; }
  }
  const host = text(req.headers.host).toLowerCase();
  try {
    const url = new URL(origin);
    return url.hostname === host.split(':')[0];
  } catch {
    return false;
  }
}

export function terminalImagesForFiles(files, config) {
  const paths = new Set(files.map(file => file.path));
  const lower = files.map(file => file.path.toLowerCase());
  if (paths.has('package.json') || lower.some(file => /(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)yarn\.lock$/.test(file))) return ['node', config.terminal.images.node];
  if (paths.has('pyproject.toml') || paths.has('requirements.txt') || paths.has('setup.py')) return ['python', config.terminal.images.python];
  if (paths.has('go.mod')) return ['go', config.terminal.images.go];
  if (paths.has('Cargo.toml')) return ['rust', config.terminal.images.rust];
  if (lower.some(file => file.endsWith('.java'))) return ['java', config.terminal.images.java];
  if (lower.some(file => /\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(file))) return ['gcc', config.terminal.images.gcc];
  return ['node', config.terminal.images.node];
}

export function terminalArgs({ image, runtime, workdir }) {
  const args = [
    'run', '--rm', '--init',
    ...(runtime ? ['--runtime', runtime] : []),
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '128',
    '--memory', '768m',
    '--memory-swap', '768m',
    '--cpus', '1',
    '--ulimit', 'fsize=104857600:104857600',
    '--ulimit', 'nofile=1024:1024',
    '--user', '65534:65534',
    '--workdir', '/work',
    '-e', 'HOME=/tmp',
    '-e', 'TERM=xterm-256color',
    '-e', 'LANG=C.UTF-8',
    '-e', 'LC_ALL=C.UTF-8',
    '-e', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-e', 'KINDGLEAM_TERMINAL=1',
    '-v', workdir + ':/work:rw',
    image,
    'sh', '-i'
  ];
  return args;
}

async function writeSnapshot(workdir, files) {
  for (const file of files) {
    // Credential-bearing files must never enter the interactive execution
    // container, even when they are present in a source snapshot.
    if (SENSITIVE_TERMINAL_PATH.test(String(file.path ?? ''))) continue;
    const safe = file.path;
    const destination = path.join(workdir, safe);
    if (!destination.startsWith(workdir + path.sep)) throw new Error('Invalid workspace path');
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true, mode: 0o755 });
    await fs.writeFile(destination, file.content, { encoding: 'utf8', mode: 0o644 });
  }
  const dirs = new Set([workdir]);
  for (const file of files) dirs.add(path.dirname(path.join(workdir, file.path)));
  for (const dir of dirs) await fs.chmod(dir, 0o777);
  for (const file of files) await fs.chmod(path.join(workdir, file.path), 0o666);
}

async function readSnapshot(objects, scope, objectId) {
  if (!objectId) return [];
  const object = await objects.read(scope, objectId);
  const raw = Buffer.isBuffer(object?.content)
    ? object.content.toString('utf8')
    : String(object?.content ?? '');
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return normalizeSourceFiles(parsed?.files ?? []);
}

async function walkTextFiles(root) {
  const files = [];
  async function visit(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(target, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(target);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(target, 'utf8');
      if (content.includes('\0')) continue;
      const safeRelative = relative.replaceAll('\\\\', '/');
      if (SENSITIVE_TERMINAL_PATH.test(safeRelative)) continue;
      files.push({ path: safeRelative, content });
      if (files.length > 250) return;
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function snapshotChanges(session) {
  const current = await walkTextFiles(session.workdir);
  const base = new Map(session.baseFiles.map(file => [file.path, file.content]));
  const currentPaths = new Set(current.map(file => file.path));
  const changes = [];
  for (const file of current) {
    const previous = base.get(file.path);
    if (previous !== file.content) {
      changes.push({
        path: file.path,
        content: file.content,
        ...(previous !== undefined ? { beforeDigest: contentDigest(previous) } : {})
      });
    }
  }
  for (const [filePath, previous] of base) {
    if (!currentPaths.has(filePath)) {
      changes.push({ path: filePath, kind: 'delete', beforeDigest: contentDigest(previous) });
    }
  }
  return { current, changes, manifest: sourceManifest(current) };
}

class TerminalSession {
  constructor({ id, ws, principal, scope, source, baseFiles, workdir, ptyProcess, manager, image, runtime }) {
    this.id = id;
    this.ws = ws;
    this.principal = principal;
    this.scope = scope;
    this.source = source;
    this.baseFiles = baseFiles;
    this.workdir = workdir;
    this.pty = ptyProcess;
    this.image = image;
    this.runtime = runtime;
    this.manager = manager;
    this.createdAt = Date.now();
    this.lastInputAt = this.createdAt;
    this.outputBytes = 0;
    this.inputWindowStartedAt = this.createdAt;
    this.inputWindowBytes = 0;
    this.controlWindowStartedAt = this.createdAt;
    this.controlMessageCount = 0;
    this.closed = false;
    this.lastAccessCheckAt = 0;
    this.lifetimeTimer = null;
    this.idleTimer = null;
  }

  send(payload) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  async ensureAccess() {
    if (this.closed) return false;
    if (Date.now() - this.lastAccessCheckAt < ACCESS_RECHECK_MS) return true;
    try {
      await this.manager.identity.requireAccess(this.principal, this.scope.workspaceId, 'editor');
      this.lastAccessCheckAt = Date.now();
      return true;
    } catch (error) {
      this.send({ type: 'status', status: 'access-revoked' });
      this.close('access-revoked');
      this.manager.logger?.warn?.('terminal access revoked during session', {
        sessionId: this.id, principalId: this.principal.id, workspaceId: this.scope.workspaceId,
        code: error?.code ?? 'access-revoked'
      });
      return false;
    }
  }

  touch() {
    this.lastInputAt = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (Date.now() - this.lastInputAt >= this.manager.config.terminal.idleMs) {
        this.send({ type: 'status', status: 'idle-timeout' });
        this.close('idle-timeout');
      }
    }, this.manager.config.terminal.idleMs + 50);
    this.idleTimer.unref?.();
  }

  startTimers() {
    this.touch();
    this.lifetimeTimer = setTimeout(() => {
      this.send({ type: 'status', status: 'lifetime-limit' });
      this.close('lifetime-limit');
    }, this.manager.config.terminal.lifetimeMs);
    this.lifetimeTimer.unref?.();
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetimeTimer);
    clearTimeout(this.idleTimer);
    try { this.pty.kill(); } catch {}
    try { this.ws.close(1000, reason.slice(0, 100)); } catch {}
    void fs.rm(this.workdir, { recursive: true, force: true }).catch(() => {});
    this.manager.sessions.delete(this.id);
    this.manager.metrics?.increment('terminal_sessions_closed_total', { reason });
    this.manager.audit?.record?.({
      principalId: this.principal.id,
      workspaceId: this.scope.workspaceId,
      action: 'terminal.session.close',
      target: this.id,
      outcome: 'allowed',
      detail: { reason },
      requestId: this.id
    }).catch?.(() => {});
  }
}

export function attachTerminalServer(server, {
  config, identity, pool, objects, audit, logger, metrics, fetchImpl = fetch
}) {
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES, perMessageDeflate: false });

  const manager = {
    config, identity, pool, objects, audit, logger, metrics, fetchImpl, sessions,
    async create({ ws, principal, scope, sourceId, cols, rows }) {
      if (!config.terminal.enabled) throw Object.assign(new Error('Interactive terminal is disabled'), { code: 'terminal-disabled' });
      const principalCount = [...sessions.values()].filter(item => item.principal.id === principal.id).length;
      const workspaceCount = [...sessions.values()].filter(item => item.scope.workspaceId === scope.workspaceId).length;
      if (principalCount >= config.terminal.maxSessionsPerPrincipal) throw Object.assign(new Error('Too many active terminal sessions'), { code: 'terminal-session-limit' });
      if (workspaceCount >= config.terminal.maxSessionsPerWorkspace) throw Object.assign(new Error('Workspace terminal limit reached'), { code: 'terminal-workspace-limit' });

      let source = null;
      let baseFiles = [];
      if (sourceId) {
        assertSourceId(sourceId);
        const { rows: [row] } = await pool.query(
          `SELECT * FROM workspace_sources
             WHERE id = $1 AND workspace_id = $2 AND principal_id = $3 AND revoked_at IS NULL
           FOR SHARE`,
          [sourceId, scope.workspaceId, principal.id]
        );
        source = row || null;
        if (!source) throw Object.assign(new Error('Workspace source not found'), { code: 'terminal-source-not-found' });
        baseFiles = await readSnapshot(objects, scope, source.snapshot_object_id);
      }

      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindgleam-terminal-'));
      try {
        await writeSnapshot(workdir, baseFiles);
      } catch (error) {
        await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const [, image] = terminalImagesForFiles(baseFiles, config);
      if (!image) {
        await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
        throw Object.assign(new Error('No terminal image is configured'), { code: 'terminal-image-unavailable' });
      }
      const safeCols = Math.max(MIN_COLS, Math.min(MAX_COLS, Number(cols) || 100));
      const safeRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Number(rows) || 30));
      let child;
      try {
        child = pty.spawn('docker', terminalArgs({ image, runtime: config.terminal.runtime, workdir }), {
        name: 'xterm-256color',
        cols: safeCols,
        rows: safeRows,
        cwd: process.cwd(),
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8'
        }
        });
      } catch (error) {
        await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }

      const session = new TerminalSession({
        id: crypto.randomUUID(), ws, principal, scope, source,
        baseFiles, workdir, ptyProcess: child, manager, image, runtime: config.terminal.runtime
      });
      sessions.set(session.id, session);
      child.onData(data => {
        if (session.closed) return;
        const bytes = Buffer.byteLength(data, 'utf8');
        if (session.outputBytes + bytes > config.terminal.maxOutputBytes ||
            session.ws.bufferedAmount > 1024 * 1024) {
          session.send({ type: 'status', status: 'output-limit' });
          session.close('output-limit');
          return;
        }
        session.outputBytes += bytes;
        for (let at = 0; at < data.length; at += MAX_OUTPUT_CHUNK) {
          session.send({ type: 'output', data: data.slice(at, at + MAX_OUTPUT_CHUNK) });
        }
      });
      child.onExit(event => {
        if (!session.closed) {
          session.send({ type: 'exit', code: event.exitCode ?? null, signal: event.signal ?? null });
          session.close('process-exit');
        }
      });
      session.startTimers();
      metrics?.increment('terminal_sessions_started_total');
      audit?.record?.({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'terminal.session.start',
        target: session.id,
        outcome: 'allowed',
        detail: { sourceKind: source?.kind ?? null, sourceId: source?.id ?? null, image },
        requestId: session.id
      }).catch?.(() => {});
      return session;
    },
    async handleMessage(session, raw) {
      if (session.closed) return;
      if (!(await session.ensureAccess())) return;
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch {
        session.send({ type: 'error', error: 'Invalid terminal message' });
        return;
      }
      const type = text(message?.type);
      if (!['input'].includes(type)) {
        const now = Date.now();
        if (now - session.controlWindowStartedAt >= 1000) {
          session.controlWindowStartedAt = now;
          session.controlMessageCount = 0;
        }
        session.controlMessageCount += 1;
        if (session.controlMessageCount > MAX_CONTROL_MESSAGES_PER_SECOND) {
          session.send({ type: 'error', error: 'Terminal control rate limit reached' });
          return;
        }
      }
      if (type === 'input') {
        const data = typeof message.data === 'string' ? message.data : '';
        const bytes = Buffer.byteLength(data, 'utf8');
        const now = Date.now();
        if (now - session.inputWindowStartedAt >= 1000) {
          session.inputWindowStartedAt = now;
          session.inputWindowBytes = 0;
        }
        if (!data || bytes > MAX_WS_MESSAGE_BYTES || session.inputWindowBytes + bytes > config.terminal.maxInputBytesPerSecond) {
          session.send({ type: 'error', error: 'Terminal input rate limit reached' });
          return;
        }
        session.inputWindowBytes += bytes;
        session.touch();
        session.pty.write(data);
        return;
      }
      if (type === 'resize') {
        const cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Number(message.cols) || 100));
        const rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Number(message.rows) || 30));
        session.pty.resize(cols, rows);
        return;
      }
      if (type === 'interrupt') {
        session.pty.write('\\x03');
        return;
      }
      if (type === 'changes') {
        const result = await snapshotChanges(session);
        session.send({
          type: 'changes',
          changes: result.changes,
          manifest: result.manifest,
          baseContentHash: sourceManifest(session.baseFiles).contentHash,
          source: session.source ? {
            id: session.source.id,
            kind: session.source.kind,
            permissions: session.source.permissions ?? {},
            metadata: session.source.metadata ?? {},
            repoOwner: session.source.repo_owner ?? null,
            repoName: session.source.repo_name ?? null,
            repoRef: session.source.repo_ref ?? null
          } : null
        });
        return;
      }
      if (type === 'close') {
        session.close('client-close');
        return;
      }
      session.send({ type: 'error', error: 'Unknown terminal message' });
    }
  };

  async function upgrade(req, socket, head) {
    const parsed = new URL(req.url || '', 'http://localhost');
    if (parsed.pathname !== TERMINAL_PATH) {
      socket.destroy();
      return;
    }
    if (!terminalOriginAllowed(req, config)) {
      socket.write('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n');
      socket.destroy();
      return;
    }
    try {
      const cookies = parseCookies(req.headers.cookie);
      const cookieName = sessionCookieName(config);
      const principal = await identity.principalFromSession(cookies[cookieName]);
      const workspaceId = text(parsed.searchParams.get('workspace'));
      const scope = await identity.requireAccess(principal, workspaceId, 'editor');
      const sourceId = text(parsed.searchParams.get('source'));
      wss.handleUpgrade(req, socket, head, ws => {
        ws.once('error', () => {});
        void (async () => {
          try {
            const session = await manager.create({
              ws, principal, scope, sourceId,
              cols: parsed.searchParams.get('cols'),
              rows: parsed.searchParams.get('rows')
            });
            ws.send(JSON.stringify({
              type: 'ready',
              sessionId: session.id,
              workspaceId: scope.workspaceId,
              sourceId: sourceId || null,
              sandbox: { runtime: session.runtime || 'docker', image: session.image, network: 'none', user: '65534:65534', workspace: '/work' }
            }));
            ws.on('message', data => void manager.handleMessage(session, data));
            ws.on('close', () => session.close('socket-close'));
          } catch (error) {
            try { ws.send(JSON.stringify({ type: 'error', error: error.message || 'Terminal unavailable', code: error.code })); } catch {}
            try { ws.close(1011, 'terminal-start-failed'); } catch {}
          }
        })();
      });
    } catch (error) {
      socket.write('HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n');
      socket.destroy();
      logger?.warn?.('terminal websocket denied', { code: error.code || 'unauthenticated' });
      metrics?.increment('terminal_sessions_denied_total', { code: error.code || 'unauthenticated' });
    }
  }

  const onUpgrade = (req, socket, head) => { void upgrade(req, socket, head); };
  server.on('upgrade', onUpgrade);

  return {
    close() {
      server.off('upgrade', onUpgrade);
      for (const session of sessions.values()) session.close('server-shutdown');
      wss.close();
    }
  };
}
