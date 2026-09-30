import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateJob, containerArgs, runJob, testSummary, SandboxError, DEFAULT_IMAGES, languageName } from '../src/sandbox.js';

const IMAGES = { ...DEFAULT_IMAGES };
/** Each language's container tests run only where its image exists. */
const withImage = key => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGES[key]], { stdio: 'ignore' });
    return { timeout: 300_000 };
  } catch {
    return { skip: `no ${IMAGES[key]} image here` };
  }
};
const run = job => runJob(job, { images: IMAGES });

test('the sandbox runs seven languages, by any of their usual names', () => {
  assert.deepEqual(['py', 'js', 'golang', 'java', 'c', 'c++', 'rs'].map(languageName), ['python', 'javascript', 'go', 'java', 'c', 'cpp', 'rust']);
  const reject = (input, code) => assert.throws(() => validateJob(input), error => error instanceof SandboxError && error.code === code);
  reject({ language: 'cobol', source: 'x' }, 'sandbox-language');
  // Packages come from the web only for Python and JavaScript.
  reject({ language: 'go', source: 'package main', packages: ['github.com/x/y'] }, 'sandbox-package');
});

test('compiled languages run as projects: checked, built and tested in their own way', () => {
  const go = validateJob({ language: 'go', source: 'package main\nfunc main() {}\n', tests: 'package main\nimport "testing"\nfunc TestX(t *testing.T) {}\n' });
  assert.equal(go.project, true);
  assert.ok(go.files.has('go.mod'), 'a module is made for the code');
  assert.equal(go.timeoutMs, 90_000, 'Go builds its standard library in each run');
  assert.match(go.command.at(-1), /go test -v \.\/\.\.\./);
  const goArgs = containerArgs(go, { phase: 'run', workdir: '/w', name: 'n' });
  assert.ok(goArgs.includes('GOCACHE=/work/.cache/go') && goArgs[goArgs.indexOf('--network') + 1] === 'none');

  const java = validateJob({ language: 'java', source: 'public class Main {}', tests: 'package shop;\npublic class MainTest {}' });
  assert.deepEqual(java.checked, ['Main.java', 'MainTest.java'], 'Java compiles every file to check it');
  assert.match(java.command.at(-1), /java -cp \/work\/\.out 'shop\.MainTest'/);

  const c = validateJob({ language: 'c', project: true, check: ['geom.c'], files: { 'geom.h': '', 'geom.c': '', 'main.c': '', 'test_geom.c': '' } });
  assert.deepEqual(c.checked, ['geom.c']);
  assert.match(c.command.at(-1), /gcc -std=c17 -O1 -I\. -o \/work\/\.out\/t0 'geom\.c' 'test_geom\.c' -lm/, 'a test is built with the code but not its main file');
  const cpp = validateJob({ language: 'cpp', source: 'int main() {}' });
  assert.match(cpp.command.at(-1), /g\+\+ -std=c\+\+20 .* 'main\.cpp'.* && exec \/work\/\.out\/app$/);

  const rust = validateJob({ language: 'rust', source: 'fn main() {}\n#[cfg(test)]\nmod tests { #[test] fn t() {} }\n' });
  assert.equal(rust.tested, true, 'tests written inside the code count');
  assert.ok(rust.files.has('Cargo.toml') && rust.files.has('src/main.rs'));
  assert.equal(rust.memoryMb, 1024);
  assert.deepEqual(rust.command, ['sh', '-c', 'exec cargo test --offline']);
});

