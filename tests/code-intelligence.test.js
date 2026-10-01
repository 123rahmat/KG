import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectIndex, impactClosure, relatedSymbols, relatedTests } from '../src/project-index.js';
import { compileCodeContext, compactContextPack, isCodeTask } from '../src/context-compiler.js';
import { rolesFor } from '../src/multi-agent.js';

const files = [
  { path: 'src/auth.js', content: [
    "import { db } from './db.js';",
    'export function verifyToken(token) {',
    '  return db.verify(token);',
    '}',
    '',
    'export function requireAuth(req) {',
    '  return verifyToken(req.token);',
    '}'
  ].join('\n') },
  { path: 'src/db.js', content: 'export const db = { verify: token => Boolean(token) };' },
  { path: 'src/routes.js', content: "import { requireAuth } from './auth.js';\nexport function route(req) { return requireAuth(req); }" },
  { path: 'tests/auth.test.js', content: "import test from 'node:test';\ntest('auth', () => {});" },
  { path: 'package.json', content: '{"scripts":{"test":"node --test"}}' }
];

test('project index records deterministic runtime and test commands', () => {
  const index = buildProjectIndex([
    { path: 'package.json', content: JSON.stringify({ engines: { node: '>=22' }, dependencies: { express: '^5' }, scripts: { test: 'node --test', lint: 'eslint .' } }) },
    { path: 'package-lock.json', content: '{}' }
  ]);
  assert.equal(index.profile.packageManager, 'npm');
  assert.equal(index.profile.runtime, 'node');
  assert.ok(index.profile.frameworks.includes('express'));
  assert.ok(index.profile.testCommands.includes('node --test'));
});

test('project index is deterministic and captures semantic structure', () => {
  const index = buildProjectIndex(files, { revisionId: 'r1' });
  const again = buildProjectIndex([...files].reverse(), { revisionId: 'r1' });
  assert.equal(index.contentHash, again.contentHash);
  assert.equal(index.fileCount, 5);
  assert.ok(index.symbols.some(item => item.name === 'verifyToken' && item.path === 'src/auth.js'));
  assert.ok(index.imports.some(item => item.from === 'src/auth.js' && item.target === './db.js'));
  assert.ok(index.dependencies.some(item => item.from === 'src/routes.js' && item.to === 'src/auth.js'));
  assert.ok(index.tests.includes('tests/auth.test.js'));
  assert.ok(index.config.includes('package.json'));
});

test('impact and semantic lookup find the code neighborhood instead of the repository', () => {
  const index = buildProjectIndex(files);
  const impact = impactClosure(index, ['src/auth.js']);
  assert.ok(impact.includes('src/db.js'));
  assert.ok(impact.includes('src/routes.js'));

  const symbols = relatedSymbols(index, 'verifyToken', ['src/auth.js']);
  assert.equal(symbols[0].name, 'verifyToken');

  const tests = relatedTests(index, ['src/auth.js']);
  assert.ok(tests.includes('tests/auth.test.js'));
});

test('context compiler prioritizes changed code and related verification', () => {
  const index = buildProjectIndex(files);
  const pack = compileCodeContext({
    files,
    index,
    goal: 'fix verifyToken authentication',
    task: { id: 'build-code', type: 'code', purpose: 'fix the authentication bug', metadata: { buildPlan: true } },
    changedPaths: ['src/auth.js'],
    scale: 'standard',
    maxChars: 9000,
    maxFiles: 6
  });
  assert.equal(pack.strategy, 'semantic-minimum-sufficient-context');
  assert.equal(pack.focus.changedFiles[0], 'src/auth.js');
  assert.ok(pack.focus.relatedTests.includes('tests/auth.test.js'));
  assert.ok(pack.files.some(item => item.path === 'src/auth.js'));
  assert.ok(pack.budget.usedChars <= 9000);

  const compact = compactContextPack(pack, { maxChars: 2500, maxFiles: 3 });
  assert.ok(compact.files.length <= 3);
  assert.equal(compact.budget.maxChars, 2500);
});

test('code task detection stays conservative', () => {
  assert.equal(isCodeTask({ id: 'build-code', type: 'step' }), true);
  assert.equal(isCodeTask({ id: 'respond', type: 'respond' }), false);
});


test('context selection with sensitive files never exposes obvious secrets', () => {
  const sensitiveFiles = [
    { path: '.env', content: 'PAYMENT_API_KEY="super-secret-payment-key-value"' },
    { path: 'src/auth.js', content: 'export const apiKey = "ordinary-secret-looking-value";' }
  ];
  const index = buildProjectIndex(sensitiveFiles);
  const pack = compileCodeContext({
    files: sensitiveFiles,
    index,
    goal: 'review authentication security',
    task: { id: 'build-code', type: 'code', purpose: 'review auth', metadata: { buildPlan: true } },
    scale: 'small',
    maxChars: 5000,
    maxFiles: 4
  });
  const env = pack.files.find(item => item.path === '.env');
  assert.ok(env);
  assert.match(env.content, /sensitive file withheld/i);
  const auth = pack.files.find(item => item.path === 'src/auth.js');
  assert.ok(auth);
  assert.doesNotMatch(auth.content, /ordinary-secret-looking-value/);
  assert.match(auth.content, /\[REDACTED\]/);
});

test('adaptive code specialists recruit the right engineering perspectives', () => {
  const security = rolesFor(
    {
      goal: 'fix authentication token security bug',
      situation: { risk: 'high-impact', successCriteria: ['secure token validation'] },
      adaptation: { scale: 'complex' }
    },
    { id: 'build-code', type: 'code', purpose: 'repair the auth bug', metadata: { buildPlan: true } },
    { maxAgents: 5, mode: 'always' }
  );
  assert.ok(security.roles.includes('security-reviewer'));

  const retry = rolesFor(
    {
      goal: 'fix failing API tests',
      attempt: 2,
      situation: { successCriteria: ['tests pass'], failure: true },
      adaptation: { scale: 'standard' }
    },
    { id: 'build-code', type: 'code', purpose: 'repair the failed build', metadata: { buildPlan: true } },
    { maxAgents: 5, mode: 'always', progress: { failedRoles: [], findings: [] } }
  );
  assert.ok(retry.roles.includes('debugger') || retry.roles.includes('diagnostician'));
});
