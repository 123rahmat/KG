import test from 'node:test';
import assert from 'node:assert/strict';
import { projectContextKey, workspaceStateFor } from '../src/runs.js';

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

test('ongoing controller state is reusable only inside its workspace and project', () => {
  const previous = { surface: 'code', adaptation: {
    modeController: { mode: 'code' }, projectContext: { key: 'project-a' },
    projectOverlay: [{ path: 'app.js', content: 'old project code' }]
  } };
  assert.equal(workspaceStateFor(previous, { surface: 'code', projectKey: 'project-a' }), previous);
  assert.equal(workspaceStateFor(previous, { surface: 'code' }), previous);
  for (const surface of ['normal-chat', 'chat', 'research']) {
    assert.equal(workspaceStateFor(previous, { surface }), null, surface);
  }
  assert.equal(workspaceStateFor(previous, { surface: 'code', projectKey: 'project-b' }), null);
  assert.equal(workspaceStateFor(null, { surface: 'code' }), null);
});

test('legacy controller and chat surface identifiers preserve compatible continuation', () => {
  const chat = { surface: 'chat', adaptation: {} };
  assert.equal(workspaceStateFor(chat, { surface: 'normal-chat' }), chat);
  const research = { adaptation: { modeController: { mode: 'research' } } };
  assert.equal(workspaceStateFor(research, { surface: 'code' }), null);
  assert.equal(workspaceStateFor(research, { surface: 'research' }), research);
});
