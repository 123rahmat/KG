/**
 * Object-at-rest cryptography.
 *
 * A single deployment master key is never used directly for workspace content.
 * A deterministic workspace key is derived from it, so content encryption and
 * content digests are cryptographically separated by workspace.
 */

import crypto from 'node:crypto';

const text = value => String(value ?? '').trim();

export function deriveWorkspaceKey(masterKey, workspaceId) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('Object encryption master key must be exactly 32 bytes');
  }
  const scope = text(workspaceId);
  if (!scope) throw new Error('workspace id is required for content encryption');
  return crypto.createHmac('sha256', masterKey)
    // Fixed derivation label from the product's earlier name: changing it
    // would make every stored object undecryptable. Never rename.
    .update('professor-ai/workspace-key/v1:', 'utf8')
    .update(scope, 'utf8')
    .digest();
}

export function objectDigest(masterKey, workspaceId, plaintext) {
  const key = deriveWorkspaceKey(masterKey, workspaceId);
  return crypto.createHmac('sha256', key)
    .update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext))
    .digest('hex');
}

export function encryptObject(masterKey, workspaceId, plaintext) {
  const key = deriveWorkspaceKey(masterKey, workspaceId);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    bytes: Buffer.concat([nonce, tag, encrypted])
  };
}

export function decryptObject(masterKey, workspaceId, payload, version = 1) {
  if (version === 0) return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (version !== 1) throw new Error('Unsupported object encryption version');

  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length < 28) throw new Error('Encrypted object payload is malformed');

  const key = deriveWorkspaceKey(masterKey, workspaceId);
  const nonce = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseBase64Key(value) {
  const normalized = text(value).replace(/\s+/g, '');
  if (!normalized) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('OBJECT_ENCRYPTION_KEY must be standard base64');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32) throw new Error('OBJECT_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

