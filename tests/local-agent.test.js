/**
 * The local agent runs code on a person's machine, so its boundary is tested
 * against the real process: origin and host checks, challenge authenticity,
 * single use, and a receipt the server can verify.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { executionPayloadDigest, signExecutionChallenge, verifyExecutionReceipt } from '../src/execution.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:3000';

async function withAgent(run) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['bin/local-agent.js'], {
    env: {
      PATH: process.env.PATH,
      LOCAL_AGENT_PORT: String(port),
      LOCAL_AGENT_ALLOWED_ORIGIN: ORIGIN,
      LOCAL_AGENT_ALLOW_PROCESS_EXECUTION: 'true',
      LOCAL_AGENT_SHARED_SECRET: SECRET,
      LOCAL_AGENT_RUN_ROOT: path.join(os.tmpdir(), 'pa-agent-' + crypto.randomBytes(4).toString('hex'))
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('listening')) resolve();
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('exit', code => reject(new Error(
      `agent exited with ${code}: ${stderr.trim() || stdout.trim() || 'no diagnostic output'}`
    )));
  });
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

function challengeFor(runId, taskId, attempt = 1, payload = { language: 'node', source: 'console.log(1)' }) {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const nonce = crypto.randomBytes(16).toString('base64url');
  return {
    expiresAt, nonce, attempt,
    signature: signExecutionChallenge(SECRET, { runId, taskId, taskType: 'code', attempt, executionTarget: 'local', expiresAt, nonce, payloadDigest: executionPayloadDigest(payload) })
  };
}

const post = (base, body, headers = {}) => fetch(base + '/v1/execute', {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

test('the local agent refuses foreign origins', () =>
  withAgent(async base => {
    const response = await fetch(base + '/v1/preflight', { headers: { origin: 'https://evil.example' } });
    assert.equal(response.status, 403);
    const own = await fetch(base + '/v1/preflight', { headers: { origin: ORIGIN } });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).agent.available, true);
  }));

test('a signed challenge runs once and yields a verifiable receipt', () =>
  withAgent(async base => {
    const payload = { language: 'node', source: 'console.log(6 * 7)' };
    const request = {
      runId: 'run-1', taskId: 'build-code', taskType: 'code', executionTarget: 'local', attempt: 1,
      executionChallenge: challengeFor('run-1', 'build-code', 1, payload),
      payload
    };
    // The approved challenge carried with different code: refused before anything runs.
    const swapped = await post(base, { ...request, payload: { language: 'node', source: 'require("fs").writeFileSync("pwned", "x")' } });
    assert.equal((await swapped.json()).status, 'invalid-execution-challenge');
    const first = await post(base, request);
    const body = await first.json();
    assert.equal(first.status, 200);
    assert.equal(body.stdout, '42\n');
    const { signature, ...receipt } = body.receipt;
    assert.equal(verifyExecutionReceipt(SECRET, {
      runId: 'run-1', taskId: 'build-code', taskType: 'code', attempt: 1,
      challengeNonce: receipt.challengeNonce,
      receipt
    }, signature), true);

    const replay = await post(base, request);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).status, 'execution-challenge-replayed');
  }));

test('the local agent executes a complete multi-file JavaScript workspace', () =>
  withAgent(async base => {
    const payload = {
      project: true,
      language: 'javascript',
      files: {
        'main.mjs': 'import { value } from "./lib/value.mjs"; console.log(value * 2);',
        'lib/value.mjs': 'export const value = 21;',
        'main.test.mjs': 'import test from "node:test"; import assert from "node:assert/strict"; import { value } from "./lib/value.mjs"; test("value", () => assert.equal(value, 21));'
      },
      entry: 'main.mjs'
    };
    const request = {
      runId: 'run-project', taskId: 'test-code', taskType: 'code', executionTarget: 'local', attempt: 1,
      executionChallenge: challengeFor('run-project', 'test-code', 1, payload),
      payload
    };
    const response = await post(base, request);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'completed');
    assert.equal(body.stdout, '42\n');
    assert.equal(body.testSummary.total, 1);
    assert.equal(body.receipt.payloadDigest, executionPayloadDigest(payload));
  }));

test('the local agent rejects duplicate project file paths', () =>
  withAgent(async base => {
    const payload = {
      project: true,
      language: 'javascript',
      files: [
        { path: 'main.mjs', content: 'console.log(1)' },
        { path: 'main.mjs', content: 'console.log(2)' }
      ],
      entry: 'main.mjs'
    };
    const request = {
      runId: 'run-dup', taskId: 'test-code', taskType: 'code', executionTarget: 'local', attempt: 1,
      executionChallenge: challengeFor('run-dup', 'test-code', 1, payload),
      payload
    };
    const response = await post(base, request);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'failed');
    assert.match(body.message ?? body.error ?? '', /duplicate workspace file path/);
  }));

test('a challenge for another task or with a forged signature is refused', () =>
  withAgent(async base => {
    const moved = await post(base, {
      runId: 'run-1', taskId: 'test-code', taskType: 'code', executionTarget: 'local', attempt: 1,
      executionChallenge: challengeFor('run-1', 'build-code', 1),
      payload: { language: 'node', source: 'console.log(1)' }
    });
    assert.equal((await moved.json()).status, 'invalid-execution-challenge');

    const forged = await post(base, {
      runId: 'run-1', taskId: 'build-code', taskType: 'code', executionTarget: 'local', attempt: 1,
      executionChallenge: { ...challengeFor('run-1', 'build-code', 1), signature: 'forged' },
      payload: { language: 'node', source: 'console.log(1)' }
    });
    assert.equal((await forged.json()).status, 'invalid-execution-challenge');
  }));
