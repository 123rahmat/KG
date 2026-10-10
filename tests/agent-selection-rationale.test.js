import test from 'node:test';
import assert from 'node:assert/strict';
import { explainAgentSelection } from '../src/agent-selection-rationale.js';
import { rolesFor } from '../src/multi-agent.js';

test('role selection exposes what, when, how and why without pretending it ran',()=>{
  const run={surface:'code',goal:'Fix authorization security in an API',
    situation:{risk:'medium',complexity:.8,uncertainty:.4},
    adaptation:{scale:'complex'},attempt:1};
  const output=rolesFor(run,{id:'build-code',type:'code'},{mode:'always',maxAgents:4});
  const rationale=output.allocation.selectionRationale;
  assert.equal(rationale.source,'server-selected-task-allocation');
  assert.deepEqual(rationale.roles.map(v=>v.role),output.roles);
  assert.ok(rationale.roles.every(v=>v.what&&v.when&&v.how&&v.why
    &&v.status==='selected-not-proof-of-execution'));
  assert.equal(rationale.modelCallsPerformed,0);
  assert.equal(rationale.mayAuthorizeTools,false);
});
test('uncovered requirement is described as such',()=>{
  const item=explainAgentSelection({
    surface:'research',goal:'Assess novel detector evidence',
    task:{id:'investigate'},roles:['situational-a'],
    dynamicSpecialists:[{role:'situational-a',requirement:'Review spectroscopy drift against measured references'}]
  });
  assert.match(item.roles[0].why,/spectroscopy drift/);
  assert.match(item.parallelPolicy,/Serial/);
});
test('zero selected roles never imply that a team ran',()=>{
  const value=explainAgentSelection({roles:[],decision:{reason:'single-agent-sufficient'}});
  assert.deepEqual(value.roles,[]);
  assert.equal(value.whyAgents,'single-agent-sufficient');
});
