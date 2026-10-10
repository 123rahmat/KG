import { parseBase64Key } from './object-crypto.js';
import { DEFAULT_MODEL, LIGHT_MODEL, isGeminiModel, normalizeModelId } from './model-catalog.js';

/**
 * Configuration: environment in, validated frozen config out.
 *
 * Every setting is read once, here, at boot. Nothing else in the codebase
 * touches process.env. A bad value stops the process with a list of what is
 * wrong rather than surfacing as a confusing failure under load.
 */

const PROVIDERS = ['google'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const AI_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];

const text = value => String(value ?? '').trim();

function integer(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, name, errors }) {
  if (!text(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return fallback;
  }
  return value;
}

function boolean(raw, fallback) {
  const value = text(raw).toLowerCase();
  if (!value) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

/**
 * Which proxies may set X-Forwarded-For. Express's `true` trusts every hop,
 * so the left-most address — which the client writes — would become req.ip
 * and a client could dodge per-IP rate limits. `true` therefore means one
 * hop (the proxy you run); several layers take a hop count, and fixed
 * proxies can be named by address or subnet.
 */
function trustProxySetting(raw, errors) {
  const value = text(raw).toLowerCase();
  if (!value || ['false', '0', 'no'].includes(value)) return false;
  if (['true', 'yes'].includes(value)) return 1;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) errors.push('TRUST_PROXY hop count must be 10 or fewer');
    return hops;
  }
  const entries = value.split(',').map(item => item.trim()).filter(Boolean);
  const named = ['loopback', 'linklocal', 'uniquelocal'];
  const address = /^[0-9a-f:.]+(\/\d{1,3})?$/;
  if (!entries.length || entries.some(item => !named.includes(item) && !address.test(item))) {
    errors.push('TRUST_PROXY must be false, true (one proxy), a hop count, or a comma-separated list of proxy addresses/subnets');
    return false;
  }
  return entries;
}

