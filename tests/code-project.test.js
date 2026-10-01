import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonResponse, stepsIn, advanceTo, codeWritten } from './helpers.js';
import { zip } from './document-fixtures.js';
import { codeFiles, missingTests, sandboxPayload, mergeFix, builtCode, repairContext, hasCode, normalizePackage, repairDecision } from '../src/code-workflow.js';
import { validateJob, containerArgs, SandboxError, testSummary } from '../src/sandbox.js';
import { readProject, formatOf } from '../src/documents.js';
import { projectView, rankFiles, words } from '../src/project-view.js';

const geminiReply = (textValue, { groundingMetadata = undefined, finishReason = 'STOP' } = {}) => jsonResponse({
  candidates: [{
    content: { parts: [{ text: textValue }] },
    finishReason,
    ...(groundingMetadata ? { groundingMetadata } : {})
  }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 }
});

function modelRequest(options) {
  const body = JSON.parse(options.body);
  const texts = (Array.isArray(body.contents) ? body.contents : [])
    .filter(message => message?.role === 'user')
    .flatMap(message => Array.isArray(message?.parts) ? message.parts : [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .reverse();
  let request = {};
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.task) {
        request = parsed;
        break;
      }
    } catch {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (parsed && typeof parsed === 'object' && parsed.task) {
            request = parsed;
            break;
          }
        } catch { /* not a structured task */ }
      }
    }
  }
  return { body, request };
}

const project = {
  language: 'python',
  files: [
    { path: 'shop/__init__.py', content: '' },
    { path: 'shop/cart.py', content: 'from shop.pricing import total\n' },
    { path: 'shop/pricing.py', content: 'def total(items):\n    return sum(items)\n' },
    { path: 'tests/__init__.py', content: '' },
    { path: 'tests/test_cart.py', content: 'import unittest\n\nclass CartTest(unittest.TestCase):\n  def test_imports(self):\n    self.assertTrue(True)\n' }
  ],
  packages: []
};

test('a code package can be a project of several files, with its tests as files', () => {
  assert.equal(hasCode(project), true);
  assert.equal(missingTests(project), false);
  assert.equal(missingTests({ language: 'python', files: [{ path: 'app.py', content: 'x = 1' }] }), true, 'a project without test files');
  assert.equal(missingTests({ language: 'javascript', files: [{ path: 'lib/a.mjs', content: 'x' }, { path: 'lib/a.test.mjs', content: "test('a', () => {});" }] }), false);
  // Unsafe or repeated paths never get through.
  const paths = codeFiles({ files: [{ path: '../etc/passwd', content: 'x' }, { path: '/abs.py', content: 'x' }, { path: 'a/.hidden', content: 'x' }, { path: 'ok.py', content: '1' }, { path: 'ok.py', content: '2' }] }).map(file => file.path);
  assert.deepEqual(paths, ['a/.hidden', 'ok.py']);
});

test('a project runs on top of the attached project: unchanged files stay, changed ones replace them', () => {
  const payload = sandboxPayload(
    { language: 'python', files: [{ path: 'shop/pricing.py', content: 'NEW' }, { path: 'tests/test_discount.py', content: 'import unittest' }] },
    { baseFiles: [{ path: 'shop/pricing.py', content: 'OLD' }, { path: 'shop/__init__.py', content: '' }, { path: '../bad.py', content: 'x' }] }
  );
  assert.equal(payload.project, true);
  assert.deepEqual(Object.keys(payload.files).sort(), ['shop/__init__.py', 'shop/pricing.py', 'tests/test_discount.py']);
  assert.equal(payload.files['shop/pricing.py'], 'NEW');
  // A single file stays a single file.
  assert.deepEqual(sandboxPayload({ language: 'python', source: 'print(1)', tests: 'import main' }), { language: 'python', source: 'print(1)', tests: 'import main' });
});

test('a fix returns only the files it changes and is laid over the project it fixes', () => {
  const fixed = mergeFix(project, { language: 'python', files: [{ path: 'shop/pricing.py', content: 'def total(items):\n    return round(sum(items), 2)\n' }] });
  assert.equal(fixed.files.length, project.files.length);
  assert.match(fixed.files.find(file => file.path === 'shop/pricing.py').content, /round/);
  assert.equal(fixed.files.find(file => file.path === 'shop/cart.py').content, 'from shop.pricing import total\n');
  // The record kept for a repair holds the whole project; what the fix is shown is within budget.
  const big = { ...project, files: [...project.files, { path: 'data.py', content: 'x'.repeat(90_000) }] };
  const tasks = [{ id: 'build-code', evidence: { structured: big } }];
  assert.equal(builtCode(tasks, { whole: true }).files.at(-1).content.length, 90_000);
  const shown = repairContext({ attempt: 1, adaptation: { codeRepairs: [{ attempt: 1, round: 1, code: builtCode(tasks, { whole: true }), failure: { status: 'failed' } }] } });
  assert.match(shown.previousCode.files.at(-1).content, /\[cut: 90000 characters in all\]$/);
});

