import test from 'node:test';
import assert from 'node:assert/strict';
import { liveWorkFocus } from '../public/live-work-focus.js';

const runWith = (type, status = 'running', evidence = {}, extra = {}) => ({
  id: 'run-one', state: status === 'running' ? 'running' : 'queued', next: 'active',
  tasks: [{ id: 'active', type, status, purpose: 'Fix checkout tax rounding', evidence }],
  ...extra
});

test('stage one shows the exact selected task in one line, not generic reasoning', () => {
  const view = liveWorkFocus(runWith('code'), { workspace: 'code' });
  assert.equal(view.line, 'Working · Fix checkout tax rounding');
  assert.equal(view.surface, 'files');
  assert.equal(view.allowTerminal, false);
});

test('unstarted sandbox must not be described as running', () => {
  const view = liveWorkFocus(runWith('tool', 'pending', {
    executionTarget: 'general-ai-sandbox'
  }));
  assert.equal(view.status, 'Up next');
  assert.equal(view.surface, 'sandbox');
  assert.equal(view.hasRecordedExecution, true);
  assert.ok(!view.line.includes('Running'));
});

test('a tool name appears only when active task has running tool evidence', () => {
  const live = liveWorkFocus(runWith('tool', 'running', {
    tools: [{ tool: 'file.read', status: 'running' }]
  }));
  assert.match(live.line, /^Working · file.read · Fix checkout tax rounding$/);
  const stale = liveWorkFocus(runWith('tool', 'pending', {
    tools: [{ tool: 'file.read', status: 'running' }]
  }));
  assert.ok(!stale.line.includes('file.read'));
});

test('terminal action requires Code, an authorized connected GitHub source, and tool-related work', () => {
  const run = runWith('code');
  assert.equal(liveWorkFocus(run, { workspace: 'normal-chat', connectedGitHub: true }).allowTerminal, false);
  assert.equal(liveWorkFocus(run, { workspace: 'code', connectedGitHub: false }).allowTerminal, false);
  assert.equal(liveWorkFocus(run, { workspace: 'code', connectedGitHub: true }).allowTerminal, true);
  assert.equal(liveWorkFocus(run, { workspace: 'code', connectedGitHub: true, offline: true }).allowTerminal, false);
  assert.equal(liveWorkFocus(runWith('respond'), { workspace: 'code', connectedGitHub: true }).allowTerminal, false);
});

test('simple everyday chat stays one line without extra detail panel', () => {
  const view = liveWorkFocus(runWith('respond'), { workspace: 'normal-chat' });
  assert.equal(view.showDetails, false);
  assert.equal(view.surface, 'chat');
});

test('code verification shows last recorded sandbox outcome without implying it runs now', () => {
  const run = {
    state: 'running', next: 'verify',
    tasks: [
      { id: 'test-code', type: 'code', status: 'complete',
        evidence: { executionTarget: 'general-ai-sandbox' } },
      { id: 'verify', type: 'verify', status: 'running', purpose: 'Check acceptance criteria' }
    ]
  };
  const view = liveWorkFocus(run, { workspace: 'code' });
  assert.equal(view.line, 'Working · Check acceptance criteria');
  assert.equal(view.hasRecordedExecution, true);
  assert.ok(view.activity.some(item => item.label === 'Last recorded execution' && item.value === 'Sandbox'));
});

test('Research work stays in its own surface and labels a queued step honestly', () => {
  const view = liveWorkFocus(runWith('investigate', 'pending'), { workspace: 'research' });
  assert.equal(view.surface, 'research');
  assert.equal(view.status, 'Up next');
  assert.equal(view.allowGitHub, false);
});

test('completed and stopped runs never present an active tool or terminal action', () => {
  const run = runWith('tool', 'running', { tools: [{ tool: 'file.write', status: 'running' }] });
  run.state = 'complete';
  assert.equal(liveWorkFocus(run, { workspace: 'code', connectedGitHub: true }).allowTerminal, false);
  assert.equal(liveWorkFocus(run).line, 'Finished');
  assert.equal(liveWorkFocus(run, { stopping: true }).status, 'Stopping');
});

test('detail rows include only saved information and clip excessive user strings', () => {
  const run = runWith('code', 'running', {}, {
    adaptation: { attachments: [{ name: 'package.json' }, { name: 'src/index.js' }] }
  });
  const view = liveWorkFocus(run, { workspace: 'code' });
  assert.equal(view.activity.find(item => item.label === 'Selected files')?.value, 'package.json, src/index.js');
  assert.equal(view.stageCount, 1);
  assert.equal(view.showDetails, true);
});
