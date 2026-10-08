import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore } from '../src/objects.js';
import { withServer } from './helpers.js';
import { runDbScope } from '../src/db.js';

const inScope = (scope, operation) => runDbScope({ ...scope, role: 'admin' }, operation);

test('replacement rejects storage growth beyond workspace quota before mutating blobs', async () => {
  const writes = [];
  const original = { id: 'file-1', workspace_id: 'ws', owner_id: 'person', size: 2, digest: 'old', name: 'a.txt' };
  // A read-only transaction fixture allows the admission boundary to be
  // exercised without PostgreSQL; integration tests below verify real locks.
  const client = {
    release() {},
    async query(sql, values) {
      if (/SELECT max_bytes, max_objects/.test(sql)) return { rows: [{ max_bytes: 5, max_objects: 10 }] };
      if (/kg_workspace_storage_usage/.test(sql)) return { rows: [{ bytes: 4, objects: 2 }] };
      if (/SELECT \* FROM objects/.test(sql)) return { rows: [{ ...original }] };
      if (/SELECT ref_count/.test(sql)) return { rows: [] };
      if (/UPDATE objects/.test(sql)) return { rows: [{ ...original, size: values[3], digest: values[4] }] };
      if (/^(?:INSERT|UPDATE|DELETE)/.test(sql.trim())) writes.push(sql);
      return { rows: [], rowCount: 0 };
    }
  };
  const store = new ObjectStore({ connect: async () => client }, { maxObjectBytes: 100 });
  await assert.rejects(store.replace({ workspaceId: 'ws', principalId: 'person' }, { id: 'person' }, 'file-1', { content: 'four' }), error => error.code === 'quota-exceeded');
  assert.equal(writes.length, 0);
});

test('replacement quota rejection leaves bytes and blob references unchanged', () => withServer(async ({ call, seed, pool, app }) => {
  const { token, workspace, principal } = await seed();
  await pool.query('UPDATE workspaces SET max_bytes = 10, max_objects = 10 WHERE id = $1', [workspace]);
  const auth = { token, workspace };
  const first = (await call('POST', '/api/objects', { ...auth, body: { name: 'one.txt', content: '1234' } })).body;
  await call('POST', '/api/objects', { ...auth, body: { name: 'two.txt', content: '1234' } });
  const scope = { workspaceId: workspace, principalId: principal.id };
  await assert.rejects(inScope(scope, () => app.locals.objects.replace(scope, principal, first.id, { content: '1234567' })), error => error.code === 'quota-exceeded');
  const stored = await inScope(scope, () => app.locals.objects.read(scope, first.id));
  assert.equal(stored.content.toString('utf8'), '1234');
  const { rows } = await pool.query('SELECT size, ref_count FROM blobs WHERE workspace_id = $1', [workspace]);
  assert.deepEqual(rows, [{ size: 4, ref_count: 2 }]);
  const replaced = await inScope(scope, () => app.locals.objects.replace(scope, principal, first.id, { content: '123456' }));
  assert.equal(replaced.size, 6, 'only the two-byte size delta is charged');
  assert.equal((await inScope(scope, () => app.locals.objects.usage(scope))).bytes, 10);
}));

test('same-size and shrinking replacements remain allowed after the workspace quota is lowered', () => withServer(async ({ call, seed, pool, app }) => {
  const { token, workspace, principal } = await seed();
  const auth = { token, workspace }, scope = { workspaceId: workspace, principalId: principal.id };
  const object = (await call('POST', '/api/objects', { ...auth, body: { content: '12345678' } })).body;
  await pool.query('UPDATE workspaces SET max_bytes = 4 WHERE id = $1', [workspace]);
  assert.equal((await inScope(scope, () => app.locals.objects.replace(scope, principal, object.id, { content: 'abcdefgh' }))).size, 8);
  assert.equal((await inScope(scope, () => app.locals.objects.replace(scope, principal, object.id, { content: 'abcde' }))).size, 5);
  await assert.rejects(inScope(scope, () => app.locals.objects.replace(scope, principal, object.id, { content: 'abcdef' })), error => error.code === 'quota-exceeded');
  assert.equal((await inScope(scope, () => app.locals.objects.replace(scope, principal, object.id, { content: 'abc' }))).size, 3);
}));

