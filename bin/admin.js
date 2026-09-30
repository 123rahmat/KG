#!/usr/bin/env node
/**
 * Administration CLI.
 *
 * A system with authentication needs a way to create the first credential
 * without one. That bootstrap happens here, on the operator's machine with
 * database access, rather than through an HTTP route that would otherwise
 * have to be left unauthenticated.
 *
 *   node bin/admin.js bootstrap --workspace acme --name "Ada"
 *   node bin/admin.js issue-key --principal <id> --name ci
 *   node bin/admin.js revoke-key --key <id>
 *   node bin/admin.js add-member --workspace acme --principal <id> --role editor
 *   node bin/admin.js list-workspaces
 *   node bin/admin.js platform-admin --email ada@example.com [--revoke]
 *   node bin/admin.js migrate
 */

import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { createLogger } from '../src/observability.js';
import { Identity, ROLES } from '../src/identity.js';
import { GovernanceStore, LAYERS as GOVERNANCE_LAYERS } from '../src/governance.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    const name = rest[i].slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[(i += 1)] : 'true';
    flags[name] = value;
  }
  return { command, flags };
}

function require_(flags, name) {
  if (!flags[name]) {
    throw new Error(`--${name} is required`);
  }
  return flags[name];
}

const COMMANDS = {
  async migrate({ pool, logger }) {
    const { applied } = await migrate(pool, logger);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database already up to date.');
  },

  /** Create a workspace, an admin principal, a membership and a first key. */
  async bootstrap({ pool, identity, logger, flags, config }) {
    await migrate(pool, logger);

    const workspaceId = require_(flags, 'workspace');
    const { rows } = await pool.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
    const workspace = rows[0] ?? await identity.createWorkspace({
      id: workspaceId,
      name: flags['workspace-name'] ?? workspaceId,
      maxBytes: Number(flags['max-bytes'] ?? config.limits.workspaceBytes),
      maxObjects: Number(flags['max-objects'] ?? config.limits.workspaceObjects),
      organizationId: flags['organization'] ?? null,
      organizationType: flags['organization-type'] ?? 'personal',
      jurisdiction: flags.jurisdiction ?? null
    });

    const principal = await identity.createPrincipal({
      kind: flags.kind ?? 'user',
      name: flags.name ?? 'Administrator',
      email: flags.email ?? null
    });
    await identity.addMember({ workspaceId: workspace.id, principalId: principal.id, role: 'admin' });
    // The first person runs the service: email sending and other platform settings.
    await pool.query('UPDATE principals SET platform_admin = true WHERE id = $1', [principal.id]);
    const key = await identity.issueKey({ principalId: principal.id, name: flags['key-name'] ?? 'bootstrap' });

    console.log('');
    console.log(`  workspace   ${workspace.id}`);
    console.log(`  principal   ${principal.id}  (${principal.name}, admin)`);
    console.log(`  api key     ${key.token}`);
    console.log('');
    console.log('  This key is shown once and is not recoverable — only its hash is stored.');
    console.log('');
  },

  async 'issue-key'({ identity, flags }) {
    const key = await identity.issueKey({
      principalId: require_(flags, 'principal'),
      name: flags.name ?? 'api key',
      expiresAt: flags.expires ? new Date(flags.expires) : null
    });
    console.log(`\n  ${key.token}\n\n  Shown once. Store it now.\n`);
  },

  async 'revoke-key'({ identity, flags }) {
    const revoked = await identity.revokeKey(require_(flags, 'key'));
    console.log(revoked ? 'Key revoked.' : 'No such active key.');
  },

  async 'create-principal'({ identity, flags }) {
    const principal = await identity.createPrincipal({
      kind: flags.kind ?? 'user', name: require_(flags, 'name'), email: flags.email ?? null
    });
    console.log(`${principal.id}  ${principal.name}`);
  },

  async 'add-member'({ identity, flags }) {
    const role = flags.role ?? 'viewer';
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
    await identity.addMember({
      workspaceId: require_(flags, 'workspace'),
      principalId: require_(flags, 'principal'),
      role
    });
    console.log(`Added ${flags.principal} to ${flags.workspace} as ${role}.`);
  },

  async 'create-workspace'({ identity, flags, config }) {
    const workspace = await identity.createWorkspace({
      id: require_(flags, 'workspace'),
      name: flags['workspace-name'] ?? flags.workspace,
      maxBytes: Number(flags['max-bytes'] ?? config.limits.workspaceBytes),
      maxObjects: Number(flags['max-objects'] ?? config.limits.workspaceObjects),
      organizationId: flags['organization'] ?? null,
      organizationType: flags['organization-type'] ?? 'personal',
      jurisdiction: flags.jurisdiction ?? null
    });
    console.log(`${workspace.id}  ${workspace.name}`);
  },

  async 'list-workspaces'({ pool }) {
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.max_bytes, w.max_objects,
              (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS members,
              (SELECT COUNT(*) FROM objects o WHERE o.workspace_id = w.id) AS objects
         FROM workspaces w WHERE w.archived_at IS NULL ORDER BY w.name`
    );
    if (!rows.length) return console.log('No workspaces. Run: node bin/admin.js bootstrap --workspace <id>');
    for (const row of rows) {
      console.log(`${row.id}\t${row.name}\tmembers=${row.members}\tobjects=${row.objects}/${row.max_objects}`);
    }
  },

  /** Grant or remove the right to manage the whole service (mail settings). */
  async 'platform-admin'({ pool, flags }) {
    const email = require_(flags, 'email').trim().toLowerCase();
    const grant = flags.revoke !== 'true';
    const { rowCount } = await pool.query('UPDATE principals SET platform_admin = $2 WHERE email = $1', [email, grant]);
    console.log(rowCount ? `${email} is ${grant ? 'now' : 'no longer'} a platform administrator.` : `No account uses ${email}.`);
  },

  async purge({ identity }) {
    console.log(await identity.purgeExpired());
  },

  async 'set-policy'({ governance, flags }) {
    const layer = require_(flags, 'layer').toLowerCase();
    if (!GOVERNANCE_LAYERS.includes(layer)) {
      throw new Error(`--layer must be one of ${GOVERNANCE_LAYERS.join(', ')}`);
    }
    let policy;
    try {
      policy = JSON.parse(require_(flags, 'policy'));
    } catch {
      throw new Error('--policy must be valid JSON');
    }
    const row = await governance.set({
      layer,
      scopeId: flags.scope ?? (layer === 'platform' ? 'global' : null),
      policy
    });
    console.log(JSON.stringify(row));
  },

  async 'get-policy'({ governance, flags }) {
    const layer = require_(flags, 'layer').toLowerCase();
    if (!GOVERNANCE_LAYERS.includes(layer)) {
      throw new Error(`--layer must be one of ${GOVERNANCE_LAYERS.join(', ')}`);
    }
    const row = await governance.get({
      layer,
      scopeId: flags.scope ?? (layer === 'platform' ? 'global' : null)
    });
    console.log(row ? JSON.stringify(row) : 'Policy not configured.');
  }
};

const { command, flags } = parseArgs(process.argv.slice(2));

if (!command || !COMMANDS[command]) {
  console.error(`Usage: node bin/admin.js <command> [flags]\n\nCommands:\n  ${Object.keys(COMMANDS).join('\n  ')}\n`);
  process.exit(command ? 1 : 0);
}

const config = loadConfig();
const logger = createLogger({ level: 'info' });
const pool = createPool(config, logger, {
  connectionString: config.database.migrationUrl || config.database.url,
  applicationName: 'kindgleam-admin'
});
const identity = new Identity(pool, { sessionHours: config.limits.sessionHours });
const governance = new GovernanceStore(pool);

try {
  await COMMANDS[command]({ pool, identity, governance, logger, flags, config });
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
