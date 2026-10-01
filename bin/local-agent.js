#!/usr/bin/env node
/**
 * Kindgleam local execution bridge.
 *
 * This process is intentionally separate from the main web server. It exposes
 * host-resource preflight and an explicit, user-approved local execution
 * boundary. It never accepts shell command strings. Code uses an allowlisted
 * runtime.
 *
 * Run under a restricted OS user/container for stronger isolation. This bridge
 * is a placement mechanism, not a kernel-level sandbox.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { executionPayloadDigest, signExecutionReceipt, verifyExecutionChallenge, executionIdFor } from '../src/execution.js';
import { isWorkspacePath } from '../src/workspace-path.js';
import { testSummary } from '../src/sandbox.js';

const text = value => String(value ?? '').trim();
const boolean = (value, fallback = false) => {
  const normalized = text(value).toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes'].includes(normalized);
};

const HOST = text(process.env.LOCAL_AGENT_HOST) || '127.0.0.1';
const PORT = Number(process.env.LOCAL_AGENT_PORT) || 8765;
const ALLOWED_ORIGIN = text(process.env.LOCAL_AGENT_ALLOWED_ORIGIN);
// A workspace made under the earlier product name is kept in use rather than orphaned.
const DEFAULT_RUN_ROOT = path.join(process.cwd(), '.kindgleam-local-workspace');
const LEGACY_RUN_ROOT = path.join(process.cwd(), '.general-ai-local-workspace');
const RUN_ROOT = path.resolve(text(process.env.LOCAL_AGENT_RUN_ROOT)
  || (!existsSync(DEFAULT_RUN_ROOT) && existsSync(LEGACY_RUN_ROOT) ? LEGACY_RUN_ROOT : DEFAULT_RUN_ROOT));
const ALLOW_EXECUTION = boolean(process.env.LOCAL_AGENT_ALLOW_PROCESS_EXECUTION);
const SHARED_SECRET = text(process.env.LOCAL_AGENT_SHARED_SECRET);
const TIMEOUT_MS = Math.min(Math.max(Number(process.env.LOCAL_AGENT_TIMEOUT_MS) || 120_000, 1_000), 900_000);
const MAX_OUTPUT = Math.min(Math.max(Number(process.env.LOCAL_AGENT_MAX_OUTPUT_BYTES) || 4 * 1024 * 1024, 1_024), 16 * 1024 * 1024);
const MAX_FILES = 300;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const AGENT_VERSION = '1.0.0';

const CODE_RUNTIMES = Object.freeze({
  node: {
    file: 'main.mjs',
    command: process.execPath,
    args: file => [file]
  },
  python: {
    file: 'main.py',
    command: process.platform === 'win32' ? 'python' : 'python3',
    args: file => [file]
  }
});


function setCors(res) {
  if (!ALLOWED_ORIGIN) return;
  res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-general-ai-local-agent');
  res.setHeader('vary', 'Origin');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  setCors(res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

function authorizedOrigin(req) {
  if (!ALLOWED_ORIGIN) return false;
  // Only a loopback Host is served, so a DNS-rebound name cannot reach us.
  const host = text(req.headers.host).toLowerCase();
  const loopback = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  if (!loopback.includes(host)) return false;
  return text(req.headers.origin) === ALLOWED_ORIGIN;
}

// Each server-signed challenge authorizes one execution. Without this, any
// local process (which, unlike a browser, can set Origin freely) could
// replay a captured challenge until it expires.
const usedNonces = new Map();
function claimNonce(nonce, expiresAt) {
  const now = Date.now();
  for (const [value, expiry] of usedNonces) if (expiry <= now) usedNonces.delete(value);
  const key = text(nonce);
  if (!key || usedNonces.has(key)) return false;
  usedNonces.set(key, Date.parse(expiresAt));
  return true;
}

async function readBody(req, maxBytes = 48 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function diskPreflight() {
  if (typeof fs.statfs !== 'function') return {};
  const stats = await fs.statfs(RUN_ROOT);
  return {
    storageBytes: Number(stats.blocks) * Number(stats.bsize),
    availableStorageBytes: Number(stats.bavail) * Number(stats.bsize)
  };
}

async function gpuPreflight() {
  return new Promise(resolve => {
    execFile('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits'
    ], { timeout: 2_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve({ available: false, name: '', vendor: '', memoryBytes: null });
      const first = text(stdout).split('\n')[0];
      const [name, memoryMiB] = first.split(',').map(text);
      const memoryBytes = Number.isFinite(Number(memoryMiB)) ? Number(memoryMiB) * 1024 ** 2 : null;
      resolve({
        available: Boolean(name),
        name: name || '',
        vendor: name ? 'NVIDIA' : '',
        memoryBytes
      });
    });
  });
}

function softwareVersion(command, args) {
  return new Promise(resolve => {
    execFile(command, args, {
      timeout: 2_000,
      windowsHide: true,
      shell: false
    }, (error, stdout) => {
      if (error) return resolve(null);
      const match = String(stdout ?? '').match(/v?\d+(?:\.\d+){0,3}/);
      resolve(match ? match[0] : null);
    });
  });
}

async function installedSoftware() {
  const node = process.version;
  const python = await softwareVersion(
    process.platform === 'win32' ? 'python' : 'python3',
    ['--version']
  );
  const git = await softwareVersion('git', ['--version']);
  return Object.fromEntries([
    ['node', node],
    python ? ['python', python] : null,
    git ? ['git', git] : null
  ].filter(Boolean));
}

async function preflight() {
  await fs.mkdir(RUN_ROOT, { recursive: true });
  return {
    version: '1',
    source: 'local-agent',
    platform: os.platform(),
    architecture: os.arch(),
    cpuCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    availableMemoryBytes: os.freemem(),
    ...(await diskPreflight()),
    gpu: await gpuPreflight(),
    software: await installedSoftware(),
    agent: { available: true, version: AGENT_VERSION },
    checkedAt: new Date().toISOString()
  };
}

function safeRunId(value) {
  const id = text(value);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid run id');
  return id;
}

function safeTaskId(value) {
  const id = text(value);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error('invalid task id');
  return id;
}

async function runProcess(command, args, { cwd, env, stdin = '', timeoutMs = TIMEOUT_MS }) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let bytesSeen = 0;
    let truncated = false;
    const capture = (target, chunk) => {
      if (truncated) return;
      const remaining = MAX_OUTPUT - bytesSeen;
      if (remaining <= 0) { truncated = true; return; }
      const textChunk = Buffer.from(chunk).subarray(0, remaining).toString('utf8');
      target.value += textChunk;
      bytesSeen += Buffer.byteLength(textChunk);
      if (bytesSeen >= MAX_OUTPUT) truncated = true;
    };

    const out = { value: '' };
    const err = { value: '' };
    child.stdout.on('data', chunk => capture(out, chunk));
    child.stderr.on('data', chunk => capture(err, chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(String(stdin ?? ''));

    let timedOut = false;
    const killTree = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        executed: false,
        status: 'failed',
        error: error.code === 'ENOENT' ? 'runtime-not-found' : 'process-error',
        message: error.message,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt)
      });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      stdout = out.value;
      stderr = err.value;
      resolve({
        executed: true,
        status: timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        signal,
        stdout,
        stderr,
        outputTruncated: truncated,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt)
      });
    });
  });
}

async function decodePayloadFile(value, name) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value?.base64 !== undefined) {
    const raw = String(value.base64).replace(/\s+/g, '');
    if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('invalid base64 file: ' + name);
    return Buffer.from(raw, 'base64');
  }
  return Buffer.from(String(value?.text ?? ''), 'utf8');
}

async function payloadFiles(payload, runtime) {
  const files = new Map();
  const source = String(payload?.source ?? '');
  if (source.trim()) files.set(runtime.file, Buffer.from(source, 'utf8'));
  const tests = String(payload?.tests ?? '');
  if (tests.trim() && runtime.testFile && !files.has(runtime.testFile)) {
    files.set(runtime.testFile, Buffer.from(tests, 'utf8'));
  }

  const raw = payload?.files && typeof payload.files === 'object' ? payload.files : {};
  const entries = Array.isArray(raw)
    ? raw.map(item => [item?.path ?? item?.name, item])
    : Object.entries(raw);

  const seenPaths = new Set(files.keys());
  for (const [rawPath, value] of entries) {
    const filePath = String(rawPath ?? '').replaceAll('\\', '/');
    if (!isWorkspacePath(filePath) || filePath.startsWith('.deps/')) {
      throw new Error('invalid workspace file path: ' + filePath);
    }
    if (seenPaths.has(filePath)) throw new Error('duplicate workspace file path: ' + filePath);
    seenPaths.add(filePath);
    const bytes = await decodePayloadFile(value, filePath);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('workspace file is too large: ' + filePath);
    files.set(filePath, bytes);
  }

  if (files.size > MAX_FILES) throw new Error('too many workspace files');
  const total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error('workspace files are too large together');
  return files;
}

function codeFilesHaveTests(files, language) {
  const names = [...files.keys()];
  if (language === 'python') return names.some(name => /(^|\/)test[^/]*\.py$/i.test(name));
  return names.some(name =>
    /(^|\/)test[^/]*\.(?:mjs|cjs|js)$/i.test(name) || /\.test\.(?:mjs|cjs|js)$/i.test(name)
  );
}

async function executeChecks(files, language, runtime, directory, timeoutMs, checkList) {
  const checked = [...new Set(Array.isArray(checkList) ? checkList.map(String) : [])];
  if (!checked.length) return null;
  if (checked.some(name => !files.has(name) || !isWorkspacePath(name))) {
    throw new Error('execution check references a file not in the payload');
  }

  const env = { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C', NODE_ENV: 'production' };
  if (language === 'python') {
    return runProcess(runtime.command, [
      '-c',
      'import ast,sys\nfor name in sys.argv[1:]: ast.parse(open(name, encoding="utf-8").read(), name)',
      ...checked
    ], { cwd: directory, env, timeoutMs });
  }

  let result = null;
  for (const file of checked) {
    result = await runProcess(runtime.command, ['--check', file], { cwd: directory, env, timeoutMs });
    if (result.timedOut || result.exitCode !== 0) return result;
  }
  return result;
}

async function executeCode(body) {
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  if (Array.isArray(payload.packages) && payload.packages.length) {
    return {
      executed: false,
      status: 'local-packages-not-supported',
      message: 'The local agent never installs packages. Run this project in the managed sandbox instead.'
    };
  }

  const rawLanguage = text(payload.language).toLowerCase();
  const language = ({
    javascript: 'node',
    js: 'node',
    nodejs: 'node',
    python3: 'python'
  })[rawLanguage] ?? rawLanguage;
  const runtime = CODE_RUNTIMES[language];
  if (!runtime) return { executed: false, status: 'unsupported-language', supported: Object.keys(CODE_RUNTIMES) };

  const project = payload.project === true || (payload.files && typeof payload.files === 'object');
  const runId = safeRunId(body.runId);
  const taskId = safeTaskId(body.taskId);
  // Older local-agent clients did not send executionId. Derive the same
  // stable identity the server signs so the challenge remains task/attempt
  // bound without weakening replay protection.
  const executionId = safeTaskId(text(body.executionId) || executionIdFor({
    runId, taskId, attempt: Number(body.attempt), executionTarget: 'local'
  }));
  const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || TIMEOUT_MS, 1_000), TIMEOUT_MS);
  const files = await payloadFiles(payload, runtime);

  if (!files.size) return { executed: false, status: 'source-required' };

  const entry = text(payload.entry)
    || (files.has(runtime.file) ? runtime.file : project ? null : runtime.file);
  if (entry && (!isWorkspacePath(entry) || !files.has(entry))) {
    return { executed: false, status: 'invalid-entry' };
  }

  const directory = path.join(RUN_ROOT, runId, taskId, executionId);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });

  for (const [name, bytes] of files) {
    const target = path.join(directory, name);
    const folder = path.dirname(target);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(target, bytes, { mode: 0o600 });
  }

  const env = { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C', NODE_ENV: 'production' };

  try {
    const check = await executeChecks(files, language, runtime, directory, timeoutMs, payload.check);
    if (check && (check.timedOut || check.exitCode !== 0)) {
      return {
        ...check,
        executed: true,
        status: check.timedOut ? 'timeout' : 'syntax-error',
        testSummary: null
      };
    }

    const hasTests = codeFilesHaveTests(files, language);
    let tests = null;
    if (hasTests) {
      tests = language === 'python'
        ? await runProcess(runtime.command, ['-m', 'unittest', 'discover', '-v', '-s', '.', '-p', 'test*.py'], {
            cwd: directory, env, timeoutMs
          })
        : await runProcess(runtime.command, ['--test'], { cwd: directory, env, timeoutMs });

      const summary = testSummary(language === 'node' ? 'javascript' : 'python', tests.stdout, tests.stderr);
      if (tests.timedOut || tests.exitCode !== 0) return { ...tests, testSummary: summary };
    }

    if (!entry) {
      return {
        ...(tests ?? { executed: true }),
        executed: true,
        status: tests?.timedOut ? 'timeout' : 'completed',
        exitCode: tests?.exitCode ?? 0,
        stdout: tests?.stdout ?? '',
        stderr: tests?.stderr ?? '',
        testSummary: tests ? testSummary(language === 'node' ? 'javascript' : 'python', tests.stdout, tests.stderr) : null
      };
    }

    return {
      ...await runProcess(runtime.command, [entry], {
        cwd: directory, env, stdin: payload.stdin ?? '', timeoutMs
      }),
      ...(tests ? { testSummary: testSummary(language === 'node' ? 'javascript' : 'python', tests.stdout, tests.stderr) } : {})
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

if (ALLOW_EXECUTION && SHARED_SECRET.length < 32) {
  throw new Error('LOCAL_AGENT_SHARED_SECRET must be at least 32 characters when execution is enabled');
}

if (ALLOW_EXECUTION && !ALLOWED_ORIGIN) {
  throw new Error('LOCAL_AGENT_ALLOWED_ORIGIN is required when process execution is enabled');
}

async function execute(body) {
  if (!ALLOW_EXECUTION) {
    return {
      executed: false,
      status: 'execution-disabled',
      message: 'Set LOCAL_AGENT_ALLOW_PROCESS_EXECUTION=true only after this local bridge has been installed and reviewed.'
    };
  }
  if (body?.executionTarget !== 'local') {
    return { executed: false, status: 'invalid-execution-target' };
  }
  const runId = safeRunId(body.runId);
  const taskId = safeTaskId(body.taskId);
  const executionId = safeTaskId(text(body.executionId) || executionIdFor({
    runId, taskId, attempt: Number(body.attempt), executionTarget: 'local'
  }));
  const challenge = body?.executionChallenge;
  if (!challenge || !verifyExecutionChallenge(SHARED_SECRET, {
    runId,
    taskId,
    taskType: body.taskType,
    attempt: Number(body.attempt),
    executionId,
    executionTarget: body.executionTarget,
    expiresAt: challenge.expiresAt,
    nonce: challenge.nonce,
    // The challenge covers this exact code: any other code fails the check.
    payloadDigest: executionPayloadDigest(body?.payload ?? {})
  }, challenge.signature)) {
    return { executed: false, status: 'invalid-execution-challenge' };
  }
  if (!claimNonce(challenge.nonce, challenge.expiresAt)) {
    return { executed: false, status: 'execution-challenge-replayed' };
  }
  if (body?.taskType === 'code') {
    try {
      const result = await executeCode({ ...body, runId, taskId, executionId });
      return result;
    } catch (error) {
      // A validly authenticated request can still fail validation before any
      // process runs. Keep that as an execution attempt result rather than
      // turning a domain failure into a transport-level 400.
      return {
        executed: false,
        status: 'failed',
        message: error?.message || 'local execution validation failed'
      };
    }
  }
  return { executed: false, status: 'unsupported-task' };
}

const server = createServer(async (req, res) => {
  try {
    const origin = text(req.headers.origin);
    if (req.method === 'OPTIONS') {
      if (!authorizedOrigin(req)) return json(res, 403, { error: 'Origin not allowed' });
      setCors(res);
      res.writeHead(204, {
        'access-control-allow-origin': ALLOWED_ORIGIN,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-general-ai-local-agent',
        'vary': 'Origin'
      });
      return res.end();
    }

    if (req.url === '/v1/preflight' && req.method === 'GET') {
      if (!authorizedOrigin(req)) return json(res, 403, { error: 'Origin not allowed' });
      return json(res, 200, await preflight());
    }

    if (req.url === '/v1/execute' && req.method === 'POST') {
      if (!authorizedOrigin(req)) return json(res, 403, { error: 'Origin not allowed' });
      const body = await readBody(req);
      const executionId = text(body.executionId) || executionIdFor({
        runId: safeRunId(body.runId),
        taskId: safeTaskId(body.taskId),
        attempt: Number(body.attempt),
        executionTarget: 'local'
      });
      const result = await execute({ ...body, executionId });
      const receipt = {
        ...result,
        executionTarget: 'local',
        attempt: Number(body.attempt),
        executionId,
        challengeNonce: text(body.executionChallenge?.nonce),
        payloadDigest: executionPayloadDigest(body?.payload ?? {}),
        origin,
        agentVersion: AGENT_VERSION
      };
      const signature = result.executed
        ? signExecutionReceipt(SHARED_SECRET, {
            runId: body.runId,
            taskId: body.taskId,
            taskType: body.taskType,
            attempt: Number(body.attempt),
            executionId: text(body.executionId),
            challengeNonce: text(body.executionChallenge?.nonce),
            receipt
          })
        : null;
      const responseStatus = result.executed || result.status === 'failed' ? 200 : 409;
      return json(res, responseStatus, {
        ...result,
        receipt: signature ? { ...receipt, signature } : receipt
      });
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 400, { error: error.message || 'Bad request' });
  }
});

server.listen(PORT, HOST, async () => {
  await fs.mkdir(RUN_ROOT, { recursive: true });
  console.log(`Kindgleam local agent ${AGENT_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN || '(none — browser access disabled)'}`);
  console.log(`Process execution: ${ALLOW_EXECUTION ? 'enabled' : 'disabled'}`);
});
