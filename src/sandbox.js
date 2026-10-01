/**
 * The sandbox: runs code Kindgleam writes, with the libraries it needs from
 * the public package registries, sealed off from everything else.
 *
 * Two phases, each in its own throwaway container:
 *   install  only when packages are asked for. May reach the registries, but
 *            installs pre-built wheels (pip --only-binary) and runs no npm
 *            scripts, so no package code runs while downloading.
 *   check    a syntax check of the code and its tests, same sealing as run.
 *   run      no network at all, read-only system, no capabilities, no
 *            privilege escalation, an unprivileged user, and limits on memory,
 *            CPU, processes, file size and time. Only /work is writable.
 * The container runtime (Docker, or a compatible one such as Podman or gVisor
 * via runsc) is the isolation layer; this module never runs code on the host.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isWorkspacePath } from './workspace-path.js';

export const LANGUAGES = Object.freeze({
  python: {
    file: 'main.py', command: ['python', 'main.py'], testFile: 'test_main.py', testCommand: ['python', '-m', 'unittest', '-v', 'test_main'], image: 'python', installer: 'pip',
    // A project of several files: every test_*.py is found and run.
    code: /\.py$/, test: /(^|\/)(test[^/]*|[^/]*_test)\.py$/, run: ['python'], projectTestCommand: ['python', '-m', 'unittest', 'discover', '-v', '-s', '.', '-p', 'test*.py'],
    // Tests written for pytest (plain test functions, no unittest) run with pytest.
    pytestCommand: ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'],
    // Parses without running or writing anything (no .pyc files).
    checkCommand: files => ['python', '-c', 'import ast, sys\nfor name in sys.argv[1:]:\n    ast.parse(open(name, encoding="utf-8").read(), name)', ...files]
  },
  javascript: {
    file: 'main.mjs', command: ['node', 'main.mjs'], testFile: 'main.test.mjs', testCommand: ['node', '--test', 'main.test.mjs'], image: 'node', installer: 'npm',
    // A project of several files: node --test finds every *.test.mjs itself.
    code: /\.(mjs|cjs|js)$/, test: /\.test\.(mjs|cjs|js)$/, run: ['node'], projectTestCommand: ['node', '--test'],
    // node --check reads one file at a time; the names are passed as
    // arguments, never written into the shell command.
    checkCommand: files => ['sh', '-c', 'for f do node --check "$f" || exit 1; done', 'sh', ...files]
  },
  // Compiled languages run as a project (one file or many): `plan` builds
  // the run from the files, with no packages from the web (nothing is
  // installed for them) and their own compile check.
  go: {
    file: 'main.go', testFile: 'main_test.go', image: 'go', installer: null,
    // Go builds its standard library afresh in each sealed run: allow for it.
    code: /\.go$/, test: /_test\.go$/, defaultTimeoutMs: 90_000,
    env: ['GOCACHE=/work/.cache/go', 'GOTMPDIR=/work/.tmp', 'GOPATH=/work/.gopath', 'GOTOOLCHAIN=local', 'CGO_ENABLED=0', 'GOFLAGS=-mod=mod'],
    prepare: files => { if (!files.has('go.mod')) files.set('go.mod', Buffer.from('module app\n\ngo 1.23\n')); },
    // gofmt -e reports every syntax error without building anything.
    checkCommand: files => ['gofmt', '-l', '-e', ...files],
    plan: ({ tested, entry }) => shell(`mkdir -p /work/.tmp /work/.cache && exec go ${tested ? 'test -v ./...' : `run ./${entry && entry.includes('/') ? quote(entry.slice(0, entry.lastIndexOf('/'))) : '.'}`}`)
  },
  java: {
    file: 'Main.java', testFile: 'MainTest.java', image: 'java', installer: null,
    code: /\.java$/, test: /(^|\/)([^/]*Test|Test[^/]*)\.java$/, wholeCheck: true, checkTimeoutMs: 90_000,
    // Compiling is the check: it needs every file, and the classes it
    // writes are what the run phase starts.
    checkCommand: files => ['sh', '-c', 'mkdir -p /work/.out && javac -encoding UTF-8 -d /work/.out "$@"', 'sh', ...files],
    plan: ({ files, testFiles, tested, entry }) => {
      const classOf = name => {
        const pkg = files.get(name).toString('utf8').match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
        return `${pkg ? `${pkg}.` : ''}${name.split('/').pop().replace(/\.java$/, '')}`;
      };
      return tested
        ? shell(eachProgram(testFiles.map(name => ({ name, run: `java -cp /work/.out ${quote(classOf(name))}` }))))
        : shell(`exec java -cp /work/.out ${quote(classOf(entry))}`);
    }
  },
  c: nativeSpec({ file: 'main.c', testFile: 'test_main.c', compiler: 'gcc', std: '-std=c17', ext: 'c', libs: '-lm' }),
  cpp: nativeSpec({ file: 'main.cpp', testFile: 'test_main.cpp', compiler: 'g++', std: '-std=c++20', ext: '(?:cpp|cc|cxx)', libs: '-lm' }),
  rust: {
    file: 'src/main.rs', testFile: null, image: 'rust', installer: null,
    // Rust tests live in the code: tests sent on their own join the main file.
    appendTests: tests => `\n\n#[cfg(test)]\nmod sandbox_tests {\n    #[allow(unused_imports)]\n    use super::*;\n${tests.split('\n').map(line => (line ? `    ${line}` : line)).join('\n')}\n}\n`,
    code: /\.rs$/, test: /(^|\/)tests\/[^/]*\.rs$/, inline: /#\[test\]/, wholeCheck: true,
    checkTimeoutMs: 120_000, minMemoryMb: 1024,
    env: ['CARGO_HOME=/work/.cargo', 'CARGO_TARGET_DIR=/work/.target', 'CARGO_NET_OFFLINE=true', 'CARGO_TERM_COLOR=never'],
    prepare: files => {
      if (!files.has('Cargo.toml')) files.set('Cargo.toml', Buffer.from('[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n'));
    },
    checkCommand: () => ['cargo', 'check', '--offline', '--all-targets', '--quiet'],
    plan: ({ tested }) => shell(tested ? 'exec cargo test --offline' : 'exec cargo run --offline --quiet')
  }
});

/** A C or C++ toolchain: each test program is built with the code (not its main file) and run on its own. */
function nativeSpec({ file, testFile, compiler, std, ext, libs }) {
  return {
    file, testFile, image: 'gcc', installer: null,
    code: new RegExp(`\\.${ext}$`), test: new RegExp(`(^|/)(test[^/]*|[^/]*_test)\\.${ext}$`),
    headers: /\.(h|hpp|hh)$/,
    checkCommand: files => ['sh', '-c', `for f do ${compiler} ${std} -I. -fsyntax-only "$f" || exit 1; done`, 'sh', ...files],
    plan: ({ code, testFiles, tested, entry }) => {
      const library = code.filter(name => !testFiles.includes(name) && name !== (entry ?? file) && name !== file);
      const build = (sources, output) => `${compiler} ${std} -O1 -I. -o ${output} ${sources.map(quote).join(' ')} ${libs}`;
      return tested
        ? shell(`mkdir -p /work/.out; ${eachProgram(testFiles.map((name, index) => ({ name, build: build([...library, name], `/work/.out/t${index}`), run: `/work/.out/t${index}` })))}`)
        : shell(`mkdir -p /work/.out && ${build(code.filter(name => !testFiles.includes(name)), '/work/.out/app')} && exec /work/.out/app`);
    }
  };
}