test('each language reports how many tests passed and failed', () => {
  assert.deepEqual(testSummary('go', '=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n    --- SKIP: TestB/sub (0.00s)\n'), { total: 3, passed: 1, failed: 1, skipped: 1 });
  assert.deepEqual(testSummary('rust', 'test result: FAILED. 3 passed; 1 failed; 2 ignored; 0 measured\ntest result: ok. 1 passed; 0 failed; 0 ignored'), { total: 7, passed: 4, failed: 1, skipped: 2 });
  assert.deepEqual(testSummary('java', 'ok 1 - area\nnot ok 2 - zero\n# FAIL MainTest.java\n'), { total: 2, passed: 1, failed: 1, skipped: 0 });
  // A program that failed without saying which test (a crash, a build error) is one failure.
  assert.deepEqual(testSummary('c', 'ok 1 - a\n# PASS test_a.c\n# FAIL test_b.c\n'), { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(testSummary('cpp', '# PASS test_a.cpp\n# FAIL test_b.cpp\n'), { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.equal(testSummary('go', 'no tests here'), null);
});

test('Go: a package with tests across folders; a failing test fails the run; a syntax error runs nothing', withImage('go'), async () => {
  const project = await run({ language: 'go', project: true, files: {
    'calc/calc.go': 'package calc\n\nfunc Add(a, b int) int { return a + b }\n',
    'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(2, 3) != 5 { t.Fatal("bad") } }\nfunc TestWrong(t *testing.T) { if Add(1, 1) != 3 { t.Fatal("1+1 is not 3") } }\n',
    'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"app/calc"\n)\n\nfunc main() { fmt.Println(calc.Add(1, 2)) }\n'
  } });
  assert.equal(project.status, 'failed', project.stderr);
  assert.deepEqual(project.testSummary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  const program = await run({ language: 'go', source: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello from go") }\n' });
  assert.equal(program.status, 'completed', program.stderr);
  assert.match(program.stdout, /hello from go/);
  const broken = await run({ language: 'go', source: 'package main\n\nfunc main( {\n' });
  assert.equal(broken.status, 'syntax-error');
});

test('Java: test classes are compiled with the program and each is run', withImage('java'), async () => {
  const result = await run({ language: 'java',
    source: 'public class Main {\n  static int area(int w, int h) { return w * h; }\n  public static void main(String[] a) { System.out.println(area(3, 4)); }\n}\n',
    tests: 'public class MainTest {\n  public static void main(String[] a) {\n    boolean ok = Main.area(3, 4) == 12;\n    System.out.println((ok ? "ok" : "not ok") + " 1 - area");\n    if (!ok) System.exit(1);\n  }\n}\n' });
  assert.equal(result.status, 'completed', result.stderr);
  assert.deepEqual(result.testSummary, { total: 1, passed: 1, failed: 0, skipped: 0 });
  const broken = await run({ language: 'java', source: 'public class Main { void f( }\n' });
  assert.equal(broken.status, 'syntax-error');
  assert.match(broken.stderr, /Main\.java:1: error/);
});

test('C and C++: each test program is built with the code and run on its own', withImage('gcc'), async () => {
  const c = await run({ language: 'c', project: true, files: {
    'geom.h': 'int area(int w, int h);\n', 'geom.c': '#include "geom.h"\nint area(int w, int h) { return w * h; }\n',
    'main.c': '#include <stdio.h>\n#include "geom.h"\nint main(void) { printf("%d\\n", area(3, 4)); return 0; }\n',
    'test_geom.c': '#include <assert.h>\n#include "geom.h"\nint main(void) { assert(area(3, 4) == 12); return 0; }\n',
    'test_wrong.c': '#include <assert.h>\n#include "geom.h"\nint main(void) { assert(area(1, 1) == 2); return 0; }\n'
  } });
  assert.equal(c.status, 'failed');
  assert.deepEqual(c.testSummary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  const cpp = await run({ language: 'c++', source: '#include <iostream>\nint main() { std::cout << "hello from c++" << std::endl; }\n' });
  assert.equal(cpp.status, 'completed', cpp.stderr);
  assert.match(cpp.stdout, /hello from c\+\+/);
  const broken = await run({ language: 'c', source: 'int main( { return 0; }\n' });
  assert.equal(broken.status, 'syntax-error');
});

test('Rust: tests inside the code run with cargo, offline', withImage('rust'), async () => {
  const result = await run({ language: 'rust', source: 'fn add(a: i32, b: i32) -> i32 { a + b }\n\nfn main() { println!("{}", add(1, 2)); }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn adds() { assert_eq!(add(2, 3), 5); }\n    #[test]\n    fn wrong() { assert_eq!(add(1, 1), 3); }\n}\n' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.testSummary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  const broken = await run({ language: 'rust', source: 'fn main( {\n' });
  assert.equal(broken.status, 'syntax-error');
});

test('a language runs only if this sandbox has it turned on, and its toolchain is fetched in the background the first time it is needed', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-docker-'));
  const log = path.join(dir, 'calls.log');
  const present = path.join(dir, 'present');
  // A stand-in container CLI: an image is present once pulled; pulling fails for images named "broken".
  const docker = path.join(dir, 'docker');
  await fs.writeFile(docker, `#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = image ]; then grep -qx "$3" ${present} 2>/dev/null && exit 0; exit 1; fi\nif [ "$1" = pull ]; then sleep 0.2; case "$3" in *broken*) echo "manifest unknown" >&2; exit 1;; esac; echo "$3" >> ${present}; exit 0; fi\nexit 0\n`, { mode: 0o755 });
  const down = path.join(dir, 'docker-down');
  await fs.writeFile(down, '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n', { mode: 0o755 });
  const job = validateJob({ language: 'go', source: 'package main\nfunc main() {}\n' });
  const { languageReady, pullsInFlight } = await import('../src/sandbox.js');

  assert.match((await languageReady(job, { docker, languages: new Set(['python']) })).message, /Running Go code is not turned on/);
  assert.match((await languageReady(job, { docker })).message, /Go toolchain \(golang:1\.23-alpine\) is not installed/);
  assert.equal((await languageReady(job, { docker: down, pullOnDemand: true })).status, 'sandbox-unavailable');
  // Several jobs at once start one fetch and are told to run again shortly, instead of waiting on it.
  const first = await Promise.all([1, 2, 3].map(() => languageReady(job, { docker, pullOnDemand: true })));
  assert.deepEqual(first.map(result => result?.status), ['toolchain-preparing', 'toolchain-preparing', 'toolchain-preparing']);
  await pullsInFlight();
  assert.equal(await languageReady(job, { docker, pullOnDemand: true }), null);
  const calls = (await fs.readFile(log, 'utf8')).split('\n').filter(line => line.startsWith('pull'));
  assert.equal(calls.length, 1);
  // An image that does not exist is reported as unavailable, not retried forever.
  const broken = { docker, pullOnDemand: true, images: { ...IMAGES, go: 'broken/go' } };
  assert.equal((await languageReady(job, broken)).status, 'toolchain-preparing');
  await pullsInFlight();
  const failed = await languageReady(job, broken);
  assert.equal(failed.status, 'language-unavailable');
  assert.match(failed.message, /manifest unknown/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('code runs even when the server writes files with a strict umask', withImage('python'), async () => {
  const previous = process.umask(0o077);
  try {
    const result = await run({ language: 'python', project: true, files: {
      'primes/check.py': 'def is_prime(n):\n    return n > 1 and all(n % i for i in range(2, int(n ** 0.5) + 1))\n',
      'test_check.py': 'import unittest\nfrom primes.check import is_prime\n\nclass T(unittest.TestCase):\n    def test(self):\n        self.assertTrue(is_prime(7))\n        self.assertFalse(is_prime(8))\n\nif __name__ == "__main__":\n    unittest.main()\n'
    } });
    assert.equal(result.status, 'completed', result.stderr);
  } finally {
    process.umask(previous);
  }
});
