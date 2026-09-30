/**
 * A backup is restored only after its whole authentication tag checks out:
 * GCM ciphertext can be altered bit by bit, and pg_restore must never be fed
 * altered data before the tag fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyEncrypted } from '../bin/pg-maintenance.js';

async function encryptedBackup(dir, key, plaintext) {
  // The backup format: "PAB2" + 12-byte nonce, ciphertext, 16-byte tag.
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const file = path.join(dir, 'backup.dump.enc');
  await fsp.writeFile(file, Buffer.concat([Buffer.from('PAB2'), nonce, body, cipher.getAuthTag()]));
  return file;
}

test('a backup is verified whole before restore, and an altered one is refused', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kg-backup-'));
  try {
    const key = crypto.randomBytes(32);
    const file = await encryptedBackup(dir, key, Buffer.from('-- dump\nINSERT INTO principals VALUES (1, \'user\');\n'.repeat(200)));
    await verifyEncrypted(file, key);

    // Flip one bit in the middle of the ciphertext: GCM keeps decrypting,
    // only the final tag check can notice.
    const bytes = await fsp.readFile(file);
    bytes[200] ^= 0x01;
    await fsp.writeFile(file, bytes);
    await assert.rejects(() => verifyEncrypted(file, key), /integrity check/);

    const other = await encryptedBackup(dir, key, Buffer.from('ok'));
    await assert.rejects(() => verifyEncrypted(other, crypto.randomBytes(32)), /integrity check/, 'a wrong key is refused the same way');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