test('the sandbox checks every file of a project and runs all its tests', () => {
  const job = validateJob({ language: 'python', project: true, files: Object.fromEntries(project.files.map(file => [file.path, file.content])) });
  assert.equal(job.tested, true);
  assert.deepEqual(job.checked, ['shop/__init__.py', 'shop/cart.py', 'shop/pricing.py', 'tests/__init__.py', 'tests/test_cart.py']);
  const args = containerArgs(job, { phase: 'run', workdir: '/tmp/w', name: 'n' });
  assert.deepEqual(args.slice(-9), ['python', '-m', 'unittest', 'discover', '-v', '-s', '.', '-p', 'test*.py']);
  const node = validateJob({ language: 'javascript', project: true, files: { 'lib/a.mjs': 'export const a = 1;', 'lib/a.test.mjs': 'x' } });
  assert.deepEqual(containerArgs(node, { phase: 'run', workdir: '/tmp/w', name: 'n' }).slice(-2), ['node', '--test']);
  // Without tests, the entry file runs.
  const entry = validateJob({ language: 'python', project: true, entry: 'app/main.py', files: { 'app/main.py': 'print(1)', 'app/util.py': '' } });
  assert.deepEqual(containerArgs(entry, { phase: 'run', workdir: '/tmp/w', name: 'n' }).slice(-2), ['python', 'app/main.py']);
  const reject = (input, code) => assert.throws(() => validateJob(input), error => error instanceof SandboxError && error.code === code);
  reject({ language: 'python', project: true, files: { 'app/util.py': '' } }, 'sandbox-no-entry');
  reject({ language: 'python', project: true, entry: 'nope.py', files: { 'a.py': '', 'test_a.py': '' } }, 'sandbox-entry');
  reject({ language: 'python', project: true, files: { 'readme.md': 'hi' } }, 'sandbox-no-code');
  reject({ language: 'python', project: true, files: { '-rf.py': '' } }, 'sandbox-file-name');
  reject({ language: 'python', project: true, files: { 'a/-x.py': '' } }, 'sandbox-file-name');
});

test('a change counts the tests it already had, and a package in any shape is stored in one', () => {
  const change = { language: 'python', files: [{ path: 'shop/pricing.py', content: 'x = 1' }] };
  assert.equal(missingTests(change), true);
  assert.equal(missingTests(change, { previous: project }), false, 'a fix to a tested project');
  assert.equal(missingTests(change, { baseFiles: [{ path: 'tests/test_shop.py', content: 'def test_x(): pass' }] }), false, 'a change to an attached, tested project');
  assert.equal(missingTests(change, { baseFiles: [{ path: 'shop/cart.py', content: 'x' }] }), true);
  // The model may list files as a map or with name/text; they are stored as [{ path, content }].
  assert.deepEqual(normalizePackage({ language: 'python', files: { 'a.py': '1', 'test_a.py': '2' } }).files, [{ path: 'a.py', content: '1' }, { path: 'test_a.py', content: '2' }]);
  assert.deepEqual(normalizePackage({ language: 'python', files: [{ name: 'my app.py', text: '1' }] }).files, [{ path: 'my app.py', content: '1' }]);
  // Only what the change wrote is syntax-checked.
  assert.deepEqual(sandboxPayload(change, { baseFiles: [{ path: 'legacy.py', content: 'print "x"' }] }).check, ['shop/pricing.py']);
});

test('the sandbox knows pytest tests, and names with spaces are passed safely', () => {
  const job = validateJob({ language: 'python', project: true, files: { 'my app/core.py': 'x = 1', 'tests/test_core.py': 'def test_x():\n    assert True\n' } });
  assert.deepEqual(job.command, ['python', '-m', 'pytest', '-q', '-p', 'no:cacheprovider']);
  assert.deepEqual(job.packages, ['pytest']);
  assert.deepEqual(validateJob({ language: 'python', project: true, files: { 'test_a.py': 'import unittest' } }).command.slice(0, 4), ['python', '-m', 'unittest', 'discover']);
  assert.deepEqual(testSummary('python', '....F\n==== 1 failed, 4 passed, 1 skipped in 0.05s ====', ''), { total: 6, passed: 4, failed: 1, skipped: 1 });
  const node = validateJob({ language: 'javascript', project: true, files: { 'a b.mjs': 'x', 'a.test.mjs': 't' } });
  const check = containerArgs(node, { phase: 'check', workdir: '/w', name: 'n' });
  // The names are arguments after the fixed script, never part of the shell command.
  assert.deepEqual(check.slice(-6), ['sh', '-c', 'for f do node --check "$f" || exit 1; done', 'sh', 'a b.mjs', 'a.test.mjs']);
});

test('a zipped package folder keeps its name: it is part of every import', () => {
  const read = readProject(zip({ 'mypkg/__init__.py': '', 'mypkg/core.py': 'x = 1\n', 'mypkg/test_core.py': 'from mypkg import core\n' }));
  assert.deepEqual(read.files.map(file => file.path), ['mypkg/__init__.py', 'mypkg/core.py', 'mypkg/test_core.py']);
  const windows = readProject(zip({ 'proj\\app\\main.py': 'print(1)\n', 'proj\\README.md': '# x\n' }));
  assert.deepEqual(windows.files.map(file => file.path), ['README.md', 'app/main.py']);
});

