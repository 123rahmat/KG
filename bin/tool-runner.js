#!/usr/bin/env node
/**
 * Kindgleam built-in tool runner.
 *
 * The generic tool boundary (TOOL_RUNNER_URL) for discovered capabilities and
 * investigation tasks. It runs as its own process so a tool can never touch
 * the web server's memory, credentials or database connection.
 *
 * Contract: POST /v1/execute with the server's runner payload; the tool and
 * its input come from `payload.tool` and `payload.input`. Every response is
 * explicit: { executed: true, status, tool, output, provenance } when the
 * tool ran, { executed: false, status, ... } when it did not.
 *
 *   RUNNER_TOKEN                 shared bearer token (32+ characters, required)
 *   TOOL_RUNNER_HOST / _PORT     default 127.0.0.1:8766
 *   TOOL_RUNNER_TLS_CERT / _KEY  serve HTTPS (required for production use)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { toolCatalog, selectTool } from '../src/tools/registry.js';

const text = value => String(value ?? '').trim();
const HOST = text(process.env.TOOL_RUNNER_HOST) || '127.0.0.1';
// 0 lets the OS choose a free port (printed on start); anything that is not
// a valid port falls back to the default, as before.
const requestedPort = Number(String(process.env.TOOL_RUNNER_PORT ?? '').trim() || NaN);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 8766;
const production = text(process.env.NODE_ENV).toLowerCase() === 'production';
const TOKEN = text(process.env.TOOL_RUNNER_TOKEN) || (production ? '' : text(process.env.RUNNER_TOKEN));
const MAX_BODY = 1024 * 1024;
const TOOL_TIMEOUT_MS = 30_000;
const VERSION = '1.0.0';
const MAX_CACHED_EXECUTIONS = 2_000;
const completedExecutions = new Map();

if (TOKEN.length < 32) {
  console.error('RUNNER_TOKEN must be at least 32 characters; the runner will not start without it.');
  process.exit(1);
}

const tlsCert = text(process.env.TOOL_RUNNER_TLS_CERT);
const tlsKey = text(process.env.TOOL_RUNNER_TLS_KEY);
if (production && (!tlsCert || !tlsKey)) {
  console.error('TOOL_RUNNER_TLS_CERT and TOOL_RUNNER_TLS_KEY are required in production.');
  process.exit(1);
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
  if (!executionId) {
    return { executed: false, status: 'execution-id-required', message: 'The server must provide an execution ID.' };
  }
  const cached = completedExecutions.get(executionId);
  if (cached) return { ...cached, replayed: true };

  const task = body?.task ?? {};
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  const selected = selectTool(task, payload.tool);
  if (selected.error) {
    return { executed: false, status: selected.error, message: selected.message, available: selected.available };
  }
  const startedAt = new Date().toISOString();
  try {
    const result = await Promise.race([
      selected.tool.run(payload.input ?? {}),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The tool timed out'), { code: 'timeout' })), TOOL_TIMEOUT_MS).unref())
    ]);
    const completed = {
      executed: true,
      status: 'completed',
      tool: selected.name,
      runner: { name: 'kindgleam-builtin-tools', version: VERSION },
      executionId,
      startedAt,
      completedAt: new Date().toISOString(),
      output: result.output,
      provenance: result.provenance
    };
    completedExecutions.set(executionId, completed);
    while (completedExecutions.size > MAX_CACHED_EXECUTIONS) {
      completedExecutions.delete(completedExecutions.keys().next().value);
    }
    return completed;
  } catch (error) {
    // The tool refused or failed: nothing was produced, and the answer says so.
    return {
      executed: false,
      status: 'tool-failed',
      tool: selected.name,
      code: error.code ?? 'tool-error',
      message: error.message
    };
  }
}

async function handle(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/v1/health') return send(res, 200, { ok: true, version: VERSION });
    if (!authorized(req)) return send(res, 401, { executed: false, status: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/v1/tools') return send(res, 200, { tools: toolCatalog() });
    if (req.method === 'POST' && (req.url === '/' || req.url === '/v1/execute')) {
      return send(res, 200, await execute(await readJson(req)));
    }
    send(res, 404, { executed: false, status: 'not-found' });
  } catch (error) {
    send(res, error.status ?? 500, { executed: false, status: 'bad-request', message: error.status ? error.message : 'Runner error' });
  }
}

const server = tlsCert && tlsKey
  ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, handle)
  : http.createServer(handle);
server.requestTimeout = TOOL_TIMEOUT_MS + 10_000;

server.listen(PORT, HOST, () => {
  const scheme = tlsCert && tlsKey ? 'https' : 'http';
  console.log(`Kindgleam tool runner ${VERSION} listening on ${scheme}://${HOST}:${server.address().port}`);
  console.log(`Tools: ${toolCatalog().map(tool => tool.name).join(', ')}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
