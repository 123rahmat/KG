import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

test('the live runtime role has only the intended audit privileges', () =>
  withServer(async ({ appPool }) => {
    const { rows: [row] } = await appPool.query(`
      SELECT current_user,
             has_table_privilege(current_user, 'public.audit_log', 'SELECT') AS can_select,
             has_table_privilege(current_user, 'public.audit_log', 'INSERT') AS can_insert,
             has_table_privilege(current_user, 'public.audit_log', 'UPDATE') AS can_update,
             has_table_privilege(current_user, 'public.audit_log', 'DELETE') AS can_delete
    `);
    assert.ok(row.current_user.startsWith('pro_rt_'), row.current_user);
    assert.equal(row.can_select, true);
    assert.equal(row.can_insert, true);
    assert.equal(row.can_update, false);
    assert.equal(row.can_delete, false);
  }));


test('the live runtime role can execute the exact audit-chain query', () =>
  withServer(async ({ appPool }) => {
    await appPool.query('SELECT entry_hash FROM audit_log WHERE workspace_id IS NOT DISTINCT FROM $1 ORDER BY id DESC LIMIT 1 FOR SHARE', ['ws']);
  }));
