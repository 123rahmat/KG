import test from 'node:test';
import assert from 'node:assert/strict';
import { codeFailure, staleAfterRepair, repairRecord, repairContext, canRepair, untestedCode, missingTests, compactCodeEvidence, hasMeaningfulTests, MAX_CODE_REPAIRS, MAX_PROJECT_FILES, codeFiles } from '../src/code-workflow.js';

const tasks = [
  { id: 'approval', position: 5, status: 'complete', dependsOn: [] },
  { id: 'investigation-work', position: 6, status: 'complete', dependsOn: ['approval'] },
  { id: 'build-code', position: 7, status: 'complete', dependsOn: ['approval'], evidence: { structured: { language: 'python', source: 'def f():\n  return 1\n', tests: 'import main', packages: ['six'] } } },
  { id: 'observe-build-code', position: 8, status: 'complete', dependsOn: ['build-code'] },
  { id: 'reassess-build-code', position: 9, status: 'complete', dependsOn: ['observe-build-code'] },
  { id: 'test-code', position: 10, status: 'ready', dependsOn: ['reassess-build-code'] },
  { id: 'verify', position: 11, status: 'pending', dependsOn: ['test-code'] }
];

test('a fix makes build-code and the steps up to the failed run stale, nothing before it', () => {
  assert.deepEqual(staleAfterRepair(tasks, 'test-code').sort(), ['build-code', 'observe-build-code', 'reassess-build-code', 'test-code']);
  assert.deepEqual(staleAfterRepair(tasks.filter(task => task.id !== 'build-code'), 'test-code'), []);
});

test('what failed is kept as the sandbox reported it, with bounded output', () => {
  const failure = codeFailure({
    status: 'failed',
    result: { executed: true, status: 'failed', outcome: 'failed', output: { status: 'failed', exitCode: 1, stderr: `${'x'.repeat(5000)}AssertionError: 1 != 2`, stdout: '', testSummary: { total: 2, passed: 1, failed: 1, skipped: 0 } } }
  });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.exitCode, 1);
  assert.deepEqual(failure.testSummary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.ok(failure.stderr.endsWith('AssertionError: 1 != 2'));
  assert.ok(failure.stderr.length <= 4001);
});

test('repairs are counted per attempt and the next build sees the failed code and every earlier round', () => {
  let run = { attempt: 1, adaptation: {} };
  assert.equal(repairContext(run), null);
  for (let round = 1; round <= MAX_CODE_REPAIRS; round += 1) {
    assert.equal(canRepair(run), true);
    const { record, history } = repairRecord(run, tasks, 'test-code', { status: 'failed', stderr: `error ${round}` });
    assert.equal(record.round, round);
    assert.equal(record.code.language, 'python');
    run = { ...run, adaptation: { codeRepairs: history } };
  }
  assert.equal(canRepair(run), false);
  const context = repairContext(run);
  assert.equal(context.round, MAX_CODE_REPAIRS);
  assert.equal(context.failure.stderr, `error ${MAX_CODE_REPAIRS}`);
  assert.deepEqual(context.earlier.map(item => item.round), [1, 2]);
  // A new attempt starts with a fresh repair budget.
  assert.equal(canRepair({ ...run, attempt: 2 }), true);
});

test('code without tests is asked for tests and cannot be certified by the automated check', () => {
  assert.equal(missingTests({ language: 'python', source: 'print(1)', tests: '' }), true);
  assert.equal(missingTests({ language: 'python', source: 'print(1)', tests: 'import main' }), true, 'an import alone runs no assertion');
  assert.equal(missingTests({ language: 'python', source: 'print(1)', tests: 'from main import f\n\ndef test_f():\n  assert f() == 1' }), false);
  assert.equal(hasMeaningfulTests({ language: 'javascript', source: 'export const f = () => 1', tests: "import test from 'node:test'; test('f', () => {});" }), true);
  assert.equal(missingTests(null), false);
  const ran = tested => ({ tasks: [{ id: 'test-code', status: 'complete', evidence: { result: { executed: true, output: { status: 'completed', tested } } } }] });
  assert.equal(untestedCode(ran(false)), true);
  assert.equal(untestedCode(ran(true)), false);
  // A test file in which no test ran is no test at all.
  const empty = { tasks: [{ id: 'test-code', status: 'complete', evidence: { result: { output: { tested: true, testSummary: { total: 0, passed: 0, failed: 0, skipped: 0 } } } } }] };
  assert.equal(untestedCode(empty), true);
});

test('project code files stay aligned with the sandbox project limit instead of truncating at an arbitrary lower ceiling', () => {
  const files = Array.from({ length: MAX_PROJECT_FILES }, (_, index) => ({
    path: `src/file-${String(index).padStart(3, '0')}.js`,
    content: `export const value${index} = ${index};`
  }));
  assert.equal(codeFiles({ files }).length, MAX_PROJECT_FILES);
  assert.equal(codeFiles({ files: files.slice(0, 61) }).at(-1).path, 'src/file-060.js');
});

test('later reasoning sees code results, not megabytes of output', () => {
  const evidence = { result: { executed: true, output: { status: 'completed', stdout: 'y'.repeat(10_000), stderr: '', files: [{ name: 'out/a.bin', bytes: 9, base64: 'AAAA' }], testSummary: { total: 1, passed: 1, failed: 0, skipped: 0 } } } };
  const compact = compactCodeEvidence(evidence);
  assert.ok(compact.result.output.stdout.length <= 3001);
  assert.deepEqual(compact.result.output.files, [{ name: 'out/a.bin', bytes: 9 }]);
  assert.deepEqual(compact.result.output.testSummary, evidence.result.output.testSummary);
  assert.equal(compactCodeEvidence({ text: 'x' }).text, 'x');
});

test('code that could not be run is reported only for the attempt it happened in', async () => {
  const { codeNotRunNow } = await import('../src/code-workflow.js');
  const { adaptationFor } = await import('../src/prompt-scope.js');
  const run = attempt => ({ attempt, tasks: [], adaptation: { codeNotRun: { language: 'go', reason: 'off', attempt: 1 } } });
  assert.ok(codeNotRunNow(run(1)));
  assert.equal(untestedCode(run(1)), true);
  assert.equal(codeNotRunNow(run(2)), null, 'a later attempt ran its code');
  assert.equal(untestedCode(run(2)), false);
  assert.equal(adaptationFor(run(2), { type: 'deliver' })?.codeNotRun, undefined);
});