test('a small plan that grows is no longer called small', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Build and run a Python script.' } });
    assert.equal(run.adaptation.scale, 'small');
    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'understand', evidence: { structured: { needsInvestigation: true, successCriteria: ['runs'] } } } });
    const { body: grown } = await call('GET', `/api/runs/${run.id}`, auth);
    assert.equal(grown.adaptation.scale, 'standard');
    assert.notEqual(grown.brief.headline, 'Small, familiar task');
  }));

test('a large project shows each step the files that matter to it, and lists the rest', () => {
  // 40 unrelated modules of 3,000 characters, and the few this change is about.
  const filler = Array.from({ length: 40 }, (_, index) => ({ path: `app/module${index}.py`, content: `def helper_${index}():\n    return ${index}\n`.padEnd(3000, '#') }));
  const files = [
    ...filler,
    { path: 'shop/pricing.py', content: 'def total(items):\n    return sum(price * qty for price, qty in items)\n' },
    { path: 'shop/cart.py', content: 'from shop.pricing import total\n\nclass Cart:\n    def total(self):\n        return total(self.items)\n' },
    { path: 'shop/__init__.py', content: '' },
    { path: 'tests/test_cart.py', content: 'from shop.cart import Cart\n' },
    { path: 'README.md', content: '# Shop\n' }
  ];
  const view = projectView(files, { focus: 'Add discount codes to the Cart total in shop/cart.py', budget: 20_000 });
  for (const path of ['shop/cart.py', 'shop/pricing.py', 'tests/test_cart.py']) assert.ok(view.shown.includes(path), `${path} is shown`);
  assert.ok(view.notShown.length > 30, 'most unrelated modules are left out');
  assert.match(view.text, /Only the \d+ files relevant to this step are shown in full; the other \d+ are listed only/);
  for (const file of files) assert.ok(view.text.includes(`${file.path} (`), 'every path is listed');
  assert.ok(view.text.length <= 20_000);
  // What imports the file in focus, and its tests, rank above unrelated files.
  const ranked = rankFiles(files, 'change the pricing total').map(item => item.path);
  assert.equal(ranked[0], 'shop/pricing.py');
  assert.ok(ranked.indexOf('shop/cart.py') < ranked.indexOf('app/module0.py'));
  // A project that fits is shown whole, in path order.
  assert.deepEqual(projectView(files.slice(40), { focus: 'x' }).notShown, []);
  assert.deepEqual([...words('CartTotal apply_discount the add')], ['cart', 'total', 'apply', 'discount']);
});

test('a change can delete files: they leave the project the tests run, and stay deleted through fixes', () => {
  const change = { language: 'python', files: [{ path: 'shop/helpers.py', content: 'x = 1' }], delete: ['shop/utils_v1.py', '../etc', 'shop/helpers.py'] };
  assert.deepEqual(normalizePackage(change).delete, ['shop/utils_v1.py'], 'unsafe paths and files it also writes are not deleted');
  const payload = sandboxPayload(change, { baseFiles: [{ path: 'shop/utils_v1.py', content: 'old' }, { path: 'shop/cart.py', content: 'c' }] });
  assert.deepEqual(Object.keys(payload.files).sort(), ['shop/cart.py', 'shop/helpers.py']);
  const onlyDelete = { language: 'python', delete: ['old.py'] };
  assert.equal(hasCode(onlyDelete), true, 'a change that only deletes is still a change');
  const fixed = mergeFix(normalizePackage(change), { language: 'python', files: [{ path: 'shop/helpers.py', content: 'x = 2' }] });
  assert.deepEqual(fixed.delete, ['shop/utils_v1.py']);
  const restored = mergeFix(fixed, { language: 'python', files: [{ path: 'shop/utils_v1.py', content: 'back' }] });
  assert.equal(restored.delete, undefined, 'writing the file again undoes its deletion');
});

test('a zipped project is read as its source files, without installed, generated or secret files', () => {
  assert.equal(formatOf({ name: 'shop.zip' }), 'project');
  const read = readProject(zip({
    'shop-main/shop/cart.py': 'from shop.pricing import total\n',
    'shop-main/shop/pricing.py': 'def total(items): return sum(items)\n',
    'shop-main/README.md': '# Shop\n',
    'shop-main/node_modules/lib/index.js': 'x',
    'shop-main/shop/__pycache__/cart.cpython-312.pyc': 'x',
    'shop-main/.env': 'SECRET=1',
    'shop-main/logo.png': 'binary'
  }));
  assert.deepEqual(read.files.map(file => file.path), ['README.md', 'shop/cart.py', 'shop/pricing.py']);
  assert.match(read.text, /^Code project: 3 source files; 1 other files left out/);
  assert.match(read.text, /=== shop\/pricing\.py ===\ndef total/);
});

