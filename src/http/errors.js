/**
 * The final error handler. Only the application's own errors are written
 * for clients; anything else gets a generic body and a request id.
 */

import { AuthError } from '../identity.js';
import { QuotaError } from '../objects.js';
import { RunError } from '../runs.js';
import { ModelProviderError } from '../runtime.js';

export function errorHandler(error, req, res, _next) {
  const known = error instanceof AuthError || error instanceof QuotaError || error instanceof RunError;
  const status = known ? error.status : error.status ?? (error.type === 'entity.parse.failed' ? 400 : 500);

  // Gemini being busy, down or refusing the key is the service's state, not
  // a bug here: the person gets the reason and when to retry, and the log a
  // warning rather than an unhandled error.
  if (error instanceof ModelProviderError && error.expose) {
    req.log?.warn('model provider unavailable', { code: error.code, upstreamStatus: error.upstreamStatus, path: req.path });
    if (error.retryAfterSeconds) res.set('retry-after', String(error.retryAfterSeconds));
    return res.status(error.status).json({
      error: error.message, code: error.code,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      requestId: req.requestId
    });
  }

  if (status >= 500) {
    req.log?.error('unhandled error', { error, path: req.path });
  }
  if (status === 401) res.set('www-authenticate', 'Bearer realm="kindgleam"');

  // Only the application's own errors are written for clients. Anything
  // else (a driver error, say) can carry SQL codes or row data in
  // `code`/`detail`, so it gets a generic body plus the request id that
  // ties it to the server log.
  const exposed = (known || error.expose === true) && status < 500;
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : error.message,
    code: exposed && error.code ? error.code
      : status >= 500 ? 'internal'
        : error.type === 'entity.too.large' ? 'payload-too-large'
          : 'bad-request',
    ...(exposed && error.detail ? { detail: error.detail } : {}),
    requestId: req.requestId
  });
}