// File names are checked by FILE_NAME and cannot hold a quote, so single
// quotes make each one a single, literal shell word.
const quote = value => `'${String(value)}'`;
const shell = script => ['sh', '-c', script];

/** Run each test program in turn; report "# PASS name" / "# FAIL name" and fail if any fails. */
function eachProgram(programs) {
  return `fail=0; ${programs.map(({ name, build, run }) => `if ${build ? `${build} && ` : ''}${run}; then echo "# PASS "${quote(name)}; else echo "# FAIL "${quote(name)}; fail=1; fi;`).join(' ')} exit $fail`;
}
export function isImmutableImageReference(value) {
  return /^[^@\s]+@sha256:[0-9a-f]{64}$/i.test(String(value ?? '').trim());
}

export function assertProductionSandboxConfiguration({ images = DEFAULT_IMAGES, runtime = '', installProxy = '', tlsConfigured = false, pullOnDemand = false, languages = null } = {}) {
  if (!String(runtime ?? '').trim()) throw new Error('SANDBOX_RUNTIME is required in production');
  const runtimeName = path.basename(String(runtime).trim());
  if (!['runsc', 'kata-runtime'].includes(runtimeName)) {
    throw new Error('SANDBOX_RUNTIME must be an isolated runtime such as runsc or kata-runtime in production');
  }
  if (!String(installProxy ?? '').trim()) {
    throw new Error('SANDBOX_INSTALL_PROXY is required in production so package-install egress can be controlled');
  }
  let proxy;
  try { proxy = new URL(String(installProxy).trim()); } catch { throw new Error('SANDBOX_INSTALL_PROXY must be a valid HTTPS URL in production'); }
  if (proxy.protocol !== 'https:') throw new Error('SANDBOX_INSTALL_PROXY must use HTTPS in production');
  if (!tlsConfigured) throw new Error('Sandbox runner TLS certificate and key are required in production');
  if (pullOnDemand) throw new Error('SANDBOX_PULL_ON_DEMAND=false is required in production; pre-pull pinned images during deployment');
  const enabled = languages && languages.size ? [...languages] : Object.keys(LANGUAGES);
  for (const name of enabled) {
    const key = LANGUAGES[name]?.image;
    const image = images?.[key];
    if (!image || !isImmutableImageReference(image)) {
      throw new Error(`Sandbox image for ${name} must be pinned to an immutable @sha256 digest in production`);
    }
  }
  return true;
}