test('a project attached as a zip is changed by the files the AI returns, and the sandbox runs the whole project', () => {
  const runnerRequests = [];
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const file = await call('POST', '/api/objects', {
      ...auth,
      body: {
        name: 'shop.zip', type: 'attachment', contentType: 'application/zip', encoding: 'base64',
        content: zip({ 'shop/shop/__init__.py': '', 'shop/shop/pricing.py': 'def total(items):\n    return sum(items)\n' }).toString('base64')
      }
    });
    assert.equal(file.status, 201);
    const { body: run } = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Add a 10% discount function to this Python project, with tests, and run them.', attachments: [file.body.id], privacyConsent: { modelProvider: true } }
    });
    assert.equal(run.adaptation.attachments[0].readable, true);
    assert.notEqual(run.adaptation.scale, 'small', 'a change to an attached project is not a small task');
    await advanceTo(call, auth, run.id, { until: 'code' });
    const built = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.equal(built.status, 200, JSON.stringify(built.body).slice(0, 300));
    // The code step saw the project it changes.
    const buildRequest = seen.find(request => request.task?.id === 'build-code');
    assert.ok(buildRequest?.codeIntelligence, 'code context is compiled server-side');
    assert.equal(buildRequest.codeIntelligence.project.fileCount, 2);
    assert.ok(buildRequest.codeIntelligence.files.some(file => file.path === 'shop/shop/pricing.py'));
    const tested = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(tested.status, 200, JSON.stringify(tested.body).slice(0, 400));
    const payload = runnerRequests.at(-1).payload;
    assert.equal(payload.project, true);
    assert.deepEqual(Object.keys(payload.files).sort(), ['shop/__init__.py', 'shop/discount.py', 'shop/pricing.py', 'test_discount.py']);
    assert.match(payload.files['shop/pricing.py'], /sum\(items\)/, 'the unchanged file comes from the attached project');
  }, {
    env: { AI_PROVIDER: 'google', AI_MODEL: 'gemini-3.8-flash', AI_API_KEY: 'test-key', SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31) },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('http://sandbox.test')) {
        runnerRequests.push(JSON.parse(options.body));
        return jsonResponse({ executed: true, status: 'completed', output: { status: 'completed', exitCode: 0, stdout: '', stderr: 'Ran 2 tests in 0.001s\n\nOK', tested: true, testSummary: { total: 2, passed: 2, failed: 0, skipped: 0 } } });
      }
      const { request } = modelRequest(options);
      seen.push(request);
      const text = request.task?.id === 'build-code' ? JSON.stringify({
        language: 'python',
        files: [
          { path: 'shop/discount.py', content: 'def discount(price):\n    return round(price * 0.9, 2)\n' },
          { path: 'test_discount.py', content: 'import unittest\nfrom shop.discount import discount\nclass T(unittest.TestCase):\n    def test_ten(self):\n        self.assertEqual(discount(100), 90)\n' }
        ],
        packages: [],
        notes: 'Adds shop/discount.py.'
      }) : 'Done.';
      return geminiReply(text);
    }
  });
});

test('in a run, the code step of a large attached project reads the files its request is about', () => {
  const seen = [];
  const big = {};
  for (let index = 0; index < 40; index += 1) big[`shop/app/module${index}.py`] = `def helper_${index}():\n    return ${index}\n`.padEnd(3000, '#');
  big['shop/billing/invoice.py'] = 'def invoice_total(lines):\n    return sum(lines)\n';
  big['shop/tests/test_invoice.py'] = 'from billing.invoice import invoice_total\n';
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const file = await call('POST', '/api/objects', {
      ...auth, body: { name: 'shop.zip', type: 'attachment', contentType: 'application/zip', encoding: 'base64', content: zip(big).toString('base64') }
    });
    const { body: run } = await call('POST', '/api/runs', {
      ...auth, body: { goal: 'Round invoice_total in billing/invoice.py to cents, with tests.', attachments: [file.body.id], privacyConsent: { modelProvider: true } }
    });
    for (const taskId of await stepsIn(call, auth, run.id, ['understand', 'discover-capabilities', 'adapt', 'plan'])) {
      await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId, summary: taskId } });
    }
    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'approval', approved: true } });
    const built = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    assert.ok(seen.some(request => request.task?.id === 'build-code'), `${run.tasks.map(task => task.id).join(' ')} → ${JSON.stringify(built.body).slice(0, 300)}`);
    const project = seen.find(request => request.task?.id === 'build-code').codeIntelligence;
    assert.ok(project, 'large projects use compiled code intelligence');
    assert.ok(project.budget.truncated, 'a large project is context-bounded');
    assert.ok(project.files.some(file => file.path === 'shop/billing/invoice.py'));
    assert.ok(project.files.some(file => file.path === 'shop/tests/test_invoice.py'));
  }, {
    env: { AI_PROVIDER: 'google', AI_MODEL: 'gemini-3.8-flash', AI_API_KEY: 'test-key', SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31), MAX_ATTACHMENT_CHARS: '20000' },
    fetchImpl: async (_url, options) => {
      const { request } = modelRequest(options);
      seen.push(request);
      const text = request.task?.id === 'build-code'
        ? JSON.stringify({ language: 'python', files: [{ path: 'billing/invoice.py', content: 'def invoice_total(lines):\n    return round(sum(lines), 2)\n' }], notes: 'Rounds.' })
        : 'Done.';
      return geminiReply(text);
    }
  });
});