test('concurrent creates and replacements admit only storage that fits', () => withServer(async ({ call, seed, app, pool }) => {
  const { token, workspace, principal } = await seed();
  await pool.query('UPDATE workspaces SET max_bytes = 10, max_objects = 10 WHERE id = $1', [workspace]);
  const auth = { token, workspace }, scope = { workspaceId: workspace, principalId: principal.id };
  const first = (await call('POST', '/api/objects', { ...auth, body: { content: 'aa' } })).body;
  const second = (await call('POST', '/api/objects', { ...auth, body: { content: 'bb' } })).body;
  const results = await inScope(scope, () => Promise.allSettled([
    app.locals.objects.replace(scope, principal, first.id, { content: '123456' }),
    app.locals.objects.replace(scope, principal, second.id, { content: 'abcdef' }),
    app.locals.objects.create(scope, principal, { content: 'new!' })
  ]));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'quota-exceeded');
  assert.equal((await inScope(scope, () => app.locals.objects.usage(scope))).bytes, 8);
}));

test('concurrent replacement with identical bytes preserves deduplicated blob references', () => withServer(async ({ call, seed, pool, app }) => {
  const { token, workspace, principal } = await seed();
  const auth = { token, workspace }, scope = { workspaceId: workspace, principalId: principal.id };
  const first = (await call('POST', '/api/objects', { ...auth, body: { content: 'aa' } })).body;
  const second = (await call('POST', '/api/objects', { ...auth, body: { content: 'bb' } })).body;
  const replaced = await inScope(scope, () => Promise.all([first, second].map(object => app.locals.objects.replace(scope, principal, object.id, { content: 'same' }))));
  assert.equal(replaced[0].digest, replaced[1].digest);
  await inScope(scope, () => app.locals.objects.replace(scope, principal, first.id, { content: 'same' }));
  const { rows } = await pool.query('SELECT size, ref_count FROM blobs WHERE workspace_id = $1', [workspace]);
  assert.deepEqual(rows, [{ size: 4, ref_count: 2 }]);
}));

test('workspace quotas include peers private files without exposing them through object RLS', () => withServer(async ({ call, seed, pool, app, appPool }) => {
  const owner = await seed({ workspace: 'shared', role: 'editor' });
  const peer = await seed({ workspace: 'shared', role: 'editor' });
  await seed({ workspace: 'other' });
  await pool.query('UPDATE workspaces SET max_bytes = 10, max_objects = 10 WHERE id = $1', ['shared']);
  const ownerFile = await call('POST', '/api/objects', { token: owner.token, workspace: 'shared', body: { content: '123456', visibility: 'private' } });
  const peerFile = await call('POST', '/api/objects', { token: peer.token, workspace: 'shared', body: { content: 'ab', visibility: 'private' } });
  assert.equal(ownerFile.status, 201); assert.equal(peerFile.status, 201);
  const scope = { workspaceId: 'shared', principalId: peer.principal.id };
  await assert.rejects(inScope(scope, () => app.locals.objects.replace(scope, peer.principal, peerFile.body.id, { content: 'abcdef' })), error => error.code === 'quota-exceeded');
  const tooLarge = await call('POST', '/api/objects', { token: peer.token, workspace: 'shared', body: { content: 'xyz' } });
  assert.equal(tooLarge.body.code, 'quota-exceeded'); assert.equal(tooLarge.body.detail.adding, 3);
  await pool.query('UPDATE workspaces SET max_objects = 2 WHERE id = $1', ['shared']);
  const rejected = await call('POST', '/api/objects', { token: peer.token, workspace: 'shared', body: { content: 'x' } });
  assert.equal(rejected.body.code, 'quota-exceeded', 'object count also covers peer-private files');
  const visible = await call('GET', '/api/objects', { token: peer.token, workspace: 'shared' });
  assert.deepEqual(visible.body.objects.map(file => file.id), [peerFile.body.id]);
  const usage = await inScope(scope, () => app.locals.objects.usage(scope));
  assert.equal(usage.bytes, 8); assert.equal(usage.objects, 2);
  assert.deepEqual((await inScope(scope, () => appPool.query('SELECT * FROM kg_workspace_storage_usage($1)', ['other']))).rows, [], 'explicit cross-workspace calls cannot reveal totals');
  assert.deepEqual((await inScope({ ...scope, workspaceId: 'other' }, () => appPool.query('SELECT * FROM kg_workspace_storage_usage($1)', ['other']))).rows, [], 'a scope without membership cannot reveal totals');
}));
