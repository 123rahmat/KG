import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateJob, containerArgs, runJob, testSummary, SandboxError } from '../src/sandbox.js';

const IMAGES = { python: process.env.SANDBOX_PYTHON_IMAGE || 'mirror.gcr.io/library/python:3.12-slim', node: process.env.SANDBOX_NODE_IMAGE || 'mirror.gcr.io/library/node:22-slim' };

/** Container tests run only where a container runtime and the images exist. */
function dockerReady() {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGES.python, IMAGES.node], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const withDocker = dockerReady() ? {} : { skip: 'no container runtime with the sandbox images here' };
// Networks that intercept HTTPS (corporate proxies) need their certificate authority.
const NETWORK = process.env.SANDBOX_CA_FILE ? { caFile: process.env.SANDBOX_CA_FILE } : {};

test('jobs are checked before anything runs', () => {
  const job = validateJob({ language: 'py', source: 'print(1)', packages: ['numpy', 'pandas==2.2.2', 'scipy>=1.10,<2'], files: { 'data/in.csv': 'a,b' } });
  assert.equal(job.language, 'python');
  assert.deepEqual([...job.files.keys()], ['main.py', 'data/in.csv']);
  const reject = (input, code) => assert.throws(() => validateJob(input), error => error instanceof SandboxError && error.code === code);
  reject({ language: 'ruby', source: 'x' }, 'sandbox-language');
  reject({ language: 'python', source: ' ' }, 'sandbox-no-code');
  reject({ language: 'python', source: 'x', files: { '../escape.py': '' } }, 'sandbox-file-name');
  reject({ language: 'python', source: 'x', files: { '/etc/passwd': '' } }, 'sandbox-file-name');
  reject({ language: 'python', source: 'x', files: { '.deps/sitecustomize.py': '' } }, 'sandbox-file-name');
  reject({ language: 'python', source: 'x', packages: ['--index-url=http://evil'] }, 'sandbox-package');
  reject({ language: 'python', source: 'x', packages: ['numpy --extra-index-url x'] }, 'sandbox-package');
  reject({ language: 'javascript', source: 'x', packages: ['lodash; rm -rf /'] }, 'sandbox-package');
  assert.equal(validateJob({ language: 'python', source: 'x', timeoutMs: 10 ** 9 }).timeoutMs, 120_000);
});

test('the run phase is sealed: no network, read-only, no capabilities, unprivileged, limited', () => {
  const job = validateJob({ language: 'python', source: 'x', memoryMb: 256, packages: ['numpy'] });
  const run = containerArgs(job, { phase: 'run', workdir: '/tmp/w', name: 'n' });
  const flag = name => run[run.indexOf(name) + 1];
  assert.equal(flag('--network'), 'none');
  assert.ok(run.includes('--read-only'));
  assert.ok(run.includes('--ipc=none'));
  assert.equal(flag('--cap-drop'), 'ALL');
  assert.equal(flag('--security-opt'), 'no-new-privileges');
  assert.equal(flag('--user'), '65534:65534');
  assert.equal(flag('--memory'), '256m');
  assert.equal(flag('--pids-limit'), '256');
  assert.equal(run[run.indexOf('--ulimit') + 1], 'fsize=104857600:104857600');
  assert.ok(run.includes('core=0:0'));
  const install = containerArgs(job, { phase: 'install', workdir: '/tmp/w', name: 'n' });
  assert.ok(install.includes('--only-binary=:all:'), 'no package build scripts run while installing');
  const npm = containerArgs(validateJob({ language: 'javascript', source: 'x', packages: ['lodash'] }), { phase: 'install', workdir: '/tmp/w', name: 'n' });
  assert.ok(npm.includes('--ignore-scripts'));
});

