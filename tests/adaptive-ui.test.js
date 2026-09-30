import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFile(path.join(ROOT, name), 'utf8');
// The browser client: app.js and the parts it is split into (app-*.js).
const client = async () => {
  const names = (await fs.readdir(path.join(ROOT, 'public'))).filter(name => /^(?:app(?:-[\w-]+)?|adaptive-workspace)\.js$/.test(name)).sort();
  return (await Promise.all(names.map(name => read(`public/${name}`)))).join('\n');
};

test('the web shell is one chat: a thread, a message box and a chat list', async () => {
  const html = await read('public/index.html');
  assert.match(html, /id="goal"/);
  assert.match(html, /id="composer"/);
  assert.match(html, /id="thread"/);
  assert.match(html, /id="runList"/);
  assert.match(html, /id="attachBtn"/);
  assert.match(html, /id="settings"/);
  assert.match(html, /id="chatSearch"/);
  assert.match(html, /data-tab="explore"/);
  assert.match(html, /id="tab-runs"/);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/i);
  assert.doesNotMatch(html, /ProfessorAI|Professor<span>/);
});

test('the client asks for decisions inline, not in browser pop-ups', async () => {
  const js = await client();
  assert.match(js, /\/api\/runs/);
  assert.match(js, /run\.adaptation/);
  assert.match(js, /function renderNextStep/);
  assert.match(js, /\/api\/conversations/);
  assert.match(js, /function autoDrive/);
  // Answers, approvals, checks and findings are forms on the page; only the
  // irreversible "stop", "delete", "delete chat" and "forget everything"
  // actions keep a confirmation dialog.
  assert.doesNotMatch(js, /\bprompt\(/);
  assert.equal((js.match(/\bconfirm\(/g) ?? []).length, 4);
  // Work a person does is labelled as theirs, and AI consent is explicit.
  assert.match(js, /humanProvided: true/);
  assert.match(js, /modelConsent: true/);
});

test('adaptive UI keeps execution approval and evidence boundaries visible', async () => {
  const js = await client();
  assert.match(js, /approved/);
  assert.match(js, /preflight/);
  assert.match(js, /execution-result/);
  assert.match(js, /evidence/);
});


test('adaptive workspace presentation follows the same live run state', async () => {
  const html = await read('public/index.html');
  const js = await read('public/adaptive-workspace.js');
  assert.match(html, /id="adaptiveWorkspaceBar"/);
  assert.match(js, /function surfaceSet/);
  assert.match(js, /renderAdaptiveWorkspace/);
  assert.match(js, /syncAdaptiveWorkspace/);
  assert.match(js, /kindgleam:select-surface/);
  assert.match(js, /needed for this situation|Current work/);
});

test('there is no simulation tab: files are handled in the chat and simulations are code', async () => {
  const html = await read('public/index.html');
  const app = await read('public/app.js');
  assert.doesNotMatch(html, /data-tab="simulation"|id="tab-simulation"|simulationCanvas/);
  assert.doesNotMatch(app, /simulation-ui\.js/);
  await assert.rejects(read('public/simulation-ui.js'));
});

test('every step has an up/down toggle that shows or hides what it did', async () => {
  const app = await read('public/app.js');
  const css = await read('public/app.css');
  const html = await read('public/index.html');
  assert.match(app, /class: 'step-toggle', 'aria-expanded': String\(open\), 'aria-controls': detailId/);
  assert.match(app, /class: 'step-detail', id: detailId, hidden: !open/);
  assert.match(app, /state\.openSteps/, 'an open step stays open when the chat refreshes');
  assert.match(app, /\/\^https\?:\\\/\\\/\/i\.test/, 'only web addresses become source links');
  assert.match(css, /\.steps \.step-toggle\[aria-expanded="true"\] svg \{ transform: rotate\(180deg\)/);
  assert.match(html, /id="i-chevron"/);
});
