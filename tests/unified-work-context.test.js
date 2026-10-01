import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedWorkContext, applyWorkChange } from '../src/unified-work-context.js';
import { isWorkspacePath, workspacePath } from '../src/workspace-path.js';

test('one strict workspace-path rule protects workflow context and sandbox paths', () => {
  assert.equal(workspacePath('src/components/App.jsx'), 'src/components/App.jsx');
  for (const unsafe of ['../secret', '/etc/passwd', 'src/../secret', 'src//file.js', '.env', 'src/.hidden/file.js', 'src/file.js ', '  src/file.js']) {
    assert.equal(isWorkspacePath(unsafe), false, unsafe);
  }
});

test('workflow, filesystem and code share one project-owned context', () => {
  const context = buildUnifiedWorkContext({
    goal: 'Fix the React app',
    project: { root: 'C:/projects/app' },
    attachments: [{ id: 'a', name: 'app.zip', format: 'project', readable: true }],
    files: [{ path: 'src/App.jsx', type: 'code' }, { path: 'README.md', type: 'text' }]
  });
  assert.equal(context.unified, true);
  assert.equal(context.workflow.ownsContext, true);
  assert.equal(context.code.enabled, true);
  assert.deepEqual(context.code.editablePaths, ['src/App.jsx']);
  assert.equal(context.filesystem.scope, 'active-workspace-and-project');
  assert.ok(context.identity.key);
  assert.equal(context.chat.conversationId, null);
  assert.equal(context.chat.memory.scope, 'unavailable');
  assert.equal(context.chat.multiAgent.mode, 'auto');
});

test('material code changes update the same context instead of creating a second state', () => {
  const context = buildUnifiedWorkContext({
    project: { id: 'project-a' },
    files: [{ path: 'src/a.js' }, { path: 'src/b.js' }]
  });
  const next = applyWorkChange(context, {
    files: [{ path: 'src/c.js', type: 'code' }],
    deleted: ['src/b.js']
  });
  assert.deepEqual(next.filesystem.files.map(file => file.path), ['src/a.js', 'src/c.js']);
  assert.ok(next.code.editablePaths.includes('src/c.js'));
  assert.ok(!next.filesystem.files.some(file => file.path === 'src/b.js'));
  assert.equal(next.identity.key, context.identity.key);
});

test('project identities prevent unrelated file contexts from being merged', () => {
  const a = buildUnifiedWorkContext({ project: { root: 'C:/A' }, files: [{ path: 'a.js' }] });
  const b = buildUnifiedWorkContext({ project: { root: 'C:/B' }, files: [{ path: 'b.py' }] });
  assert.notEqual(a.identity.key, b.identity.key);
});


test('material changes preserve explicit project identity and advance context revision', () => {
  const context = buildUnifiedWorkContext({
    project: { root: 'C:/projects/app' },
    files: [{ path: 'src/a.js' }]
  });
  const next = applyWorkChange(context, {
    files: [{ path: 'src/b.js', type: 'code' }],
    deleted: ['src/a.js']
  });
  assert.equal(next.identity.key, context.identity.key);
  assert.equal(next.revision, context.revision + 1);
  assert.deepEqual(next.lastChange.files, ['src/b.js']);
  assert.deepEqual(next.lastChange.deleted, ['src/a.js']);
});


test('deleted overlay state remains deleted after a later material change', () => {
  const context = buildUnifiedWorkContext({
    project: { id: 'project-delete' },
    projectOverlay: [{ path: 'src/old.js', content: null }],
    files: [{ path: 'src/new.js' }]
  });
  const next = applyWorkChange(context, { files: [{ path: 'src/next.js' }] });
  assert.ok(next.filesystem.deleted.includes('src/old.js'));
});


test('unified code workspace context binds chat memory and multi-agent settings to one conversation', () => {
  const context = buildUnifiedWorkContext({
    goal: 'Fix the app',
    project: { id: 'project-chat' },
    conversationId: 'chat-12345678',
    multiAgent: { mode: 'always', maxAgents: 3 },
    files: [{ path: 'src/app.js', type: 'code' }]
  });
  assert.equal(context.chat.conversationId, 'chat-12345678');
  assert.equal(context.chat.memory.scope, 'conversation');
  assert.equal(context.chat.memory.alwaysOn, true);
  assert.equal(context.chat.memory.crossChat, 'user-controlled');
  assert.equal(context.chat.multiAgent.mode, 'always');
  assert.equal(context.chat.multiAgent.maxAgents, 3);
  assert.equal(context.chat.multiAgent.serverOrchestrated, true);
});
