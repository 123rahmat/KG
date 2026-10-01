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


test('the live runtime role can use the secured audit-chain lookup', () =>
  withServer(async ({ appPool }) => {
    const { rows: [row] } = await appPool.query('SELECT kg_audit_previous_hash($1) AS entry_hash', ['ws']);
    assert.ok(Object.hasOwn(row, 'entry_hash'));
  }));
