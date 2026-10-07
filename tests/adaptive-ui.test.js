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
  // Answers, approvals, checks and findings are forms on the page; only
  // irreversible destructive actions keep a confirmation dialog.
  assert.doesNotMatch(js, /\bprompt\(/);
  // Confirmation dialogs are reserved for destructive/irreversible actions;
  // normal workflow decisions stay inline.
  assert.ok((js.match(/\bconfirm\(/g) ?? []).length <= 6);
  // Work a person does is labelled as theirs, and AI consent is explicit.
  assert.match(js, /humanProvided: true/);
  assert.match(js, /modelConsent: true/);
});

test('the chat workspace exposes server-owned, evidence-backed approach options', async () => {
  const js = await client();
  const css = await read('public/app.css');
  assert.match(js, /function brainstormCard\(run\)/);
  assert.match(js, /Options, trade-offs, and the evidence needed before changing course/);
  assert.match(js, /selected from current evidence/);
  assert.match(css, /\.brainstorm-card/);
  assert.match(css, /\.brainstorm-option\[data-selected="true"\]/);
});

test('work status exposes server-confirmed work details without hidden reasoning', async () => {
  const js = await client();
  assert.match(js, /function workDetailsCard\(run\)/);
  assert.match(js, /Current server-confirmed scope, execution, evidence and workspace state/);
  assert.match(js, /Work details/);
  assert.match(js, /Why now/);
  assert.match(js, /Revision/);
});

test('adaptive UI keeps execution approval and evidence boundaries visible', async () => {
  const js = await client();
  assert.match(js, /approved/);
  assert.match(js, /preflight/);
  assert.match(js, /execution-result/);
  assert.match(js, /evidence/);
});

test('coding plan approval exposes user keep/remove/add/change inputs before approval', async () => {
  const js = await client();
  assert.match(js, /What do you want to keep\? \(optional\)/);
  assert.match(js, /What do you want to remove\? \(optional\)/);
  assert.match(js, /What do you want to add\? \(optional\)/);
  assert.match(js, /What do you want to change\? \(optional\)/);
  assert.match(js, /Approve these changes and code/);
  assert.match(js, /planChoices/);
  assert.match(js, /existingCodePlan/);
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


test('normal chat keeps agent and model authority server-side instead of exposing control clutter', async () => {
  const js = await client();
  assert.doesNotMatch(js, /Three-agent control/);
  assert.doesNotMatch(js, /choose (?:a )?model/i);
  assert.match(js, /server-controlled|server-confirmed|server-owned/i);
});

test('adaptive workspace exposes exactly Normal Chat, Code, and Research product surfaces', async () => {
  const js = await read('public/adaptive-workspace.js');
  assert.match(js, /Normal Chat/);
  assert.match(js, /Code Workspace/);
  assert.match(js, /Research Workspace/);
  assert.doesNotMatch(js, /Design Workspace/);
  assert.doesNotMatch(js, /kindgleam:open-design-workspace/);
  const css = await read('public/app.css');
  assert.doesNotMatch(css, /data-workspace="design"|design-studio|design-canvas|design-inspector/);
  assert.match(js, /kindgleam:open-code-workspace/);
  assert.match(js, /kindgleam:select-surface/);
  const attachments = await read('public/app-attachments.js');
  const app = await read('public/app.js');
  const actions = await read('public/app-actions.js');
  assert.match(attachments, /activeSurface: state\.activeSurface/);
  assert.match(attachments, /activeSurface: item\.activeSurface/);
  assert.match(app, /state\.activeSurface = 'research'/);
  assert.match(app, /state\.activeSurface = 'code'/);
  assert.match(actions, /Research Workspace/);
});


test('workspace mode exposes the required capability dock in the sidebar', async () => {
  const html = await read('public/index.html');
  const js = await read('public/adaptive-workspace.js');
  const css = await read('public/app.css');
  assert.match(html, /id="workspaceCapabilityDock"/);
  assert.match(html, /id="attachCodeInput"/);
  assert.match(js, /function capabilityItems/);
  assert.match(js, /ZIP \+ single-file inputs/);
  assert.match(js, /GitHub project/);
  assert.match(js, /Tests \+ verification/);
  assert.match(js, /Search \+ gather/);
  assert.match(js, /Source set/);
  assert.match(js, /Evidence \+ gaps/);
  assert.match(js, /Citations \+ provenance/);
  assert.match(css, /\.workspace-capability-dock/);
});

test('Code Workspace keeps GitHub, ZIP and single-file inputs on one server-owned project context', async () => {
  const runs = await read('src/routes/runs.js');
  const attachments = await read('src/attachments.js');
  assert.match(runs, /workspaceSourceId/);
  assert.match(attachments, /export async function projectFiles/);
  assert.match(attachments, /workspace-file-conflict/);
  assert.match(attachments, /read\.format === 'project'/);
  assert.match(attachments, /CODE_FILE\.test/);
});

test('Research Workspace persists bounded source and evidence continuity', async () => {
  const runs = await read('src/runs.js');
  const research = await read('src/research-workspace.js');
  assert.match(runs, /researchWorkspace/);
  assert.match(runs, /updateResearchWorkspaceState/);
  assert.match(research, /RESEARCH_WORKSPACE_LIMITS/);
  assert.match(research, /sourceSet/);
  assert.match(research, /evidenceLedger/);
  assert.match(research, /unresolvedQuestions/);
});


test('deep modes have dedicated project-grade workspace shells instead of chat-only chrome', async () => {
  const html = await read('public/index.html');
  const js = await read('public/adaptive-workspace.js');
  const css = await read('public/app.css');
  assert.match(html, /id="deepWorkspaceShell"/);
  assert.match(js, /function codeWorkspaceProject/);
  assert.match(js, /function researchWorkspaceProject/);
  assert.match(js, /CODE PROJECT/);
  assert.match(js, /RESEARCH PROJECT/);
  assert.match(js, /Source set/);
  assert.match(css, /\.deep-workspace-shell/);
  assert.match(css, /\.deep-workspace-grid/);
});

test('Research Workspace opens in the dedicated workspace surface, not Explore', async () => {
  const js = await read('public/adaptive-workspace.js');
  assert.match(js, /name: 'runs', workspace: 'research'/);
  assert.doesNotMatch(js, /name: 'explore', workspace: 'research'/);
});
