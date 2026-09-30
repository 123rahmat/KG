/**
 * The built-in tools and their runner. The network guard is tested against
 * the addresses SSRF attacks actually use, including a redirect hop into
 * cloud metadata; the runner is tested as the real process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { isPublicAddress, checkUrl, resolvePublic } from '../src/tools/net-guard.js';
import { webFetch, httpCheck } from '../src/tools/web.js';
import { evaluateExpression } from '../src/tools/math.js';
import { selectTool } from '../src/tools/registry.js';
import { withServer } from './helpers.js';

/* ---------------------------------------------------------------- guard */

test('only globally routable addresses are public', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '0:0:0:0:0:ffff:192.168.1.1',
    '::ffff:c0a8:101',
    '64:ff9b::a00:1', '2002:c0a8:0101::', '2001:10::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.equal(isPublicAddress('0:0:0:0:0:ffff:8.8.8.8'), true);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('URL shape is checked before any network activity', () => {
  for (const [url, code] of [
    ['file:///etc/passwd', 'unsupported-scheme'],
    ['gopher://example.com/', 'unsupported-scheme'],
    ['https://user:pass@example.com/', 'credentials-in-url'],
    ['https://example.com:8443/', 'port-not-allowed'],
    ['not a url', 'invalid-url']
  ]) {
    assert.throws(() => checkUrl(url), error => error.code === code, url);
  }
  assert.equal(checkUrl('https://example.com/a').hostname, 'example.com');
});

test('a host with any private answer is refused', async () => {
  await assert.rejects(
    resolvePublic('mixed.test', { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] }),
    error => error.code === 'non-public-address'
  );
  await assert.rejects(resolvePublic('169.254.169.254'), error => error.code === 'non-public-address');
  await assert.rejects(resolvePublic('[::1]'), error => error.code === 'non-public-address');
  const ok = await resolvePublic('public.test', { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(ok.address, '93.184.216.34');
});

test('the real resolver refuses localhost', async () => {
  await assert.rejects(webFetch({ url: 'http://localhost/' }), error => error.code === 'non-public-address');
});

/* ------------------------------------------------------------ web tools */

async function withSite(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // Loopback stands in for "a public site" here, and only here.
    await run({ port, options: { isAllowed: address => address === '127.0.0.1', ports: [port] } });
  } finally {
    server.close();
  }
}

test('web.fetch returns readable text with provenance', () =>
  withSite((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Tides</title><script>steal()</script></head><body><h1>Tides</h1><p>The moon pulls &amp; the sea follows.</p></body></html>');
  }, async ({ port, options }) => {
    const result = await webFetch({ url: `http://127.0.0.1:${port}/tides` }, options);
    assert.equal(result.output.title, 'Tides');
    assert.match(result.output.content, /The moon pulls & the sea follows\./);
    assert.ok(!result.output.content.includes('steal'), 'scripts are dropped, not returned as text');
    assert.equal(result.provenance.finalUrl, `http://127.0.0.1:${port}/tides`);
    assert.match(result.provenance.sha256, /^[0-9a-f]{64}$/);
  }));

test('a redirect into cloud metadata is refused at the second hop', () =>
  withSite((req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  }, async ({ port, options }) => {
    // Port 80 is allowed so the refusal comes from the address check.
    await assert.rejects(
      webFetch({ url: `http://127.0.0.1:${port}/go` }, { ...options, ports: [port, 80] }),
      error => error.code === 'non-public-address'
    );
  }));

test('binary content and oversized bodies are handled safely', () =>
  withSite((req, res) => {
    if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.alloc(10));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5000));
  }, async ({ port, options }) => {
    await assert.rejects(webFetch({ url: `http://127.0.0.1:${port}/image` }, options), error => error.code === 'unsupported-content-type');
    const big = await webFetch({ url: `http://127.0.0.1:${port}/big` }, { ...options, maxBytes: 1000 });
    assert.equal(big.output.truncated, true);
    assert.equal(big.output.content.length, 1000);
    const checked = await httpCheck({ url: `http://127.0.0.1:${port}/big` }, options);
    assert.equal(checked.output.ok, true);
  }));

/* ----------------------------------------------------------------- math */

test('math.evaluate computes without executing code', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('2 ^ 3 ^ 2'), 512, 'power is right associative');
  assert.equal(evaluateExpression('-2 ^ 2'), -4);
  assert.equal(evaluateExpression('sqrt(16) + max(1, 7, 3)'), 11);
  assert.ok(Math.abs(evaluateExpression('sin(pi / 2)') - 1) < 1e-12);
  for (const hostile of ['process.exit()', 'constructor', '1; 2', 'x => x', '1 +', '(1', 'eval(1)', '1 / 0']) {
    assert.throws(() => evaluateExpression(hostile), error => error.code === 'invalid-expression', hostile);
  }
  assert.throws(() => evaluateExpression('('.repeat(100) + '1' + ')'.repeat(100)), /nested too deeply/);
});

