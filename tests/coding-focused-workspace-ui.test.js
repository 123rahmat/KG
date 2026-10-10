import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const content = path => readFileSync(new URL('../'+path, import.meta.url),'utf8');
const shell=content('public/index.html');
const ui=content('public/adaptive-workspace.js');
const app=content('public/app.js');
const css=content('public/app.css');
const progress=content('public/coding-progress-panel.js');

test('KG Code sidebar exposes real coding inspector destinations',()=>{
  for(const id of ['codeNavWork','codeNavProjects','codeNavProgress','codeNavChanges',
    'codeNavTests','codeNavSpecialists','codeNavTerminal','codeNavFiles','codeNavActivity']) {
    assert.equal((shell.match(new RegExp('id="'+id+'"','g')) || []).length,1,id);
  }
  assert.match(app,/openCodingInspector\('changes','codeNavChanges'\)/);
  assert.match(app,/openCodingInspector\('tests','codeNavTests'\)/);
  assert.match(app,/openCodingInspector\('agents','codeNavSpecialists'\)/);
  assert.match(app,/kindgleam:open-code-area/);
  assert.match(app,/chatViewMessages/);
  assert.match(shell,/id="chatViewSwitch" role="tablist"/);
  assert.ok(shell.indexOf('id="chatViewSwitch"')<shell.indexOf('id="thread"'));
});
test('code-only inspector is one focused ARIA tabpanel with keyboard navigation',()=>{
  assert.match(ui,/state\.product\?\.codingOnly === true/);
  assert.match(ui,/codeWorkspaceKey\(\)/);
  assert.match(ui,/role: 'tablist'/);
  assert.match(ui,/'aria-selected'/);
  assert.match(ui,/role: 'tabpanel'/);
  assert.match(ui,/control\.tabIndex = id === selected \? 0 : -1/);
  assert.match(ui,/\['ArrowLeft','ArrowRight','Home','End'\]/);
  assert.match(ui,/area\.hidden = !active/);
  assert.match(ui,/sectionGrid\.hidden = selected === 'overview'/);
  assert.match(ui,/applyFocusedCodeArea\(host\)/);
  assert.match(css,/\[data-coding-focus="true"\] \[role="tabpanel"\]\[hidden\]/);
  assert.match(css,/prefers-reduced-motion/);
});
test('coding progress preserves offline truth and links to real workspace areas',()=>{
  assert.match(progress,/Offline · showing the last saved run status/);
  assert.match(progress,/offline \? 'Offline · saved state'/);
  assert.match(progress,/not full task completion/);
  assert.match(progress,/inspectArea\('changes'\)/);
  assert.match(progress,/inspectArea\('tests'\)/);
  assert.match(progress,/inspectArea\('agents'\)/);
  assert.match(progress,/execution is not confirmed live/i);
  assert.match(content('public/app-attachments.js'),/offline: state\.network\?\.online === false/);
});
test('legacy research workspace remains unaffected by the focused coding-only UI',()=>{
  assert.match(ui,/workspace === 'code' && state\.product\?\.codingOnly === true/);
  assert.match(ui,/workspaceAreas\.get\(workspace\) \|\| 'overview'/);
  assert.match(ui,/data\.workspace === 'code' \? codeWorkspaceProject\(data\) : researchWorkspaceProject\(data\)/);
});
