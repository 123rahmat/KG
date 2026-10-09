import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceOutcomeSummary } from '../public/workspace-outcomes.js';

test('outcomes never claim code execution when no authenticated receipt exists', () => {
  const run = { state: 'complete', tasks: [
    { id: 'build-code', type: 'code', status: 'complete' },
    { id: 'test-code', type: 'code', status: 'complete' },
    { id: 'verify', type: 'verify', status: 'complete', evidence: { verdict: { verdict: 'fail' } } }
  ], adaptation: {} };
  const output = workspaceOutcomeSummary(run, 'code');
  assert.equal(output.title, 'What was completed');
  assert.ok(output.facts.some(item => item.includes('test step')));
  assert.ok(output.notes.some(item => item.includes('authenticated runner receipt')));
  assert.ok(output.notes.some(item => item.includes('No applied file-change')));
  assert.equal(output.facts.some(item => item.includes('passing verification')), false);
});

test('research outcomes report only tracked evidence and open gaps', () => {
  const run = { state: 'failed', tasks: [{ id: 'investigate', type: 'investigate', status: 'complete' }],
    adaptation: { researchWorkspace: { sourceCount: 2, evidenceCount: 1,
      unresolvedQuestions: ['Source missing'], conflicts: ['Disagreement'] } } };
  const output = workspaceOutcomeSummary(run, 'research');
  assert.equal(output.state, 'failed');
  assert.ok(output.facts.includes('2 tracked sources'));
  assert.ok(output.notes.some(item => item.includes('open research question')));
  assert.ok(output.notes.some(item => item.includes('evidence conflict')));
});

test('outcomes are reserved for final code and research records', () => {
  assert.equal(workspaceOutcomeSummary(null, 'code'), null);
  assert.equal(workspaceOutcomeSummary({ state: 'respond', tasks: [] }, 'code'), null);
  assert.equal(workspaceOutcomeSummary({ state: 'complete', tasks: [] }, 'normal-chat'), null);
});
