import test from 'node:test';
import assert from 'node:assert/strict';
import { observedTaskEvidence, evidenceNextTaskGate } from '../src/evidence-next-task-gate.js';

const gap = { items: [{ id: 'accuracy', status: 'partially-satisfied', required: true }] };
const source = { id: 'reassess', type: 'reassess' };
const proposal = { type: 'investigate', purpose: 'Check the unexpected failure' };
const tested = { id: 'test-code', type: 'code', status: 'complete',
  evidence: { result: { exitCode: 1, output: 'Unexpected failed test' } } };

test('ordinary daily-use first steps do not need an expensive evidence gate', () => {
  assert.equal(evidenceNextTaskGate({
    sourceTask: { type: 'understand' }, proposal: { type: 'respond' }
  }).allowed, true);
});

test('grounded execution and unmet acceptance need admit a new targeted task', () => {
  const result = evidenceNextTaskGate({
    sourceTask: source, proposal, tasks: [tested], requirements: gap
  });
  assert.equal(result.allowed, true);
  assert.equal(result.evidenceTaskId, 'test-code');
});

test('agent-generated confidence and narrative do not count as observed evidence', () => {
  assert.equal(observedTaskEvidence({
    id: 'reviewer', type: 'investigate', status: 'complete',
    evidence: { confidence: 0.99, summary: 'I found a problem', findings: 'Just a claim' }
  }), false);
  assert.equal(evidenceNextTaskGate({
    sourceTask: source, proposal, tasks: [
      { type: 'investigate', status: 'complete', evidence: { confidence: 1, findings: 'Claim' } }
    ], requirements: gap
  }).reason, 'material-evidence-missing');
});

test('a completed task alone cannot create unnecessary extra work', () => {
  const result = evidenceNextTaskGate({
    sourceTask: source, proposal, tasks: [tested],
    requirements: { items: [{ status: 'satisfied' }] }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'no-unmet-task-requirement');
});

test('budget gate suppresses optional expansion but not mandatory verification', () => {
  const args = { sourceTask: source, tasks: [tested], requirements: gap, budgetAllows: false };
  assert.equal(evidenceNextTaskGate({ ...args, proposal }).reason, 'workflow-budget-exhausted');
  assert.equal(evidenceNextTaskGate({ ...args, proposal: { type: 'verify' } }).allowed, true);
});

test('a verified source record or external execution receipt counts', () => {
  assert.equal(observedTaskEvidence({
    type: 'investigate', status: 'complete',
    evidence: { sources: [{ url: 'https://example.org', title: 'Record' }] }
  }), true);
  assert.equal(observedTaskEvidence({
    type: 'tool', status: 'complete',
    evidence: { executionReceipt: { id: 'receipt-1' } }
  }), true);
});

test('proposal-free reassessment never invents a task', () => {
  assert.equal(evidenceNextTaskGate({ sourceTask: source, tasks: [tested] }).allowed, false);
});

test('failed and non-completed tasks without actual results do not count as observations', () => {
  assert.equal(observedTaskEvidence({
    type: 'tool', status: 'running', evidence: { executionReceipt: { id: 'fake' } }
  }), false);
  assert.equal(observedTaskEvidence({ type: 'step', status: 'complete',
    evidence: { result: 'Only a model answer' } }), false);
});