export const LIMITS = Object.freeze({
  maxFiles: 40, maxProjectFiles: 300, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024,
  maxPackages: 20, maxTimeoutMs: 120_000, defaultTimeoutMs: 30_000, installTimeoutMs: 180_000,
  maxMemoryMb: 2048, defaultMemoryMb: 512, maxOutputBytes: 64 * 1024, maxResultFileBytes: 2 * 1024 * 1024
});
const CHECK_TIMEOUT_MS = 30_000;
export const DEFAULT_IMAGES = Object.freeze({
  python: 'python:3.12-slim', node: 'node:22-slim', go: 'golang:1.23-alpine', java: 'eclipse-temurin:21-jdk-alpine', gcc: 'gcc:14', rust: 'rust:1-alpine'
});
// Other names people and models use for the same languages.
const ALIASES = { py: 'python', python3: 'python', js: 'javascript', node: 'javascript', nodejs: 'javascript', golang: 'go', 'c++': 'cpp', cxx: 'cpp', rs: 'rust' };
export const languageName = value => { const name = String(value ?? '').toLowerCase().trim(); return ALIASES[name] ?? name; };

const PIP_PACKAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]{1,80}\])?(\s*(==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]{1,40}(\s*,\s*(==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]{1,40})*)?$/;
const NPM_PACKAGE = /^(@[a-z0-9~-][a-z0-9._~-]{0,100}\/)?[a-z0-9~-][a-z0-9._~-]{0,100}(@[A-Za-z0-9.^~<>=*|+ -]{1,60})?$/;
// Relative paths are validated by the shared workspace boundary.

export class SandboxError extends Error {
  constructor(message, code = 'sandbox-invalid') {
    super(message);
    this.code = code;
  }
}

/**
 * Check and normalise a job: { language, source, files, packages, stdin,
 * timeoutMs, memoryMb }. `files` maps names to { text } or { base64 }.
 *
 * With `project: true` the code is the files themselves (a program of
 * several modules): every code file is syntax-checked, then all its test
 * files run together, or `entry` runs when there are none.
 */
