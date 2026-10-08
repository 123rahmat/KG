import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectIndex } from '../src/project-index.js';
import { compileCodeContext, compactContextPack, CONTEXT_BUDGETS } from '../src/context-compiler.js';

test('large model-context overrides never bypass advanced character and file ceilings', () => {
  const files = Array.from({ length: 54 }, (_, i) => ({
    path: 'src/module' + i + '.js',
    content: 'export const item' + i + ' = ' + i + ';\n' + 'x'.repeat(1100)
  }));
  const index = buildProjectIndex(files);
  const pack = compileCodeContext({
    files, index, goal: 'Review the project structure',
    task: { id: 'review-code', type: 'code' },
    maxChars: 10 ** 12, maxFiles: 10 ** 10
  });
  assert.ok(pack);
  assert.equal(pack.budget.maxChars, CONTEXT_BUDGETS.advanced.maxChars);
  assert.ok(pack.files.length <= CONTEXT_BUDGETS.advanced.maxFiles);
});

test('changed files are prioritized even under smaller context budgets', () => {
  const files = [
    { path: 'src/ordinary.js', content: 'export const a = 1;\n' + 'a'.repeat(5000) },
    { path: 'src/critical.js', content: 'export const critical = 2;\n' + 'b'.repeat(5000) }
  ];
  const pack = compileCodeContext({
    files, index: buildProjectIndex(files),
    goal: 'Fix src/critical.js',
    task: { id: 'build-code', type: 'code' },
    changedPaths: ['src/critical.js'],
    maxChars: 4000, maxFiles: 2
  });
  assert.ok(pack.files.some(item => item.path === 'src/critical.js'));
  assert.equal(pack.budget.maxChars, 4000);
});

test('compaction limits excessive caller budgets without losing critical change context', () => {
  const pack = {
    version: 1, focus: { changedFiles: ['src/critical.js'], relevantSymbols: [] },
    files: [
      { path: 'src/critical.js', kind: 'code', content: 'important'.repeat(4500) },
      { path: 'src/other.js', kind: 'code', content: 'other'.repeat(4500) }
    ]
  };
  const bounded = compactContextPack(pack, { maxChars: Infinity, maxFiles: Infinity });
  assert.equal(bounded.budget.maxChars, 18_000);
  assert.ok(bounded.files.some(file => file.path === 'src/critical.js'));
  const maxed = compactContextPack(pack, { maxChars: 10 ** 12, maxFiles: 10 ** 8 });
  assert.equal(maxed.budget.maxChars, CONTEXT_BUDGETS.advanced.maxChars);
  assert.ok(maxed.files.reduce((sum, item) => sum + item.content.length, 0) <= CONTEXT_BUDGETS.advanced.maxChars);
});


test('project context cache reuses identical input but invalidates on changed files', () => {
  const files = [{ path: 'src/counter.js', content: 'export const count = 1;\n' }];
  const index = buildProjectIndex(files, { revisionId: 'rev-one' });
  const options = { files, index, goal: 'Check the counter',
    task: { id: 'review-code', type: 'code' } };
  const a = compileCodeContext(options);
  assert.equal(compileCodeContext(options), a, 'unchanged inputs reuse the exact pack');
  const revised = compileCodeContext({ ...options,
    files: [{ path: 'src/counter.js', content: 'export const count = 2;\n' }] });
  assert.notEqual(revised, a, 'changed bytes must not reuse stale context');
  assert.match(revised.files[0].content, /count = 2/);
  assert.notEqual(revised.project.workspaceContentHash, a.project.workspaceContentHash);
});

test('context cache incorporates failure evidence and prior attempts', () => {
  const files = [{ path: 'src/check.js', content: 'export const checked = true;\n' }];
  const index = buildProjectIndex(files, { revisionId: 'rev-check' });
  const common = { files, index, goal: 'Debug an issue',
    task: { id: 'debug-code', type: 'code', purpose: 'Diagnose a failing test' } };
  const a = compileCodeContext({ ...common, failure: { stderr: 'error one' },
    previousAttempts: [{ status: 'failed', summary: 'first attempt' }] });
  const b = compileCodeContext({ ...common, failure: { stderr: 'error two' },
    previousAttempts: [{ status: 'failed', summary: 'second attempt' }] });
  assert.notEqual(a, b);
  assert.match(b.failure.stderr, /error two/);
  assert.match(b.previousAttempts[0].summary, /second attempt/);
});