test('code runs in the sandbox and returns output and files', withDocker, async () => {
  const result = await runJob({
    language: 'python',
    source: 'import csv, json\nrows = list(csv.DictReader(open("in/loads.csv")))\ntotal = sum(float(r["watts"]) for r in rows)\nopen("out/total.json", "w").write(json.dumps({"total": total}))\nprint(total)',
    files: { 'in/loads.csv': 'room,watts\nkitchen,3000\nhall,200\n' }
  }, { images: IMAGES });
  assert.equal(result.status, 'completed', result.stderr);
  assert.equal(result.stdout.trim(), '3200.0');
  assert.deepEqual(JSON.parse(Buffer.from(result.files[0].base64, 'base64')), { total: 3200 });
  assert.equal(result.limits.network, 'none');
});

test('the sandbox has no network, cannot write the system, and stops at its time limit', withDocker, async () => {
  const network = await runJob({ language: 'python', source: 'import urllib.request\nurllib.request.urlopen("http://example.com", timeout=3)' }, { images: IMAGES });
  assert.equal(network.status, 'failed');
  assert.match(network.stderr, /URLError|Errno|resolution|unreachable/i);
  const system = await runJob({ language: 'python', source: 'open("/etc/owned", "w").write("x")' }, { images: IMAGES });
  assert.equal(system.status, 'failed');
  assert.match(system.stderr, /Read-only file system|Permission denied/);
  const user = await runJob({ language: 'python', source: 'import os\nprint(os.getuid())' }, { images: IMAGES });
  assert.equal(user.stdout.trim(), '65534');
  const slow = await runJob({ language: 'javascript', source: 'while (true) {}', timeoutMs: 2000 }, { images: IMAGES });
  assert.equal(slow.status, 'timed-out');
  assert.ok(slow.durationMs < 15_000);
});

test('the sandbox brings libraries from the web: installs a pre-built package, then runs offline', { ...withDocker, timeout: 300_000 }, async () => {
  const result = await runJob({
    language: 'python',
    packages: ['six'],
    source: 'import six\nprint(six.__version__)'
  }, { images: IMAGES, network: NETWORK });
  if (result.status === 'install-failed' && /network|resolve|connect|proxy|SSL/i.test(result.stderr)) {
    return; // No route to the package registry from this machine; the rest is covered above.
  }
  assert.equal(result.status, 'completed', result.stderr);
  assert.match(result.installed.join(' '), /six==\d/);
});

