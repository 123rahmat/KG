/**
 * Minimal MCP Streamable-HTTP client for governed external tools.
 *
 * MCP is shared infrastructure, not a workspace. Discovery is cached and may
 * retry because it is read-only. Tool calls are never automatically retried:
 * a remote side effect must not run twice because of a network ambiguity.
 */
const text = value => String(value ?? '').trim();
const state = new Map();
let requestId = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Date.now();

function serverState(name) {
  if (!state.has(name)) state.set(name, {
    failures: 0, circuitUntil: 0, active: 0, waiters: [], tools: null, toolsAt: 0, initialized: false
  });
  return state.get(name);
}

function configuredServer(config, name) {
  return (config?.tools?.mcp?.servers ?? []).find(item => item.name === text(name)) ?? null;
}

async function acquire(server, s) {
  const max = Math.max(1, Number(server.maxConcurrency) || 4);
  if (s.active < max) { s.active += 1; return; }
  const timeoutMs = Math.max(100, Number(server.queueTimeoutMs) || 3_000);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('MCP server is busy.'), { code: 'mcp-queue-timeout' })), timeoutMs);
    s.waiters.push(() => { clearTimeout(timer); s.active += 1; resolve(); });
  });
}
function release(s) {
  s.active = Math.max(0, s.active - 1);
  const next = s.waiters.shift();
  if (next) next();
}
function trip(server, s) {
  s.failures += 1;
  const threshold = Math.max(1, Number(server.circuitFailures) || 3);
  if (s.failures >= threshold) {
    s.circuitUntil = now() + Math.max(1_000, Number(server.circuitOpenMs) || 30_000);
    s.failures = 0;
  }
}
function recover(s) { s.failures = 0; s.circuitUntil = 0; }

async function rpc(server, method, params, { fetchImpl = fetch, retry = false } = {}) {
  const s = serverState(server.name);
  if (s.circuitUntil > now()) {
    const error = new Error('MCP server circuit is open after repeated failures.');
    error.code = 'mcp-circuit-open';
    throw error;
  }
  await acquire(server, s);
  try {
    const attempts = retry ? 2 : 1;
    let last;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const id = ++requestId;
        const response = await fetchImpl(server.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(server.headers ?? {})
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
          signal: AbortSignal.timeout(Math.max(500, Number(server.timeoutMs) || 15_000))
        });
        if (!response.ok) {
          const error = new Error(`MCP ${server.name} returned HTTP ${response.status}.`);
          error.code = response.status === 429 ? 'mcp-rate-limited' : 'mcp-http-error';
          throw error;
        }
        const type = text(response.headers.get('content-type')).toLowerCase();
        if (!type.includes('application/json')) {
          const error = new Error('This MCP endpoint returned a streaming response; configure its JSON response mode for Kindgleam.');
          error.code = 'mcp-streaming-response-unsupported';
          throw error;
        }
        const data = await response.json();
        if (data?.error) {
          const error = new Error(text(data.error.message) || 'MCP request failed.');
          error.code = 'mcp-jsonrpc-error';
          error.rpcCode = data.error.code;
          throw error;
        }
        recover(s);
        return data?.result ?? {};
      } catch (error) {
        last = error;
        if (attempt + 1 < attempts) await sleep(150 * (attempt + 1));
      }
    }
    trip(server, s);
    throw last;
  } finally {
    release(s);
  }
}

async function ensureInitialized(server, options) {
  const s = serverState(server.name);
  if (s.initialized) return;
  await rpc(server, 'initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'kindgleam', version: '1' }
  }, { ...options, retry: true });
  // The 2026 Streamable HTTP transport has no protocol-level sessions. Sending
  // initialized is best-effort; stateless JSON endpoints may not need it.
  try {
    await rpc(server, 'notifications/initialized', undefined, options);
  } catch {
    // A notification has no result and some JSON-only gateways answer 202/empty.
    // The successful initialize response is sufficient to attempt discovery.
  }
  s.initialized = true;
}

export function mcpServerCatalog(config) {
  return (config?.tools?.mcp?.servers ?? []).map(server => ({
    name: server.name,
    url: server.url,
    maxConcurrency: server.maxConcurrency,
    configured: true
  }));
}

export async function listMcpTools(config, { server: serverName = '', fetchImpl = fetch, force = false } = {}) {
  const servers = serverName ? [configuredServer(config, serverName)].filter(Boolean) : (config?.tools?.mcp?.servers ?? []);
  const results = [];
  for (const server of servers) {
    const s = serverState(server.name);
    const cacheMs = Math.max(1_000, Number(server.cacheMs) || 60_000);
    if (!force && s.tools && now() - s.toolsAt < cacheMs) {
      results.push({ server: server.name, tools: s.tools, cached: true });
      continue;
    }
    await ensureInitialized(server, { fetchImpl });
    const found = await rpc(server, 'tools/list', {}, { fetchImpl, retry: true });
    const tools = (Array.isArray(found?.tools) ? found.tools : []).map(tool => ({
      name: text(tool?.name),
      title: text(tool?.title),
      description: text(tool?.description),
      inputSchema: tool?.inputSchema ?? {},
      readOnly: tool?.annotations?.readOnlyHint === true,
      destructive: tool?.annotations?.destructiveHint === true
    })).filter(tool => tool.name).slice(0, 200);
    s.tools = tools;
    s.toolsAt = now();
    results.push({ server: server.name, tools, cached: false });
  }
  return results;
}

export async function callMcpTool(config, { server: serverName, tool, arguments: args = {} } = {}, { fetchImpl = fetch } = {}) {
  const server = configuredServer(config, serverName);
  if (!server) return { error: 'Unknown MCP server.', code: 'mcp-server-not-found' };
  const toolName = text(tool);
  if (!toolName) return { error: 'Choose an MCP tool.', code: 'mcp-tool-required' };
  await ensureInitialized(server, { fetchImpl });
  // Never retry tool calls: the remote operation may have side effects.
  const result = await rpc(server, 'tools/call', { name: toolName, arguments: args && typeof args === 'object' ? args : {} }, { fetchImpl, retry: false });
  return {
    server: server.name,
    tool: toolName,
    isError: result?.isError === true,
    content: Array.isArray(result?.content) ? result.content : [],
    structuredContent: result?.structuredContent ?? null
  };
}

export function resetMcpRuntimeForTests() { state.clear(); requestId = 0; }
