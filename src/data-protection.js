/**
 * Application-level protection for private fields.
 *
 * The database remains tenant-isolated with PostgreSQL RLS, while especially
 * sensitive fields are encrypted before they reach PostgreSQL. Each purpose
 * derives a separate AES-256-GCM key from its deployment master key.
 */
import crypto from 'node:crypto';

const VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Sensitive data encryption key must be exactly 32 bytes');
  }
}

function purposeKey(masterKey, purpose) {
  assertKey(masterKey);
  return crypto.createHmac('sha256', masterKey).update('kindgleam:' + String(purpose)).digest();
}

export function encryptField(masterKey, purpose, value) {
  assertKey(masterKey);
  const plaintext = Buffer.from(String(value ?? ''), 'utf8');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', purposeKey(masterKey, purpose), nonce);
  cipher.setAAD(Buffer.from(String(purpose), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptField(masterKey, purpose, encoded) {
  assertKey(masterKey);
  const value = String(encoded ?? '');
  const [version, nonceText, tagText, ciphertextText] = value.split('.');
  if (version !== VERSION || !nonceText || !tagText || !ciphertextText) {
    throw new Error('Invalid encrypted field');
  }
  const nonce = Buffer.from(nonceText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid encrypted field');
  const decipher = crypto.createDecipheriv('aes-256-gcm', purposeKey(masterKey, purpose), nonce);
  decipher.setAAD(Buffer.from(String(purpose), 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encryptJson(masterKey, purpose, value) {
  return encryptField(masterKey, purpose, JSON.stringify(value ?? {}));
}

export function decryptJson(masterKey, purpose, encoded) {
  return JSON.parse(decryptField(masterKey, purpose, encoded));
}

/**
 * Deterministic lookup token for a normalized value. It is not reversible and
 * lets the application locate an encrypted record without a plaintext index.
 */
export function keyedDigest(masterKey, purpose, value) {
  assertKey(masterKey);
  return crypto.createHmac('sha256', purposeKey(masterKey, purpose))
    .update(String(value ?? ''), 'utf8')
    .digest('hex');
}