test('a project with pytest tests runs them with pytest, and old files it did not change are not its problem', { ...withDocker, timeout: 300_000 }, async () => {
  const result = await runJob({ language: 'python', project: true, check: ['calc/ops.py'], files: {
    'calc/__init__.py': '',
    'calc/ops.py': 'def add(a, b):\n    return a + b\n',
    'legacy/old script.py': 'print "python 2"\n',
    'tests/test_ops.py': 'from calc.ops import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_wrong():\n    assert add(1, 1) == 3\n'
  } }, { images: IMAGES, network: NETWORK });
  if (result.status === 'install-failed' && /network|resolve|connect|proxy|SSL/i.test(result.stderr)) {
    return; // No route to the package registry for pytest from this machine.
  }
  assert.equal(result.status, 'failed', result.stderr);
  assert.deepEqual(result.testSummary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.match(result.stdout, /test_wrong/);
});

test('tests shipped with the code are what runs, and a failing test fails the run', withDocker, async () => {
  const source = 'def area(w, h):\n    return w * h\n';
  const passing = await runJob({ language: 'python', source, tests: 'import unittest\nfrom main import area\nclass T(unittest.TestCase):\n    def test_area(self):\n        self.assertEqual(area(3, 4), 12)\n' }, { images: IMAGES });
  assert.equal(passing.status, 'completed', passing.stderr);
  assert.equal(passing.tested, true);
  assert.match(passing.stderr, /Ran 1 test/);
  assert.deepEqual(passing.testSummary, { total: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(passing.checks.syntax, 'passed');
  const failing = await runJob({ language: 'javascript', source: 'export const add = (a, b) => a - b;', tests: "import test from 'node:test'; import assert from 'node:assert'; import { add } from './main.mjs'; test('adds', () => assert.equal(add(2, 2), 4));" }, { images: IMAGES });
  assert.equal(failing.status, 'failed');
  assert.match(failing.stdout, /not ok 1 - adds/);
  assert.deepEqual(failing.testSummary, { total: 1, passed: 0, failed: 1, skipped: 0 });
});

test('a syntax error is reported as such, and nothing runs', withDocker, async () => {
  const python = await runJob({ language: 'python', source: 'open("out/ran", "w")\ndef broken(:\n  pass\n' }, { images: IMAGES });
  assert.equal(python.status, 'syntax-error');
  assert.match(python.stderr, /SyntaxError/);
  assert.deepEqual(python.files, []);
  const js = await runJob({ language: 'javascript', source: 'export const ok = 1;', tests: 'import test from "node:test"; test("x", () => { ;' }, { images: IMAGES });
  assert.equal(js.status, 'syntax-error');
  assert.match(js.stderr, /main\.test\.mjs/);
});

test('a project of several files runs all its tests, across folders, in both languages', withDocker, async () => {
  const python = await runJob({ language: 'python', project: true, files: {
    'shop/__init__.py': '',
    'shop/pricing.py': 'def total(items):\n    return round(sum(p * q for p, q in items), 2)\n',
    'shop/cart.py': 'from shop.pricing import total\nclass Cart:\n    def __init__(self):\n        self.items = []\n    def add(self, price, qty=1):\n        self.items.append((price, qty))\n    def total(self):\n        return total(self.items)\n',
    'test_cart.py': 'import unittest\nfrom shop.cart import Cart\nclass T(unittest.TestCase):\n    def test_total(self):\n        c = Cart(); c.add(2.5, 2); c.add(1)\n        self.assertEqual(c.total(), 6.0)\n',
    'tests/__init__.py': '',
    'tests/test_pricing.py': 'import unittest\nfrom shop.pricing import total\nclass T(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(total([]), 0)\n    def test_wrong(self):\n        self.assertEqual(total([(1, 1)]), 2)\n'
  } }, { images: IMAGES });
  assert.equal(python.status, 'failed');
  assert.deepEqual(python.testSummary, { total: 3, passed: 2, failed: 1, skipped: 0 });
  assert.match(python.stderr, /FAIL: test_wrong/);
  const js = await runJob({ language: 'javascript', project: true, files: {
    'lib/math.mjs': 'export const add = (a, b) => a + b;\n',
    'lib/math.test.mjs': "import test from 'node:test'; import assert from 'node:assert';\nimport { add } from './math.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n",
    'app.test.mjs': "import test from 'node:test'; import assert from 'node:assert';\nimport { add } from './lib/math.mjs';\ntest('app', () => assert.equal(add(1, 1), 2));\n"
  } }, { images: IMAGES });
  assert.equal(js.status, 'completed');
  assert.deepEqual(js.testSummary, { total: 2, passed: 2, failed: 0, skipped: 0 });
  // A syntax error in any one file stops the run before anything executes.
  const broken = await runJob({ language: 'python', project: true, entry: 'app/main.py', files: { 'app/main.py': 'import app.util\n', 'app/util.py': 'def f(:\n' } }, { images: IMAGES });
  assert.equal(broken.status, 'syntax-error');
  assert.match(broken.stderr, /app\/util\.py/);
});

test('the check phase is sealed like the run phase and checks the tests too', () => {
  const job = validateJob({ language: 'python', source: 'x = 1', tests: 'import main' });
  const check = containerArgs(job, { phase: 'check', workdir: '/tmp/w', name: 'n' });
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.ok(check.includes('--read-only'));
  assert.deepEqual(check.slice(-2), ['main.py', 'test_main.py']);
});

test('test counts are read from the test runner summary', () => {
  assert.deepEqual(testSummary('python', '', 'Ran 3 tests in 0.01s\n\nFAILED (failures=1, errors=1)'), { total: 3, passed: 1, failed: 2, skipped: 0 });
  assert.deepEqual(testSummary('python', '', 'Ran 4 tests in 0.01s\n\nOK (skipped=1)'), { total: 4, passed: 3, failed: 0, skipped: 1 });
  assert.deepEqual(testSummary('javascript', '# tests 4\n# pass 3\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0', ''), { total: 4, passed: 3, failed: 1, skipped: 0 });
  assert.equal(testSummary('python', 'hello', ''), null);
});

test('after its tests pass, the program runs on its own and its output comes back', withDocker, async () => {
  const result = await runJob({
    language: 'python',
    source: 'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nif __name__ == "__main__":\n    print(fib(30))\n',
    tests: 'import unittest\nfrom main import fib\n\nclass T(unittest.TestCase):\n    def test_small(self):\n        self.assertEqual([fib(i) for i in range(1, 8)], [1, 1, 2, 3, 5, 8, 13])\n\nif __name__ == "__main__":\n    unittest.main()\n'
  }, { images: IMAGES });
  assert.equal(result.status, 'completed', result.stderr);
  assert.equal(result.testSummary.passed, 1);
  assert.equal(result.program.exitCode, 0);
  assert.equal(result.program.stdout.trim(), '832040');
  // A failing test means the program is not run for an answer.
  const failing = await runJob({ language: 'python', source: 'def f():\n    return 1\nprint("ran")\n', tests: 'import unittest\nfrom main import f\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(f(), 2)\n' }, { images: IMAGES });
  assert.equal(failing.status, 'failed');
  assert.equal(failing.program, undefined);
});

test('a multi-file project runs its entry file after its tests pass, for its output', withDocker, async () => {
  const text = value => ({ text: value });
  const result = await runJob({
    language: 'python', project: true,
    files: {
      'pendulum.py': text('import math\n\ndef angle(t):\n    return round(20 * math.exp(-0.05 * t) * math.cos(3.13 * t), 2)\n'),
      'main.py': text('from pendulum import angle\n\nprint(angle(0))\n'),
      'test_pendulum.py': text('import unittest\nfrom pendulum import angle\n\nclass T(unittest.TestCase):\n    def test_start(self):\n        self.assertEqual(angle(0), 20)\n')
    }
  }, { images: IMAGES });
  assert.equal(result.status, 'completed', result.stderr);
  assert.equal(result.testSummary.passed, 1);
  assert.equal(result.program.stdout.trim(), '20.0');
});

test('sandbox outputs never follow links out of the job folder', async () => {
  const { collectOutputs } = await import('../src/sandbox.js');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kg-escape-'));
  const secret = path.join(os.tmpdir(), `kg-host-secret-${process.pid}`);
  await fsp.writeFile(secret, 'HOST SECRET');
  try {
    // The code replaced /work/out itself with a link to a host folder.
    await fsp.symlink(os.tmpdir(), path.join(dir, 'out'));
    assert.deepEqual(await collectOutputs(dir), [], 'a linked out folder is not read');

    // A real out folder holding a link to a host file, and a normal file.
    await fsp.unlink(path.join(dir, 'out'));
    await fsp.mkdir(path.join(dir, 'out', 'sub'), { recursive: true });
    await fsp.symlink(secret, path.join(dir, 'out', 'leak.txt'));
    await fsp.symlink(os.tmpdir(), path.join(dir, 'out', 'sub', 'hostdir'));
    await fsp.writeFile(path.join(dir, 'out', 'result.txt'), 'ok');
    const found = await collectOutputs(dir);
    assert.deepEqual(found.map(item => item.name), ['result.txt']);
    assert.ok(!JSON.stringify(found).includes(Buffer.from('HOST SECRET').toString('base64')));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(secret, { force: true });
  }
});
