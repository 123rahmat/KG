import test from 'node:test';
import assert from 'node:assert/strict';
import { defineEvalCase, runEvalSuite, regressionGate } from '../src/evals.js';
test('evals can run cases concurrently and gate promotion', async () => {
  const report = await runEvalSuite([
    defineEvalCase({ id: 'a', goal: 'a', expected: { success: true }, run: async () => ({ success: true }) }),
    defineEvalCase({ id: 'b', goal: 'b', expected: { success: true }, run: async () => ({ success: true }) })
  ], { concurrency: 2 });
  assert.equal(report.passRate, 1); assert.equal(regressionGate(report).pass, true);
});