function httpUrl(raw, { name, errors }) {
  const value = text(raw);
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${name} is not a valid URL (got "${value}")`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`${name} must be http or https (got "${url.protocol}")`);
    return null;
  }
  return url.toString();
}

function databaseUsername(connectionString) {
  const value = text(connectionString);
  if (!value) return '';
  try {
    return decodeURIComponent(new URL(value).username);
  } catch {
    return '';
  }
}

/**
 * STRIPE_PLANS: a JSON array of the paid plans, in the order they are shown:
 * [{"id":"pro","name":"Pro","priceId":"price_…","price":"<your price>",
 *   "fourHourTokens":60000,"weeklyTokens":200000,"features":["…"]},
 *  {"id":"enterprise","name":"Enterprise","contactUrl":"mailto:sales@example.com",
 *   "price":"Custom","features":["…"]}]
 * These are deployment examples, not fixed product pricing. Choose limits from
 * measured Vertex Gemini costs and the deployment's infrastructure budget.
 * A plan with a contactUrl is sold by your team, not through Checkout: its
 * subscription is created in Stripe with metadata plan_id=<id> (or one of its
 * priceIds). Limits of 0 or missing mean no limit on that plan. The free plan
 * is everyone without a subscription (BILLING_FREE_* and USAGE_LIMIT_*).
 */
function parseJsonObject(raw, name, errors, fallback = {}) {
  if (!text(raw)) return fallback;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    errors.push(name + ' must be a JSON object');
    return fallback;
  }
}

function parseMcpServers(raw, errors, { production = false } = {}) {
  if (!text(raw)) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    errors.push('MCP_SERVERS_JSON must be a JSON array of MCP server definitions');
    return [];
  }
  if (!Array.isArray(parsed)) {
    errors.push('MCP_SERVERS_JSON must be a JSON array of MCP server definitions');
    return [];
  }
  const names = new Set();
  const servers = [];
  for (const [index, item] of parsed.entries()) {
    const name = text(item?.name).toLowerCase();
    const rawUrl = text(item?.url);
    let url;
    try { url = new URL(rawUrl); } catch {
      errors.push(`MCP_SERVERS_JSON[${index}].url must be a valid HTTP(S) URL`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || names.has(name)) {
      errors.push(`MCP_SERVERS_JSON[${index}].name must be unique and use a-z, 0-9, and hyphen`);
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) {
      errors.push(`MCP_SERVERS_JSON[${index}].url must use HTTPS in production`);
      continue;
    }
    names.add(name);
    const headers = item?.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
      ? Object.fromEntries(Object.entries(item.headers)
          .map(([key, value]) => [text(key).toLowerCase(), text(value)])
          .filter(([key, value]) => key && value && !['host','content-length','connection'].includes(key)))
      : {};
    servers.push({
      name,
      url: url.toString(),
      headers,
      timeoutMs: integer(item?.timeoutMs, 15_000, { min: 500, max: 120_000, name: `MCP_SERVERS_JSON[${index}].timeoutMs`, errors }),
      cacheMs: integer(item?.cacheMs, 60_000, { min: 1_000, max: 3_600_000, name: `MCP_SERVERS_JSON[${index}].cacheMs`, errors }),
      maxConcurrency: integer(item?.maxConcurrency, 4, { min: 1, max: 16, name: `MCP_SERVERS_JSON[${index}].maxConcurrency`, errors }),
      queueTimeoutMs: integer(item?.queueTimeoutMs, 3_000, { min: 100, max: 60_000, name: `MCP_SERVERS_JSON[${index}].queueTimeoutMs`, errors }),
      circuitFailures: integer(item?.circuitFailures, 3, { min: 1, max: 20, name: `MCP_SERVERS_JSON[${index}].circuitFailures`, errors }),
      circuitOpenMs: integer(item?.circuitOpenMs, 30_000, { min: 1_000, max: 600_000, name: `MCP_SERVERS_JSON[${index}].circuitOpenMs`, errors })
    });
  }
  return servers.slice(0, 20);
}
function stripePlans(raw, errors) {
  if (!text(raw)) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { errors.push('STRIPE_PLANS must be a JSON array of plans'); return []; }
  if (!Array.isArray(parsed)) { errors.push('STRIPE_PLANS must be a JSON array of plans'); return []; }
  const plans = [];
  const PRICE = /^price_[A-Za-z0-9]+$/;
  for (const [index, plan] of parsed.entries()) {
    const id = text(plan?.id);
    const priceIds = [...new Set([plan?.priceId, ...(Array.isArray(plan?.priceIds) ? plan.priceIds : [])].map(text).filter(Boolean))];
    const contactUrl = text(plan?.contactUrl);
    const contactOk = !contactUrl || /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(contactUrl);
    if (!/^[a-z0-9-]{1,40}$/.test(id) || id === 'free' || !text(plan?.name) || !contactOk
        || priceIds.some(price => !PRICE.test(price)) || (!priceIds.length && !contactUrl)) {
      errors.push(`STRIPE_PLANS[${index}] needs an id (a-z, 0-9, -; not "free"), a name, and a Stripe priceId (price_…) or a contactUrl (mailto: or https:)`);
      continue;
    }
    const limit = value => (Number.isInteger(value) && value > 0 ? value : 0);
    plans.push({
      id, priceIds,
      priceId: contactUrl ? null : priceIds[0],
      contactUrl: contactUrl || null,
      name: text(plan.name).slice(0, 60),
      price: text(plan.price).slice(0, 60),
      badge: text(plan.badge).slice(0, 30),
      description: text(plan.description).slice(0, 200),
      features: Array.isArray(plan.features) ? plan.features.map(text).filter(Boolean).slice(0, 8) : [],
      fourHourTokens: limit(plan.fourHourTokens),
      weeklyTokens: limit(plan.weeklyTokens),
      // Unset: every model the deployment offers.
      modelIds: Array.isArray(plan.modelIds)
        ? [...new Set(plan.modelIds.map(normalizeModelId).filter(Boolean))]
        : null
    });
  }
  if (new Set(plans.map(plan => plan.id)).size !== plans.length) errors.push('STRIPE_PLANS ids must be unique');
  const prices = plans.flatMap(plan => plan.priceIds);
  if (new Set(prices).size !== prices.length) errors.push('STRIPE_PLANS: a Stripe price can belong to one plan only');
  return plans;
}

export function loadConfig(env = process.env) {
  const errors = [];
  const nodeEnv = text(env.NODE_ENV) || 'development';
  const production = nodeEnv === 'production';
  const reviewMode = (text(env.AGENTS_REVIEW) || 'auto').toLowerCase();
  if (!['auto', 'always', 'off'].includes(reviewMode)) errors.push(`AGENTS_REVIEW must be auto, always or off (got "${reviewMode}")`);
  const multiAgentMode = (text(env.MULTI_AGENT_MODE) || 'auto').toLowerCase();
  if (!['auto', 'always', 'off'].includes(multiAgentMode)) errors.push(`MULTI_AGENT_MODE must be auto, always or off (got "${multiAgentMode}")`);
  const parallelMode = (text(env.AGENTS_PARALLEL_MODE) || 'auto').toLowerCase();
  if (!['auto', 'always', 'off'].includes(parallelMode)) errors.push(`AGENTS_PARALLEL_MODE must be auto, always or off (got "${parallelMode}")`);
  const multiAgentMax = integer(env.MULTI_AGENT_MAX_AGENTS, 11, { min: 1, max: 11, name: 'MULTI_AGENT_MAX_AGENTS', errors });
  const fleetPartitions = integer(env.FLEET_PARTITIONS, 1, { min: 1, max: 256, name: 'FLEET_PARTITIONS', errors });
  const fleetPartition = text(env.FLEET_PARTITION)
    ? integer(env.FLEET_PARTITION, 0, { min: 0, max: 255, name: 'FLEET_PARTITION', errors })
    : null;

  // PostgreSQL is the only datastore. Object content lives in it too, so
  // there is no filesystem state to back up, mount, or keep in sync.
  const databaseUrl = text(env.DATABASE_URL);
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required (postgres://user:password@host:5432/database)');
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a postgres:// or postgresql:// connection string');
  }

  // The system runs on its own PostgreSQL server. `disable` suits a database
  // on the same host or a private network; `require` encrypts without
  // verifying the server certificate; `verify` checks it against the CA
  // bundle in PGSSLROOTCERT (the production default).
  const sslMode = text(env.PGSSLMODE).toLowerCase() || (production ? 'verify' : 'disable');
  if (!['disable', 'require', 'verify'].includes(sslMode)) {
    errors.push(`PGSSLMODE must be disable, require or verify (got "${sslMode}")`);
  }
  // Unencrypted is only acceptable when the traffic never leaves the machine:
  // across any network, rows (and the password) would travel in the clear.
  if (production && sslMode === 'disable' && databaseUrl) {
    let host = '';
    try { host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, ''); } catch { /* reported above */ }
    const local = !host || ['localhost', '127.0.0.1', '::1'].includes(host) || host.startsWith('/');
    if (!local) errors.push('PGSSLMODE=disable is only allowed in production for a database on this machine; use require or verify');
  }
  // Report it with every other problem at boot, not later when the pool opens.
  if (sslMode === 'verify' && !text(env.PGSSLROOTCERT)) {
    errors.push('PGSSLMODE=verify requires PGSSLROOTCERT to point at a CA bundle');
  }

  const vertexProject = text(env.GOOGLE_CLOUD_PROJECT);
  const vertexLocation = text(env.GOOGLE_CLOUD_LOCATION) || 'global';
  const vertexAccessToken = text(env.VERTEX_ACCESS_TOKEN);
  const vertexModel = text(env.VERTEX_MODEL || env.AI_MODEL) || DEFAULT_MODEL;
  if (vertexProject && !isGeminiModel(vertexModel)) {
    errors.push('VERTEX_MODEL must be a supported Gemini model');
  }
  const providerSetting = text(env.AI_PROVIDER).toLowerCase();
  if (providerSetting && providerSetting !== 'google') {
    errors.push('AI_PROVIDER must be google when set');
  }
  if (providerSetting && !vertexProject) {
    errors.push('GOOGLE_CLOUD_PROJECT is required when AI_PROVIDER is set');
  }
  const primary = vertexProject && isGeminiModel(vertexModel)
    ? {
        provider: 'google',
        project: vertexProject,
        location: vertexLocation,
        accessToken: vertexAccessToken || null,
        model: vertexModel,
        modelId: normalizeModelId(vertexModel)
      }
    : null;
  if (production && !primary) {
    errors.push('Google Vertex AI Gemini must be configured in production with GOOGLE_CLOUD_PROJECT');
  }

  // How deeply Gemini reasons. xhigh remains accepted as a compatibility alias
  // and is clamped to Vertex HIGH by the runtime.
  const aiEffort = text(env.AI_EFFORT).toLowerCase();
  if (aiEffort && !AI_EFFORT_LEVELS.includes(aiEffort)) {
    errors.push(`AI_EFFORT must be one of ${AI_EFFORT_LEVELS.join(', ')} (got "${aiEffort}")`);
  }

  const logLevel = text(env.LOG_LEVEL).toLowerCase() || (production ? 'info' : 'debug');
  if (!LOG_LEVELS.includes(logLevel)) {
    errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${logLevel}")`);
  }

  // Sessions ride on a cookie. Serving that cookie without Secure in
  // production hands it to anyone on the network, so it is on by default and
  // turning it off is a deliberate, logged act.
  const cookieSecure = boolean(env.COOKIE_SECURE, production);
  if (production && !cookieSecure) {
    errors.push('COOKIE_SECURE=false in production would send session cookies over plain HTTP');
  }

  let objectEncryptionKey = null;
  try {
    objectEncryptionKey = parseBase64Key(env.OBJECT_ENCRYPTION_KEY);
  } catch (error) {
    errors.push(error.message);
  }
  if (production && !objectEncryptionKey) {
    errors.push('OBJECT_ENCRYPTION_KEY is required in production and must decode to 32 bytes');
  }

  let billingEncryptionKey = null;
  try {
    billingEncryptionKey = parseBase64Key(env.BILLING_ENCRYPTION_KEY);
  } catch (error) {
    errors.push(error.message.replace('OBJECT_ENCRYPTION_KEY', 'BILLING_ENCRYPTION_KEY'));
  }
  if (production && !billingEncryptionKey) {
    errors.push('BILLING_ENCRYPTION_KEY is required in production and must decode to 32 bytes');
  }

  let personalDataEncryptionKey = null;
  try {
    personalDataEncryptionKey = parseBase64Key(env.PERSONAL_DATA_ENCRYPTION_KEY);
  } catch (error) {
    errors.push(error.message.replace('OBJECT_ENCRYPTION_KEY', 'PERSONAL_DATA_ENCRYPTION_KEY'));
  }
  if (production && !personalDataEncryptionKey) {
    errors.push('PERSONAL_DATA_ENCRYPTION_KEY is required in production and must decode to 32 bytes');
  }
  if (production && objectEncryptionKey && billingEncryptionKey && objectEncryptionKey.equals(billingEncryptionKey)) {
    errors.push('BILLING_ENCRYPTION_KEY must be different from OBJECT_ENCRYPTION_KEY in production');
  }
  if (production && objectEncryptionKey && personalDataEncryptionKey && objectEncryptionKey.equals(personalDataEncryptionKey)) {
    errors.push('PERSONAL_DATA_ENCRYPTION_KEY must be different from OBJECT_ENCRYPTION_KEY in production');
  }
  if (production && billingEncryptionKey && personalDataEncryptionKey && billingEncryptionKey.equals(personalDataEncryptionKey)) {
    errors.push('PERSONAL_DATA_ENCRYPTION_KEY must be different from BILLING_ENCRYPTION_KEY in production');
  }

  let billingEncryptionKeyPrevious = null;
  try {
    billingEncryptionKeyPrevious = parseBase64Key(env.BILLING_ENCRYPTION_KEY_PREVIOUS);
  } catch (error) {
    errors.push(error.message.replace('OBJECT_ENCRYPTION_KEY', 'BILLING_ENCRYPTION_KEY_PREVIOUS'));
  }
  let personalDataEncryptionKeyPrevious = null;
  try {
    personalDataEncryptionKeyPrevious = parseBase64Key(env.PERSONAL_DATA_ENCRYPTION_KEY_PREVIOUS);
  } catch (error) {
    errors.push(error.message.replace('OBJECT_ENCRYPTION_KEY', 'PERSONAL_DATA_ENCRYPTION_KEY_PREVIOUS'));
  }
  if (production && billingEncryptionKey && billingEncryptionKeyPrevious && billingEncryptionKey.equals(billingEncryptionKeyPrevious)) {
    errors.push('BILLING_ENCRYPTION_KEY_PREVIOUS must be different from BILLING_ENCRYPTION_KEY in production');
  }
  if (production && personalDataEncryptionKey && personalDataEncryptionKeyPrevious && personalDataEncryptionKey.equals(personalDataEncryptionKeyPrevious)) {
    errors.push('PERSONAL_DATA_ENCRYPTION_KEY_PREVIOUS must be different from PERSONAL_DATA_ENCRYPTION_KEY in production');
  }

  const config = {
    nodeEnv,
    production,
    host: text(env.HOST) || '0.0.0.0',
    port: integer(env.PORT, 3000, { min: 0, max: 65535, name: 'PORT', errors }),
    runtimeMode: ['auto', 'local', 'hosted', 'hybrid'].includes(text(env.RUNTIME_MODE).toLowerCase())
      ? text(env.RUNTIME_MODE).toLowerCase()
      : 'auto',
    trustProxy: trustProxySetting(env.TRUST_PROXY, errors),
    // Optional bearer token for scraping /api/metrics without the database.
    metricsToken: (() => {
      const value = text(env.METRICS_TOKEN);
      if (value && value.length < 32) errors.push('METRICS_TOKEN must be at least 32 characters');
      return value || null;
    })(),
    cookieSecure,
    logLevel,
    // Staged release switch. OFF until project/record migrations and UI are
    // verified; when ON, new work must pass the Coding/Research project gate.
    product: {
      codingResearchOnly: boolean(env.CODING_RESEARCH_ONLY, false),
      // KG Code ships coding-only by default. Operators can set KG_CODING_ONLY=false for emergency rollback.
      codingOnly: boolean(env.KG_CODING_ONLY, true)
    },

    security: {
      objectEncryptionKey,
      billingEncryptionKey,
      billingEncryptionKeyPrevious,
      personalDataEncryptionKey,
      personalDataEncryptionKeyPrevious
    },

    database: {
      url: databaseUrl,
      migrationUrl: text(env.DATABASE_MIGRATION_URL) || null,
      backupUrl: text(env.BACKUP_DATABASE_URL) || null,
      restoreUrl: text(env.RESTORE_DATABASE_URL) || null,
      sslMode,
      caCertPath: text(env.PGSSLROOTCERT) || null,
      // Postgres has a hard `max_connections`. Sizing the pool per instance
      // above (max_connections / instances) is how a deploy takes itself down.
      poolMax: integer(env.PG_POOL_MAX, 10, { min: 1, max: 500, name: 'PG_POOL_MAX', errors }),
      poolMin: integer(env.PG_POOL_MIN, 0, { min: 0, max: 500, name: 'PG_POOL_MIN', errors }),
      idleTimeoutMs: integer(env.PG_IDLE_TIMEOUT_MS, 30_000, { name: 'PG_IDLE_TIMEOUT_MS', errors }),
      connectionTimeoutMs: integer(env.PG_CONNECT_TIMEOUT_MS, 10_000, { name: 'PG_CONNECT_TIMEOUT_MS', errors }),
      // A query that runs longer than this is killed by the server, so one
      // pathological statement cannot pin a pool connection indefinitely.
      statementTimeoutMs: integer(env.PG_STATEMENT_TIMEOUT_MS, 15_000, { name: 'PG_STATEMENT_TIMEOUT_MS', errors })
    },

    ai: primary
      ? {
          provider: 'google',
          project: primary.project,
          location: primary.location || 'global',
          accessToken: primary.accessToken || null,
          model: primary.model || DEFAULT_MODEL,
          modelId: primary.modelId || normalizeModelId(DEFAULT_MODEL),
          models: [LIGHT_MODEL, DEFAULT_MODEL],
          fallbackModels: [LIGHT_MODEL],
          autoDiscover: false,
          effort: AI_EFFORT_LEVELS.includes(aiEffort) ? aiEffort : null
        }
      : null,

    runners: {
      // Kindgleam's own sealed sandbox for running code (bin/sandbox-runner.js).
      sandbox: httpUrl(env.SANDBOX_RUNNER_URL, { name: 'SANDBOX_RUNNER_URL', errors }),
      // Generic tool boundary for discovered/research/adaptive capabilities.
      tools: httpUrl(env.TOOL_RUNNER_URL, { name: 'TOOL_RUNNER_URL', errors }),
      sandboxToken: text(env.SANDBOX_RUNNER_TOKEN) || (production ? null : text(env.RUNNER_TOKEN) || null),
      toolToken: text(env.TOOL_RUNNER_TOKEN) || (production ? null : text(env.RUNNER_TOKEN) || null)
    },

    terminal: {
      // Interactive terminal is opt-in in production. A deployment must
      // explicitly enable it and provide the hardened runtime/image contract.
      enabled: boolean(env.TERMINAL_ENABLED, !production),
      runtime: text(env.TERMINAL_RUNTIME) || null,
      maxSessionsPerPrincipal: integer(env.TERMINAL_MAX_SESSIONS_PER_PRINCIPAL, 2, { min: 1, max: 8, name: 'TERMINAL_MAX_SESSIONS_PER_PRINCIPAL', errors }),
      maxSessionsPerWorkspace: integer(env.TERMINAL_MAX_SESSIONS_PER_WORKSPACE, 4, { min: 1, max: 16, name: 'TERMINAL_MAX_SESSIONS_PER_WORKSPACE', errors }),
      idleMs: integer(env.TERMINAL_IDLE_MS, 10 * 60_000, { min: 60_000, max: 60 * 60_000, name: 'TERMINAL_IDLE_MS', errors }),
      lifetimeMs: integer(env.TERMINAL_LIFETIME_MS, 30 * 60_000, { min: 5 * 60_000, max: 4 * 60 * 60_000, name: 'TERMINAL_LIFETIME_MS', errors }),
      maxOutputBytes: integer(env.TERMINAL_MAX_OUTPUT_BYTES, 8 * 1024 * 1024, { min: 64 * 1024, max: 64 * 1024 * 1024, name: 'TERMINAL_MAX_OUTPUT_BYTES', errors }),
      maxInputBytesPerSecond: integer(env.TERMINAL_MAX_INPUT_BYTES_PER_SECOND, 128 * 1024, { min: 8 * 1024, max: 4 * 1024 * 1024, name: 'TERMINAL_MAX_INPUT_BYTES_PER_SECOND', errors }),
      images: parseJsonObject(env.TERMINAL_IMAGES_JSON, 'TERMINAL_IMAGES_JSON', errors, {
        node: 'node:22-slim',
        python: 'python:3.12-slim',
        go: 'golang:1.23-alpine',
        rust: 'rust:1-alpine',
        java: 'eclipse-temurin:21-jdk-alpine',
        gcc: 'gcc:14'
      })
    },
    execution: {
      // Browser-to-loopback/local-agent bridge. It is opt-in; no local service
      // is contacted unless this URL is explicitly configured by the deployment.
      localAgentUrl: httpUrl(env.LOCAL_AGENT_URL, { name: 'LOCAL_AGENT_URL', errors }),
      // Deployment declaration only; this is not cryptographic attestation.
      localAgentIsolation: ['none', 'container', 'vm'].includes(text(env.LOCAL_AGENT_ISOLATION).toLowerCase())
        ? text(env.LOCAL_AGENT_ISOLATION).toLowerCase()
        : 'none',
      // Shared only by Kindgleam and the paired local agent. It is never
      // sent to the browser; the agent uses it to authenticate execution receipts.
      localAgentSharedSecret: text(env.LOCAL_AGENT_SHARED_SECRET) || null,
    },

    agents: {
      // Independent second review of verified work (src/agents.js).
      // auto = only complex, high-stakes, code or retried work; always; off.
      review: reviewMode,
      // Advisory specialist panel (src/multi-agent.js).
      // auto = expands only for material complexity/uncertainty; always; off.
      multiAgent: multiAgentMode,
      parallel: parallelMode,
      maxAgents: multiAgentMax
    },

    tools: {
      // The AI may read public web pages through the SSRF-guarded fetcher.
      webAccess: text(env.TOOLS_WEB_ACCESS).toLowerCase() !== 'false',
      // Optional external Model Context Protocol servers. MCP remains shared
      // tool infrastructure; it never creates another workspace.
      mcp: {
        servers: parseMcpServers(env.MCP_SERVERS_JSON, errors, { production })
      }
    },

    providerConcurrency: {
      max: integer(env.AI_MAX_CONCURRENCY, production ? 4 : 6, { min: 1, max: 16, name: 'AI_MAX_CONCURRENCY', errors }),
      min: integer(env.AI_MIN_CONCURRENCY, 1, { min: 1, max: 16, name: 'AI_MIN_CONCURRENCY', errors }),
      queueTimeoutMs: integer(env.AI_CONCURRENCY_QUEUE_TIMEOUT_MS, 5_000, { min: 100, max: 60_000, name: 'AI_CONCURRENCY_QUEUE_TIMEOUT_MS', errors })
    },

    fleet: {
      batchSize: integer(env.FLEET_BATCH_SIZE, 8, { min: 1, max: 32, name: 'FLEET_BATCH_SIZE', errors }),
      maxConcurrency: integer(env.FLEET_MAX_CONCURRENCY, 4, { min: 1, max: 16, name: 'FLEET_MAX_CONCURRENCY', errors }),
      partition: fleetPartition,
      partitions: fleetPartitions
    },

    usage: {
      // AI tokens per person in a rolling 4-hour window and a rolling week.
      // 0 means no limit. The context size overrides the provider's usual one.
      fourHourTokens: integer(env.USAGE_LIMIT_4H_TOKENS, 0, { min: 0, max: 1e12, name: 'USAGE_LIMIT_4H_TOKENS', errors }),
      weeklyTokens: integer(env.USAGE_LIMIT_WEEKLY_TOKENS, 0, { min: 0, max: 1e13, name: 'USAGE_LIMIT_WEEKLY_TOKENS', errors }),
      contextWindowTokens: integer(env.AI_CONTEXT_WINDOW_TOKENS, 0, { min: 0, max: 1e8, name: 'AI_CONTEXT_WINDOW_TOKENS', errors })
    },

    policy: {
      // Topics this service does not discuss at all, for everyone
      // (docs/USAGE_POLICY.md). "none" offers every topic.
      blockedTopics: (text(env.BLOCKED_TOPICS) || 'religion').toLowerCase() === 'none'
        ? []
        : [...new Set((text(env.BLOCKED_TOPICS) || 'religion').toLowerCase().split(',').map(item => item.trim()).filter(Boolean))]
    },

    terms: {
      // People confirm their age and accept the terms and usage policy once
      // per version before they start. A new version asks again.
      version: text(env.TERMS_VERSION) || '2026-09',
      minimumAge: integer(env.MINIMUM_AGE, 16, { min: 13, max: 21, name: 'MINIMUM_AGE', errors }),
      required: text(env.TERMS_REQUIRED).toLowerCase() !== 'false'
    },

    billing: {
      // Shown in Settings → Billing. Payment methods and invoices live with
      // the payment provider; its customer portal is linked, never embedded.
      planName: text(env.BILLING_PLAN_NAME) || null,
      portalUrl: httpUrl(env.BILLING_PORTAL_URL, { name: 'BILLING_PORTAL_URL', errors }),
      supportEmail: text(env.BILLING_SUPPORT_EMAIL) || null,
      // Everyone without a subscription is on the free plan.
      free: {
        name: text(env.BILLING_FREE_NAME) || 'Free',
        description: text(env.BILLING_FREE_DESCRIPTION) || 'To try Kindgleam.',
        features: text(env.BILLING_FREE_FEATURES).split('|').map(text).filter(Boolean).slice(0, 8)
      }
    },

    // Where this deployment is reached; Stripe returns people here, and
    // sign-in links point here.
    publicUrl: httpUrl(env.PUBLIC_URL, { name: 'PUBLIC_URL', errors })?.replace(/\/$/, '') ?? null,

    // Anyone with an email address may create an account by signing in.
    // ALLOW_SIGNUP=false limits email sign-in to people who already have one.
    signUp: text(env.ALLOW_SIGNUP).toLowerCase() !== 'false',

    stripe: text(env.STRIPE_SECRET_KEY) ? {
      secretKey: text(env.STRIPE_SECRET_KEY),
      webhookSecret: text(env.STRIPE_WEBHOOK_SECRET) || null,
      apiBase: 'https://api.stripe.com',
      plans: stripePlans(env.STRIPE_PLANS, errors)
    } : null,

    limits: {
      // Request body cap. Object content arrives base64-encoded, so this sits
      // above objectBytes with room for the ~33% encoding overhead.
      requestBytes: integer(env.MAX_REQUEST_BYTES, 8 * 1024 * 1024, { name: 'MAX_REQUEST_BYTES', errors }),
      objectBytes: integer(env.MAX_OBJECT_BYTES, 5 * 1024 * 1024, { name: 'MAX_OBJECT_BYTES', errors }),
      workspaceBytes: integer(env.WORKSPACE_MAX_BYTES, 1024 * 1024 * 1024, { name: 'WORKSPACE_MAX_BYTES', errors }),
      workspaceObjects: integer(env.WORKSPACE_MAX_OBJECTS, 10_000, { name: 'WORKSPACE_MAX_OBJECTS', errors }),
      // Bound what a runner or provider can stream back at us.
      responseBytes: integer(env.MAX_RESPONSE_BYTES, 4 * 1024 * 1024, { name: 'MAX_RESPONSE_BYTES', errors }),
      rateWindowMs: integer(env.RATE_WINDOW_MS, 60_000, { name: 'RATE_WINDOW_MS', errors }),
      rateStore: ['memory', 'postgres'].includes(text(env.RATE_LIMIT_STORE).toLowerCase())
        ? text(env.RATE_LIMIT_STORE).toLowerCase()
        : (production ? 'postgres' : 'memory'),
      rateMax: integer(env.RATE_MAX, 300, { name: 'RATE_MAX', errors }),
      // How many times a run may replan before it is declared exhausted.
      // Without this, `iterate` is an unbounded loop.
      runAttempts: integer(env.MAX_RUN_ATTEMPTS, 5, { min: 1, max: 100, name: 'MAX_RUN_ATTEMPTS', errors }),
      sessionHours: integer(env.SESSION_HOURS, 12, { min: 1, max: 720, name: 'SESSION_HOURS', errors }),
      requestTimeoutMs: integer(env.REQUEST_TIMEOUT_MS, 120_000, { name: 'REQUEST_TIMEOUT_MS', errors }),
      // After SIGTERM, how long /api/ready reports 503 while the server still
      // serves, so a load balancer stops routing here before it closes.
      shutdownDrainMs: integer(env.SHUTDOWN_DRAIN_MS, 0, { min: 0, max: 60_000, name: 'SHUTDOWN_DRAIN_MS', errors }),
      goalChars: integer(env.MAX_GOAL_CHARS, 32_000, { min: 256, max: 1_000_000, name: 'MAX_GOAL_CHARS', errors }),
      evidenceBytes: integer(env.MAX_EVIDENCE_BYTES, 512 * 1024, { min: 1_024, max: 8 * 1024 * 1024, name: 'MAX_EVIDENCE_BYTES', errors }),
      provenanceBytes: integer(env.MAX_PROVENANCE_BYTES, 64 * 1024, { min: 1_024, max: 1 * 1024 * 1024, name: 'MAX_PROVENANCE_BYTES', errors }),
      fieldChars: integer(env.MAX_FIELD_CHARS, 512, { min: 32, max: 10_000, name: 'MAX_FIELD_CHARS', errors })
    }
  };

  if (config.execution.localAgentUrl && !config.execution.localAgentSharedSecret) {
    errors.push('LOCAL_AGENT_SHARED_SECRET is required when LOCAL_AGENT_URL is configured');
  } else if (config.execution.localAgentSharedSecret && config.execution.localAgentSharedSecret.length < 32) {
    errors.push('LOCAL_AGENT_SHARED_SECRET must be at least 32 characters when set');
  }

  if (production && config.execution.localAgentUrl && config.execution.localAgentIsolation === 'none') {
    errors.push('LOCAL_AGENT_ISOLATION must be container or vm when LOCAL_AGENT_URL is configured in production');
  }

  if (config.providerConcurrency.min > config.providerConcurrency.max) {
    errors.push('AI_MIN_CONCURRENCY cannot exceed AI_MAX_CONCURRENCY');
  }

  if (config.fleet.partition !== null && config.fleet.partition >= config.fleet.partitions) {
    errors.push('FLEET_PARTITION must be lower than FLEET_PARTITIONS');
  }

  if (production && !config.database.backupUrl) {
    errors.push('BACKUP_DATABASE_URL is required in production for a dedicated read-only backup identity');
  }
  if (production && !config.database.restoreUrl) {
    errors.push('RESTORE_DATABASE_URL is required in production for a dedicated restore identity');
  }
  if (production && config.database.backupUrl) {
    const runtimeUser = databaseUsername(config.database.url);
    const backupUser = databaseUsername(config.database.backupUrl);
    if (runtimeUser && backupUser && runtimeUser === backupUser) {
      errors.push('BACKUP_DATABASE_URL must use a different PostgreSQL username from DATABASE_URL');
    }
  }
  if (production && config.database.restoreUrl) {
    const runtimeUser = databaseUsername(config.database.url);
    const restoreUser = databaseUsername(config.database.restoreUrl);
    if (runtimeUser && restoreUser && runtimeUser === restoreUser) {
      errors.push('RESTORE_DATABASE_URL must use a different PostgreSQL username from DATABASE_URL');
    }
  }
  if (production && config.database.backupUrl && config.database.restoreUrl) {
    const backupUser = databaseUsername(config.database.backupUrl);
    const restoreUser = databaseUsername(config.database.restoreUrl);
    if (backupUser && restoreUser && backupUser === restoreUser) {
      errors.push('BACKUP_DATABASE_URL and RESTORE_DATABASE_URL must use different PostgreSQL usernames');
    }
  }

  if (production && config.database.migrationUrl && config.database.backupUrl) {
    const migrationUser = databaseUsername(config.database.migrationUrl);
    const backupUser = databaseUsername(config.database.backupUrl);
    if (migrationUser && backupUser && migrationUser === backupUser) {
      errors.push('BACKUP_DATABASE_URL must use a different PostgreSQL username from DATABASE_MIGRATION_URL');
    }
  }
  if (production && config.database.migrationUrl && config.database.restoreUrl) {
    const migrationUser = databaseUsername(config.database.migrationUrl);
    const restoreUser = databaseUsername(config.database.restoreUrl);
    if (migrationUser && restoreUser && migrationUser === restoreUser) {
      errors.push('RESTORE_DATABASE_URL must use a different PostgreSQL username from DATABASE_MIGRATION_URL');
    }
  }

  if (production && config.database.backupUrl === config.database.url) {
    errors.push('BACKUP_DATABASE_URL must not reuse the runtime DATABASE_URL');
  }
  if (production && config.database.restoreUrl === config.database.url) {
    errors.push('RESTORE_DATABASE_URL must not reuse the runtime DATABASE_URL');
  }
  if (production && config.database.backupUrl && config.database.restoreUrl && config.database.backupUrl === config.database.restoreUrl) {
    errors.push('BACKUP_DATABASE_URL and RESTORE_DATABASE_URL must use separate database identities');
  }

  if (production && !config.database.migrationUrl) {
    errors.push('DATABASE_MIGRATION_URL is required in production so the runtime database role does not need DDL privileges');
  }
  if (production && config.database.migrationUrl === config.database.url) {
    errors.push('DATABASE_MIGRATION_URL must use a separate privileged database identity from DATABASE_URL in production');
  }
  if (production && config.database.migrationUrl) {
    const runtimeUser = databaseUsername(config.database.url);
    const migrationUser = databaseUsername(config.database.migrationUrl);
    if (!runtimeUser || !migrationUser) {
      errors.push('DATABASE_URL and DATABASE_MIGRATION_URL must contain explicit PostgreSQL usernames in production');
    } else if (runtimeUser === migrationUser) {
      errors.push('DATABASE_MIGRATION_URL must use a different PostgreSQL username from DATABASE_URL in production');
    }
  }

  if (production && config.limits.rateStore !== 'postgres') {
    errors.push('RATE_LIMIT_STORE must be postgres in production for multi-instance rate limiting');
  }

  if (production && config.terminal.enabled) {
    if (!config.terminal.runtime) errors.push('TERMINAL_RUNTIME must be configured in production');
    else {
      const runtimeName = config.terminal.runtime.split('/').pop();
      if (!['runsc', 'kata-runtime'].includes(runtimeName)) errors.push('TERMINAL_RUNTIME must be runsc or kata-runtime in production');
    }
    for (const [name, image] of Object.entries(config.terminal.images ?? {})) {
      if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/i.test(String(image ?? '').trim())) {
        errors.push('TERMINAL_IMAGES_JSON.' + name + ' must use an immutable @sha256 image reference in production');
      }
    }
  }
  if (production && config.runners.sandbox && (!config.runners.sandboxToken || config.runners.sandboxToken.length < 32)) {
    errors.push('SANDBOX_RUNNER_TOKEN must be at least 32 characters in production when the sandbox runner is configured');
  }
  if (production && config.runners.tools && (!config.runners.toolToken || config.runners.toolToken.length < 32)) {
    errors.push('TOOL_RUNNER_TOKEN must be at least 32 characters in production when the tool runner is configured');
  }
  if (production && config.runners.sandbox && config.runners.tools
      && config.runners.sandboxToken && config.runners.toolToken
      && config.runners.sandboxToken === config.runners.toolToken) {
    errors.push('SANDBOX_RUNNER_TOKEN and TOOL_RUNNER_TOKEN must be different in production');
  }

  if (
    production
    && [config.runners.tools, config.runners.sandbox]
      .filter(Boolean)
      .some(url => !url.startsWith('https://'))
  ) {
    errors.push('Managed runner URLs must use HTTPS in production because runner tokens and user/workspace data cross that boundary');
  }

  if (config.stripe) {
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(config.stripe.secretKey)) errors.push('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_… or rk_…)');
    if (!config.stripe.webhookSecret || !config.stripe.webhookSecret.startsWith('whsec_')) errors.push('STRIPE_WEBHOOK_SECRET (whsec_…) is required with STRIPE_SECRET_KEY: subscriptions are only trusted from signed webhooks');
    if (!config.publicUrl) errors.push('PUBLIC_URL is required with STRIPE_SECRET_KEY, so Stripe can send people back to this site');
    if (!config.stripe.plans.length) errors.push('STRIPE_PLANS must list at least one plan with STRIPE_SECRET_KEY');
    if (production && config.stripe.secretKey.includes('_test_')) errors.push('STRIPE_SECRET_KEY is a test key; use a live key in production');
  }
  if (production && config.publicUrl && !config.publicUrl.startsWith('https://')) errors.push('PUBLIC_URL must use HTTPS in production');
  if (production && config.billing.portalUrl && !config.billing.portalUrl.startsWith('https://')) {
    errors.push('BILLING_PORTAL_URL must use HTTPS in production');
  }
  if (config.billing.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.billing.supportEmail)) {
    errors.push('BILLING_SUPPORT_EMAIL must be an email address');
  }


  if (production) {
    for (const [name, url] of Object.entries(config.runners)) {
      if (name === 'token' || !url) continue;
      try {
        if (new URL(url).protocol !== 'https:') {
          errors.push(`${name} runner URL must use HTTPS in production`);
        }
      } catch {
        // URL parsing is already handled by httpUrl above.
      }
    }
  }

  if (production && config.execution.localAgentUrl && !config.execution.localAgentSharedSecret) {
    errors.push('Local execution pairing must have a shared secret in production');
  }

  if (config.limits.objectBytes >= config.limits.requestBytes) {
    errors.push('MAX_OBJECT_BYTES must be smaller than MAX_REQUEST_BYTES to leave room for base64 overhead');
  }

  if (errors.length) {
    const error = new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
    error.code = 'ECONFIG';
    throw error;
  }

  return Object.freeze(config);
}

export { PROVIDERS };