export function validateJob(input = {}) {
  const language = languageName(input.language);
  const spec = LANGUAGES[language];
  if (!spec) throw new SandboxError(`The sandbox runs ${Object.keys(LANGUAGES).join(' or ')}, not "${input.language}".`, 'sandbox-language');
  // A compiled language always runs as a project, even from one file.
  const project = input.project === true || Boolean(spec.plan);
  const source = String(input.source ?? '');
  if (!project && !source.trim()) throw new SandboxError('There is no code to run.', 'sandbox-no-code');
  const files = new Map(source.trim() ? [[spec.file, Buffer.from(source, 'utf8')]] : []);
  // With tests, the tests are what runs: they import the main file.
  const tests = String(input.tests ?? '');
  if (tests.trim() && spec.testFile) files.set(spec.testFile, Buffer.from(tests, 'utf8'));
  else if (tests.trim() && spec.appendTests && files.has(spec.file)) files.set(spec.file, Buffer.concat([files.get(spec.file), Buffer.from(spec.appendTests(tests), 'utf8')]));
  for (const [name, value] of Object.entries(input.files ?? {})) {
    if (!isWorkspacePath(name) || name.startsWith('.deps')) throw new SandboxError(`"${name}" is not an allowed file name.`, 'sandbox-file-name');
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8')
      : value?.base64 !== undefined ? Buffer.from(String(value.base64), 'base64') : Buffer.from(String(value?.text ?? ''), 'utf8');
    if (bytes.length > LIMITS.maxFileBytes) throw new SandboxError(`"${name}" is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`, 'sandbox-too-large');
    files.set(name, bytes);
  }
  const maxFiles = project ? LIMITS.maxProjectFiles : LIMITS.maxFiles;
  if (files.size > maxFiles) throw new SandboxError(`At most ${maxFiles} files.`, 'sandbox-too-many-files');
  const total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > LIMITS.maxTotalBytes) throw new SandboxError('The files are too large together.', 'sandbox-too-large');
  const packages = [...new Set((Array.isArray(input.packages) ? input.packages : []).map(item => String(item).trim()).filter(Boolean))];
  if (packages.length && !spec.installer) throw new SandboxError(`Packages from the web are installed only for Python and JavaScript; ${language} code must use its standard library.`, 'sandbox-package');
  if (packages.length > LIMITS.maxPackages) throw new SandboxError(`At most ${LIMITS.maxPackages} packages.`, 'sandbox-too-many-packages');
  const pattern = spec.installer === 'pip' ? PIP_PACKAGE : NPM_PACKAGE;
  const bad = packages.find(item => !pattern.test(item) || /\s(-|--)/.test(` ${item}`) || item.startsWith('-'));
  if (bad) throw new SandboxError(`"${bad}" is not a valid ${spec.installer} package name.`, 'sandbox-package');
  const timeoutMs = Math.min(LIMITS.maxTimeoutMs, Math.max(1000, Math.floor(Number(input.timeoutMs) || spec.defaultTimeoutMs || LIMITS.defaultTimeoutMs)));
  const memoryMb = Math.min(LIMITS.maxMemoryMb, Math.max(spec.minMemoryMb ?? 64, Math.floor(Number(input.memoryMb) || LIMITS.defaultMemoryMb)));
  const stdin = input.stdin === undefined ? '' : typeof input.stdin === 'string' ? input.stdin : JSON.stringify(input.stdin);
  if (Buffer.byteLength(stdin) > LIMITS.maxFileBytes) throw new SandboxError('The input is too large.', 'sandbox-too-large');
  const base = { language, spec, files, packages, timeoutMs, memoryMb, stdin };
  if (project) {
    spec.prepare?.(files);
    const code = [...files.keys()].filter(name => spec.code.test(name)).sort();
    if (!code.length) throw new SandboxError('There is no code to run.', 'sandbox-no-code');
    const testFiles = code.filter(name => spec.test.test(name));
    // Tests written inside the code (Rust's #[test]) count as tests too.
    const tested = testFiles.length > 0 || Boolean(spec.inline && code.some(name => spec.inline.test(files.get(name).toString('utf8'))));
    const entry = input.entry ? String(input.entry) : files.has(spec.file) ? spec.file : null;
    if (entry && !code.includes(entry)) throw new SandboxError(`The entry file "${entry}" is not one of the code files.`, 'sandbox-entry');
    // Go and Rust find their own program; the others need tests or an entry.
    if (!tested && !entry && !['go', 'rust'].includes(language)) throw new SandboxError('A project needs test files or an entry file to run.', 'sandbox-no-entry');
    // Only the files this change wrote are syntax-checked (`check`); an old
    // file it did not touch is not its problem, and the tests still run it.
    // A compiled language that must build the whole program to check it
    // (Java, Rust) checks every file.
    const wanted = new Set((Array.isArray(input.check) ? input.check : []).map(String));
    const checkable = spec.headers ? [...files.keys()].filter(name => spec.code.test(name) || spec.headers.test(name)).sort() : code;
    const checked = wanted.size && !spec.wholeCheck ? checkable.filter(name => wanted.has(name)) : checkable;
    if (spec.plan) {
      if (!tested && entry && !code.includes(entry)) throw new SandboxError(`The entry file "${entry}" is not one of the code files.`, 'sandbox-entry');
      return { ...base, project: true, tested, checked: checked.length ? checked : code, command: spec.plan({ files, code, testFiles, tested, entry: entry ?? (code.includes(spec.file) ? spec.file : null) }) };
    }
    // Plain test functions without unittest are pytest tests.
    const pytest = spec.pytestCommand && tested && testFiles.some(name => {
      const body = files.get(name).toString('utf8');
      return !/\bunittest\b/.test(body) && (/^\s*def test_/m.test(body) || /\bimport pytest\b/.test(body));
    });
    const withRunner = pytest && !packages.some(item => /^pytest\b/i.test(item)) ? [...packages, 'pytest'] : packages;
    if (withRunner.length > LIMITS.maxPackages) throw new SandboxError(`At most ${LIMITS.maxPackages} packages.`, 'sandbox-too-many-packages');
    return {
      ...base, packages: withRunner, project: true, tested, checked: checked.length ? checked : code,
      command: pytest ? spec.pytestCommand : tested ? spec.projectTestCommand : [...spec.run, entry],
      // After its tests pass, the project's entry runs on its own for its output.
      ...(tested && entry && spec.run ? { programCommand: [...spec.run, entry] } : {})
    };
  }
  // The code and its tests are checked for syntax before anything runs.
  const checked = [spec.file, ...(tests.trim() ? [spec.testFile] : [])];
  return { ...base, tested: Boolean(tests.trim()), checked };
}

// The program's own run after its tests pass is short: it is for its output.
const PROGRAM_TIMEOUT_MS = 15000;

