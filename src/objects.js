/**
 * The object store.
 *
 * Every artifact the workflow consumes or produces is one object with
 * identity, workspace scope, an owner, a lifecycle, a digest and provenance.
 *
 * Content identity is deliberately separate from object identity: bytes are
 * addressed by SHA-256 and stored once, while the objects referencing them
 * stay independently owned, scoped, authorized and deleted.
 *
 *         bytes → SHA-256 → one blob row
 *                            ↙        ↘
 *                     Object A        Object B
 *                     tenant A        tenant B
 *
 * Scope is never read from caller input. Callers pass a `scope` that
 * `Identity.requireAccess` produced, so a workspace id cannot be forged.
 */

import crypto from 'node:crypto';
import { transaction } from './db.js';
import { decryptObject, encryptObject, objectDigest } from './object-crypto.js';

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

const text = value => String(value ?? '').trim();

export class QuotaError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'QuotaError';
    this.status = 413;
    this.code = 'quota-exceeded';
    this.detail = detail;
  }
}

export class ObjectStore {
  constructor(pool, { maxObjectBytes, maxProvenanceBytes = 64 * 1024, maxFieldChars = 512, encryptionKey = null, audit } = {}) {
    this.pool = pool;
    this.maxObjectBytes = maxObjectBytes;
    this.maxProvenanceBytes = maxProvenanceBytes;
    this.maxFieldChars = maxFieldChars;
    this.encryptionKey = encryptionKey;
    this.audit = audit;
  }

