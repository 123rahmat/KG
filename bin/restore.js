#!/usr/bin/env node
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { postgresEnvironment, pgSsl, keyFromEnv, restoreEncrypted, verifyEncrypted } from './pg-maintenance.js';


async function verifyManifest(input) {
  const manifestFile = input + '.manifest.json';
  try {
    const raw = await fsp.readFile(manifestFile, 'utf8');
    const manifest = JSON.parse(raw);
    if (manifest.format !== 'professor-ai-encrypted-backup-v3') {
      throw new Error('Backup manifest format is not supported for restore');
    }
    const stat = await fsp.stat(input);
    const expectedBytes = Number(manifest.bytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== stat.size) {
      throw new Error('Backup size does not match its manifest');
    }
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(input), hash);
    const actual = hash.digest('hex');
    if (actual !== String(manifest.sha256 || '')) {
      throw new Error('Backup SHA-256 does not match its manifest');
    }
    return manifest;
  } catch (error) {
    throw new Error('Backup manifest verification failed: ' + error.message, { cause: error });
  }
}


async function assertRestoreRole() {
  const pool = new pg.Pool({ connectionString: databaseUrl(), ssl: pgSsl(), max: 1 });
  try {
    const { rows: [role] } = await pool.query(
      'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    if (!role?.rolbypassrls) {
      throw new Error('RESTORE_DATABASE_URL must use a dedicated role with BYPASSRLS for RLS-protected tenant tables');
    }
    // --clean drops and recreates tables, which only their owner may do. The
    // restore identity acts as that owner through membership, so restored
    // objects keep the owner that later migrations expect.
    const { rows: [owner] } = await pool.query(
      "SELECT tableowner AS name, pg_has_role(current_user, tableowner, 'MEMBER') AS member FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'"
    );
    if (!owner) {
      // A fresh restore target has no schema_migrations row yet. In that case
      // use the database owner as the restore role when the authenticated
      // restore identity is explicitly allowed to SET ROLE to it. This keeps
      // trusted extensions such as pgcrypto installable without granting the
      // restore login broad database-creation privileges.
      const { rows: [databaseOwner] } = await pool.query(
        "SELECT pg_get_userbyid(datdba) AS name FROM pg_database WHERE datname = current_database()"
      );
      if (!databaseOwner?.name || databaseOwner.name === role.current_user) return null;
      const { rows: [membership] } = await pool.query(
        "SELECT pg_has_role(current_user, $1, 'MEMBER') AS member",
        [databaseOwner.name]
      );
      if (!membership?.member) {
        throw new Error(
          'The restore role ' + role.current_user + ' must be a member of the target database owner role ' + databaseOwner.name
          + ' (GRANT ' + databaseOwner.name + ' TO ' + role.current_user + '; see docs/sql/roles.sql)'
        );
      }
      return databaseOwner.name;
    }
    if (!owner.member && !role.rolsuper) {
      throw new Error(
        'The restore role ' + role.current_user + ' must be a member of the schema owner role ' + owner.name
        + ' (GRANT ' + owner.name + ' TO ' + role.current_user + '; see docs/sql/roles.sql)'
      );
    }
    return owner.name;
  } finally {
    await pool.end();
  }
}

async function runRestore(input, key, ownerRole) {
  // Work from a private copy, so the file cannot change between the check
  // and the restore, and verify all of it before pg_restore sees a byte.
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'kindgleam-restore-'));
  try {
    await fsp.chmod(work, 0o700);
    const copy = path.join(work, 'backup.enc');
    await fsp.copyFile(input, copy);
    await fsp.chmod(copy, 0o600);
    await verifyEncrypted(copy, key);
    await restoreVerified(copy, key, ownerRole);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function restoreVerified(input, key, ownerRole) {
  // Without --dbname pg_restore prints SQL to stdout and restores nothing,
  // while still exiting 0. The target must be explicit.
  const env = postgresEnvironment(databaseUrl());
  if (!env.PGDATABASE) throw new Error('RESTORE_DATABASE_URL must name the target database');
  const args = ['--dbname=' + env.PGDATABASE, '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'];
  if (ownerRole) args.push('--role=' + ownerRole);
  const child = spawn('pg_restore', args, {
    shell: false,
    env,
    stdio: ['pipe', 'inherit', 'inherit']
  });

  const { decipher, stream } = await restoreEncrypted(input, key);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });

  try {
    await pipeline(stream, decipher, child.stdin);
    const code = await exited;
    if (code !== 0) throw new Error('pg_restore exited with code ' + code);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

if (String(process.env.RESTORE_CONFIRM || '') !== 'I_UNDERSTAND') throw new Error('RESTORE_CONFIRM=I_UNDERSTAND is required for destructive restore');
const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const name = production ? 'RESTORE_DATABASE_URL' : (process.env.RESTORE_DATABASE_URL ? 'RESTORE_DATABASE_URL' : 'DATABASE_URL');
const url = String(process.env[name] || '');
if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error(name + ' is required');
if (production && url === String(process.env.DATABASE_URL || '')) {
  throw new Error('RESTORE_DATABASE_URL must use a dedicated database identity in production');
}
const databaseUrl = () => url;
if (!process.argv[2]) throw new Error('Usage: npm run restore -- /path/to/backup.dump.enc');
const input = path.resolve(process.argv[2]);
try {
  const ownerRole = await assertRestoreRole();
  await verifyManifest(input);
  await runRestore(input, keyFromEnv(), ownerRole);
  console.log('Restore complete. Restart the application so it reconciles database role grants.');
} catch (error) {
  console.error('Restore failed: ' + error.message);
  process.exitCode = 1;
}
