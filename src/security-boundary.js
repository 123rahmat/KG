/**
 * PA-ONE-X security boundary for the universal workflow.
 *
 * This module is intentionally small and domain-neutral. It protects ingress,
 * browser state, and request metadata without owning identity, tenancy,
 * governance, execution, or business logic.
 */

import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DISALLOWED_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const BLOCKED_PROXY_HEADERS = new Set([
  'x-forwarded-host',
  'x-forwarded-server',
  'x-real-ip'
]);

function validRequestId(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : null;
}

export function installIngressBoundary(app, { trustProxy = false } = {}) {
  app.use((req, res, next) => {
    // These methods are not part of the application's HTTP contract. In
    // particular, TRACE can reflect credentials and security headers to a
    // caller (cross-site tracing), so leave no route or middleware path that
    // could accidentally enable it later.
    if (DISALLOWED_METHODS.has(req.method)) {
      res.set('allow', 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE');
      return res.status(405).json({ error: 'HTTP method is not allowed', code: 'method-not-allowed' });
    }
    if (trustProxy && req.headers['x-forwarded-host']) {
      return res.status(400).json({ error: 'Invalid request metadata', code: 'invalid-proxy-metadata' });
    }
    for (const header of BLOCKED_PROXY_HEADERS) {
      if (req.headers[header]) {
        return res.status(400).json({ error: 'Invalid request metadata', code: 'invalid-proxy-metadata' });
      }
    }

    const rawUrl = String(req.originalUrl || req.url || '');
    if (/\\0|%00|%2e%2e|%252e%252e|%5c|%255c/i.test(rawUrl)) {
      return res.status(400).json({ error: 'Invalid request path', code: 'invalid-request-path' });
    }

    // A client-controlled correlation id is useful only when it came through
    // a proxy we explicitly trust. Otherwise an attacker can choose log and
    // trace identifiers for other requests. Generate our own value instead.
    const requestId = trustProxy
      ? (validRequestId(req.get('x-request-id')) ?? crypto.randomUUID())
      : crypto.randomUUID();
    req.requestId = requestId;
    res.set('x-request-id', requestId);

    if (
      !SAFE_METHODS.has(req.method)
      && req.path.startsWith('/api/')
      && req.headers['content-type']
    ) {
      const contentType = String(req.headers['content-type']).toLowerCase();
      const allowed = contentType.includes('application/json')
        || contentType.includes('multipart/form-data')
        || contentType.includes('application/x-www-form-urlencoded');
      if (!allowed) {
        return res.status(415).json({
          error: 'Unsupported request format',
          code: 'unsupported-content-type'
        });
      }
    }

    next();
  });
}

/**
 * Apply browser-only request signals as a second CSRF boundary. Fetch
 * Metadata headers are not authentication (a client can forge them), but a
 * real browser supplies them and they let us reject cross-site state changes
 * before parsing a body or consulting credentials. Cookie CSRF validation in
 * app.js remains the authority when a session is used.
 */
export function installApiRequestBoundary(app, { exemptPaths = [] } = {}) {
  const exempt = new Set(exemptPaths);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || SAFE_METHODS.has(req.method) || exempt.has(req.path)) return next();
    const site = String(req.get('sec-fetch-site') ?? '').trim().toLowerCase();
    if (site === 'cross-site') {
      return res.status(403).json({
        error: 'Cross-site state-changing requests are not allowed',
        code: 'cross-site-request'
      });
    }
    next();
  });
}

export function installBrowserBoundary(app, { production = false } = {}) {
  app.use((req, res, next) => {
    res.set('x-content-type-options', 'nosniff');
    res.set('x-frame-options', 'DENY');
    res.set('referrer-policy', 'no-referrer');
    // The application does not need hardware, payment, or embedded-document
    // permissions. An empty allowlist prevents a future UI regression or a
    // compromised same-origin asset from silently acquiring those powers.
    res.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()');
    res.set('cross-origin-opener-policy', 'same-origin');
    res.set('cross-origin-resource-policy', 'same-origin');
    res.set('x-dns-prefetch-control', 'off');
    res.set('x-permitted-cross-domain-policies', 'none');
    if (req.path.startsWith('/api/')) res.set('cache-control', 'no-store');
    if (production) res.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    next();
  });
}

export function securityProfile() {
  return Object.freeze({
    model: 'PA-ONE-X',
    version: 1,
    trustModel: 'zero-trust',
    failClosed: true,
    algorithms: Object.freeze([
      'AES-256-GCM',
      'HKDF-SHA-256',
      'HMAC-SHA-256'
    ]),
    invariants: Object.freeze([
      'authenticate-before-resource-access',
      'tenant-bound-resource-authorization',
      'policy-before-execution',
      'explicit-human-approval-for-governed-execution',
      'evidence-before-completion',
      'authenticated-execution-receipts',
      'no-fabricated-execution',
      'immutable-audit-records'
    ])
  });
}
