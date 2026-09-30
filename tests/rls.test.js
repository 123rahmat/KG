import crypto from 'node:crypto';
import pg from 'pg';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';
import { migrate } from '../src/db.js';

function ident(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('invalid test role');
  return '"' + value + '"';
}

test('PostgreSQL RLS blocks cross-user and cross-workspace access for the runtime role', () =>
  withServer(async ({ call, seed, pool, adminUrl, logger }) => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    const role = 'rls_runtime_' + crypto.randomBytes(6).toString('hex');
    const password = crypto.randomBytes(18).toString('base64url');

    await admin.query("CREATE ROLE " + ident(role) + " LOGIN PASSWORD '" + password.replace(/'/g, "''") + "'");
    try {
      // Reconcile the exact privileges that production uses after migrations.
      await migrate(pool, logger, { runtimeRole: role, hardenRuntime: true });

      const owner = await seed({ workspace: 'shared', role: 'editor', name: 'Owner' });
      const peer = await seed({ workspace: 'shared', role: 'editor', name: 'Peer' });
      const other = await seed({ workspace: 'other', role: 'editor', name: 'Other' });
      await admin.query(
        `INSERT INTO idempotency_keys
           (key, principal_id, request_hash, status_code, response, state, lease_until)
         VALUES
           ('owner-key', $1, 'h1', 200, '{"private":"owner"}'::jsonb, 'complete', NULL),
           ('peer-key', $2, 'h2', 200, '{"private":"peer"}'::jsonb, 'complete', NULL)`,
        [owner?.principal?.id, peer?.principal?.id]
      );
      const privateRun = await call('POST', '/api/runs', {
        token: owner.token, workspace: 'shared',
        body: { goal: 'Owner private run.' }
      });
      assert.equal(privateRun.status, 201);

      const sharedRun = await call('POST', '/api/runs', {
        token: peer.token, workspace: 'shared',
        body: { goal: 'Workspace shared run.', visibility: 'workspace' }
      });
      assert.equal(sharedRun.status, 201);

      const otherRun = await call('POST', '/api/runs', {
        token: other.token, workspace: 'other',
        body: { goal: 'Other tenant run.' }
      });
      assert.equal(otherRun.status, 201);

      const connection = new URL(adminUrl);
      connection.username = role;
      connection.password = password;
      const client = new pg.Client({ connectionString: connection.toString() });

      await client.connect();
      try {
        const roleCheck = await client.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        );
        assert.equal(roleCheck.rows[0].rolsuper, false);
        assert.equal(roleCheck.rows[0].rolbypassrls, false);

        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('app.principal_id', $1, true), set_config('app.workspace_id', $2, true), set_config('app.organization_id', $3, true), set_config('app.jurisdiction', $4, true), set_config('app.role', $5, true)",
          [owner.principal.id, 'shared', 'org-shared', '', 'editor']
        );

        const idempotentOwner = await client.query(
          "SELECT key, response FROM idempotency_keys ORDER BY key"
        );
        assert.deepEqual(idempotentOwner.rows, [
          { key: 'owner-key', response: { private: 'owner' } }
        ]);
        await await client.query(
          `INSERT INTO workspace_billing (workspace_id, billing_email, company_name, tax_id, country, address, billing_private_enc, billing_encryption_version)
           VALUES ($1, '', '', '', '', '', $2, 1)
           ON CONFLICT (workspace_id) DO NOTHING`,
          ['shared', 'v1.testcipher']
        );
        const billingVisible = await client.query('SELECT workspace_id, billing_private_enc FROM workspace_billing');
        assert.equal(billingVisible.rows.length, 1);
        const billingWrite = await client.query(
          `UPDATE workspace_billing
              SET subscription_status = 'tampered'
            WHERE workspace_id = $1`,
          ['shared']
        );
        assert.equal(billingWrite.rowCount, 0);

        const sharedScope = await client.query(
          "SELECT id, visibility, principal_id FROM runs ORDER BY id"
        );
        assert.deepEqual(
          sharedScope.rows.map(row => row.id),
          [privateRun.body.id, sharedRun.body.id].sort()
        );

        await client.query(
          "SELECT set_config('app.workspace_id', $1, true)",
          ['other']
        );
        const crossWorkspace = await client.query('SELECT id FROM runs');
        assert.deepEqual(crossWorkspace.rows, []);

        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    } finally {
      // Grants made by the hardening migration must go before the role can.
      await admin.query('DROP OWNED BY ' + ident(role));
      await admin.query('DROP ROLE IF EXISTS ' + ident(role));
      await admin.end();
    }
  }));
