import { parseBase64Key } from './object-crypto.js';
import { DEFAULT_MODEL, isGeminiModel, normalizeModelId } from './model-catalog.js';

/**
 * Configuration: environment in, validated frozen config out.
 *
 * Every setting is read once, here, at boot. Nothing else in the codebase
 * touches process.env. A bad value stops the process with a list of what is
 * wrong rather than surfacing as a confusing failure under load.
 */

const PROVIDERS = ['google'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const AI_EFFORT_LEVELS = ['low', 'medium', 'high'];

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
 * measured Gemini 3.8 Flash costs and the deployment's infrastructure budget.
 * A plan with a contactUrl is sold by your team, not through Checkout: its
 * subscription is created in Stripe with metadata plan_id=<id> (or one of its
 * priceIds). Limits of 0 or missing mean no limit on that plan. The free plan
 * is everyone without a subscription (BILLING_FREE_* and USAGE_LIMIT_*).
 */
function parseAiProviders(raw, errors, { vertexConfigured = false } = {}) {
  if (!text(raw)) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { errors.push('AI_PROVIDERS_JSON must be a JSON object or array'); return []; }
  const items = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([provider, value]) => ({ provider, ...(value ?? {}) }));
  const out = [];
  for (const [index, item] of items.entries()) {
    const provider = text(item?.provider).toLowerCase();
    const apiKey = text(item?.apiKey || item?.key);
    if (!PROVIDERS.includes(provider) || (!apiKey && !(provider === 'google' && vertexConfigured))) {
      errors.push(`AI_PROVIDERS_JSON[${index}] needs the supported google provider and either an API key or Vertex AI credentials`);
      continue;
    }
    const model = text(item?.model) || text(item?.modelId).replace(/^google:/, '') || DEFAULT_MODEL;
    if (!isGeminiModel(model)) {
      errors.push(`AI_PROVIDERS_JSON[${index}].model must be a Gemini model id such as ${DEFAULT_MODEL} (got "${model}")`);
      continue;
    }
    out.push({ provider, apiKey, model, modelId: `google:${model}` });
  }
  return [...new Map(out.map(item => [item.provider, item])).values()];
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
  const multiAgentMax = integer(env.MULTI_AGENT_MAX_AGENTS, 3, { min: 1, max: 3, name: 'MULTI_AGENT_MAX_AGENTS', errors });

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

  const vertexProject = text(env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT || env.VERTEX_AI_PROJECT);
  const vertexLocation = text(env.GOOGLE_CLOUD_LOCATION || env.VERTEX_AI_LOCATION) || 'global';
  const vertexAccessToken = text(env.GOOGLE_VERTEX_ACCESS_TOKEN || env.VERTEX_AI_ACCESS_TOKEN) || null;
  const vertexServiceAccountJson = text(env.GOOGLE_SERVICE_ACCOUNT_JSON) || null;
  const vertexCredentialsPath = text(env.GOOGLE_APPLICATION_CREDENTIALS) || null;
  const vertexConfigured = Boolean(vertexProject);
  const configuredFromJson = parseAiProviders(env.AI_PROVIDERS_JSON, errors, { vertexConfigured });
  const legacyProvider = text(env.AI_PROVIDER).toLowerCase();
  if (legacyProvider && !PROVIDERS.includes(legacyProvider)) {
    errors.push(`AI_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${legacyProvider}")`);
  }
  if (legacyProvider && !text(env.AI_API_KEY)) {
    errors.push('AI_API_KEY is required when AI_PROVIDER is set');
  }
  const legacyModel = text(env.AI_MODEL).toLowerCase() || DEFAULT_MODEL;
  if (legacyProvider && !isGeminiModel(legacyModel)) {
    errors.push(`AI_MODEL must be a Gemini model id such as ${DEFAULT_MODEL} (got "${legacyModel}")`);
  }
  const legacy = legacyProvider && text(env.AI_API_KEY) && isGeminiModel(legacyModel)
    ? [{ provider: legacyProvider, apiKey: text(env.AI_API_KEY), model: legacyModel, modelId: `google:${legacyModel}` }]
    : [];
  const aiProviders = [...configuredFromJson, ...legacy, ...(vertexConfigured && !configuredFromJson.length && !legacy.length ? [{ provider: 'google', apiKey: '', model: legacyModel, modelId: `google:${legacyModel}` }] : [])].reduce((map, item) => map.set(item.provider, item), new Map());
  const providerEntries = [...aiProviders.values()];
  const primary = providerEntries[0] || null;
  if (production && !primary) {
    errors.push('At least one AI provider must be configured in production (AI_PROVIDERS_JSON or legacy AI_PROVIDER/AI_API_KEY)');
  }
  if (production && !providerEntries.some(item => item.provider === 'google')) {
    errors.push('Google must be configured in production for Gemini (AI_PROVIDERS_JSON or AI_PROVIDER/AI_API_KEY)');
  }

  // The Gemini models administrators may choose from in Settings; the
  // default model is always one of them, listed first.
  const offeredModels = text(env.AI_MODELS).toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  for (const model of offeredModels) {
    if (!isGeminiModel(model)) errors.push(`AI_MODELS lists "${model}", which is not a Gemini model id such as ${DEFAULT_MODEL}`);
  }

  // Backup Gemini models, tried in order when the chosen one is out of quota,
  // overloaded or retired (each Gemini model has its own quota).
  const fallbackModels = text(env.AI_FALLBACK_MODELS).toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
  for (const model of fallbackModels) {
    if (!isGeminiModel(model)) errors.push(`AI_FALLBACK_MODELS lists "${model}", which is not a Gemini model id such as ${DEFAULT_MODEL}`);
  }

  // How deeply Gemini reasons. Unset keeps the model's own default.
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

    security: {
      objectEncryptionKey
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
          provider: primary.provider,
          apiKey: primary.apiKey || null,
          model: primary.model || null,
          vertexProject,
          vertexLocation,
          vertexAccessToken,
          vertexServiceAccountJson,
          vertexCredentialsPath,
          modelId: primary.modelId,
          models: [...new Set([primary.model || DEFAULT_MODEL, ...offeredModels.filter(isGeminiModel)])],
          fallbackModels: [...new Set(fallbackModels.filter(isGeminiModel))],
          autoDiscover: boolean(env.AI_AUTO_DISCOVER_MODELS, false),
          effort: AI_EFFORT_LEVELS.includes(aiEffort) ? aiEffort : null,
          providers: Object.fromEntries(providerEntries.map(item => [item.provider, {
            apiKey: item.apiKey, model: item.model || null, modelId: item.modelId
          }]))
        }
      : null,

    runners: {
      // Kindgleam's own sealed sandbox for running code (bin/sandbox-runner.js).
      sandbox: httpUrl(env.SANDBOX_RUNNER_URL, { name: 'SANDBOX_RUNNER_URL', errors }),
      // Generic tool boundary for discovered/research/adaptive capabilities.
      tools: httpUrl(env.TOOL_RUNNER_URL, { name: 'TOOL_RUNNER_URL', errors }),
      token: text(env.RUNNER_TOKEN) || null
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
      maxAgents: multiAgentMax
    },

    tools: {
      // The AI may read public web pages through the SSRF-guarded fetcher.
      webAccess: text(env.TOOLS_WEB_ACCESS).toLowerCase() !== 'false'
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

  if (
    production
    && (config.runners.tools || config.runners.sandbox)
    && (!config.runners.token || config.runners.token.length < 32)
  ) {
    errors.push('RUNNER_TOKEN must be at least 32 characters in production when any managed runner is configured');
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
