/**
 * Test harness.
 *
 * Every test runs against a real PostgreSQL database — the same engine
 * production uses — in its own schema-isolated database, created and dropped
 * per file. Nothing is mocked that the application actually depends on.
 *
 * TEST_DATABASE_URL points at a server the suite may create databases on.
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db.js';
import { createLogger, createMetrics } from '../src/observability.js';
import { build } from '../server.js';
import { backfillSensitiveData, assertSensitiveDataEncrypted } from '../src/data-protection.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres';

/** A logger that keeps records in memory so tests can assert on them. */
export function recordingLogger() {
  const lines = [];
  const logger = createLogger({ level: 'error', stream: { write: line => lines.push(JSON.parse(line)) } });
  logger.lines = lines;
  return logger;
}

/**
 * Stand up an isolated database, wire the real object graph against it, and
 * hand back a client bound to an ephemeral port.
 *
 * Most integration fixtures use a neutral Responses-style stand-in. This
 * adapter translates the real Vertex Gemini request/response contract at the
 * boundary so old fixture bodies do not leak provider assumptions into tests.
 */
const VERTEX_TEST_DEFAULTS = Object.freeze({
  AI_PROVIDER: 'google',
  GOOGLE_CLOUD_PROJECT: 'test-project',
  GOOGLE_CLOUD_LOCATION: 'global',
  VERTEX_ACCESS_TOKEN: 'test-token',
  AI_MODEL: 'gemini-3.8-flash'
});
const VERTEX_MARKER = '/publishers/google/models/';

function vertexModelFromUrl(url) {
  const value = String(url);
  const start = value.indexOf(VERTEX_MARKER);
  if (start < 0) return 'gemini-3.8-flash';
  return decodeURIComponent(value.slice(start + VERTEX_MARKER.length).split(':')[0]) || 'gemini-3.8-flash';
}

export function geminiFromStandIn(standIn) {
  return async (url, options = {}) => {
    if (!String(url).includes(VERTEX_MARKER)) return standIn(url, options);
    const body = JSON.parse(options.body || '{}');
    const input = [];
    const systemText = body.systemInstruction?.parts?.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n\n');
    if (systemText) input.push({ role: 'system', content: [{ type: 'input_text', text: systemText }] });
    for (const content of Array.isArray(body.contents) ? body.contents : []) {
      const textParts = (content.parts ?? []).filter(part => typeof part?.text === 'string').map(part => part.text);
      if (!textParts.length) continue;
      input.push({
        role: content.role === 'model' ? 'assistant' : 'user',
        content: textParts.map(text => ({ type: 'input_text', text }))
      });
    }
    const tools = Array.isArray(body.tools) && body.tools.length
      ? body.tools.map(tool => tool?.googleSearch ? { type: 'web_search' } : tool)
      : [];
    const legacyInput = input.map(item => ({
      role: item.role,
      content: item.content.map(part => part.text).join('\n')
    }));
    const messages = (Array.isArray(body.contents) ? body.contents : []).map(item => {
      const blocks = (item.parts ?? []).flatMap(part => {
        if (typeof part?.text === 'string') return [{ type: 'text', text: part.text }];
        if (part?.inlineData?.data) {
          return [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.inlineData.mimeType || 'image/png',
              data: part.inlineData.data
            }
          }];
        }
        return [];
      });
      return {
        role: item.role === 'model' ? 'assistant' : 'user',
        content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks
      };
    });
    const legacy = {
      model: vertexModelFromUrl(url),
      input: legacyInput,
      inputParts: input,
      messages,
      system: systemText || '',
      ...(tools.length ? { tools } : {}),
      ...(body.generationConfig?.maxOutputTokens ? { max_output_tokens: body.generationConfig.maxOutputTokens } : {})
    };
    const response = await standIn('https://standin.invalid/v1/responses', {
      ...options,
      body: JSON.stringify(legacy)
    });
    if (!response?.ok) return response;
    const data = await response.json();
    if (Array.isArray(data?.candidates)) {
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const outputParts = Array.isArray(data?.output)
      ? data.output.flatMap(item => item?.content ?? [])
      : [];
    const answer = String(
      data?.output_text
      ?? outputParts.find(part => typeof part?.text === 'string')?.text
      ?? (Array.isArray(data?.content) ? data.content.find(part => typeof part?.text === 'string')?.text : '')
      ?? data?.text
      ?? ''
    );
    const usage = data?.usage ?? {};
    const contentCitations = [
      ...(Array.isArray(data?.content) ? data.content : []),
      ...outputParts
    ].flatMap(part => Array.isArray(part?.citations) ? part.citations : [])
      .filter(item => item?.url)
      .map(item => ({ url: item.url, title: item.title || '' }));
    const sources = [
      ...(Array.isArray(data?.output_sources) ? data.output_sources : []),
      ...contentCitations
    ];
    return new Response(JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: answer ? [{ text: answer }] : [] },
        finishReason: 'STOP',
        ...(sources.length ? {
          groundingMetadata: {
            groundingChunks: [...new Map(sources.filter(item => item?.url).map(item => [item.url, item])).values()].map(item => ({
              web: { uri: item.url, title: item.title || '' }
            }))
          }
        } : {})
      }],
      usageMetadata: {
        promptTokenCount: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
        candidatesTokenCount: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
        thoughtsTokenCount: Number(usage.reasoning_tokens ?? 0)
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}