test('approved capability specs limit which tool a task may run', () => {
  const task = { metadata: { capabilitySpecs: [{ id: 'calc', tools: ['math.evaluate'] }] } };
  assert.equal(selectTool(task, 'math.evaluate').name, 'math.evaluate');
  assert.equal(selectTool(task, 'web.fetch').error, 'tool-not-approved');
  assert.equal(selectTool({ metadata: { capabilitySpecs: [{ id: 'unnamed' }] } }, 'math.evaluate').error, 'tool-not-approved');
  assert.equal(selectTool({}, 'shell.exec').error, 'tool-not-implemented');
  assert.equal(selectTool({}, 'web.fetch').name, 'web.fetch');
});

/* --------------------------------------------------------------- runner */

async function withRunner(run) {
  const token = crypto.randomBytes(24).toString('hex');
  // Port 0: the OS picks a free port, so parallel test files never collide.
  const child = spawn(process.execPath, ['bin/tool-runner.js'], {
    env: { PATH: process.env.PATH, RUNNER_TOKEN: token, TOOL_RUNNER_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', code => reject(new Error('runner exited with ' + code)));
  });
  try {
    await run({ url: `http://127.0.0.1:${port}`, token });
  } finally {
    child.kill();
  }
}

test('the runner requires its token and reports every outcome explicitly', () =>
  withRunner(async ({ url, token }) => {
    const post = (body, auth = token) => fetch(url + '/v1/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body)
    }).then(async response => ({ status: response.status, body: await response.json() }));

    assert.equal((await post({}, null)).status, 401);
    assert.equal((await post({}, 'x'.repeat(48))).status, 401);

    const computed = await post({ executionId: 'tool-test-1', task: { id: 't' }, payload: { tool: 'math.evaluate', input: { expression: '6 * 7' } } });
    assert.equal(computed.body.executed, true);
    assert.equal(computed.body.output.value, 42);
    const replay = await post({ executionId: 'tool-test-1', task: { id: 't' }, payload: { tool: 'math.evaluate', input: { expression: '6 * 7' } } });
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.output.value, 42);

    const blocked = await post({ executionId: 'tool-test-2', task: { id: 't' }, payload: { tool: 'web.fetch', input: { url: 'http://169.254.169.254/' } } });
    assert.equal(blocked.body.executed, false);
    assert.equal(blocked.body.code, 'non-public-address');

    const unknown = await post({ executionId: 'tool-test-3', task: { id: 't' }, payload: { tool: 'shell.exec', input: { command: 'id' } } });
    assert.equal(unknown.body.executed, false);
    assert.equal(unknown.body.status, 'tool-not-implemented');
  }));

/* ---------------------------------------------------------- end to end */


test('a discovered, approved capability runs on the built-in runner end to end', () =>
  withRunner(({ url, token }) => withServer(async ({ call, seed }) => {
    const { token: key, workspace } = await seed();
    const { body: run } = await call('POST', '/api/runs', {
      token: key, workspace, body: { goal: 'Invent an unfamiliar tool for an unknown process.' }
    });
    const discovery = {
      structured: {
        capabilities: [{
          id: 'exact-calculation', purpose: 'Compute the tolerance exactly.',
          executionModes: ['tool'], tools: ['math.evaluate'], risk: 'medium'
        }]
      }
    };
    for (;;) {
      const { body: current } = await call('GET', `/api/runs/${run.id}`, { token: key, workspace });
      const next = current.tasks.find(task => task.id === current.next);
      if (next.type === 'tool') break;
      const body = next.type === 'approval' ? { taskId: next.id, approved: true }
        : next.id === 'discover-capabilities' ? { taskId: next.id, evidence: discovery }
          // Understanding finds that a capability the system lacks is needed.
          : next.type === 'understand' ? { taskId: next.id, summary: next.id, evidence: { structured: { needsCapabilityDiscovery: true } } }
            : { taskId: next.id, summary: next.id };
      const step = await call('POST', `/api/runs/${run.id}/advance`, { token: key, workspace, body });
      assert.equal(step.status, 200, next.id);
    }

    const execute = payload => call('POST', `/api/runs/${run.id}/execute`, {
      token: key, workspace, body: { approved: true, payload }
    });
    // Discovered capabilities stay candidates until an administrator approves.
    assert.equal((await execute({ tool: 'math.evaluate', input: { expression: '1' } })).body.code, 'capability-approval-required');
    assert.equal((await call('POST', '/api/capability-specs/exact-calculation/approve', { token: key, workspace, body: {} })).status, 200);

    // The approved capability names its tool; anything else is refused.
    const refused = await execute({ tool: 'web.fetch', input: { url: 'https://example.com/' } });
    assert.equal(refused.body.execution.executed, false);
    assert.equal(refused.body.execution.status, 'tool-not-approved');

    const done = await execute({ tool: 'math.evaluate', input: { expression: '(3 + 4) * 6' } });
    assert.equal(done.body.execution.executed, true);
    const task = done.body.run.tasks.find(item => item.type === 'tool' && item.status === 'complete');
    assert.equal(task.evidence.result.output.value, 42);
    assert.equal(task.evidence.executionTarget, 'generic-tool-router');
  }, {
    env: { TOOL_RUNNER_URL: url, RUNNER_TOKEN: token },
    fetchImpl: (target, options) => {
      assert.ok(String(target).startsWith(url), 'only the tool runner may be called');
      return fetch(target, options);
    }
  })));
