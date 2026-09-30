/**
 * PostgreSQL access: pool, schema migrations, transactions.
 *
 * Every other module receives a `db` from here and never imports `pg` itself,
 * so the driver and its configuration stay in one place.
 */

import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { encryptObject, objectDigest } from './object-crypto.js';
import { MIGRATIONS } from './migrations.js';

const { Pool, types } = pg;

// node-postgres returns BIGINT as a string to avoid silent precision loss.
// Our bigints are byte counts and row counts, all far inside Number's safe
// range, and a string here would quietly break arithmetic and JSON output.
types.setTypeParser(types.builtins.INT8, value => Number(value));

const dbScopeStorage = new AsyncLocalStorage();

export function runDbScope(scope, callback) {
  const value = scope && typeof scope === 'object' ? scope : {};
  return dbScopeStorage.run(value, callback);
}

export function currentDbScope() {
  return dbScopeStorage.getStore() ?? null;
}

async function applyLocalDbScope(client, scope = currentDbScope()) {
  if (!scope) return;
  await client.query(
    `SELECT
       set_config('app.principal_id', $1, true),
       set_config('app.workspace_id', $2, true),
       set_config('app.organization_id', $3, true),
       set_config('app.jurisdiction', $4, true),
       set_config('app.role', $5, true)`,
    [
      String(scope.principalId ?? ''),
      String(scope.workspaceId ?? ''),
      String(scope.organizationId ?? ''),
      String(scope.jurisdiction ?? ''),
      String(scope.role ?? '')
    ]
  );
}

export { MIGRATIONS };

function quoteIdentifier(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) throw new Error('Invalid PostgreSQL role identifier');
  return '"' + text.replace(/"/g, '""') + '"';
}

function sslOption(config) {
  if (config.database.sslMode === 'disable') return false;
  if (config.database.sslMode === 'require') return { rejectUnauthorized: false };
  const ca = config.database.caCertPath;
  if (!ca) throw new Error('PGSSLMODE=verify requires PGSSLROOTCERT to point at a CA bundle');
  return { rejectUnauthorized: true, ca: fs.readFileSync(ca, 'utf8') };
}

export function createPool(config, logger, { connectionString = config.database.url, applicationName = 'kindgleam' } = {}) {
  const pool = new Pool({
    connectionString,
    ssl: sslOption(config),
    max: config.database.poolMax,
    min: config.database.poolMin,
    idleTimeoutMillis: config.database.idleTimeoutMs,
    connectionTimeoutMillis: config.database.connectionTimeoutMs,
    statement_timeout: config.database.statementTimeoutMs,
    application_name: applicationName
  });

  // An idle client erroring (a server restart, a dropped network) emits on the
  // pool. Without a listener, Node treats it as an unhandled error and exits.
  pool.on('error', error => logger?.error('database idle client error', { error }));

  // RLS context must be transaction-local. Pool-level session state is unsafe:
  // a later tenant could inherit a previous connection's context.
  const rawQuery = pool.query.bind(pool);
  const rawConnect = pool.connect.bind(pool);
  pool.query = async (...args) => {
    const scope = currentDbScope();
    if (!scope) return rawQuery(...args);

    const client = await rawConnect();
    try {
      await client.query('BEGIN');
      await applyLocalDbScope(client, scope);
      const result = await client.query(...args);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  return pool;
}

/**
 * Apply every migration the database has not seen, inside one transaction
 * each, guarded by an advisory lock so concurrent instances starting at the
 * same time cannot both run them.
 */
export async function migrate(pool, logger, {
  objectEncryptionKey = null,
  runtimeRole = null,
  hardenRuntime = false,
  backupRole = null,
  restoreRole = null
} = {}) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [0x70726f66]);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(row => row.version));
    // Always in version order, whatever order they are listed in: a migration
    // may depend on the schema an earlier one created.
    const pending = MIGRATIONS
      .filter(migration => !applied.has(migration.version))
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      logger?.info('applying migration', { version: migration.version, name: migration.name });
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${error.message}`, { cause: error });
      }
    }

    if (hardenRuntime) {
      if (!runtimeRole) throw new Error('runtimeRole is required when hardenRuntime is enabled');
      await hardenRuntimeRole(client, runtimeRole, logger);
      // Hardening revokes CONNECT from PUBLIC, so the maintenance identities
      // must be reconciled in the same step or backups stop working.
      await reconcileMaintenanceRoles(client, { backupRole, restoreRole, logger });
    }

    return { applied: pending.map(migration => migration.version) };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [0x70726f66]).catch(() => {});
    client.release();
  }
}

/**
 * Run `body` inside a transaction, committing on return and rolling back on
 * throw. The client is always released, including when the rollback fails.
 */
export async function transaction(pool, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyLocalDbScope(client);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


export async function reencryptPlaintextObjects(pool, masterKey, logger) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [0x70726f66]);
    return await migratePlaintextObjects(client, masterKey, logger);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [0x70726f66]).catch(() => {});
    client.release();
  }
}

export async function assertRlsReady(pool) {
  const expected = [
    'workspaces', 'organizations', 'memberships',
    'objects', 'blobs', 'runs', 'run_tasks', 'audit_log',
    'governance_policies', 'capability_specs', 'situation_events', 'run_jobs',
    'idempotency_keys', 'user_preferences',
    'usage_events', 'workspace_billing', 'workspace_ai_settings', 'stripe_events', 'run_actions', 'workspace_tools', 'schedules', 'notifications', 'memories', 'safety_events', 'safety_reports', 'terms_acceptances'
  ];
  const { rows: tables } = await pool.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, owner.rolname AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles owner ON owner.oid = c.relowner
      WHERE n.nspname = current_schema()
        AND c.relname = ANY($1::text[])`,
    [expected]
  );
  const byName = new Map(tables.map(row => [row.relname, row]));
  const missing = expected.filter(name => !byName.has(name));
  const weak = tables
    .filter(row => !row.relrowsecurity || !row.relforcerowsecurity)
    .map(row => row.relname);
  const { rows: [currentRole] } = await pool.query('SELECT current_user');
  const ownedByRuntime = tables
    .filter(row => row.owner === currentRole.current_user)
    .map(row => row.relname);
  const { rows: policyRows } = await pool.query(
    `SELECT tablename, COUNT(*)::integer AS policy_count
       FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = ANY($1::text[])
      GROUP BY tablename`,
    [expected]
  );
  const policies = new Map(policyRows.map(row => [row.tablename, Number(row.policy_count)]));
  const missingPolicies = expected.filter(name => !policies.has(name) || policies.get(name) < 1);
  const { rows: [role] } = await pool.query(
    `SELECT current_user, rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = current_user`
  );
  if (missing.length || weak.length || missingPolicies.length || ownedByRuntime.length || role?.rolsuper || role?.rolbypassrls) {
    throw new Error(
      'PostgreSQL RLS boundary is incomplete: '
      + JSON.stringify({ missing, weak, missingPolicies, ownedByRuntime, currentUser: role?.current_user, superuser: role?.rolsuper, bypassRls: role?.rolbypassrls })
    );
  }
  return { expected, protected: tables.map(row => row.relname), currentUser: role.current_user };
}

