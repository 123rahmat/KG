/**
 * Unified, dependency-free system doctor.
 *
 * This is intentionally deterministic and read-only. It gives the same fast
 * architectural health signal locally and in CI without requiring Postgres,
 * provider credentials, network access, or a second environment.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const checks = [];

async function exists(relative) {
  try { await access(path.join(root, relative)); return true; }
  catch { return false; }
}

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const requiredFiles = [
  'server.js', 'package.json', 'src/core.js', 'src/runs.js',
  'src/runtime.js', 'src/safety.js', 'src/verification.js',
  'src/code-workspace.js', 'src/project-index.js', 'src/context-compiler.js', 'src/parallel-orchestrator.js', 'src/adaptive.js',
  'tests/security.test.js', 'tests/code-workspace.test.js'
];

for (const file of requiredFiles) check(
  `required:${file}`,
  await exists(file),
  await exists(file) ? 'present' : 'missing'
);

const pkg = JSON.parse(await read('package.json'));
check('node-engine', Number(String(pkg.engines?.node ?? '').replace(/[^0-9.]/g, '')) >= 22, `requires ${pkg.engines?.node ?? 'unset'}`);
check('package-lock-sync', (await read('package-lock.json')).includes(`\"version\": \"${pkg.version}\"`), 'package.json and package-lock.json versions must match');
for (const script of ['check', 'lint', 'test', 'verify']) {
  check(`script:${script}`, typeof pkg.scripts?.[script] === 'string', pkg.scripts?.[script] ?? 'missing');
}

const core = await read('src/core.js');
const runs = await read('src/runs.js');
const workspace = await read('src/code-workspace.js');
const safety = await read('src/safety.js');
const verification = await read('src/verification.js');
const runtime = await read('src/runtime.js');
const adaptive = await read('src/adaptive.js');
const adaptiveControl = await read('src/adaptive-control.js');

check('server-owned-workflow', /SELECT[\s\S]*FOR UPDATE/.test(runs), 'run state is expected to be re-read under a row lock');
check('execution-claim-integrity', /executed\s*[:=]/.test(core + runs), 'execution state is represented explicitly');
check('workspace-path-boundary', /workspacePath\(/.test(workspace), 'workspace paths use the centralized boundary');
check('workspace-content-hash', /createHash\(['"]sha256['"]\)/.test(workspace), 'workspace revisions have deterministic content hashes');
check('safety-boundary', /export|function/.test(safety) && /BLOCK|deny|refus/i.test(safety), 'safety module is present with decision/refusal logic');
check('verification-separation', /verify|verification/i.test(verification), 'verification remains a distinct subsystem');
check('provider-governor-enforced', /providerGovernor\.run\(modelKey/.test(runtime), 'model traffic passes through the adaptive concurrency boundary');
check('runner-side-effect-no-retry', /retries:\s*0/.test(runtime), 'side-effecting runner POSTs do not retry ambiguously');
check('adaptive-efficiency-integrated', /adaptiveEffortProfile\(/.test(adaptive), 'adaptive efficiency participates in situation analysis');
check('adaptive-scope-controller', /reconcileAdaptiveTransition|adaptiveBudgetStatus/.test(adaptiveControl), 'adaptive scope is re-evaluated at transitions');

const forbidden = [
  ['eval', /\beval\s*\(/],
  ['new-function', /new\s+Function\s*\(/],
  ['child-shell', /execSync\s*\([^\n]*shell\s*:/]
];
const sourceFiles = ['server.js', 'src/core.js', 'src/runs.js', 'src/runtime.js', 'src/safety.js', 'src/verification.js', 'src/code-workspace.js'];
for (const [name, pattern] of forbidden) {
  let hit = false;
  for (const file of sourceFiles) hit ||= pattern.test(await read(file));
  check(`unsafe-pattern:${name}`, !hit, hit ? 'pattern found in critical source' : 'not found in critical source');
}

const failed = checks.filter(item => !item.ok);
const passed = checks.length - failed.length;
console.log(`Kindgleam system doctor: ${passed}/${checks.length} checks passed.`);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} — ${item.detail}`);
if (failed.length) {
  console.error(`\nSystem doctor found ${failed.length} issue(s). Fix these before release.`);
  process.exit(1);
}
console.log('\nSystem doctor passed. No release-blocking architecture issue was detected by this deterministic audit.');
