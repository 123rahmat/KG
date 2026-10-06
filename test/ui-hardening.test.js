import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../public/' + path, import.meta.url), 'utf8');

test('composer exposes a real send-to-stop state without markup injection', () => {
  const html = read('index.html');
  const app = read('app.js');
  const attachments = read('app-attachments.js');

  assert.match(html, /id="createRun"[^>]*data-mode="send"/);
  assert.match(html, /class="stop-icon"[^>]*hidden/);
  assert.match(app, /data-mode = active \? 'stop' : sending \? 'busy' : 'send'/);
  assert.match(app, /stopRun\('stopped by user'\)/);
  assert.match(attachments, /\/api\/runs\/\$\{run\.id\}\/fail/);
  assert.match(attachments, /state\.drivingRuns\?\.delete\(run\.id\)/);
});

test('live progress has an explicit reconnect state and compact adaptive presentation', () => {
  const workspace = read('adaptive-workspace.js');
  const css = read('app.css');

  assert.match(workspace, /Connection lost/);
  assert.match(workspace, /work-connection-banner/);
  assert.match(workspace, /Next step adapts from evidence/);
  assert.match(css, /\.work-connection-banner/);
  assert.match(css, /\.send\[data-mode="stop"\]/);
});

test('model-authored markdown remains DOM-built and link-scheme restricted', () => {
  const markdown = read('markdown.js');
  assert.doesNotMatch(markdown, /\.innerHTML\s*=/);
  assert.ok(markdown.includes('return /^(https?:\\/\\/|mailto:)/i.test(href);'));
});