export async function withServer(run, { env = {}, fetchImpl } = {}) {
  const provider = String(env.AI_PROVIDER ?? '').toLowerCase();
  const vertexNative = provider === 'google' && Boolean(env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT);
  if (provider && !vertexNative) {
    const requestedModel = String(env.VERTEX_MODEL || env.AI_MODEL || '');
    env = {
      ...env,
      ...VERTEX_TEST_DEFAULTS,
      AI_MODEL: /^gemini-/.test(requestedModel) ? requestedModel : VERTEX_TEST_DEFAULTS.AI_MODEL
    };
    if (fetchImpl) fetchImpl = geminiFromStandIn(fetchImpl);
  }

  const name = `pro_test_${crypto.randomBytes(6).toString('hex')}`;
  // Requests are served by a non-superuser runtime role hardened exactly as
  // production hardens it, so missing grants and RLS gaps fail here instead
  // of in a deployment. Seeding and assertions use a separate admin pool.
  const role = `pro_rt_${crypto.randomBytes(6).toString('hex')}`;
  const password = crypto.randomBytes(18).toString('hex');
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await admin.end();

  const adminUrl = new URL(ADMIN_URL);
  adminUrl.pathname = `/${name}`;
  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.username = role;
  runtimeUrl.password = password;

  const baseEnv = {
    LOG_LEVEL: 'error',
    COOKIE_SECURE: 'false',
    // Integration tests explicitly exercise the multi-agent panel in tests/multi-agent.test.js.
    // Keep broad HTTP fixtures deterministic by default; this does not alter production config.
    MULTI_AGENT_MODE: 'off',
    AGENTS_REVIEW: 'off',
    // Legacy API/Research fixtures explicitly exercise pre-cutover behavior.
    // The shipped runtime defaults to coding-only; dedicated KG Code tests
    // override this to true and assert the server admission boundary.
    KG_CODING_ONLY: 'false',
    OBJECT_ENCRYPTION_KEY: Buffer.from('test-object-encryption-key-32byt').toString('base64'),
    BILLING_ENCRYPTION_KEY: Buffer.from('billing-key-32-bytes-long-000000').toString('base64'),
    PERSONAL_DATA_ENCRYPTION_KEY: Buffer.from('personal-key-32-bytes-long-00000').toString('base64'),
    ...env
  };
  const logger = recordingLogger();
  const metrics = createMetrics();
  const noFetch = () => { throw new Error('unexpected outbound call'); };

  const adminConfig = loadConfig({ ...baseEnv, DATABASE_URL: adminUrl.toString() });
  const adminParts = build({ config: adminConfig, logger, metrics, fetchImpl: noFetch });
  await migrate(adminParts.pool, logger, { runtimeRole: role, hardenRuntime: true });
  await backfillSensitiveData(adminParts.pool, {
    billingKey: adminConfig.security.billingEncryptionKey,
    personalDataKey: adminConfig.security.personalDataEncryptionKey,
    logger
  });
  await assertSensitiveDataEncrypted(adminParts.pool);

  const config = loadConfig({ ...baseEnv, DATABASE_URL: runtimeUrl.toString() });
  const parts = build({ config, logger, metrics, fetchImpl: fetchImpl ?? noFetch });

  const server = parts.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const context = {
    ...parts,
    pool: adminParts.pool,
    appPool: parts.pool,
    adminUrl: adminUrl.toString(),
    runtimeRole: role,
    config, logger, metrics, base,
    async seed({ workspace = 'ws', role = 'admin', name: who = 'Tester', policies = {}, organizationType = 'personal', jurisdiction = null, acceptTerms = true } = {}) {
      const existing = await adminParts.pool.query('SELECT id FROM workspaces WHERE id = $1', [workspace]);
      if (!existing.rows[0]) {
        await adminParts.identity.createWorkspace({
          id: workspace, name: workspace,
          maxBytes: config.limits.workspaceBytes, maxObjects: config.limits.workspaceObjects,
          organizationId: 'org-' + workspace,
          organizationType,
          jurisdiction
        });
      }
      const principal = await adminParts.identity.createPrincipal({ name: who });
      await adminParts.identity.addMember({ workspaceId: workspace, principalId: principal.id, role });
      for (const [layer, policy] of Object.entries(policies)) {
        const scopeId = layer === 'platform' ? 'global'
          : layer === 'workspace' ? workspace
          : layer === 'user' ? principal.id
          : undefined;
        if (!scopeId) throw new Error(`test seed cannot target layer "${layer}" without a scope id`);
        await adminParts.governance.set({ layer, scopeId, policy });
      }
      if (acceptTerms) {
        await adminParts.pool.query('INSERT INTO terms_acceptances (principal_id, version, age_confirmed) VALUES ($1, $2, true)', [principal.id, config.terms.version]);
      }
      const key = await adminParts.identity.issueKey({ principalId: principal.id, name: 'test' });
      return { workspace, principal, token: key.token, keyId: key.id };
    },

    async call(method, path, { token, workspace, body, headers = {} } = {}) {
      const merged = { ...headers };
      if (token) merged.authorization = `Bearer ${token}`;
      if (workspace) merged['x-workspace-id'] = workspace;
      if (body !== undefined) merged['content-type'] = 'application/json';

      const response = await fetch(base + path, {
        method, headers: merged,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      return { status: response.status, body: parsed, headers: response.headers };
    }
  };

  try {
    await run(context);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await parts.pool.end().catch(() => {});
    await adminParts.pool.end().catch(() => {});
    const cleanup = new pg.Pool({ connectionString: ADMIN_URL });
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
    await cleanup.end();
  }
}

export const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  body: null,
  text: async () => JSON.stringify(body),
  json: async () => body
});