/** The hardening every sandbox container gets. */
function hardening({ memoryMb, network, user }) {
  return [
    '--rm', '--init',
    '--network', network,
    '--read-only',
    '--ipc=none',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb}m`,
    '--cpus', '1',
    '--ulimit', 'fsize=104857600:104857600',
    '--ulimit', 'nofile=1024:1024',
    '--ulimit', 'core=0:0',
    '--user', user,
    '--workdir', '/work',
    '-e', 'HOME=/tmp', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PYTHONPATH=/work/.deps', '-e', 'NODE_PATH=/work/.deps/node_modules',
    '-e', 'PIP_DISABLE_PIP_VERSION_CHECK=1', '-e', 'npm_config_cache=/tmp/.npm', '-e', 'npm_config_update_notifier=false'
  ];
}

/** Arguments for the container runtime; exported so they can be checked. */
export function containerArgs(job, { phase, workdir, name, images = DEFAULT_IMAGES, runtime = null, user = '65534:65534', network = {} }) {
  const image = images[job.spec.image];
  // Only the install phase may reach the registries, optionally through the
  // deployment's proxy and trusting its certificate authority.
  const reach = phase === 'install' ? [
    // Unpacking large wheels needs more room than the small /tmp.
    '-e', 'TMPDIR=/work/.tmp',
    ...(network.caFile ? ['-v', `${network.caFile}:/etc/sandbox-ca.pem:ro`, '-e', 'PIP_CERT=/etc/sandbox-ca.pem', '-e', 'npm_config_cafile=/etc/sandbox-ca.pem', '-e', 'NODE_EXTRA_CA_CERTS=/etc/sandbox-ca.pem'] : []),
    ...(network.proxy ? ['-e', `HTTPS_PROXY=${network.proxy}`, '-e', `https_proxy=${network.proxy}`, '-e', `npm_config_https_proxy=${network.proxy}`] : [])
  ] : [];
  const args = ['run', '--name', name, ...(runtime ? ['--runtime', runtime] : []), ...hardening({ memoryMb: phase === 'install' ? 1024 : job.memoryMb, network: phase === 'install' ? 'bridge' : 'none', user }),
    ...reach, ...(job.spec.env ?? []).flatMap(item => ['-e', item]),
    '-v', `${workdir}:/work:rw`, ...(phase === 'run' && job.stdin ? ['-i'] : []), image];
  if (phase === 'install') {
    return [...args, ...(job.spec.installer === 'pip'
      ? ['python', '-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:', '--no-input', '--target', '/work/.deps', '--', ...job.packages]
      : ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--prefix', '/work/.deps', ...job.packages])];
  }
  if (phase === 'check') return [...args, ...job.spec.checkCommand(job.checked)];
  const command = job.command ?? (job.tested ? job.spec.testCommand : job.spec.command) ?? job.spec.run;
  if (!Array.isArray(command) || !command.length) {
    throw new SandboxError('Sandbox run command is not configured', 'sandbox-command');
  }
  return [...args, ...command];
}

/**
 * How many tests ran, passed and failed, read from the test runner's own
 * summary (unittest -v, node --test). Null when there is no summary.
 */
export function testSummary(language, stdout = '', stderr = '') {
  const output = `${stdout}\n${stderr}`;
  if (language === 'python') {
    const ran = output.match(/^Ran (\d+) tests? in /m);
    if (!ran) {
      // pytest: "3 passed, 1 failed, 2 skipped in 0.12s"
      const line = output.split('\n').reverse().find(item => /\b\d+ (passed|failed|errors?)\b.* in [\d.]+s\b/.test(item));
      if (!line) return null;
      const count = key => Number(line.match(new RegExp(`(\\d+) ${key}`))?.[1] ?? 0);
      const passed = count('passed');
      const failed = count('failed') + count('errors?');
      const skipped = count('skipped') + count('xfailed');
      return { total: passed + failed + skipped, passed, failed, skipped };
    }
    const total = Number(ran[1]);
    const failed = output.match(/^FAILED \(([^)]*)\)/m)?.[1] ?? '';
    const count = key => Number(failed.match(new RegExp(`${key}=(\\d+)`))?.[1] ?? 0);
    const failures = count('failures') + count('errors');
    const skipped = Number(output.match(/^OK \(skipped=(\d+)\)/m)?.[1] ?? 0) + count('skipped');
    return { total, passed: Math.max(0, total - failures - skipped), failed: failures, skipped };
  }
  const summary = (passed, failed, skipped = 0) => ({ total: passed + failed + skipped, passed, failed, skipped });
  const count = pattern => (output.match(pattern) ?? []).length;
  if (language === 'go') {
    // go test -v: one "--- PASS/FAIL/SKIP: Name" line per test and subtest.
    if (!/^\s*--- (PASS|FAIL|SKIP): /m.test(output)) return null;
    return summary(count(/^\s*--- PASS: /gm), count(/^\s*--- FAIL: /gm), count(/^\s*--- SKIP: /gm));
  }
  if (language === 'rust') {
    // cargo test: a "test result: ok. 3 passed; 0 failed; 1 ignored" line per test binary.
    const results = [...output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
    if (!results.length) return null;
    const sum = index => results.reduce((total, match) => total + Number(match[index]), 0);
    return summary(sum(1), sum(2), sum(3));
  }
  if (['java', 'c', 'cpp'].includes(language)) {
    // Test programs that print TAP ("ok 1 - name" / "not ok 2 - name") are
    // counted test by test; otherwise each program counts as one test.
    const tapOk = count(/^ok \d+/gm);
    const tapFailed = count(/^not ok \d+/gm);
    const programsPassed = count(/^# PASS /gm);
    const programsFailed = count(/^# FAIL /gm);
    // A program that failed without reporting a failing test (it crashed,
    // or did not compile) is one failure more.
    if (tapOk + tapFailed > 0) return summary(tapOk, tapFailed + (tapFailed === 0 ? programsFailed : 0));
    return programsPassed + programsFailed ? summary(programsPassed, programsFailed) : null;
  }
  const read = key => {
    const value = output.match(new RegExp(`^[#ℹ] ${key} (\\d+)`, 'm'));
    return value ? Number(value[1]) : null;
  };
  const total = read('tests');
  if (total === null) return null;
  return { total, passed: read('pass') ?? 0, failed: (read('fail') ?? 0) + (read('cancelled') ?? 0), skipped: (read('skipped') ?? 0) + (read('todo') ?? 0) };
}