  #toBuffer(content, encoding) {
    if (Buffer.isBuffer(content)) return content;
    if (encoding === 'base64') {
      // Buffer.from silently drops characters it cannot decode, which would
      // store bytes the caller never sent. Validate before trusting it.
      const value = text(content).replace(/\s+/g, '');
      const valid = value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
      if (!valid) {
        const error = new Error('content is not valid base64');
        error.status = 400;
        error.expose = true;
        throw error;
      }
      return Buffer.from(value, 'base64');
    }
    return Buffer.from(String(content ?? ''), 'utf8');
  }

  /**
   * Store an object.
   *
   * Quota check, blob upsert, refcount and insert happen in one transaction
   * with the workspace row locked, so concurrent uploads cannot both observe
   * room that only one of them can have.
   */
  async create(scope, principal, input = {}, { requestId } = {}) {
    const content = this.#toBuffer(input.content, input.encoding);
    const type = text(input.type) || 'artifact';
    const visibility = ['private', 'workspace'].includes(text(input.visibility)) ? text(input.visibility) : 'private';
    const name = text(input.name) || null;
    const contentType = text(input.contentType) || 'application/octet-stream';
    for (const [field, value] of [['type', type], ['name', name], ['contentType', contentType]]) {
      if (value && value.length > this.maxFieldChars) {
        const error = new Error(`Object ${field} is too long`);
        error.status = 413;
        error.expose = true;
        error.code = 'field-too-large';
        throw error;
      }
    }
    if (input.provenance !== undefined) {
      const provenanceBytes = Buffer.byteLength(JSON.stringify(input.provenance ?? null), 'utf8');
      if (provenanceBytes > this.maxProvenanceBytes) {
        const error = new Error('Object provenance is too large');
        error.status = 413;
        error.expose = true;
        error.code = 'provenance-too-large';
        throw error;
      }
    }
    if (content.byteLength > this.maxObjectBytes) {
      throw new QuotaError(`Object exceeds the ${this.maxObjectBytes} byte per-object limit`, {
        size: content.byteLength,
        limit: this.maxObjectBytes
      });
    }
    const digest = this.encryptionKey
      ? objectDigest(this.encryptionKey, scope.workspaceId, content)
      : crypto.createHash('sha256')
        .update(scope.workspaceId, 'utf8')
        .update(':', 'utf8')
        .update(content)
        .digest('hex');
    const stored = this.encryptionKey
      ? encryptObject(this.encryptionKey, scope.workspaceId, content)
      : { version: 0, bytes: content };

    return transaction(this.pool, async client => {
      // Serialize quota checks per workspace. A transaction-scoped advisory
      // lock does this without SELECT ... FOR UPDATE, which would need UPDATE
      // on workspaces and so let the runtime role rewrite its own quotas.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('professor.workspace-quota:' || $1, 0))" /* lock key shared by every running version; never rename */,
        [scope.workspaceId]
      );
      const { rows: [workspace] } = await client.query(
        'SELECT max_bytes, max_objects FROM workspaces WHERE id = $1',
        [scope.workspaceId]
      );

      const { rows: [usage] } = await client.query(
        `SELECT COUNT(*)::bigint AS objects, COALESCE(SUM(size), 0)::bigint AS bytes
           FROM objects WHERE workspace_id = $1`,
        [scope.workspaceId]
      );

      if (usage.objects + 1 > workspace.max_objects) {
        throw new QuotaError('Workspace object limit reached', {
          objects: usage.objects, limit: workspace.max_objects
        });
      }
      if (usage.bytes + content.byteLength > workspace.max_bytes) {
        throw new QuotaError('Workspace storage limit reached', {
          bytes: usage.bytes, adding: content.byteLength, limit: workspace.max_bytes
        });
      }

      // Insert the blob if it is new; either way take a reference on it.
      await client.query(
        `INSERT INTO blobs (digest, workspace_id, bytes, size, ref_count, encryption_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (digest) DO UPDATE SET ref_count = blobs.ref_count + 1`,
        [digest, scope.workspaceId, stored.bytes, content.byteLength, 1, stored.version]
      );

      const { rows: [object] } = await client.query(
        `INSERT INTO objects (id, workspace_id, owner_id, type, name, content_type, size, digest, provenance, visibility)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          crypto.randomUUID(),
          scope.workspaceId,
          principal.id, // stamped from the authenticated principal, never from input
          type,
          name,
          contentType,
          content.byteLength,
          digest,
          input.provenance ? JSON.stringify(input.provenance) : null,
          visibility
        ]
      );

      await this.audit?.record({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'object.create',
        target: object.id,
        outcome: 'allowed',
        detail: { size: object.size, type: object.type, digest },
        requestId
      }, client);

      return present(object);
    });
  }

  /**
   * List one workspace's objects, newest first.
   *
   * Keyset pagination, not OFFSET: an offset drifts and repeats rows when
   * items are inserted while a client is paging through.
   */
  async list(scope, { type, lifecycle, ownerId, limit, cursor } = {}) {
    const size = Math.min(Math.max(Number(limit) || DEFAULT_PAGE, 1), MAX_PAGE);
    const after = decodeCursor(cursor);

    const { rows } = await this.pool.query(
      `SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM objects
        WHERE workspace_id = $1
          AND (visibility = 'workspace' OR owner_id = $2)
          AND ($3::text IS NULL OR type = $3)
          AND ($4::text IS NULL OR lifecycle = $4)
          AND ($5::text IS NULL OR owner_id = $5)
          AND ($6::timestamptz IS NULL OR (created_at, id) < ($6, $7))
        ORDER BY created_at DESC, id DESC
        LIMIT $8`,
      [scope.workspaceId, scope.principalId, text(type) || null, text(lifecycle) || null,
       text(ownerId) || null, after?.createdAt ?? null, after?.id ?? null, size + 1]
    );

    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      objects: page.map(present),
      nextCursor: rows.length > size && last ? encodeCursor(last) : null
    };
  }

  async get(scope, id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM objects
        WHERE id = $1 AND workspace_id = $2
          AND (visibility = 'workspace' OR owner_id = $3)`,
      [text(id), scope.workspaceId, scope.principalId]
    );
    return rows[0] ? present(rows[0]) : null;
  }

  async replace(scope, principal, id, input = {}, { requestId } = {}) {
    const content = this.#toBuffer(input.content, input.encoding);
    const name = text(input.name);
    const contentType = text(input.contentType);
    if (!content.length) {
      const error = new Error('Replacement content cannot be empty');
      error.status = 400; error.expose = true; error.code = 'empty-replacement';
      throw error;
    }
    if (content.byteLength > this.maxObjectBytes) throw new QuotaError(`Replacement exceeds the ${this.maxObjectBytes} byte per-object limit`, { size: content.byteLength, limit: this.maxObjectBytes });
    if (name.length > this.maxFieldChars || contentType.length > this.maxFieldChars) {
      const error = new Error('Replacement metadata is too long');
      error.status = 413; error.expose = true; error.code = 'field-too-large';
      throw error;
    }
    const digest = this.encryptionKey
      ? objectDigest(this.encryptionKey, scope.workspaceId, content)
      : crypto.createHash('sha256').update(scope.workspaceId, 'utf8').update(':', 'utf8').update(content).digest('hex');
    const stored = this.encryptionKey
      ? encryptObject(this.encryptionKey, scope.workspaceId, content)
      : { version: 0, bytes: content };

    return transaction(this.pool, async client => {
      const { rows: [object] } = await client.query(
        `SELECT * FROM objects
          WHERE id = $1 AND workspace_id = $2
            AND (visibility = 'workspace' OR owner_id = $3)
          FOR UPDATE`,
        [text(id), scope.workspaceId, scope.principalId]
      );
      if (!object) return null;
      const { rows: [existingBlob] } = await client.query('SELECT ref_count FROM blobs WHERE digest = $1 FOR UPDATE', [object.digest]);
      if (existingBlob) {
        await client.query('UPDATE blobs SET ref_count = ref_count + 1 WHERE digest = $1', [digest]);
      } else {
        await client.query(
          `INSERT INTO blobs (digest, workspace_id, bytes, size, ref_count, encryption_version)
           VALUES ($1, $2, $3, $4, 1, $5)
           ON CONFLICT (digest) DO UPDATE SET ref_count = blobs.ref_count + 1`,
          [digest, scope.workspaceId, stored.bytes, content.byteLength, stored.version]
        );
      }
      await client.query('UPDATE blobs SET ref_count = ref_count - 1 WHERE digest = $1', [object.digest]);
      await client.query('DELETE FROM blobs WHERE digest = $1 AND ref_count = 0', [object.digest]);
      const { rows: [updated] } = await client.query(
        `UPDATE objects
            SET name = COALESCE(NULLIF($2, ''), name),
                content_type = COALESCE(NULLIF($3, ''), content_type),
                size = $4, digest = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [text(id), name, contentType, content.byteLength, digest]
      );
      await this.audit?.record({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'object.replace',
        target: id,
        outcome: 'allowed',
        detail: { size: updated.size, digest },
        requestId
      }, client);
      return present(updated);
    });
  }

  /** Metadata plus the bytes. */
  async read(scope, id) {
    const { rows } = await this.pool.query(
      `SELECT o.*, b.bytes, b.encryption_version FROM objects o JOIN blobs b ON b.digest = o.digest
        WHERE o.id = $1 AND o.workspace_id = $2
          AND (o.visibility = 'workspace' OR o.owner_id = $3)`,
      [text(id), scope.workspaceId, scope.principalId]
    );
    if (!rows[0]) return null;
    const { bytes, encryption_version: encryptionVersion, ...object } = rows[0];
    if (encryptionVersion === 1 && !this.encryptionKey) {
      const error = new Error('Encrypted object storage is configured but the decryption key is unavailable');
      error.status = 503;
      error.code = 'object-key-unavailable';
      throw error;
    }
    if (encryptionVersion === 0 && this.encryptionKey) {
      const error = new Error('Legacy unencrypted object storage is not permitted after encryption is enabled');
      error.status = 503;
      error.code = 'object-reencryption-required';
      throw error;
    }
    const content = encryptionVersion === 1
      ? decryptObject(this.encryptionKey, scope.workspaceId, bytes, encryptionVersion)
      : bytes;
    return { metadata: present(object), content };
  }

  async setLifecycle(scope, principal, id, lifecycle, { requestId } = {}) {
    const { rows } = await this.pool.query(
      `UPDATE objects SET lifecycle = $3, updated_at = now()
        WHERE id = $1 AND workspace_id = $2
          AND (visibility = 'workspace' OR owner_id = $4) RETURNING *`,
      [text(id), scope.workspaceId, lifecycle, scope.principalId]
    );
    if (!rows[0]) return null;
    await this.audit?.record({
      principalId: principal.id,
      workspaceId: scope.workspaceId,
      action: `object.${lifecycle === 'archived' ? 'archive' : 'restore'}`,
      target: id,
      outcome: 'allowed',
      requestId
    });
    return present(rows[0]);
  }

  /**
   * Delete an object and release its reference on the content.
   *
   * The blob is removed only when the last reference goes, because a
   * soft-delete that never frees storage is a leak and an unconditional
   * delete would destroy another tenant's identical bytes.
   */
  async remove(scope, principal, id, { requestId } = {}) {
    return transaction(this.pool, async client => {
      const { rows } = await client.query(
        `DELETE FROM objects
          WHERE id = $1 AND workspace_id = $2
            AND (visibility = 'workspace' OR owner_id = $3)
          RETURNING *`,
        [text(id), scope.workspaceId, scope.principalId]
      );
      const object = rows[0];
      if (!object) return null;

      const { rows: [blob] } = await client.query(
        'UPDATE blobs SET ref_count = ref_count - 1 WHERE digest = $1 RETURNING ref_count',
        [object.digest]
      );
      if (blob && blob.ref_count === 0) {
        await client.query('DELETE FROM blobs WHERE digest = $1 AND ref_count = 0', [object.digest]);
      }

      await this.audit?.record({
        principalId: principal.id,
        workspaceId: scope.workspaceId,
        action: 'object.delete',
        target: id,
        outcome: 'allowed',
        detail: { size: object.size, blobReleased: blob?.ref_count === 0 },
        requestId
      }, client);

      return { ...present(object), lifecycle: 'deleted' };
    });
  }

  async usage(scope) {
    const { rows: [row] } = await this.pool.query(
      `SELECT COUNT(*)::bigint AS objects,
              COALESCE(SUM(size), 0)::bigint AS bytes,
              COUNT(*) FILTER (WHERE lifecycle = 'archived')::bigint AS archived
         FROM objects WHERE workspace_id = $1`,
      [scope.workspaceId]
    );
    return {
      objects: row.objects,
      bytes: row.bytes,
      archived: row.archived,
      maxObjects: scope.maxObjects,
      maxBytes: scope.maxBytes
    };
  }
}

const present = row => ({
  id: row.id,
  workspaceId: row.workspace_id,
  ownerId: row.owner_id,
  type: row.type,
  name: row.name,
  contentType: row.content_type,
  size: row.size,
  digest: row.digest,
  version: row.version,
  lifecycle: row.lifecycle,
  visibility: row.visibility ?? 'private',
  provenance: row.provenance,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// Microsecond precision, as in runs.js: a JS Date would skip rows.
const encodeCursor = row =>
  Buffer.from(JSON.stringify({ c: row.cursor_at, i: row.id })).toString('base64url');

function decodeCursor(cursor) {
  if (!text(cursor)) return null;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(text(cursor), 'base64url').toString('utf8'));
  } catch {}
  const { c, i } = decoded && typeof decoded === 'object' ? decoded : {};
  if (typeof c !== 'string' || typeof i !== 'string' || !i || Number.isNaN(Date.parse(c))) {
    const error = new Error('Invalid pagination cursor');
    error.status = 400;
    error.expose = true;
    error.code = 'invalid-cursor';
    throw error;
  }
  return { createdAt: c, id: i };
}
