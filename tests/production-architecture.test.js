import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_CATALOG } from '../src/model-catalog.js';
import { SURFACE_WORKSPACE_CONTRACTS, WORKSPACE_ENVIRONMENT_CONTRACTS } from '../src/surface-policy.js';
import { decideAgentTopology } from '../src/adaptive-agents.js';
import { multiAgentDecision } from '../src/multi-agent.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('production model boundary is Vertex Gemini family only',()=>{
  assert.deepEqual(Object.keys(MODEL_CATALOG),['google:gemini-3.5-flash-lite','google:gemini-3.8-flash']);
  const configSource = read('src/config.js');
  const runtimeSource = read('src/runtime.js');
  assert.match(configSource, /const PROVIDERS = \['google'\]/);
  assert.match(runtimeSource, /SUPPORTED_PROVIDERS = Object\.freeze\(\['google'\]\)/);
  assert.doesNotMatch(configSource, /provider switching|multi-provider/i);
});

test('the three workspaces are complete operating environments',()=>{
  const names=['normal-chat','code','research'];
  assert.deepEqual(Object.keys(SURFACE_WORKSPACE_CONTRACTS),names);
  assert.deepEqual(Object.keys(WORKSPACE_ENVIRONMENT_CONTRACTS),names);
  for(const name of names){
    const env=WORKSPACE_ENVIRONMENT_CONTRACTS[name]; const contract=SURFACE_WORKSPACE_CONTRACTS[name];
    assert.ok(env.environment&&env.stateModel&&env.canonicalArtifacts&&env.primaryTools&&env.verification&&env.mutationBoundary);
    assert.ok(contract.objective&&contract.contextPolicy&&contract.toolPolicy&&contract.agentPolicy&&contract.verificationPolicy);
  }
});

test('adaptive topology is server-owned, bounded, and Gemini-only',()=>{
  const plan=decideAgentTopology({workspace:'code',tasks:[{id:'a',type:'code',writePaths:['src/a.js']},{id:'b',type:'code',writePaths:['src/b.js']}],
    scale:'complex',complexity:.9,uncertainty:.5,budget:{maxAgents:6,maxParallelAgents:3}});
  assert.ok(plan.agentCount>=1&&plan.agentCount<=6);
  assert.ok(plan.maxParallel>=1&&plan.maxParallel<=3);
  assert.equal(plan.authority.serverOwned,true);
  assert.equal(plan.authority.modelCannotAuthorize,true);
  assert.ok(plan.agents.every(agent=>agent.model==='google:gemini-3.8-flash'));
});

test('normal chat does not pay multi-agent coordination cost for simple work',()=>{
  const decision=multiAgentDecision({goal:'answer a simple question',situation:{risk:'low',uncertainty:0},adaptation:{scale:'small'}},
    {id:'respond',type:'respond'},{mode:'auto'});
  assert.equal(decision.enabled,false);
});

test('browser and workflow boundaries remain explicit',()=>{
  const app=read('src/app.js'); const runs=read('src/runs.js');
  assert.match(app,/Content-Security-Policy|contentSecurityPolicy/i);
  assert.match(app,/helmet/i);
  assert.match(runs,/server owns the graph/i);
  assert.doesNotMatch(runs,/function\s+buildTasks\s*\(/);
});