test('code in a language the sandbox cannot run goes on untested, says why, and needs a person to certify it', () => {
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Write a Go program main.go that prints the 10th Fibonacci number, with tests.', privacyConsent: { modelProvider: true } } });
    for (const taskId of await stepsIn(call, auth, run.id, ['understand', 'discover-capabilities', 'adapt', 'plan'])) {
      await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId, summary: taskId } });
    }
    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'approval', approved: true } });
    await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    for (const taskId of await stepsIn(call, auth, run.id, ['observe-build-code', 'reassess-build-code'])) {
      await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId, evidence: { recorded: true } } });
    }
    const tested = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.execution.status, 'language-unavailable');
    const step = tested.body.run.tasks.find(task => task.id === 'test-code');
    assert.equal(step.status, 'skipped');
    assert.match(step.summary, /^Not run: Running Go code is not turned on/);
    assert.equal(tested.body.run.adaptation.codeNotRun.language, 'go');
    assert.notEqual(tested.body.run.next, 'test-code', 'the run goes on');
    // The check may not certify code that never ran.
    let verified = null;
    for (let step = 0; step < 6 && !verified; step += 1) {
      const next = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
      if (next.body.execution?.status === 'human-verification-required') verified = next.body.execution;
    }
    assert.ok(verified, 'the check asks a person');
    assert.match(verified.message, /could not be run here \(Running Go code is not turned on/);
    const answerRules = seen.filter(request => request.adaptation?.codeNotRun);
    assert.ok(answerRules.length > 0, 'later steps are told the code was not run');
  }, {
    env: { AI_PROVIDER: 'google', AI_MODEL: 'gemini-3.8-flash', AI_API_KEY: 'test-key', SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31) },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('http://sandbox.test')) {
        return jsonResponse({ executed: false, status: 'language-unavailable', message: 'Running Go code is not turned on for this sandbox.', language: 'go' });
      }
      const { request } = modelRequest(options);
      seen.push(request);
      const text = request.task?.id === 'build-code'
        ? JSON.stringify({ language: 'go', source: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(55) }\n', tests: 'package main\n\nimport "testing"\n\nfunc TestX(t *testing.T) {}\n' })
        : request.task?.type === 'verify'
          ? JSON.stringify({ verdict: 'pass', criteria: (request.situation?.successCriteria ?? []).map(criterion => ({ criterion, met: true })), problems: [] })
          : 'Done.';
      return geminiReply(text);
    }
  });
});

test('code fixes go on while they get closer to working, and stop when they do not', () => {
  const run = (failures, scale = 'standard') => ({ attempt: 1, adaptation: { scale, codeRepairs: failures.map((failure, index) => ({ attempt: 1, round: index + 1, failure })) } });
  const tests = (failed, total = 10) => ({ status: 'failed', testSummary: { total, passed: total - failed, failed, skipped: 0 }, stderr: `${failed} failed` });
  assert.equal(repairDecision(run([]), tests(5)).reason, 'first-failure');
  assert.equal(repairDecision(run([tests(5)]), tests(2)).reason, 'progress', 'fewer failing tests');
  assert.equal(repairDecision(run([{ status: 'syntax-error', stderr: 'x' }]), tests(3)).reason, 'progress', 'a syntax error that became failing tests');
  assert.equal(repairDecision(run([tests(2)]), tests(2)).reason, 'one-more-try', 'the same failure again gets one more try');
  assert.equal(repairDecision(run([tests(2), tests(2)]), tests(2)).reason, 'no-progress', 'but not a third');
  assert.equal(repairDecision(run([tests(3)]), { ...tests(3), stderr: 'other' }).reason, 'one-more-try', 'one stall is allowed');
  assert.equal(repairDecision(run([tests(4), { ...tests(4), stderr: 'b' }]), { ...tests(5), stderr: 'c' }).reason, 'no-progress', 'two fixes in a row without progress');
  // While it keeps getting closer, a big job gets more fixes than a small one, up to its ceiling.
  const improving = count => Array.from({ length: count }, (_, index) => tests(20 - index));
  assert.equal(repairDecision(run(improving(4), 'small'), tests(10)).reason, 'ceiling');
  assert.equal(repairDecision(run(improving(4), 'complex'), tests(10)).repair, true);
  assert.equal(repairDecision(run(improving(8), 'complex'), tests(5)).reason, 'ceiling');
});

test('a small project is shown whole; a larger one only as far as the step needs', () => {
  const small = [{ path: 'a.py', content: 'x = 1\n' }, { path: 'b.py', content: 'y = 2\n' }];
  assert.deepEqual(projectView(small, { focus: 'change a.py' }).notShown, [], 'cheaper to show whole than to choose');
  const files = Array.from({ length: 12 }, (_, index) => ({ path: `pkg/part${index}.py`, content: `def part_${index}():\n    pass\n`.padEnd(2500, '#') }));
  files.push({ path: 'pkg/billing.py', content: 'def invoice_total(lines):\n    return sum(lines)\n' });
  // 30,000 characters fit the budget, but a change to billing does not need them.
  const view = projectView(files, { focus: 'Round invoice_total in pkg/billing.py', budget: 60_000 });
  assert.deepEqual(view.shown, ['pkg/billing.py']);
  assert.equal(view.notShown.length, 12);
});

