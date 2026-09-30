/** Workspace-bound idempotency middleware. */
import crypto from 'node:crypto';
import { text } from './context.js';
import { encryptJson, decryptJsonWithKeys } from '../data-protection.js';

export function createWorkspaceIdempotency({ pool, route, encryptionKey, previousEncryptionKey = null }) {
  const encryptionKeys = [encryptionKey, previousEncryptionKey].filter(Boolean);
  if (!encryptionKeys.length) throw new Error('PERSONAL_DATA_ENCRYPTION_KEY is required for idempotency storage');
  return route(async (req, res, next) => {
    const key = text(req.get('idempotency-key'));
    if (!key) return next();
    if (key.length > 200) return res.status(400).json({ error: 'Idempotency-Key is too long', code: 'invalid-idempotency-key' });

    const workspaceId = text(req.get('x-workspace-id'));
    if (!workspaceId) return res.status(400).json({ error: 'X-Workspace-Id is required with Idempotency-Key', code: 'idempotency-workspace-required' });

    const hash = crypto.createHash('sha256')
      .update(req.method + ':' + req.originalUrl + ':workspace=' + workspaceId + ':' + JSON.stringify(req.body ?? {}), 'utf8')
      .digest('hex');

    const leaseUntil = new Date(Date.now() + 5 * 60_000);
    const created = await pool.query(
      `INSERT INTO idempotency_keys
         (key, principal_id, request_hash, status_code, response, state, lease_until)
       VALUES ($1, $2, $3, NULL, NULL, 'pending', $4)
       ON CONFLICT (key, principal_id) DO NOTHING
       RETURNING state`,
      [key, req.principal.id, hash, leaseUntil]
    );

    if (!created.rows[0]) {
      const { rows: [existing] } = await pool.query(
        'SELECT request_hash, status_code, response, response_enc, encryption_version, state, lease_until FROM idempotency_keys WHERE key = $1 AND principal_id = $2',
        [key, req.principal.id]
      );
      if (!existing) return res.status(409).json({ error: 'The idempotency reservation disappeared; retry the request.', code: 'idempotency-retry' });
      if (existing.request_hash !== hash) return res.status(409).json({ error: 'This Idempotency-Key was used with a different request or workspace', code: 'idempotency-mismatch' });
      if (existing.state === 'complete') {
        const replay = existing.response_enc
          ? decryptJsonWithKeys(encryptionKeys, 'idempotency-response-v1', existing.response_enc).value
          : existing.response;
        res.set('idempotent-replay', 'true');
        return res.status(existing.status_code).json(replay);
      }
      const expired = !existing.lease_until || new Date(existing.lease_until).getTime() <= Date.now();
      if (expired) {
        const reclaimed = await pool.query(
          `UPDATE idempotency_keys
              SET lease_until = $3
            WHERE key = $1 AND principal_id = $2 AND state = 'pending'
              AND (lease_until IS NULL OR lease_until <= now())
            RETURNING state`,
          [key, req.principal.id, leaseUntil]
        );
        if (reclaimed.rowCount === 0) {
          res.set('retry-after', '2');
          return res.status(409).json({ error: 'The previous request is still completing', code: 'idempotency-in-progress' });
        }
      } else {
        res.set('retry-after', '2');
        return res.status(409).json({ error: 'The previous request is still completing', code: 'idempotency-in-progress' });
      }
    }

    let finalized = false;
    const finalize = async body => {
      if (finalized) return;
      finalized = true;
      try {
        await pool.query(
          `UPDATE idempotency_keys
              SET state = 'complete', status_code = $3, response = '{}'::jsonb,
                  response_enc = $4, encryption_version = 1, completed_at = now(), lease_until = NULL
            WHERE key = $1 AND principal_id = $2 AND state = 'pending'`,
          [key, req.principal.id, res.statusCode, encryptJson(encryptionKey, 'idempotency-response-v1', body)]
        );
      } catch (error) {
        req.log.error('idempotency completion write failed', { error });
      }
    };

    const originalJson = res.json.bind(res);
    res.json = body => {
      void finalize(body).finally(() => originalJson(body));
      return res;
    };

    res.on('finish', () => {
      if (res.statusCode >= 500) {
        pool.query(
          'DELETE FROM idempotency_keys WHERE key = $1 AND principal_id = $2 AND state = \'pending\'',
          [key, req.principal.id]
        ).catch(error => req.log.error('idempotency reservation cleanup failed', { error }));
      }
    });

    next();
  });
}
