import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATIONS } from '../src/migrations.js';
import fs from 'node:fs';

test('new learned specialist schema is append-only and protected by forced row-level security',()=>{
  const create=MIGRATIONS.find(m=>m.version===78);
  const feedback=MIGRATIONS.find(m=>m.version===79);
  assert.equal(create?.name,'scoped-reusable-specialist-recipes');
  assert.match(create.sql,/FORCE ROW LEVEL SECURITY/);
  assert.match(create.sql,/principal_id = current_setting\('app.principal_id', true\)/);
  assert.match(create.sql,/workspace_id = current_setting\('app.workspace_id', true\)/);
  assert.match(create.sql,/CHECK \(cardinality\(observed_run_ids\) <= 8\)/);
  assert.match(feedback.sql,/failed_run_ids/);
});

test('runtime db startup requires protected recipe table and explicit least-privilege grants',()=>{
  const src=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(src,/['"]saved_specialist_recipes['"]/);
  assert.match(src,/['"]SELECT, INSERT, UPDATE, DELETE['"], \[['"]saved_specialist_recipes['"]\]/);
});

test('normal direct model and optional agent panel see the same bounded library context',()=>{
  const src=fs.readFileSync(new URL('../src/routes/execution.js',import.meta.url),'utf8');
  assert.equal((src.match(/savedSpecialists\.suggest\(/g)||[]).length,1);
  assert.match(src,/let payload = compact\(\{\s*goal: run.goal,\s*reusableSpecialists,/);
  assert.match(src,/basePayload: payload,/);
  assert.match(src,/reusedSpecialistIds: reusableSpecialists\.map/);
  assert.match(src,/savedSpecialists\.observeFailedReuse\(/);
  assert.match(src,/savedSpecialists\.observeVerified\(/);
});

test('personalization controls are present and use readable DOM text rather than innerHTML',()=>{
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const js=fs.readFileSync(new URL('../public/app-settings-window.js',import.meta.url),'utf8');
  assert.match(html,/id="savedSpecialistList"/);
  assert.match(html,/id="savedSpecialistRefresh"/);
  assert.match(js,/renderSavedSpecialists\(/);
  assert.match(js,/api\('GET', '\/api\/specialists\/saved'\)/);
  assert.match(js,/api\('DELETE', '\/api\/specialists\/saved\/'/);
  assert.doesNotMatch(js,/savedSpecialistList[^\n]+innerHTML/);
});