test('a fixed version of the code is really run again, not replayed from the first run', () => {
  const executions = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Write a Python function is_prime(n) with unit tests, and run the tests.', privacyConsent: { modelProvider: true } } });
    for (const taskId of await stepsIn(call, auth, run.id, ['understand', 'discover-capabilities', 'adapt', 'plan'])) await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId, summary: taskId } });
    await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body: { taskId: 'approval', approved: true } });
    await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    const first = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(first.body.execution.status, 'repairing');
    await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
    const second = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.notEqual(second.body.execution.status, 'repairing');
    assert.equal(second.body.run.tasks.find(task => task.id === 'test-code').status, 'complete', 'the fixed code passed');
    assert.equal(executions.length, 2);
    assert.notEqual(executions[0].id, executions[1].id, 'each version is its own execution');
    assert.equal(executions[1].replayed, false);
  }, {
    env: { AI_PROVIDER: 'google', AI_MODEL: 'gemini-3.8-flash', AI_API_KEY: 'test-key', SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31) },
    fetchImpl: (() => {
      // Like the real runner: an execution ID it has seen gets its stored receipt back.
      const receipts = new Map();
      return async (url, options) => {
        if (String(url).startsWith('http://sandbox.test')) {
          const body = JSON.parse(options.body);
          if (receipts.has(body.executionId)) {
            executions.push({ id: body.executionId, replayed: true });
            return jsonResponse({ ...receipts.get(body.executionId), replayed: true });
          }
          const fixed = /n < 2/.test(body.payload.source);
          const receipt = { executed: true, status: fixed ? 'completed' : 'failed', executionId: body.executionId,
            output: { status: fixed ? 'completed' : 'failed', exitCode: fixed ? 0 : 1, tested: true, stdout: '', stderr: fixed ? 'Ran 2 tests\n\nOK' : 'FAIL: test_below_two\nRan 2 tests\n\nFAILED (failures=1)', testSummary: { total: 2, passed: fixed ? 2 : 1, failed: fixed ? 0 : 1, skipped: 0 } } };
          receipts.set(body.executionId, receipt);
          executions.push({ id: body.executionId, replayed: false });
          return jsonResponse(receipt);
        }
        const { request } = modelRequest(options);
        const text = request.task?.id === 'build-code'
          ? JSON.stringify({ language: 'python', source: request.codeRepair ? 'def is_prime(n):\n    if n < 2:\n        return False\n    return all(n % d for d in range(2, int(n ** 0.5) + 1))\n' : 'def is_prime(n):\n    return all(n % d for d in range(2, n))\n', tests: 'import unittest\nfrom main import is_prime\n' })
          : 'Done.';
        return geminiReply(text);
      };
    })()
  });
});

test('a fix that writes a file deleted earlier in the same fix keeps the file', () => {
  const change = normalizePackage({ language: 'python', files: [{ path: 'a.py', content: 'x = 1' }], delete: ['old.py'] });
  const fixed = mergeFix(change, { language: 'python', files: [{ path: 'old.py', content: 'kept' }], delete: ['old.py'] });
  assert.equal(codeFiles(fixed).find(file => file.path === 'old.py')?.content, 'kept');
  assert.equal(fixed.delete, undefined);
});

test('a complex job keeps its repair history long enough to reach its ceiling', () => {
  const tests = failed => ({ status: 'failed', testSummary: { total: 20, passed: 20 - failed, failed, skipped: 0 }, stderr: `${failed} failed` });
  const repairs = Array.from({ length: 7 }, (_, index) => ({ attempt: 1, round: index + 1, failure: tests(19 - index) }));
  const run = { attempt: 1, adaptation: { scale: 'complex', codeRepairs: repairs } };
  assert.equal(repairDecision(run, tests(11)).repair, true, 'the eighth fix of a complex job that keeps improving');
});

test('Rust tests written apart from the code are run inside it', () => {
  const job = validateJob({ language: 'rust', source: 'fn add(a: i32, b: i32) -> i32 { a + b }\nfn main() {}\n', tests: '#[test]\nfn adds() { assert_eq!(add(2, 3), 5); }' });
  const source = job.files.get('src/main.rs').toString();
  assert.match(source, /mod sandbox_tests \{\n {4}#\[allow\(unused_imports\)\]\n {4}use super::\*;/);
  assert.match(source, /fn adds\(\)/);
  // In a project, the tests go into the file that has the code.
  const project = sandboxPayload({ language: 'rust', files: [{ path: 'src/main.rs', content: 'fn main() {}\n' }], tests: '#[test]\nfn t() {}' });
  assert.match(project.files['src/main.rs'], /mod sandbox_tests/);
  assert.ok(job.tested);
});

test('a zipped Go or Rust project keeps its build files', () => {
  const read = readProject(zip({ 'svc/go.mod': 'module svc\n\ngo 1.23\n', 'svc/go.sum': '', 'svc/main.go': 'package main\n', 'crate/Cargo.toml': '[package]\nname = "c"\n', 'crate/src/main.rs': 'fn main() {}\n' }));
  const paths = (read.files ?? read).map(file => file.path);
  for (const path of ['go.mod', 'main.go', 'Cargo.toml', 'main.rs']) assert.ok(paths.some(item => item.endsWith(path)), `${path} in ${paths}`);
});

test('code in a language the sandbox has no toolchain for (a SPICE netlist) goes on untested instead of failing each run', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Write and run a Python script that prints 55.' } });
    const ready = await codeWritten(call, auth, run.id, { source: 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.ac dec 10 10 1Meg\n.end\n', tests: '' });
    assert.equal(ready.next, 'test-code');
    const tested = await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.execution.status, 'language-unavailable');
    assert.equal(tested.body.run.tasks.find(task => task.id === 'test-code').status, 'skipped');
    assert.notEqual(tested.body.run.next, 'test-code', 'the run goes on');
  }, {
    env: { SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31) },
    // A runner from before the fix answers an unknown language this way.
    fetchImpl: async () => jsonResponse({ executed: false, status: 'sandbox-language', message: 'The sandbox runs python or javascript, not "spice".' })
  }));

