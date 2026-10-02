        SELECT digest, COUNT(*)::BIGINT AS released
          FROM deleted_objects
         GROUP BY digest
      )
      UPDATE blobs b
         SET ref_count = b.ref_count - c.released
        FROM digest_counts c
       WHERE b.digest = c.digest;

      DELETE FROM blobs
       WHERE ref_count = 0;

      DELETE FROM workspace_sources
       WHERE kind = 'local-folder';

      ALTER TABLE workspace_sources
        DROP CONSTRAINT IF EXISTS workspace_sources_kind_check;

      ALTER TABLE workspace_sources
        ADD CONSTRAINT workspace_sources_kind_check CHECK (kind = 'github');
    `
  },{
    version: 68,
    name: 'billing-webhook-membership-read-scope',
    sql: `
      -- The billing webhook has no signed-in principal, but it still needs
      -- to synchronize this workspace's members into the account-level AI
      -- entitlement ledger. Permit only a billing-webhook connection whose
      -- transaction-local workspace scope names the same workspace.
      DROP POLICY IF EXISTS membership_billing_webhook_select_policy ON memberships;
      CREATE POLICY membership_billing_webhook_select_policy ON memberships
        FOR SELECT
        USING (
          current_setting('app.role', true) = 'billing-webhook'
          AND memberships.workspace_id = current_setting('app.workspace_id', true)
        );
    `
  }

];