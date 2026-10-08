import test from 'node:test';
import assert from 'node:assert/strict';
import { systemPromptFor } from '../src/reasoning-context.js';
import { terminalArgs } from '../src/terminal.js';
import { validateJob, containerArgs } from '../src/sandbox.js';

test('governed work favors targeted context and receipt-backed execution', () => {
  const guidance = systemPromptFor({
    task: { id: 'respond', type: 'respond' },
    run: { workflow: 'adaptive', situation: {} },
    payload: {}
  });
  assert.match(guidance, /authorized isolated sandbox/);
  assert.match(guidance, /targeted reads and changed files/);
  assert.match(guidance, /Never suppress required tests/);
});

test('execution remains sandboxed and offline outside the package-install phase', () => {
  const job = validateJob({
    language: 'javascript',
    source: 'export const answer = 42;',
    tests: "import test from 'node:test'; test('answer', () => {});"
  });
  assert.ok(job.checked.includes('main.mjs'));
  assert.ok(job.checked.includes('main.test.mjs'));
  for (const phase of ['check', 'run']) {
    const args = containerArgs(job, {
      phase, workdir: '/tmp/project', name: 'one-off-test'
    });
    assert.ok(args.includes('--read-only'));
    assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
    assert.ok(args.includes('--cap-drop'));
  }
});

test('interactive terminal remains isolated and cannot replace sandbox authority', () => {
  const args = terminalArgs({
    image: 'node@sha256:' + 'f'.repeat(64),
    runtime: 'runsc',
    workdir: '/tmp/context-check'
  });
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none']);
  assert.ok(args.includes('--cap-drop'));
});
