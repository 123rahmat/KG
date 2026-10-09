import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIGRATIONS } from '../src/migrations.js';
import { familyPlaybook, selectFamilySubagents } from '../src/adaptive-family-subagents.js';

const source = file => fs.readFileSync(new URL(file, import.meta.url),'utf8');

test('run agent and parallel wave rows keep shared reads but have owner-only writes',()=>{
  const latest=MIGRATIONS.find(entry=>entry.version===80);
  assert.equal(latest?.name,'agent-execution-owner-write-isolation');
  for(const table of ['run_agents','run_waves']){
    assert.match(latest.sql,new RegExp('DROP POLICY IF EXISTS '+table+'_scope_policy'));
    assert.match(latest.sql,new RegExp('CREATE POLICY '+table+'_read_policy'));
    assert.match(latest.sql,new RegExp('CREATE POLICY '+table+'_owner_insert'));
    assert.match(latest.sql,new RegExp('CREATE POLICY '+table+'_owner_update'));
    assert.match(latest.sql,new RegExp('CREATE POLICY '+table+'_owner_delete'));
  }
  assert.match(latest.sql,/r\.visibility = 'workspace'/);
  assert.match(latest.sql,/r\.principal_id = current_setting\('app.principal_id', true\)/);
});

test('agent owner check precedes model generation, project retrieval and tool use',()=>{
  const runtime=source('../src/routes/execution.js');
  const initial=runtime.indexOf("const run = await runs.get(req.scope, req.params.id);");
  const owner=runtime.indexOf("code: 'agent-owner-required'",initial);
  const reason=runtime.indexOf('async function reason(run, task');
  const ownership=runtime.indexOf('const resourceScope = bindAgentResourceScope',reason);
  const rag=runtime.indexOf('let ragResults = [];',reason);
  assert.ok(initial>=0 && owner>initial);
  assert.ok(reason>=0 && ownership>reason && rag>ownership);
  assert.match(runtime,/const agentResourceScope = bindAgentResourceScope\(\{run,task,scope:workScope\}\)/);
});

test('the tool boundary independently checks ownership of the persisted run',()=>{
  const toolbox=source('../src/toolbox.js');
  assert.match(toolbox,/import \{ bindAgentResourceScope \} from '\.\/agent-resource-broker.js'/);
  const start=toolbox.indexOf('export async function useTool');
  const checked=toolbox.indexOf('const auth = bindAgentResourceScope',start);
  const used=toolbox.indexOf('const tool = toolNamed',start);
  assert.ok(start>=0 && checked>start && used>checked);
});

test('backend and database specialists retain specialized owned subagents and no independent permissions',()=>{
  const backend=familyPlaybook('code','backend-engineering');
  const database=familyPlaybook('code','database-engineering');
  const security=familyPlaybook('code','security-engineering');
  assert.equal(backend.children.length,8);
  assert.equal(database.children.length,8);
  assert.equal(security.children.length,8);
  assert.ok(backend.children.some(child=>child.id==='background-jobs'));
  assert.ok(database.children.some(child=>child.id==='migrations'));
  assert.ok(security.children.some(child=>child.id==='authorization'));
  const selected=selectFamilySubagents({surface:'code',
    goal:'Build reliable backend API with authentication and integrations',
    role:'backend-engineer',situation:{complexity:.9,uncertainty:.8,unknownSituation:true,risk:'high'},
    task:{type:'plan'},remainingBudgetRatio:.8});
  assert.ok(selected.active.length>=1 && selected.active.length<=3);
  assert.ok(selected.active.every(item=>item.mayInvokeTools===false));
  assert.equal(selected.executionPolicy.parentOwnsVerification,true);
});

test('the UI reads actual admission state but never labels a proposed tool executed',()=>{
 const activity=source('../public/agent-activity.js');
 assert.match(activity,/multi\?\.resourceAdmissions/);
 assert.match(activity,/Read-only tool available · not executed/);
 assert.match(activity,/Parent executor required · not executed/);
 assert.match(activity,/User-controlled terminal only/);
});
