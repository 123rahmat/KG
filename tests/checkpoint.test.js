import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanCheckpoint } from '../src/checkpoint.js';

const reassess = sourceTask => ({ id: sourceTask ? `reassess-${sourceTask}` : 'reassess', type: 'reassess', status: 'pending', metadata: sourceTask ? { sourceTask } : {} });
const built = { id: 'build-code', type: 'code', status: 'complete', evidence: { structured: { language: 'python', source: 'x = 1', tests: 'import unittest' } } };
const tested = (summary, over = {}) => ({ id: 'test-code', type: 'code', status: 'complete', evidence: { result: { executed: true, output: { status: 'completed', exitCode: 0, testSummary: summary, ...over } } } });
const pendingTest = { id: 'test-code', type: 'code', status: 'pending' };
const toolRun = verdict => ({ id: 'tool', type: 'tool', status: 'complete', evidence: { structured: { verification: { verdict } } } });

test('code with its tests, about to be run, needs no model reassessment', () => {
  const result = cleanCheckpoint({ attempt: 1, tasks: [built, pendingTest] }, reassess('build-code'));
  assert.match(result.text, /the next step runs them/);
  assert.deepEqual(result.structured.capabilities, []);
});

test('code without tests, or not yet tested, goes to the model', () => {
  const noTests = { ...built, evidence: { structured: { source: 'x = 1', tests: '' } } };
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [noTests, pendingTest] }, reassess('build-code')), null);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [built] }, reassess('build-code')), null);
});

test('the final checkpoint is local only when every test passed', () => {
  const pass = cleanCheckpoint({ attempt: 1, tasks: [built, tested({ total: 4, passed: 4, failed: 0, skipped: 0 })] }, reassess());
  assert.match(pass.text, /tests: 4 of 4 passed/);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [built, tested({ total: 4, passed: 3, failed: 1, skipped: 0 })] }, reassess()), null);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [built, tested({ total: 0, passed: 0, failed: 0, skipped: 0 })] }, reassess()), null, 'no test ran');
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [built, tested(null)] }, reassess()), null);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [built, tested({ total: 2, passed: 2, failed: 0 }, { exitCode: 1 })] }, reassess()), null);
});

test('a tool run is always reassessed by the model: its output is open-ended', () => {
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [toolRun('pass')] }, reassess('tool')), null);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [toolRun('fail')] }, reassess('tool')), null);
});

test('research, drafts, tools, failures and retries always go to the model', () => {
  const research = { id: 'investigation-work', type: 'investigate', status: 'complete', evidence: { text: 'findings' } };
  const draft = { id: 'prototype', type: 'prototype', status: 'complete', evidence: { text: 'draft' } };
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [research] }, reassess('investigation-work')), null);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [research, draft] }, reassess()), null);
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [toolRun('pass'), research] }, reassess()), null, 'one open-ended stage is enough');
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [toolRun('pass'), { id: 'x', type: 'tool', status: 'failed' }] }, reassess('tool')), null);
  assert.equal(cleanCheckpoint({ attempt: 2, tasks: [toolRun('pass')] }, reassess('tool')), null, 'a retry after a failed check is reassessed by the model');
  assert.equal(cleanCheckpoint({ attempt: 1, tasks: [toolRun('pass')] }, { type: 'verify' }), null);
});
