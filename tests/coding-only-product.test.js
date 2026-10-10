import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProject } from '../src/projects.js';
import { admitControlEngineRequest, verifyControlledRun } from '../src/control-engine-admission.js';

const scope={workspaceId:'ws1'};
const poolWithProject = surface => ({
  async query(sql) {
    if (sql.includes('FROM projects')) return { rows:[{
      id:'p1',default_surface:surface,state:'active',current_revision:'rev1'
    }]};
    if (sql.includes('FROM runs')) return {rows:[]};
    throw Error('Unexpected DB query');
  }
});
const admission = (surface, goal) => admitControlEngineRequest({
  pool:poolWithProject(surface),scope,principalId:'user1',projectId:'p1',
  activeSurface:surface,goal,codingOnly:true
});

test('code-only projects cannot be created as research or normal chat',()=>{
  assert.equal(normalizeProject({name:'App'},{codingOnly:true}).defaultSurface,'code');
  for(const surface of ['research','normal-chat']) {
    assert.throws(()=>normalizeProject({name:'Legacy',defaultSurface:surface},{codingOnly:true}),
      error=>error.code==='code-only-project-required');
  }
});
test('code-only new coding work is admitted with pinned identity',async()=>{
  const result=await admission('code','Implement an API endpoint and test the code');
  assert.equal(result.controlEngineId,'coding');
  assert.equal(result.projectRevision,'rev1');
});
test('code-only gate rejects research projects and scholarly-only tasks',async()=>{
  await assert.rejects(admission('research','Write a research paper'),error=>
    error.code==='code-only-project-required');
  await assert.rejects(admission('code','Write a research paper and academic thesis'),error=>
    error.code==='code-only-task-required');
});
test('old research runs cannot advance in code-only mode',async()=>{
  const result=await verifyControlledRun({codingOnly:true,run:{surface:'research'},scope,
    principalId:'user1',pool:poolWithProject('research')});
  assert.equal(result.code,'code-only-historical-read-only');
});
test('UI contains task status, sidebar, and preserved conversation Files tabs',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/app-attachments.js',import.meta.url),'utf8');
  assert.match(html,/id="codingNav"/);
  assert.match(html,/id="codingProgressPanel"/);
  assert.ok(html.indexOf('id="chatViewSwitch"') < html.indexOf('id="codingProgressPanel"'));
  assert.match(css,/chat\[data-chat-view="files"\] #codingProgressPanel/);
  assert.match(app,/renderCodingProgress\(/);
});