function capture(stream, limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  stream.on('data', chunk => {
    if (size >= limit) { truncated = true; return; }
    const room = limit - size;
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    if (chunk.length > room) truncated = true;
    size += Math.min(chunk.length, room);
  });
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated });
}

/** Run the container runtime once; kill the container at the time limit. */
function runContainer(docker, args, { name, timeoutMs, stdin = '' }) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = capture(child.stdout, LIMITS.maxOutputBytes);
    const err = capture(child.stderr, LIMITS.maxOutputBytes);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn(docker, ['kill', name], { stdio: 'ignore' }).on('error', () => {});
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: error.message, timedOut: false, durationMs: Date.now() - started, failedToStart: true });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = out();
      const stderr = err();
      resolve({ exitCode: code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated, timedOut, durationMs: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/**
 * A path under the job folder that is safe to read after the code ran: its
 * real location is inside the folder and it is not a link. The code in the
 * container controls everything under /work, so it can replace any file or
 * folder there, even /work/out itself, with a link to the host's own files.
 * Reads that followed such a link would hand host files back as "outputs".
 */
async function realInside(root, target) {
  try {
    const [base, real, link] = await Promise.all([fs.realpath(root), fs.realpath(target), fs.lstat(target)]);
    if (link.isSymbolicLink()) return null;
    return real === base || real.startsWith(base + path.sep) ? { real, stat: link } : null;
  } catch {
    return null;
  }
}

/** Files the code wrote to /work/out, small ones with their content. */
export async function collectOutputs(dir) {
  const out = path.join(dir, 'out');
  const found = [];
  let total = 0;
  const top = await realInside(dir, out);
  if (!top?.stat.isDirectory()) return found;
  async function walk(folder, prefix) {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (found.length >= LIMITS.maxFiles) return;
      const full = path.join(folder, entry.name);
      const rel = `${prefix}${entry.name}`;
      const safe = await realInside(out, full);
      if (!safe) continue;
      if (safe.stat.isDirectory()) { await walk(full, `${rel}/`); continue; }
      if (!safe.stat.isFile()) continue;
      const include = total + safe.stat.size <= LIMITS.maxResultFileBytes;
      // O_NOFOLLOW: a link swapped in after the check is refused, not followed.
      const bytes = include ? await readNoFollow(full) : null;
      if (include && !bytes) continue;
      if (include) total += bytes.length;
      found.push({ name: rel, bytes: bytes ? bytes.length : safe.stat.size, ...(bytes ? { base64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : { omitted: 'too large to return' }) });
    }
  }
  await walk(out, '');
  return found;
}

async function readNoFollow(file) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.maxResultFileBytes) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Installed package names and versions, read from what was installed. */
async function installedVersions(dir, installer) {
  const deps = path.join(dir, '.deps');
  // The code ran after the install, so it may have swapped these for links.
  if (!(await realInside(dir, deps))?.stat.isDirectory()) return [];
  try {
    if (installer === 'pip') {
      const entries = await fs.readdir(deps);
      return entries.map(name => name.match(/^(.+)-([^-]+)\.dist-info$/)).filter(Boolean).map(match => `${match[1]}==${match[2]}`).sort();
    }
    const lockFile = path.join(deps, 'node_modules', '.package-lock.json');
    if (!(await realInside(deps, lockFile))?.stat.isFile()) return [];
    const raw = await readNoFollow(lockFile);
    if (!raw) return [];
    const lock = JSON.parse(raw.toString('utf8'));
    return Object.entries(lock.packages ?? {}).filter(([key]) => key.startsWith('node_modules/') && !key.slice(13).includes('node_modules/'))
      .map(([key, value]) => `${key.slice(13)}@${value.version}`).sort();
  } catch {
    return [];
  }
}

/**
 * Run a job. Returns { status, exitCode, stdout, stderr, timedOut, files,
 * installed, durationMs, limits, image }. Never throws for the code's own
 * failures: those are results.
 */
// Each language's image, fetched in the background the first time it is
// needed: a first download can take minutes, longer than any request waits,
// so the job is told to come back rather than held open (and it never holds
// a sandbox slot while it waits).
const pulls = new Map();
const PULL_TIMEOUT_MS = 20 * 60_000;
// A failed download that may succeed later (the registry or network was
// down) is tried again after this long; a missing image is not.
const PULL_RETRY_MS = 5 * 60_000;
const PERMANENT_PULL = /manifest unknown|not found|does not exist|denied|unauthorized|invalid reference|repository name must/i;

function dockerCommand(docker, args, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(docker, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = capture(child.stderr, 4096);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, message: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, message: err().text.trim() }); });
  });
}

