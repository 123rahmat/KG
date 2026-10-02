/**
 * Account-level AI entitlement synchronization.
 *
 * Billing remains stored per workspace for tenant and audit purposes, while
 * this small ledger mirrors only active plan identifiers for each member.
 * Usage resolution can therefore aggregate a person's entitlements without
 * widening workspace billing RLS.
 */

import { ACTIVE_STATUSES } from './stripe.js';

export async function syncWorkspaceAiEntitlements(client, workspaceId) {
  const { rows: [billing] } = await client.query(
    'SELECT plan_id, subscription_status FROM workspace_billing WHERE workspace_id = $1',
    [workspaceId]
  );
  const active = billing && ACTIVE_STATUSES.includes(billing.subscription_status) && billing.plan_id;
  if (active) {
    await client.query(
      `INSERT INTO principal_ai_entitlements (principal_id, workspace_id, plan_id)
       SELECT m.principal_id, m.workspace_id, $2
         FROM memberships m
        WHERE m.workspace_id = $1
       ON CONFLICT (principal_id, workspace_id) DO UPDATE
         SET plan_id = EXCLUDED.plan_id, updated_at = now()`,
      [workspaceId, billing.plan_id]
    );
  } else {
    await client.query(
      'DELETE FROM principal_ai_entitlements WHERE workspace_id = $1',
      [workspaceId]
    );
  }
}