test('a follow-up in the same chat continues the project from the version the last turn left', () => {
  const runnerRequests = [];
  const seen = [];
  return withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const conversationId = 'chat-project-follow-up';
    const file = await call('POST', '/api/objects', {
      ...auth,
      body: {
        name: 'shop.zip', type: 'attachment', contentType: 'application/zip', encoding: 'base64',
        content: zip({ 'shop/shop/__init__.py': '', 'shop/shop/pricing.py': 'def total(items):\n    return sum(items)\n' }).toString('base64')
      }
    });
    const turn = async (goal, attachments) => {
      const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal, conversationId, attachments, privacyConsent: { modelProvider: true } } });
      await advanceTo(call, auth, run.id, { until: 'code' });
      await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: {} });
      await call('POST', `/api/runs/${run.id}/execute`, { ...auth, body: { approved: true } });
      return (await call('GET', `/api/runs/${run.id}`, auth)).body;
    };
    await turn('Add a 10% discount function to this Python project, with tests, and run them.', [file.body.id]);

    const next = await turn('Now add a function that says whether an order qualifies for free shipping, with a test, and run all the tests again.');
    assert.equal(next.adaptation.attachments[0].name, 'shop.zip', 'the project comes along');
    assert.ok(next.capabilities.required.includes('code-generation'));
    assert.ok(!next.capabilities.required.includes('evidence-retrieval'), 'the work is on the project, not the web');
    assert.deepEqual(next.adaptation.projectOverlay.map(item => item.path).sort(), ['shop/discount.py', 'test_discount.py']);
    // The code step sees the project as the last turn left it...
    const build = seen.filter(request => request.task?.id === 'build-code').at(-1);
    assert.ok(build.codeIntelligence.files.some(file => /discount/.test(file.content)));
    // ...and the sandbox runs all of it: the original, the last change and this one.
    assert.deepEqual(Object.keys(runnerRequests.at(-1).payload.files).sort(),
      ['shop/__init__.py', 'shop/discount.py', 'shop/pricing.py', 'shop/shipping.py', 'test_discount.py', 'test_shipping.py']);

    // Small talk after it does not drag the files along.
    const { body: thanks } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Thanks!', conversationId } });
    assert.equal(thanks.adaptation.attachments, undefined);
    // ...and work on it after the small talk still finds the project, as last changed.
    const { body: later } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Now add a test for an empty order to the project.', conversationId } });
    assert.equal(later.adaptation.attachments?.[0]?.name, 'shop.zip');
    assert.deepEqual(later.adaptation.projectOverlay.map(item => item.path).sort(), ['shop/discount.py', 'shop/shipping.py', 'test_discount.py', 'test_shipping.py']);
  }, {
    env: { AI_PROVIDER: 'google', AI_MODEL: 'gemini-3.8-flash', AI_API_KEY: 'test-key', SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31) },
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('http://sandbox.test')) {
        runnerRequests.push(JSON.parse(options.body));
        return jsonResponse({ executed: true, status: 'completed', output: { status: 'completed', exitCode: 0, stdout: '', stderr: 'Ran 2 tests in 0.001s\n\nOK', tested: true, testSummary: { total: 2, passed: 2, failed: 0, skipped: 0 } } });
      }
      const { request } = modelRequest(options);
      seen.push(request);
      const shipping = /free shipping/.test(request.goal ?? '');
      const text = request.task?.id === 'build-code' ? JSON.stringify({
        language: 'python',
        files: shipping ? [
          { path: 'shop/shipping.py', content: 'def free_shipping(total):\n    return total >= 50\n' },
          { path: 'test_shipping.py', content: 'import unittest\nfrom shop.shipping import free_shipping\nclass T(unittest.TestCase):\n    def test_fifty(self):\n        self.assertTrue(free_shipping(50))\n' }
        ] : [
          { path: 'shop/discount.py', content: 'def discount(price):\n    return round(price * 0.9, 2)\n' },
          { path: 'test_discount.py', content: 'import unittest\nfrom shop.discount import discount\nclass T(unittest.TestCase):\n    def test_ten(self):\n        self.assertEqual(discount(100), 90)\n' }
        ],
        packages: [],
        notes: 'Done.'
      }) : 'Done.';
      return geminiReply(text);
    }
  });
});