/** Downloads still running (for tests and shutdown). */
export const pullsInFlight = () => Promise.all([...pulls.values()].map(item => item.promise).filter(Boolean));

/**
 * Whether this sandbox can run the job's language now. Returns null when it
 * can; otherwise why not:
 * - { status: 'language-unavailable' } when it never will here (not turned
 *   on, not installed and not fetched on demand, or no such image);
 * - { status: 'toolchain-preparing' } while its image is being fetched;
 * - { status: 'sandbox-unavailable' } when the container runtime is down or a
 *   download failed for a reason that may pass (try again later).
 */
export async function languageReady(job, { docker = 'docker', images = DEFAULT_IMAGES, languages = null, pullOnDemand = false } = {}) {
  const label = { cpp: 'C++', javascript: 'JavaScript' }[job.language] ?? job.language[0].toUpperCase() + job.language.slice(1);
  if (languages && !languages.has(job.language)) {
    return { status: 'language-unavailable', message: `Running ${label} code is not turned on for this sandbox.` };
  }
  const image = images[job.spec.image];
  const inspected = await dockerCommand(docker, ['image', 'inspect', image], 30_000);
  if (inspected.ok) return null;
  // Is the image missing, or is the runtime itself down?
  if (!(await dockerCommand(docker, ['version'], 30_000)).ok) {
    return { status: 'sandbox-unavailable', message: 'The container runtime is not responding; nothing was run. Try again shortly.' };
  }
  if (!pullOnDemand) return { status: 'language-unavailable', message: `The ${label} toolchain (${image}) is not installed on the sandbox server.` };
  const known = pulls.get(image);
  if (known?.state === 'failed' && known.permanent) {
    return { status: 'language-unavailable', message: `The ${label} toolchain (${image}) could not be fetched: ${known.message}` };
  }
  if (known?.state === 'failed' && Date.now() - known.at < PULL_RETRY_MS) {
    return { status: 'sandbox-unavailable', message: `The ${label} toolchain could not be fetched just now (${known.message}); try again in a few minutes.` };
  }
  if (known?.state !== 'pulling') {
    const entry = { state: 'pulling', at: Date.now() };
    entry.promise = dockerCommand(docker, ['pull', '--quiet', image], PULL_TIMEOUT_MS).then(result => {
      if (result.ok) pulls.delete(image);
      else pulls.set(image, { state: 'failed', at: Date.now(), permanent: PERMANENT_PULL.test(result.message), message: result.message.slice(0, 300) || 'the download failed' });
    });
    pulls.set(image, entry);
  }
  return { status: 'toolchain-preparing', message: `The ${label} toolchain is being set up on the sandbox for the first time (a few minutes). Nothing was run yet; run this step again shortly.` };
}

