import test from 'node:test';
import assert from 'node:assert/strict';

import { callMcpTool, listMcpTools, resetMcpRuntimeForTests } from '../src/mcp.js';
import { loadConfig } from '../src/config.js';

const config = {
  tools: {
    mcp: {
      servers: [{
        name: 'demo',
        url: 'https://mcp.example.test/rpc',
        headers: { authorization: 'Bearer secret' },
        timeoutMs: 5000,
        cacheMs: 60000,
        maxConcurrency: 2,
        queueTimeoutMs: 1000,
        circuitFailures: 3,
        circuitOpenMs: 10000
      }]
    }
  }
};

function json(result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('MCP discovery initializes once and caches tools', async () => {
  resetMcpRuntimeForTests();
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.method);
    if (body.method === 'initialize') return json({ protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 'demo', version: '1' } });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/list') return json({ tools: [{
      name: 'lookup',
      description: 'Look something up',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true }
    }] });
    throw new Error('unexpected method ' + body.method);
  };

  const first = await listMcpTools(config, { fetchImpl });
  const second = await listMcpTools(config, { fetchImpl });

  assert.equal(first[0].tools[0].name, 'lookup');
  assert.equal(first[0].tools[0].readOnly, true);
  assert.equal(second[0].cached, true);
  assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('MCP tool calls are never automatically retried', async () => {
  resetMcpRuntimeForTests();
  let toolCalls = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === 'initialize') return json({ protocolVersion: '2026-07-28', capabilities: {} });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (body.method === 'tools/call') {
      toolCalls += 1;
      return new Response('unavailable', { status: 503 });
    }
    throw new Error('unexpected method ' + body.method);
  };

  await assert.rejects(
    callMcpTool(config, { server: 'demo', tool: 'mutate', arguments: { value: 1 } }, { fetchImpl }),
    /HTTP 503/
  );
  assert.equal(toolCalls, 1);
});

test('production MCP configuration requires HTTPS and bounds reliability controls', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@localhost:5432/kindgleam',
    GOOGLE_CLOUD_PROJECT: 'test-project',
    AI_PROVIDER: 'google',
    VERTEX_ACCESS_TOKEN: 'token',
    OBJECT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    PERSONAL_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    BILLING_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    SESSION_SECRET: 'x'.repeat(48)
  };

  assert.throws(() => loadConfig({
    ...base,
    MCP_SERVERS_JSON: JSON.stringify([{ name: 'local', url: 'http://localhost:9000/mcp' }])
  }), /must use HTTPS in production/);
});