test('fixing an attached project goes to code even when understanding asks to investigate', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const file = await call('POST', '/api/objects', {
      ...auth,
      body: {
        name: 'shop.zip', type: 'attachment', contentType: 'application/zip', encoding: 'base64',
        content: zip({ 'shop/pricing.py': 'def total(items):\n    return sum(items) + 1\n', 'shop/test_pricing.py': 'from pricing import total\nassert total([1, 2]) == 3\n' }).toString('base64')
      }
    });
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'The tests in this project fail. Find the bugs, fix them, and run the tests.', attachments: [file.body.id] } });
    assert.equal(run.adaptation.ownWork, true);
    const understood = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth, body: { taskId: 'understand', summary: 'Find the bug.', evidence: { structured: { needsInvestigation: true } } }
    });
    assert.equal(understood.status, 200);
    const after = await advanceTo(call, auth, run.id, { until: 'code' });
    assert.equal(after.tasks.some(task => task.type === 'investigate'), false, 'no web research for the person\'s own code');
    assert.equal(after.tasks.find(task => task.id === after.next)?.type, 'code');
  }));

test('a follow-up shows the AI a single attached code file as it is now, with the files it added', async () => {
  const { attachmentContext } = await import('../src/attachments.js');
  const content = Buffer.from('def total(items):\n    return sum(items) + 1\n');
  const objects = { read: async () => ({ metadata: { name: 'pricing.py', contentType: 'text/x-python', digest: 'single-file-overlay' }, content }) };
  const scope = { workspaceId: 'ws-overlay', principalId: 'p' };
  const attachments = [{ id: 'o1', name: 'pricing.py', readable: true, format: 'text' }];
  const overlay = [
    { path: 'pricing.py', content: 'def total(items):\n    return sum(items)\n' },
    { path: 'test_pricing.py', content: 'from pricing import total\nassert total([1, 2]) == 3\n' }
  ];
  const { files } = await attachmentContext(objects, scope, attachments, { overlay });
  const shown = files.map(file => file.text ?? '').join('\n');
  assert.match(shown, /return sum\(items\)\n/);
  assert.doesNotMatch(shown, /\+ 1/, 'the old version is not what the AI sees');
  assert.match(shown, /test_pricing\.py/);
  // Without a follow-up's changes the file is shown as attached.
  const plain = await attachmentContext(objects, scope, attachments);
  assert.match(plain.files[0].text, /\+ 1/);
});

test('high-impact work on the person\'s own file is still checked against outside evidence', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const upload = (name, content) => call('POST', '/api/objects', { ...auth, body: { name, type: 'attachment', contentType: 'text/x-python', content } });
    const dosing = await upload('dosing.py', 'def dose_mg(weight_kg):\n    return weight_kg * 15\n');
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Fix the bug in this Python file that calculates the paracetamol dosage for my patients.', attachments: [dosing.body.id] } });
    assert.notEqual(run.adaptation.ownWork, true, 'a dosing calculation is not treated as private code work');
    // Ordinary own code still is.
    const shop = await upload('pricing.py', 'def total(items):\n    return sum(items) + 1\n');
    const { body: plain } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Fix the bug in this Python file and run it.', attachments: [shop.body.id] } });
    assert.equal(plain.adaptation.ownWork, true);
  }));

test('a new app is planned with the person first; the code follows the agreed plan and their changes', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    // Drive the steps as a person would, until the code step; returns the steps seen.
    const driveToCode = async (goal, { changes = '' } = {}) => {
      const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal } });
      const seen = [];
      let current = run;
      for (let i = 0; i < 12 && current.next && current.next !== 'build-code'; i += 1) {
        const task = current.tasks.find(item => item.id === current.next);
        seen.push(task);
        const body = task.type === 'approval'
          ? { taskId: task.id, approved: true, conditions: changes }
          : task.metadata?.buildPlan
            ? { taskId: task.id, summary: 'Plan.', evidence: { structured: { summary: 'A to-do app.', features: ['add', 'list'], files: ['storage.py'], tests: ['add then list'], assumptions: ['JSON file storage'], questions: [] } } }
            : { taskId: task.id, summary: task.id };
        const step = await call('POST', `/api/runs/${run.id}/advance`, { ...auth, body });
        assert.equal(step.status, 200, `${task.id}: ${JSON.stringify(step.body).slice(0, 200)}`);
        current = step.body;
      }
      return { run: current, seen };
    };

    const app = await driveToCode('Build a Python command-line to-do app with a storage module, commands and tests.', { changes: 'Use SQLite instead of JSON.' });
    const plan = app.seen.findIndex(task => task.metadata?.buildPlan);
    const agree = app.seen.findIndex(task => task.metadata?.planAgreement);
    assert.ok(plan >= 0 && agree > plan, app.seen.map(task => task.id).join(' → '));
    assert.equal(app.run.next, 'build-code', 'the code comes only after the plan is agreed');
    const agreed = app.run.tasks.find(task => task.metadata?.planAgreement);
    assert.equal(agreed.evidence.conditions, 'Use SQLite instead of JSON.', 'the person\'s changes are kept for the code step');

    // "Just build it", and a small snippet, go straight to the code.
    for (const goal of ['Build a Python command-line to-do app with tests. Just build it.', 'Write a JavaScript function that checks whether an email address is valid, with tests.']) {
      const { run, seen } = await driveToCode(goal);
      assert.ok(!seen.some(task => task.metadata?.buildPlan || task.metadata?.planAgreement), `${goal}: ${seen.map(task => task.id).join(' → ')}`);
      assert.equal(run.next, 'build-code', goal);
    }
  }));