export async function assertMaintenanceBypassRls(pool, roleKind = 'maintenance') {
  const { rows: [role] } = await pool.query(
    `SELECT current_user, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
       FROM pg_roles
      WHERE rolname = current_user`
  );
  if (!role) throw new Error(roleKind + ' database role could not be introspected');
  // A superuser bypasses RLS whatever its rolbypassrls flag says; a dedicated
  // BYPASSRLS role (docs/sql/roles.sql) remains the least-privilege choice.
  if (!role.rolbypassrls && !role.rolsuper) {
    throw new Error(roleKind + ' database role must have BYPASSRLS so privileged maintenance can see all tenant rows');
  }
  return {
    currentUser: role.current_user,
    superuser: role.rolsuper === true,
    bypassRls: role.rolbypassrls === true || role.rolsuper === true,
    createRole: role.rolcreaterole === true,
    createDb: role.rolcreatedb === true
  };
}

export async function assertNoPlaintextObjects(pool) {
  const { rows: [row] } = await pool.query(
    'SELECT COUNT(*)::bigint AS count FROM blobs WHERE encryption_version = 0'
  );
  return Number(row.count) === 0;
}

async function migratePlaintextObjects(client, masterKey, logger) {
  let migrated = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT o.id, o.workspace_id, o.digest, b.bytes, b.size
         FROM objects o
         JOIN blobs b ON b.digest = o.digest
        WHERE b.encryption_version = 0
        ORDER BY o.id
        LIMIT 200`
    );
    if (!rows.length) break;

    await client.query('BEGIN');
    try {
      for (const row of rows) {
        const plaintext = row.bytes;
        const digest = objectDigest(masterKey, row.workspace_id, plaintext);
        const encrypted = encryptObject(masterKey, row.workspace_id, plaintext);

        await client.query(
          `INSERT INTO blobs (digest, workspace_id, bytes, size, ref_count, encryption_version)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (digest) DO UPDATE
             SET ref_count = blobs.ref_count + 1,
                 encryption_version = 1`,
          [digest, row.workspace_id, encrypted.bytes, row.size, 1, 1]
        );

        await client.query(
          'UPDATE objects SET digest = $2, updated_at = now() WHERE id = $1',
          [row.id, digest]
        );

        const { rows: [oldBlob] } = await client.query(
          'UPDATE blobs SET ref_count = ref_count - 1 WHERE digest = $1 RETURNING ref_count',
          [row.digest]
        );
        if (oldBlob?.ref_count === 0) {
          await client.query(
            'DELETE FROM blobs WHERE digest = $1 AND ref_count = 0',
            [row.digest]
          );
        }
        migrated += 1;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error('Legacy object re-encryption failed: ' + error.message, { cause: error });
    }

    logger?.debug('re-encrypted object batch', { migrated });
  }
  return migrated;
}


/**
 * Backup reads every table (BYPASSRLS covers the rows, not the grants).
 * Restore only needs to connect: it acts as the schema owner through role
 * membership, which only an operator can grant (see docs/sql/roles.sql).
 */
async function reconcileMaintenanceRoles(client, { backupRole, restoreRole, logger }) {
  const databaseName = (await client.query('SELECT current_database() AS name')).rows[0].name;
  const database = quoteIdentifier(databaseName);
  for (const [kind, name] of [['backup', backupRole], ['restore', restoreRole]]) {
    if (!name) continue;
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
    if (!exists.rows.length) {
      throw new Error(`Configured ${kind} database role does not exist: ${name}`);
    }
    const role = quoteIdentifier(name);
    await client.query('GRANT CONNECT ON DATABASE ' + database + ' TO ' + role);
    await client.query('GRANT USAGE ON SCHEMA public TO ' + role);
    if (kind === 'backup') {
      await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + role);
      await client.query('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + role);
    }
    logger?.info('maintenance database role reconciled', { kind, role: name });
  }
}

async function hardenRuntimeRole(client, runtimeRole, logger) {
  const role = quoteIdentifier(runtimeRole);
  const { rows } = await client.query(
    'SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [runtimeRole]
  );
  const configured = rows[0];
  if (!configured) {
    throw new Error('Configured runtime database role does not exist: ' + runtimeRole);
  }

  const elevated = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls'].filter(key => configured[key]);
  if (elevated.length) {
    throw new Error(
      'Configured runtime database role must not have elevated PostgreSQL privileges: ' + elevated.join(', ')
    );
  }

  const databaseName = (await client.query('SELECT current_database() AS name')).rows[0].name;
  const database = quoteIdentifier(databaseName);
  const namespaceOwner = await client.query(
    'SELECT 1 FROM pg_namespace WHERE nspname = $1 AND nspowner = $2::regrole',
    ['public', runtimeRole]
  );
  if (namespaceOwner.rows.length) {
    throw new Error('Configured runtime database role must not own the public schema');
  }

  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('REVOKE ALL ON DATABASE ' + database + ' FROM PUBLIC');
  await client.query('GRANT CONNECT ON DATABASE ' + database + ' TO ' + role);
  await client.query('GRANT USAGE ON SCHEMA public TO ' + role);

  // Least privilege for the live application role. Future migrations do not
  // inherit broad DML grants automatically; each new table must be granted
  // deliberately by a migration, keeping new data stores fail-closed.
  await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ' + role);
  await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ' + role);
  await client.query('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM ' + role);
  await client.query('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM ' + role);

  const grants = [
    ['SELECT', ['workspaces', 'organizations', 'memberships', 'principals']],
    ['SELECT, INSERT, UPDATE', ['governance_policies']],
    ['SELECT, INSERT, UPDATE', ['capability_specs']],
    ['SELECT, UPDATE', ['api_keys']],
    ['SELECT, INSERT, UPDATE, DELETE', ['objects', 'blobs', 'runs', 'run_tasks', 'run_jobs', 'idempotency_keys', 'sessions', 'rate_limit_windows']],
    ['SELECT, INSERT', ['audit_log', 'situation_events']],
    ['SELECT, INSERT, UPDATE', ['user_preferences']],
    ['SELECT, INSERT', ['usage_events']],
    ['SELECT, INSERT, UPDATE', ['workspace_billing', 'workspace_ai_settings']],
    ['SELECT, INSERT', ['stripe_events']],
    ['SELECT, INSERT, UPDATE', ['run_actions']],
    ['SELECT, INSERT, UPDATE', ['workspace_tools']],
    ['SELECT, INSERT, UPDATE', ['schedules', 'notifications']],
    ['SELECT, INSERT, UPDATE, DELETE', ['memories']],
    ['SELECT, INSERT', ['safety_events', 'terms_acceptances']],
    ['SELECT, INSERT, UPDATE', ['safety_reports']],
    ['SELECT, INSERT, UPDATE, DELETE', ['login_links']],
    ['SELECT, INSERT, UPDATE', ['mail_settings']]
  ];
  for (const [privileges, tables] of grants) {
    await client.query(
      'GRANT ' + privileges + ' ON TABLE ' + tables.map(name => quoteIdentifier(name)).join(', ') + ' TO ' + role
    );
  }
  // Sign-up's one narrow door into principals, workspaces and memberships.
  await client.query('GRANT EXECUTE ON FUNCTION kg_sign_up(TEXT, TEXT, BIGINT, INTEGER) TO ' + role);
  await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + role);
  await client.query('REVOKE ALL ON schema_migrations FROM ' + role);

  logger?.info('runtime database role privileges reconciled', { role: runtimeRole });
}
