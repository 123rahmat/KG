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

test('blackboard retains bounded subsystem plan and typed messages', async () => {
  const { createSubsystemMessage } = await import('../src/subsystem-orchestrator.js');
  const message = createSubsystemMessage({
    type: 'handoff',
    from: 'orders-agent',
    to: 'auth-1',
    subsystemId: 'orders-2',
    projectRevision: 'r1',
    contractVersion: 1,
    payload: { summary: 'Use auth contract v1.' }
  });
  const board = mergeBlackboard(null, {
    subsystemPlan: { kind: 'adaptive-subsystem-plan', project: { contentHash: 'h1' } },
    subsystemMessages: [message]
  }, 'run-1');
  assert.equal(board.subsystemPlan.project.contentHash, 'h1');
  assert.equal(board.subsystemMessages.length, 1);
  assert.equal(board.subsystemMessages[0].type, 'handoff');
});
