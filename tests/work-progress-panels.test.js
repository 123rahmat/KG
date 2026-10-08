import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceProgressPanel } from '../public/work-progress-panels.js';

test('NormalChat hides irrelevant metrics on everyday conversations', () => {
  const view = workspaceProgressPanel({ tasks: [{ id: 'respond', status: 'running' }], next: 'respond' });
  assert.equal(view.workspace, 'normal-chat');
  assert.deepEqual(view.cards, []);
  assert.equal(view.stages[0].statusLabel, 'Working');
  assert.equal(view.stages[0].active, true);
});

test('NormalChat adapts to real files and reasoning context', () => {
  const view = workspaceProgressPanel({
    adaptation: { attachments: [{ name: 'budget.xlsx' }, { name: 'plan.docx' }] },
    intelligence: { reasoning: { depth: 'deep' } },
    tasks: [{ id: 'verify', type: 'verify', status: 'complete', evidence: { verdict: { verdict: 'pass' } } }]
  });
  assert.deepEqual(view.fileNames, ['budget.xlsx', 'plan.docx']);
  assert.deepEqual(view.cards, [
    { label: 'Files in context', value: '2' },
    { label: 'Reasoning effort', value: 'deep' },
    { label: 'Verified checks', value: '1' }
  ]);
});

test('Code view distinguishes recorded checks from verified outcomes', () => {
  const view = workspaceProgressPanel({
    adaptation: { projectOverlay: [{ path: 'a.js' }] },
    tasks: [
      { id: 'test-code', status: 'failed' },
      { id: 'verify', type: 'verify', status: 'complete', evidence: { verdict: { verdict: 'fail' } } }
    ]
  }, 'code');
  assert.equal(view.cards[0].value, '1');
  assert.equal(view.cards[1].value, '2');
  assert.equal(view.cards[2].value, '0');
});

test('Research view shows source and evidence records, not estimates', () => {
  const view = workspaceProgressPanel({
    adaptation: { researchWorkspace: {
      sourceCount: 4, evidenceCount: 8, unresolvedQuestions: ['gap'], conflicts: ['disagreement']
    } },
    tasks: []
  }, 'research');
  assert.deepEqual(view.cards, [
    { label: 'Sources recorded', value: '4' },
    { label: 'Evidence items', value: '8' },
    { label: 'Evidence conflicts', value: '1' }
  ]);
});

test('Waiting and failed stages are never presented as completed', () => {
  const view = workspaceProgressPanel({ tasks: [
    { id: 'plan', status: 'complete' }, { id: 'build-code', status: 'failed' },
    { id: 'approval', status: 'waiting' }
  ] }, 'code');
  assert.deepEqual(view.stages.map(item => item.statusLabel), ['Done', 'Failed', 'Waiting']);
  assert.equal(view.completed, 1);
});

test('Progress model bounds stage rows and sanitizes unknown values', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: 'respond', status: 'pending', metadata: { title: 'x'.repeat(150) + i } }));
  const view = workspaceProgressPanel({ tasks }, 'unexpected-mode');
  assert.equal(view.stages.length, 12);
  assert.equal(view.stages[0].label.length, 120);
  assert.equal(view.workspace, 'normal-chat');
});

test('new task reason is visible only when the server recorded an evidence anchor', () => {
  const view = workspaceProgressPanel({ tasks: [
    { id: 'test-code', type: 'code', status: 'complete' },
    { id: 'investigate-1', type: 'investigate', status: 'pending',
      metadata: { evidenceAnchorTaskId: 'test-code', admission: 'observed-evidence-and-unmet-requirement' } },
    { id: 'verify', type: 'verify', status: 'pending' }
  ] }, 'code');
  assert.equal(view.stages[0].evidenceAnchor, '');
  assert.equal(view.stages[1].evidenceAnchor, 'test-code');
  assert.equal(view.stages[2].evidenceAnchor, '');
});

test('ongoing file work reports context without inventing edits or test results', () => {
  const view = workspaceProgressPanel({
    next: 'respond',
    adaptation: { attachments: [{ name: 'notes.pdf' }, { name: 'budget.xlsx' }] },
    tasks: [{ id: 'respond', type: 'respond', status: 'running',
      purpose: 'Read selected files' }]
  });
  assert.equal(view.stageContext.title, 'Working · file-based work');
  assert.match(view.stageContext.detail, /2 files in context/);
  assert.match(view.stageContext.detail, /only when recorded/);
});

test('ongoing reassessment explains the public evidence checkpoint without disclosing private reasoning', () => {
  const view = workspaceProgressPanel({
    next: 'reassess',
    tasks: [
      { id: 'test-code', type: 'code', status: 'complete',
        evidence: { result: { exitCode: 1 } } },
      { id: 'reassess', type: 'reassess', status: 'running' }
    ]
  }, 'code');
  assert.equal(view.stageContext.title, 'Working · reassess the next action');
  assert.match(view.stageContext.detail, /recorded results/);
});

test('pending verification is presented as next rather than completed', () => {
  const view = workspaceProgressPanel({
    next: 'verify', tasks: [{ id: 'verify', type: 'verify', status: 'pending' }]
  }, 'research');
  assert.equal(view.stageContext.title, 'Up next · verify the result');
  assert.equal(view.completed, 0);
});

test('single everyday reply has no distracting explanation panel', () => {
  const view = workspaceProgressPanel({
    next: 'respond',
    tasks: [{ id: 'respond', type: 'respond', status: 'running' }]
  });
  assert.equal(view.stageContext, null);
});