/**
 * The listed steps this run's plan actually has, in order. Plans are fitted
 * to the work (a small task has no tool discovery or build checkpoint), so a
 * test that walks a plan walks the steps that exist.
 */
export async function stepsIn(call, auth, runId, ids) {
  const { body } = await call('GET', `/api/runs/${runId}`, auth);
  const present = new Set((body.tasks ?? []).map(task => task.id));
  return ids.filter(id => present.has(id));
}

// Steps a person completes on the way to the work itself.
const PREPARATION = new Set(['understand', 'discover-capabilities', 'adapt', 'plan', 'step', 'observe', 'reassess']);

/**
 * Walk a progressive run the way a person would, until the next step is
 * `until` (a step id or type) or nothing more can be done by hand. The
 * workflow grows one step at a time, so the steps ahead cannot be listed up
 * front. Approvals are granted only when `approve` is true. Returns the run.
 */
export async function advanceTo(call, auth, runId, { until = null, approve = true, evidence = null, max = 12 } = {}) {
  let run = (await call('GET', `/api/runs/${runId}`, auth)).body;
  for (let i = 0; i < max && run.next; i += 1) {
    const task = run.tasks.find(item => item.id === run.next);
    if (!task || (until && (task.id === until || task.type === until))) break;
    let body;
    if (task.type === 'approval') {
      if (!approve) break;
      body = { taskId: task.id, approved: true };
    } else if (PREPARATION.has(task.type)) {
      body = { taskId: task.id, summary: task.id, ...(evidence && task.type === 'understand' ? { evidence } : {}) };
    } else {
      break;
    }
    const step = await call('POST', `/api/runs/${runId}/advance`, { ...auth, body });
    if (step.status !== 200) throw new Error(`${task.id} → ${step.status} ${JSON.stringify(step.body).slice(0, 200)}`);
    run = (await call('GET', `/api/runs/${runId}`, auth)).body;
  }
  return run;
}

/**
 * Bring a code run to its test step: prepare it, supply the code by hand
 * (writing may be human work; running it never is), and approve running it
 * when `approve` is true. Returns the run.
 */
export async function codeWritten(call, auth, runId, { approve = true, source = 'def add(a, b):\n    return a + b\n', tests = 'from main import add\nassert add(2, 3) == 5\n' } = {}) {
  let run = await advanceTo(call, auth, runId, { until: 'code' });
  if (run.next === 'build-code') {
    const built = await call('POST', `/api/runs/${runId}/advance`, {
      ...auth, body: { taskId: 'build-code', summary: 'Code written.', evidence: { structured: { language: 'python', source, tests } } }
    });
    if (built.status !== 200) throw new Error(`build-code → ${built.status} ${JSON.stringify(built.body).slice(0, 200)}`);
  }
  run = await advanceTo(call, auth, runId, { until: 'code', approve });
  return run;
}
