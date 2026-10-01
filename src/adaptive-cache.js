/**
 * Small encrypted PostgreSQL cache for derived context.
 *
 * Entries are scoped to workspace + principal and expire quickly. Callers
 * supply a fingerprint of the source state so mutable project data naturally
 * invalidates without a global cache flush.
 */
import crypto from 'node:crypto';
import { encryptJson, decryptField, keyedDigest } from './data-protection.js';

const text = value => String(value ?? '').trim();
const MAX_VALUE_BYTES = 180_000;

export class AdaptiveCache {
  constructor(pool, { encryptionKey, namespace = 'default', ttlSeconds = 60 } = {}) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
    this.namespace = text(namespace) || 'default';
    this.ttlSeconds = Math.max(5, Math.min(3600, Number(ttlSeconds) || 60));
    if (!this.encryptionKey) throw new Error('Adaptive cache encryption key is required');
  }

  key(scope, key, fingerprint = '') {
    return keyedDigest(this.encryptionKey, 'adaptive-cache-key-v1', [
      this.namespace, scope.workspaceId, scope.principalId, text(key), text(fingerprint)
    ].join('|'));
  }

  async get(scope, key, fingerprint = '') {
    const cacheKey = this.key(scope, key, fingerprint);
    const { rows: [row] } = await this.pool.query(
      'SELECT value_enc FROM adaptive_cache WHERE workspace_id = $1 AND principal_id = $2 AND namespace = $3 AND cache_key = $4 AND expires_at > now() LIMIT 1',
      [scope.workspaceId, scope.principalId, this.namespace, cacheKey]
    );
    if (!row) return null;
    try {
      const packed = JSON.parse(decryptField(this.encryptionKey, 'adaptive-cache-v1', row.value_enc));
      return packed?.value ?? null;
    } catch {
      return null;
    }
  }

  async set(scope, key, value, fingerprint = '') {
    const cacheKey = this.key(scope, key, fingerprint);
    const packed = JSON.stringify({ value });
    if (Buffer.byteLength(packed, 'utf8') > MAX_VALUE_BYTES) return false;
    const valueEnc = encryptJson(this.encryptionKey, 'adaptive-cache-v1', { value });
    await this.pool.query(
      `INSERT INTO adaptive_cache
        (id, workspace_id, principal_id, namespace, cache_key, value_enc, source_fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now()+($8::int * interval '1 second'))
       ON CONFLICT (workspace_id, principal_id, namespace, cache_key)
       DO UPDATE SET value_enc = EXCLUDED.value_enc, source_fingerprint = EXCLUDED.source_fingerprint,
                     expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [crypto.randomUUID(), scope.workspaceId, scope.principalId, this.namespace, cacheKey, valueEnc, text(fingerprint) || null, this.ttlSeconds]
    );
    return true;
  }

  async purge(scope) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM adaptive_cache WHERE workspace_id = $1 AND principal_id = $2 AND (expires_at <= now() OR namespace = $3)',
      [scope.workspaceId, scope.principalId, this.namespace]
    );
    return rowCount;
  }
}