import test from 'node:test';
import assert from 'node:assert/strict';
import { projectContextKey } from '../src/runs.js';

test('same project identity is stable', () => {
  assert.equal(projectContextKey({ root: '/work/a' }), projectContextKey({ root: '/work/a' }));
});

test('different local project roots never share identity', () => {
  assert.notEqual(projectContextKey({ root: '/work/a' }), projectContextKey({ root: '/work/b' }));
});

test('attachments can establish a project identity', () => {
  const a = projectContextKey(null, [{ name: 'package.json' }, { name: 'src/app.js' }]);
  const b = projectContextKey(null, [{ name: 'package.json' }, { name: 'src/app.js' }]);
  const c = projectContextKey(null, [{ name: 'requirements.txt' }, { name: 'main.py' }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