export async function runJob(input, { docker = 'docker', images = DEFAULT_IMAGES, runtime = null, workRoot = os.tmpdir(), network = {}, languages = null, pullOnDemand = false } = {}) {
  const job = validateJob(input);
  const unavailable = await languageReady(job, { docker, images, languages, pullOnDemand });
  if (unavailable) return { ...unavailable, language: job.language, image: images[job.spec.image] };
  const dir = await fs.mkdtemp(path.join(workRoot, 'kindgleam-sandbox-'));
  const id = crypto.randomBytes(6).toString('hex');
  try {
    await fs.mkdir(path.join(dir, 'out'), { recursive: true });
    await fs.mkdir(path.join(dir, '.deps'), { recursive: true });
    await fs.mkdir(path.join(dir, '.tmp'), { recursive: true });
    for (const [name, bytes] of job.files) {
      const folder = path.dirname(path.join(dir, name));
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(dir, name), bytes);
      // Explicit modes: a server run with a strict umask (077) would otherwise
      // write files the unprivileged container user cannot read.
      await fs.chmod(path.join(dir, name), 0o644);
      for (let at = folder; at !== dir && at.startsWith(dir); at = path.dirname(at)) await fs.chmod(at, 0o755);
    }
    // The unprivileged container user writes only inside the work folder.
    await fs.chmod(dir, 0o777);
    for (const sub of ['out', '.deps', '.tmp']) await fs.chmod(path.join(dir, sub), 0o777);

    let install = null;
    if (job.packages.length) {
      install = await runContainer(docker, containerArgs(job, { phase: 'install', workdir: dir, name: `gai-install-${id}`, images, runtime, network }), { name: `gai-install-${id}`, timeoutMs: LIMITS.installTimeoutMs });
      if (install.failedToStart) return { status: 'sandbox-unavailable', message: `The container runtime could not start: ${install.stderr}` };
      if (install.exitCode !== 0) {
        return {
          status: 'install-failed', exitCode: install.exitCode, timedOut: install.timedOut,
          stdout: install.stdout, stderr: install.stderr, packages: job.packages,
          message: install.timedOut ? 'Installing the packages took too long.' : 'The packages could not be installed (only pre-built packages are allowed).'
        };
      }
    }
    await fs.rm(path.join(dir, '.tmp'), { recursive: true, force: true });
    // A syntax error is reported as such, before any code runs.
    const check = await runContainer(docker, containerArgs(job, { phase: 'check', workdir: dir, name: `gai-check-${id}`, images, runtime }), { name: `gai-check-${id}`, timeoutMs: job.spec.checkTimeoutMs ?? CHECK_TIMEOUT_MS });
    if (check.failedToStart) return { status: 'sandbox-unavailable', message: `The container runtime could not start: ${check.stderr}` };
    if (check.exitCode !== 0) {
      return {
        status: check.timedOut ? 'timed-out' : 'syntax-error', exitCode: check.exitCode, timedOut: check.timedOut,
        stdout: check.stdout, stderr: check.stderr, durationMs: check.durationMs, files: [], installed: [],
        image: images[job.spec.image], language: job.language, tested: job.tested, checks: { syntax: 'failed' },
        message: 'The code has a syntax error; nothing was run.'
      };
    }
    const run = await runContainer(docker, containerArgs(job, { phase: 'run', workdir: dir, name: `gai-run-${id}`, images, runtime }), { name: `gai-run-${id}`, timeoutMs: job.timeoutMs, stdin: job.stdin });
    if (run.failedToStart) return { status: 'sandbox-unavailable', message: `The container runtime could not start: ${run.stderr}` };
    // Tests show the code is right; the program itself gives the answer
    // ("run it and tell me the result"). After passing tests, the program (a
    // single file, or a project's entry file) runs once more on its own,
    // sealed the same way and briefly.
    let program = null;
    const programCommand = job.project ? job.programCommand : job.spec.command;
    if (job.tested && run.exitCode === 0 && !run.timedOut && programCommand) {
      const alone = { ...job, tested: false, command: programCommand };
      const ran = await runContainer(docker, containerArgs(alone, { phase: 'run', workdir: dir, name: `gai-program-${id}`, images, runtime }), { name: `gai-program-${id}`, timeoutMs: Math.min(job.timeoutMs, PROGRAM_TIMEOUT_MS), stdin: job.stdin });
      if (!ran.failedToStart) program = { exitCode: ran.exitCode, timedOut: ran.timedOut, stdout: ran.stdout, stderr: ran.stderr, durationMs: ran.durationMs };
    }
    return {
      ...(program ? { program } : {}),
      status: run.timedOut ? 'timed-out' : run.exitCode === 0 ? 'completed' : 'failed',
      exitCode: run.exitCode, timedOut: run.timedOut, stdout: run.stdout, stderr: run.stderr, truncated: run.truncated,
      durationMs: run.durationMs, files: await collectOutputs(dir),
      installed: job.packages.length ? await installedVersions(dir, job.spec.installer) : [],
      image: images[job.spec.image], language: job.language, tested: job.tested,
      checks: { syntax: 'passed' },
      ...(job.tested ? { testSummary: testSummary(job.language, run.stdout, run.stderr) } : {}),
      limits: { timeoutMs: job.timeoutMs, memoryMb: job.memoryMb, network: 'none', cpus: 1 }
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The job in a runner payload: an explicit job, or a chat code step's code. */
export function jobFromPayload(body) {
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
  if (payload.job && typeof payload.job === 'object') return payload.job;
  return { language: payload.language, source: payload.source, tests: payload.tests, packages: payload.packages, files: payload.files, project: payload.project === true, entry: payload.entry, check: payload.check, stdin: payload.stdin, timeoutMs: payload.timeoutMs };
}
