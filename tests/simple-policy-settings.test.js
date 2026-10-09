import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('one Privacy & policy settings tab replaces two confusing policy/data sections',()=>{
  const html=source('../public/index.html');
  assert.equal((html.match(/data-settings-section="policies"/g)||[]).length,0);
  assert.equal((html.match(/data-settings-section="data"/g)||[]).length,2);
  const begin=html.indexOf('<section class="settings-group settings-section" data-settings-section="data"');
  const finish=html.indexOf('<section class="settings-group settings-section" data-settings-section="schedules"',begin);
  const tab=html.slice(begin,finish);
  for(const id of ['setConsent','setShare','setExternalContext','openMemorySettings',
    'policyLayer','policyApproval','policyDeniedTools','policySave','policyReload']) {
    assert.ok(tab.includes('id="'+id+'"'),id);
  }
  assert.ok(tab.includes('<details class="settings-policy-details">'));
  assert.equal((tab.match(/<\/section>/g)||[]).length,1);
});
test('policy controls load from consolidated tab without deleting backend policy implementation',()=>{
  const settings=source('../public/app-settings-window.js');
  const controls=source('../public/governance-controls.js');
  assert.match(settings,/if \(activeName === 'data'\) loadPolicyControls\(\);/);
  assert.match(controls,/settingsSection === 'data'/);
  assert.match(controls,/export async function loadPolicyControls/);
});
test('one server-owned execution gate protects the primary run entry and provider boundary',()=>{
  const runtime=source('../src/routes/execution.js');
  assert.match(runtime,/const gate = checkTaskPolicy\(run, task,/);
  assert.match(runtime,/model: modelId, risk: 'medium'/);
  assert.match(runtime,/target: executionDecision.target, risk: 'high'/);
  assert.match(runtime,/checkConnectionPolicy\(run,/);
  assert.match(runtime,/recordBoundaryDenial\(req, run, task, gate.code/);
});
