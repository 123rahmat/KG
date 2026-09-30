/**
 * Shared helpers for the backup and restore commands.
 *
 * One copy, so the two cannot drift apart on how they reach PostgreSQL or
 * how they read the backup key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The app's PGSSLMODE vocabulary mapped onto libpq's, for pg_dump/pg_restore. */
const LIBPQ_SSLMODE = { disable: 'disable', require: 'require', verify: 'verify-full' };

function sslMode() {
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  return String(process.env.PGSSLMODE || '').toLowerCase() || (production ? 'verify' : 'disable');
}

/** Environment for a libpq child process (pg_dump, pg_restore). */
export function postgresEnvironment(connectionString) {
  const url = new URL(connectionString);
  const env = { ...process.env, PGHOST: url.hostname };
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database) env.PGDATABASE = database;
  const mode = sslMode();
  if (!LIBPQ_SSLMODE[mode]) throw new Error('Unsupported PGSSLMODE: ' + mode);
  env.PGSSLMODE = LIBPQ_SSLMODE[mode];
  return env;
}

/** TLS options for node-postgres, matching the application's own rules. */
export function pgSsl() {
  const mode = sslMode();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify') {
    const caPath = String(process.env.PGSSLROOTCERT || '');
    if (!caPath) throw new Error('PGSSLMODE=verify requires PGSSLROOTCERT');
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  throw new Error('Unsupported PGSSLMODE: ' + mode);
}

export function keyFromEnv() {
  const value = String(process.env.BACKUP_ENCRYPTION_KEY || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('BACKUP_ENCRYPTION_KEY must be standard base64');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

export async function restoreEncrypted(input, key) {
  const stat = await fsp.stat(input);
  if (stat.size < 32) throw new Error('Invalid Kindgleam backup format');

  const handle = await fsp.open(input, 'r');
  const header = Buffer.alloc(16);
  const tag = Buffer.alloc(16);
  try {
    await handle.read(header, 0, 16, 0);
    await handle.read(tag, 0, 16, stat.size - 16);
  } finally {
    await handle.close();
  }

  if (header.subarray(0, 4).toString('ascii') !== 'PAB2') {
    throw new Error('Unsupported Kindgleam backup format');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(4, 16));
  decipher.setAuthTag(tag);

  return {
    decipher,
    stream: fs.createReadStream(input, { start: 16, end: stat.size - 17 })
  };
}

/**
 * Check the whole backup's authentication tag before any of it is restored.
 * AES-GCM plaintext streams out before the tag is checked at the very end,
 * and GCM ciphertext can be altered bit by bit: fed straight to pg_restore,
 * an altered backup could be applied before the tag failed.
 */
export async function verifyEncrypted(input, key) {
  const { decipher, stream } = await restoreEncrypted(input, key);
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  try {
    await pipeline(stream, decipher, discard);
  } catch {
    throw new Error('The backup failed its integrity check (wrong key, or the file was altered). Nothing was restored.');
  }
}

