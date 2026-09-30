/**
 * HTTP composition root.
 *
 * Security headers, request lifecycle, authentication, workspace scope and
 * admission control live here; each resource's routes live in src/routes,
 * shared request helpers in src/http. Planning lives in core.js, workflow
 * state in runs.js, artifacts in objects.js, outbound calls in runtime.js.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { installIngressBoundary, installBrowserBoundary, securityProfile } from './security-boundary.js';
import { CONTRACT } from './core.js';
import { ADAPTIVE_CONTRACT_VERSION, ADAPTATION_INVARIANT } from './adaptive-contract.js';
import { AuthError } from './identity.js';
import { runDbScope, currentDbScope } from './db.js';
import { text, parseCookies, SESSION_COOKIE, sessionCookieName, CSRF_HEADER, LEGACY_CSRF_HEADERS } from './http/context.js';
import { rateLimiter } from './http/rate-limit.js';
import { createWorkspaceIdempotency as createIdempotency } from './http/workspace-idempotency.js';
import { errorHandler } from './http/errors.js';
import { registerPlatformRoutes } from './routes/platform.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerRunsRoutes } from './routes/runs.js';
import { registerExecutionRoutes } from './routes/execution.js';
import { registerObjectsRoutes } from './routes/objects.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerSignInRoutes, registerMailAdminRoutes } from './routes/sign-in.js';
import { Mailer } from './mailer.js';
import { MemoryStore } from './memory.js';
import { registerStripeWebhook, registerStripeRoutes, STRIPE_WEBHOOK_PATH } from './routes/stripe.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const VERSION = '10.4.0';

export function createApp({ config, pool, identity, governance, capabilities, objects, runs, jobs = null, scheduler = null, audit, logger, metrics, fetchImpl = fetch }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // Connection-pool pressure for alerting: waiting > 0 means requests are
  // queueing for a database connection.
  // Counters alerted on with increase() exist from the start at 0, so the
  // first failure is a change Prometheus can see.
  metrics.increment('readiness_failures_total', {}, 0);
  metrics.increment('rate_limit_store_errors_total', {}, 0);
  metrics.gauge('db_pool_connections', () => [
    { tags: { state: 'total' }, value: pool.totalCount },
    { tags: { state: 'idle' }, value: pool.idleCount },
    { tags: { state: 'waiting' }, value: pool.waitingCount }
  ]);
  installIngressBoundary(app, { trustProxy: config.trustProxy });
  installBrowserBoundary(app, { production: config.production });
  app.set('etag', false);

  const connectSrc = ["'self'"];
  if (config.execution.localAgentUrl) {
    connectSrc.push(new URL(config.execution.localAgentUrl).origin);
  }

  app.use(helmet({
    // A strict policy is possible because the page carries no inline script
    // or style; everything is served from its own origin.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': connectSrc,
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' },
    // Never framed, by any site: clickjacking protection for older browsers
    // that read X-Frame-Options rather than frame-ancestors.
    frameguard: { action: 'deny' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    hsts: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false
  }));

  // Reject compressed API request bodies. The service has strict byte limits
  // but must not inflate attacker-controlled compressed payloads before the
  // limit is enforced.
  app.use((req, res, next) => {
    const encoding = text(req.get('content-encoding')).toLowerCase();
    if (encoding && encoding !== 'identity') {
      return res.status(415).json({ error: 'Compressed request bodies are not accepted', code: 'content-encoding-not-supported' });
    }
    next();
  });

  // Stripe signs the raw request body, so its webhook reads the body itself.
  // Keys that could reach an object's prototype are dropped from every body
  // at parse time, so no merge anywhere can be steered into prototype
  // pollution by a crafted request.
  const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const json = express.json({
    limit: config.limits.requestBytes,
    inflate: false,
    reviver: (key, value) => (PROTO_KEYS.has(key) ? undefined : value)
  });
  app.use((req, res, next) => (req.path === STRIPE_WEBHOOK_PATH ? next() : json(req, res, next)));
  // API responses may contain private user/workspace data. Never allow
  // browsers or shared proxies to cache them.
  app.use('/api', (_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  /* ------------------------------------------------- request lifecycle */

  app.use((req, res, next) => {
    // Honour an upstream trace id when we trust the proxy that set it.
    req.requestId = req.requestId || (config.trustProxy && text(req.get('x-request-id'))) || crypto.randomUUID();
    req.startedAt = process.hrtime.bigint();
    req.log = logger.child({ requestId: req.requestId });
    res.set('x-request-id', req.requestId);

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
      // Tag by the route pattern, never the raw path: ids would explode the
      // metric's cardinality.
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'other';
      metrics.increment('http_requests_total', { method: req.method, status: res.statusCode });
      metrics.observe('http_request_duration_ms', { route }, ms);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level]('request', {
        method: req.method, path: req.path, status: res.statusCode,
        ms: Math.round(ms), principal: req.principal?.id ?? null
      });
    });
    next();
  });

  const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const sessionCookie = sessionCookieName(config);

  /* ------------------------------------------------------------ public */

  // Liveness: is the process up? Deliberately touches nothing else, so a
  // database blip cannot make an orchestrator kill healthy processes.
  app.get('/api/health', (_req, res) => res.json({
    ok: true,
    version: VERSION,
    contract: CONTRACT,
    uptimeSeconds: Math.round(process.uptime())
  }));

  // Readiness: can it actually serve? This one does touch the database.
  app.get('/api/ready', route(async (_req, res) => {
    // Shutting down: still serving, but no longer taking new traffic.
    if (app.locals.draining) return res.status(503).json({ ok: false, draining: true });
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      logger.error('readiness probe failed', { error });
      metrics.increment('readiness_failures_total');
      return res.status(503).json({ ok: false, database: 'unavailable' });
    }
    // Booleans only: readiness says what is wired, never where or with what.
    res.json({
      ok: true,
      database: 'ready',
      reasoning: config.ai ? { configured: true, provider: config.ai.provider } : { configured: false },
      runners: {
        tools: Boolean(config.runners.tools),
        sandbox: Boolean(config.runners.sandbox),
        localAgent: Boolean(config.execution.localAgentUrl && config.execution.localAgentSharedSecret)
      }
    });
  }));

  // Stripe authenticates with its signature, not a session or API key.
  registerStripeWebhook(app, { config, pool, audit, logger, metrics, fetchImpl, route });

  /**
   * Start a browser session for a signed-in principal: an httpOnly cookie the
   * page's script can never read. Shared by key and email sign-in.
   */
  async function startBrowserSession(res, principal, req) {
    const { secret, expiresAt } = await identity.startSession(principal.id, { keyId: principal.keyId ?? null });
    res.append('set-cookie', [
      `${sessionCookie}=${encodeURIComponent(secret)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      config.cookieSecure ? 'Secure' : '',
      `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`
    ].filter(Boolean).join('; '));
    await audit.record({
      principalId: principal.id, action: 'session.start', outcome: 'allowed',
      detail: { via: principal.via }, requestId: req.requestId, ip: req.ip
    });
    return { expiresAt };
  }

  // Exchange an API key for a session cookie. The key never touches the
  // browser's storage, and the cookie is unreadable to script.
  app.post('/api/session', rateLimiter({ name: 'session', windowMs: 60_000, max: 10, metrics, pool, store: config.limits.rateStore }), route(async (req, res) => {
    const principal = await identity.principalFromKey(req.body?.apiKey);
    return runDbScope({
      principalId: principal.id,
      workspaceId: '',
      organizationId: '',
      jurisdiction: '',
      role: ''
    }, async () => {
      const { expiresAt } = await startBrowserSession(res, principal, req);
      res.json({ principal: { id: principal.id, name: principal.name, kind: principal.kind }, expiresAt });
    });
  }));

  // Email sign-in: a one-time link instead of a key.
  const mailer = new Mailer({ pool, config, logger });
  app.locals.mailer = mailer;
  registerSignInRoutes(app, { config, identity, mailer, audit, metrics, pool, route, startBrowserSession });

  // Public by design: expose the adaptive contract, never user data or secrets.
  app.get('/api/adaptive-contract', (_req, res) => res.json({
    contract: CONTRACT,
    version: ADAPTIVE_CONTRACT_VERSION,
    invariant: ADAPTATION_INVARIANT,
    openWorld: true,
    executionTruth: 'Execution is reported only when a configured runner/tool returns evidence.'
  }));

  app.get('/api/security/profile', (_req, res) => res.json(securityProfile()));

  // Monitoring reads metrics with METRICS_TOKEN, checked in memory, so the
  // alerts that report a database outage can still fire during one. Any
  // other caller falls through to normal authentication below.
  app.get('/api/metrics', (req, res, next) => {
    const given = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!config.metricsToken || !given) return next();
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (!crypto.timingSafeEqual(digest(given), digest(config.metricsToken))) return next();
    res.set('content-type', 'text/plain; version=0.0.4');
    res.send(metrics.render());
  });

  /* ---------------------------------------------------- authentication */

  app.use('/api', route(async (req, res, next) => {
    // /api/health, /api/ready, /api/session and /api/sign-in/* are declared above this
    // middleware, so they never reach it.
    const header = text(req.get('authorization'));
    const cookies = parseCookies(req.get('cookie'));

    if (header) {
      if (!/^Bearer\s+/i.test(header)) throw new AuthError('Authorization must be "Bearer <api key>"');
      req.principal = await identity.principalFromKey(header.replace(/^Bearer\s+/i, ''));
    } else if (cookies[sessionCookie]) {
      req.principal = await identity.principalFromSession(cookies[sessionCookie]);
      // SameSite=Strict already blocks the classic cross-site form post; this
      // header additionally requires a caller that could read our own origin.
      if (req.method !== 'GET' && ![CSRF_HEADER, ...LEGACY_CSRF_HEADERS].some(name => text(req.get(name)) === 'web')) {
        throw new AuthError('Missing client header on a cookie-authenticated write', {
          status: 403, code: 'csrf'
        });
      }
    } else {
      throw new AuthError('Authentication required');
    }
    const dbScope = {
      principalId: req.principal.id,
      workspaceId: text(req.get('x-workspace-id')),
      organizationId: '',
      jurisdiction: '',
      role: ''
    };
    req.dbScope = dbScope;
    return runDbScope(dbScope, next);
  }));

  app.use('/api', rateLimiter({
    windowMs: config.limits.rateWindowMs,
    max: config.limits.rateMax,
    metrics,
    pool,
    store: config.limits.rateStore
  }));

  /**
   * Resolve the workspace the caller means and the role they hold in it.
   * Never read from the body alone — the header wins, and membership decides.
   * A plain download link cannot send headers, so a read-only GET may name the
   * workspace in `?workspace=`; membership and role are checked the same way.
   */
  const scoped = (role = 'viewer') => route(async (req, _res, next) => {
    const requested = text(req.get('x-workspace-id')) || (req.method === 'GET' ? text(req.query?.workspace) : '');
    req.scope = await identity.requireAccess(req.principal, requested, role);
    req.scope.principalId = req.principal.id;
    const dbScope = currentDbScope();
    if (dbScope) {
      dbScope.workspaceId = req.scope.workspaceId;
      dbScope.organizationId = req.scope.organizationId || '';
      dbScope.jurisdiction = req.scope.jurisdiction || '';
      dbScope.role = req.scope.role || '';
    }
    next();
  });

  const idempotent = createIdempotency({
    pool,
    route,
    encryptionKey: config.security.personalDataEncryptionKey,
    previousEncryptionKey: config.security.personalDataEncryptionKeyPrevious
  });
  const memories = new MemoryStore(pool, { encryptionKey: config.security.personalDataEncryptionKey });
  const deps = {
    config, pool, identity, governance, capabilities, objects, runs, jobs, scheduler, memories, audit,
    logger, metrics, fetchImpl, route, scoped, idempotent
  };
  registerPlatformRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerMailAdminRoutes(app, { ...deps, mailer });
  registerStripeRoutes(app, deps);
  registerGovernanceRoutes(app, deps);
  registerRunsRoutes(app, deps);
  // The background worker runs queued jobs through the same function.
  app.locals.executeNext = registerExecutionRoutes(app, deps).executeNext;
  registerObjectsRoutes(app, deps);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint', code: 'no-route' }));

  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: res => res.set('cache-control', 'no-cache')
  }));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // Gemini being busy, down or refusing the key is counted for alerting.
  app.use((error, req, res, next) => {
    if (error?.name === 'ModelProviderError') metrics.increment('model_provider_errors_total', { code: error.code });
    next(error);
  });
  app.use(errorHandler);
  return app;
}

export { SESSION_COOKIE, CSRF_HEADER };
