import test from 'node:test';
import assert from 'node:assert/strict';
import { defineEvalCase, runEvalSuite, regressionGate } from '../src/evals.js';

test('eval suite runs concurrent cases and produces a promotion gate', async () => {
  const suite = [
    defineEvalCase({ id: 'a', goal: 'a', expected: { success: true }, run: async () => ({ success: true }) }),
    defineEvalCase({ id: 'b', goal: 'b', expected: { success: true }, run: async () => ({ success: true }) })
  ];
  const report = await runEvalSuite(suite, { concurrency: 2 });
  assert.equal(report.passRate, 1);
  assert.equal(regressionGate(report).pass, true);
});
