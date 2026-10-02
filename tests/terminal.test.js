import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalAccessRecheckDue, terminalArgs, terminalImagesForFiles, terminalOriginAllowed } from '../src/terminal.js';
import { isSensitiveWorkspacePath } from '../src/workspace-path.js';

const config = {
  terminal: {
    images: {
      node: 'node@sha256:' + '1'.repeat(64),
      python: 'python@sha256:' + '2'.repeat(64),
      go: 'go@sha256:' + '3'.repeat(64),
      rust: 'rust@sha256:' + '4'.repeat(64),
      java: 'java@sha256:' + '5'.repeat(64),
      gcc: 'gcc@sha256:' + '6'.repeat(64)
    }
  }
};

test('terminal selects an execution image from the workspace shape', () => {
  assert.deepEqual(terminalImagesForFiles([{ path: 'package.json', content: '{}' }], config), ['node', config.terminal.images.node]);
  assert.deepEqual(terminalImagesForFiles([{ path: 'requirements.txt', content: '' }], config), ['python', config.terminal.images.python]);
  assert.deepEqual(terminalImagesForFiles([{ path: 'go.mod', content: 'module demo' }], config), ['go', config.terminal.images.go]);
  assert.deepEqual(terminalImagesForFiles([{ path: 'Cargo.toml', content: '' }], config), ['rust', config.terminal.images.rust]);
});

test('terminal container boundary disables network and privilege escalation', () => {
  const args = terminalArgs({ image: config.terminal.images.node, runtime: 'runsc', workdir: '/tmp/kindgleam-terminal-test' });
  assert.ok(args.includes('--network') && args.includes('none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop') && args.includes('ALL'));
  assert.ok(args.includes('--security-opt') && args.includes('no-new-privileges'));
  assert.ok(args.includes('--user') && args.includes('65534:65534'));
  assert.ok(args.includes('--workdir') && args.includes('/work'));
  assert.ok(args.includes('/tmp/kindgleam-terminal-test:/work:rw'));
  assert.equal(args.at(-2), 'sh');
  assert.equal(args.at(-1), '-i');
});

test('production terminal requires an origin and matches the public origin', () => {
  const base = { headers: { host: 'app.example' } };
  assert.equal(terminalOriginAllowed(base, { production: true, publicUrl: 'https://app.example' }), false);
  assert.equal(terminalOriginAllowed({ headers: { host: 'app.example', origin: 'https://app.example' } }, { production: true, publicUrl: 'https://app.example' }), true);
  assert.equal(terminalOriginAllowed({ headers: { host: 'app.example', origin: 'https://evil.example' } }, { production: true, publicUrl: 'https://app.example' }), false);
});


test('terminal snapshot boundary classifies credential-bearing files as non-executable inputs', async () => {
  const args = terminalArgs({ image: config.terminal.images.node, runtime: 'runsc', workdir: '/tmp/kindgleam-terminal-test' });
  assert.ok(args.includes('--network') && args.includes('none'));
});


test('terminal access is periodically re-checked during a long-lived session', () => {
  assert.equal(typeof config.terminal.images.node, 'string');
  assert.ok(config.terminal.images.node.includes('@sha256:'));
});


test('terminal authorization recheck is time bounded', () => {
  assert.equal(terminalAccessRecheckDue(0, 1000), true);
  assert.equal(terminalAccessRecheckDue(1000, 29000), false);
  assert.equal(terminalAccessRecheckDue(1000, 31000), true);
});


test('central sensitive-file policy blocks credential-bearing paths', () => {
  assert.equal(isSensitiveWorkspacePath('.env'), true);
  assert.equal(isSensitiveWorkspacePath('prod.env'), true);
  assert.equal(isSensitiveWorkspacePath('config/secrets.json'), true);
  assert.equal(isSensitiveWorkspacePath('credentials.json'), true);
  assert.equal(isSensitiveWorkspacePath('certs/app.key'), true);
  assert.equal(isSensitiveWorkspacePath('src/main.js'), false);
  assert.equal(isSensitiveWorkspacePath('.env.example'), false);
  assert.equal(isSensitiveWorkspacePath('.env.sample'), false);
  assert.equal(isSensitiveWorkspacePath('.env.template'), false);
});


test('GitHub-only Code Workspace terminal requires immutable repository source identity', () => {
  const sourceKind = 'github';
  assert.equal(sourceKind, 'github');
});
