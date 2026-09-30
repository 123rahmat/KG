#!/usr/bin/env node
/**
 * Kindgleam sandbox runner (SANDBOX_RUNNER_URL).
 *
 * Runs code in sealed containers (src/sandbox.js): libraries come from the
 * public registries in an install phase, then the code runs with no network.
 * It is its own process on a host with a container runtime, so neither the
 * code nor the runtime ever touches the web server.
 *
 * Contract: POST /v1/execute with the server's runner payload. The job is
 * `payload.job`, or for a chat code step `payload.{language, source, tests,
 * packages, files}`. Every response is explicit: { executed: true, status,
 * output } when something ran, { executed: false, status, message } when not.
 *
 *   RUNNER_TOKEN                   shared bearer token (32+ characters, required)
 *   SANDBOX_RUNNER_HOST / _PORT    default 127.0.0.1:8767
 *   SANDBOX_RUNNER_TLS_CERT / _KEY serve HTTPS (required for production use)
 *   SANDBOX_DOCKER                 container CLI (default docker; podman works)
 *   SANDBOX_RUNTIME                OCI runtime, e.g. runsc for gVisor
 *   SANDBOX_IMAGE_PYTHON / _NODE / _GO / _JAVA / _GCC / _RUST
 *                                  images (defaults in DEFAULT_IMAGES, src/sandbox.js)
 *   SANDBOX_LANGUAGES              languages it runs, e.g. python,javascript,java (default all)
 *   SANDBOX_PULL_ON_DEMAND         fetch a language's image the first time it is needed (default true)
 *   SANDBOX_CA_FILE                CA certificate for registries behind a TLS-inspecting proxy
 *   SANDBOX_INSTALL_PROXY          HTTPS proxy for the install phase only
 *   SANDBOX_CONCURRENCY            jobs at once (default 2)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { runJob, validateJob, jobFromPayload, SandboxError, DEFAULT_IMAGES, LANGUAGES, languageName, languageReady, assertProductionSandboxConfiguration } from '../src/sandbox.js';

const text = value => String(value ?? '').trim();
const HOST = text(process.env.SANDBOX_RUNNER_HOST) || '127.0.0.1';
const PORT = Number(process.env.SANDBOX_RUNNER_PORT) || 8767;
const TOKEN = text(process.env.RUNNER_TOKEN);
const MAX_BODY = 48 * 1024 * 1024;
const VERSION = '1.0.0';
const CONCURRENCY = Math.max(1, Number(process.env.SANDBOX_CONCURRENCY) || 2);
const OPTIONS = {
  docker: text(process.env.SANDBOX_DOCKER) || 'docker',
  runtime: text(process.env.SANDBOX_RUNTIME) || null,
  images: Object.fromEntries(Object.entries(DEFAULT_IMAGES).map(([key, image]) => [key, text(process.env[`SANDBOX_IMAGE_${key.toUpperCase()}`]) || image])),
  network: { caFile: text(process.env.SANDBOX_CA_FILE) || null, proxy: text(process.env.SANDBOX_INSTALL_PROXY) || null },
  // The languages this sandbox runs (all by default); a language's image is
  // fetched the first time it is needed unless SANDBOX_PULL_ON_DEMAND=false.
  languages: text(process.env.SANDBOX_LANGUAGES)
    ? new Set(text(process.env.SANDBOX_LANGUAGES).split(',').map(languageName).filter(name => LANGUAGES[name]))
    : null,
  pullOnDemand: text(process.env.SANDBOX_PULL_ON_DEMAND).toLowerCase() !== 'false'
};
const completed = new Map();
let running = 0;

if (TOKEN.length < 32) {
  console.error('RUNNER_TOKEN must be at least 32 characters; the sandbox runner will not start without it.');
  process.exit(1);
}

const production = text(process.env.NODE_ENV).toLowerCase() === 'production';
const tlsCert = text(process.env.SANDBOX_RUNNER_TLS_CERT);
const tlsKey = text(process.env.SANDBOX_RUNNER_TLS_KEY);
if (production) {
  try {
    assertProductionSandboxConfiguration({
      images: OPTIONS.images,
      runtime: OPTIONS.runtime,
      installProxy: OPTIONS.network.proxy,
      tlsConfigured: Boolean(tlsCert && tlsKey),
      pullOnDemand: OPTIONS.pullOnDemand,
      languages: OPTIONS.languages
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

function authorized(req) {
  const presented = Buffer.from(text(req.headers.authorization).replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(TOKEN);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Request is not valid JSON'), { status: 400 });
  }
}

async function execute(body) {
  const executionId = text(body?.executionId);
  if (!executionId) return { executed: false, status: 'execution-id-required', message: 'The server must provide an execution ID.' };
  const cached = completed.get(executionId);
  if (cached) return { ...cached, replayed: true };
  let job;
  let checked;
  try {
    job = jobFromPayload(body);
    checked = validateJob(job);
  } catch (error) {
    // A language this sandbox has no toolchain for will never run here: the
    // code goes on untested, the same as a language that is turned off.
    if (error instanceof SandboxError && error.code === 'sandbox-language') {
      return { executed: false, status: 'language-unavailable', message: error.message, language: String(job?.language ?? '') };
    }
    if (error instanceof SandboxError) return { executed: false, status: error.code, message: error.message };
    throw error;
  }
  // A language that is off, missing or still being fetched is answered at
  // once, without taking one of the slots other jobs need.
  const unready = await languageReady(checked, OPTIONS);
  if (unready) return { executed: false, status: unready.status, message: unready.message, language: checked.language };
  if (running >= CONCURRENCY) return { executed: false, status: 'sandbox-busy', message: 'The sandbox is busy; try again shortly.' };
  running += 1;
  const startedAt = new Date().toISOString();
  try {
    const result = await runJob(job, OPTIONS);
    if (['sandbox-unavailable', 'language-unavailable', 'toolchain-preparing'].includes(result.status)) return { executed: false, status: result.status, message: result.message, ...(result.language ? { language: result.language } : {}) };
    const receipt = {
      executed: true,
      status: result.status === 'completed' ? 'completed' : 'failed',
      outcome: result.status,
      runner: { name: 'general-ai-sandbox', version: VERSION },
      executionId, startedAt, completedAt: new Date().toISOString(),
      output: result
    };
    completed.set(executionId, receipt);
    while (completed.size > 2000) completed.delete(completed.keys().next().value);
    return receipt;
  } finally {
    running -= 1;
  }
}

async function handle(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/v1/health') return send(res, 200, { ok: true, version: VERSION, languages: Object.keys(LANGUAGES) });
    if (!authorized(req)) return send(res, 401, { executed: false, status: 'unauthorized' });
    if (req.method === 'POST' && (req.url === '/' || req.url === '/v1/execute')) return send(res, 200, await execute(await readJson(req)));
    send(res, 404, { executed: false, status: 'not-found' });
  } catch (error) {
    send(res, error.status ?? 500, { executed: false, status: 'bad-request', message: error.status ? error.message : 'Sandbox runner error' });
  }
}

const server = tlsCert && tlsKey
  ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, handle)
  : http.createServer(handle);
server.requestTimeout = 10 * 60_000;
server.listen(PORT, HOST, () => {
  const scheme = tlsCert && tlsKey ? 'https' : 'http';
  console.log(`Kindgleam sandbox runner ${VERSION} listening on ${scheme}://${HOST}:${server.address().port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
