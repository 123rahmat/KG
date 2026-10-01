import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBlackboard } from '../src/blackboard.js';
test('blackboard merges structured contributions without duplication', () => {
  const first = mergeBlackboard(null, { runId: 'run-1', facts: ['a'], findings: ['x'] }, 'run-1');
  const second = mergeBlackboard(first, { facts: ['a','b'], blockers: ['risk'], openQuestions: ['q'] }, 'run-1');
  assert.equal(second.version, 1);
  assert.deepEqual(second.facts, ['a','b']);
  assert.deepEqual(second.blockers, ['risk']);
  assert.deepEqual(second.openQuestions, ['q']);
});