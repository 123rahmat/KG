#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { postgresEnvironment, pgSsl, keyFromEnv } from './pg-maintenance.js';
import pg from 'pg';


function databaseUrl() {
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const name = production ? 'BACKUP_DATABASE_URL' : (process.env.BACKUP_DATABASE_URL ? 'BACKUP_DATABASE_URL' : 'DATABASE_URL');
  const value = String(process.env[name] || '');
  if (!/^postgres(?:ql)?:\/\//.test(value)) throw new Error(name + ' is required');
  if (production && value === String(process.env.DATABASE_URL || '')) {
    throw new Error('BACKUP_DATABASE_URL must use a dedicated database identity in production');
  }
  return value;
}

async function assertBackupRole() {
  const url = databaseUrl();
  const pool = new pg.Pool({ connectionString: url, ssl: pgSsl(), max: 1 });
  try {
    const { rows: [role] } = await pool.query(
      'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    if (!role?.rolbypassrls) {
      throw new Error('BACKUP_DATABASE_URL must use a dedicated role with BYPASSRLS so backups include all tenant rows');
    }
    if (role.rolsuper) {
      throw new Error('BACKUP_DATABASE_URL must not use a PostgreSQL superuser; use a dedicated BYPASSRLS backup role');
    }
  } finally {
    await pool.end();
  }
}

async function dumpEncrypted(output, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const out = fs.createWriteStream(output, { mode: 0o600 });
  out.write(Buffer.concat([Buffer.from('PAB2'), nonce]));

  const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl'], {
    shell: false,
    env: postgresEnvironment(databaseUrl()),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    if (Buffer.byteLength(stderr) < 64 * 1024) stderr += chunk;
  });

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      out.write(chunk, callback);
    }
  });

  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });

  try {
    await pipeline(child.stdout, cipher, sink);
    const code = await exited;
    if (code !== 0) throw new Error('pg_dump exited with code ' + code + (stderr ? ': ' + stderr.trim().slice(0, 1000) : ''));
    out.write(cipher.getAuthTag());
    await new Promise((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
      out.end();
    });
  } catch (error) {
    child.kill('SIGKILL');
    out.destroy();
    // A partial file must never be mistaken for a backup.
    await fsp.rm(output, { force: true });
    throw error;
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

try {
  const key = keyFromEnv();
  await assertBackupRole();
  const dir = path.resolve(process.env.BACKUP_DIR || './backups');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(dir, 'kindgleam-' + stamp + '.dump.enc');
  await dumpEncrypted(output, key);
  const stat = await fsp.stat(output);
  const hash = await sha256File(output);
  await fsp.writeFile(output + '.manifest.json', JSON.stringify({
    // Format id kept from the earlier product name so existing backups restore.
    format: 'professor-ai-encrypted-backup-v3',
    createdAt: new Date().toISOString(),
    file: path.basename(output),
    bytes: stat.size,
    sha256: hash
  }, null, 2), { mode: 0o600 });
  console.log(output);
  console.log('sha256=' + hash);
} catch (error) {
  console.error('Backup failed: ' + error.message);
  process.exitCode = 1;
}
