import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workPresentation } from '../public/adaptive-workspace.js';

const root = path.resolve(process.cwd(), 'public');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('live workflow has server-backed cancellation guardrails', () => {
  const app = read('app.js');
  const attachments = read('app-attachments.js');
  const core = read('ui-core.js');

  assert.match(core, /cancelledRuns:\s*new Set\(\)/);
  assert.match(core, /stoppingRun:\s*null/);
  assert.match(app, /cancelledRuns\?\.has\(run\.id\)/);
  assert.match(app, /stoppingRun === run\.id/);
  assert.match(app, /runs\/\$\{fresh\.id\}\/fail/);
  assert.match(attachments, /state\.cancelledRuns\.add\(run\.id\)/);
  assert.match(attachments, /Stopping is queued/);
  assert.match(attachments, /\/api\/runs\/\$\{run\.id\}\/fail/);
});

test('adaptive progress remains visible and honest during live work', () => {
  const css = read('app.css');
  const pending = { state: 'respond', next: 'answer', tasks: [{ id: 'answer', type: 'respond', status: 'running' }], requirements: { items: [], overallProgress: 100, completionReady: true } };
  assert.equal(workPresentation(pending).live, true);
  assert.equal(workPresentation(pending).percent, null, 'an empty requirement model never claims 100%');
  assert.equal(workPresentation(pending, { online: false }).disconnected, true);
  assert.equal(workPresentation(pending, { online: false }).live, false);
  assert.equal(workPresentation({ ...pending, state: 'failed' }).live, false);
  assert.doesNotMatch(css, /work-progress-meter::after/);
  assert.match(css, /\.work-background-strip/);
  assert.match(css, /\.work-permission-strip/);
  assert.match(css, /\.composer-work-status/);
  assert.match(css, /send\[data-mode="stop"\]/);
  assert.match(css, /is-stopping/);
  const html = read('index.html');
  assert.match(html, /id="workMiniStatus"/);
});

test('browser-rendered text uses DOM text APIs rather than unsafe HTML interpolation', () => {
  const core = read('ui-core.js');
  assert.match(core, /node\.textContent = String\(value/);
  assert.doesNotMatch(core, /innerHTML\s*=\s*[^=]/);
});
