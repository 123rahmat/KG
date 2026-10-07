import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
  const workspace = read('adaptive-workspace.js');
  const css = read('app.css');

  assert.match(workspace, /Adaptive workflow progress/);
  assert.match(workspace, /Server-confirmed materialized steps/);
  assert.match(workspace, /Background activity and completed steps/);
  assert.match(workspace, /Approval needed/);
  assert.match(workspace, /Connection lost/);
  assert.match(workspace, /Next step adapts from evidence/);
  assert.match(css, /\.work-progress-segments/);
  assert.match(css, /\.work-background-strip/);
  assert.match(css, /\.work-permission-strip/);
  assert.doesNotMatch(css, /work-progress-meter::after/);
  assert.match(css, /send\[data-mode="stop"\]/);
  assert.match(css, /is-stopping/);
});

test('browser-rendered text uses DOM text APIs rather than unsafe HTML interpolation', () => {
  const core = read('ui-core.js');
  assert.match(core, /node\.textContent = String\(value/);
  assert.doesNotMatch(core, /innerHTML\s*=\s*[^=]/);
});
