import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS } from '../src/db.js';

test('migrations are numbered 1..n without gaps or duplicates, in order', () => {
  const versions = MIGRATIONS.map(migration => migration.version);
  assert.deepEqual(versions, versions.map((_, index) => index + 1));
  assert.equal(new Set(MIGRATIONS.map(migration => migration.name)).size, MIGRATIONS.length, 'names are unique');
});
