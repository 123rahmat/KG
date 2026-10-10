import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_ENGINE_IDS, controlEngineForSurface, controlEngineProfile,
  makeControlWorkScope, assertControlWorkScope, scopedAgentWork,
  SHARED_RUNTIME_CONTRACT
} from '../src/work-control-engines.js';

const work = overrides => ({
  principalId:'u1',workspaceId:'tenant1',projectId:'project1',runId:'run1',
  controlEngineId:'coding',projectRevision:'revision1',policyRevision:'policy1',
  ...overrides
});

test('two independent control policies reuse one shared runtime', () => {
  assert.deepEqual(CONTROL_ENGINE_IDS,['coding','research']);
  assert.equal(controlEngineForSurface('code'),'coding');
  assert.equal(controlEngineForSurface('research'),'research');
  assert.equal(controlEngineProfile('coding').controller,'CodingControlEngine');
  assert.equal(controlEngineProfile('research').controller,'ResearchControlEngine');
  assert.notEqual(controlEngineProfile('code').acceptance,controlEngineProfile('research').acceptance);
  assert.equal(SHARED_RUNTIME_CONTRACT.runStore,'shared-single-source-of-truth');
  assert.equal(SHARED_RUNTIME_CONTRACT.budgets,'shared-account-ceiling');
  assert.throws(()=>controlEngineForSurface('normal-chat'), { code:'unsupported-control-engine' });
});

test('agentic context requires immutable controller project and run owner', () => {
  const original=makeControlWorkScope(work());
  assert.ok(Object.isFrozen(original));
  assert.equal(assertControlWorkScope(original,makeControlWorkScope(work()),{requireRevision:true}),true);
  for(const change of [
    {principalId:'u2'}, {workspaceId:'tenant2'}, {projectId:'project2'},
    {runId:'run2'}, {controlEngineId:'research'}
  ]) {
    assert.throws(()=>assertControlWorkScope(original,work(change)),{code:'control-scope-mismatch'});
  }
  assert.throws(()=>makeControlWorkScope(work({projectId:''})),{code:'invalid-control-work-scope'});
  assert.throws(()=>assertControlWorkScope(original,work({projectRevision:'changed'}),{requireRevision:true}),
    {code:'control-revision-mismatch'});
});

test('agent inherits parent scope; no silent cross-controller mutation', () => {
  const parent=makeControlWorkScope(work());
  const agent=scopedAgentWork(parent,{agentId:'agent1',taskId:'task1'});
  assert.equal(agent.controlEngineId,'coding');
  assert.equal(agent.runId,parent.runId);
  assert.ok(Object.isFrozen(agent));
  assert.throws(()=>scopedAgentWork(parent,{agentId:'agent1',taskId:'task1',controlEngineId:'research'}),
    {code:'control-scope-mismatch'});
  assert.throws(()=>scopedAgentWork(parent,{agentId:'',taskId:'task1'}),
    {code:'invalid-agent-control-scope'});
});

test('Research invokes the shared runtime with its own isolated project scope', () => {
  const coding=makeControlWorkScope(work());
  const research=makeControlWorkScope(work({controlEngineId:'research',projectId:'research-project'}));
  assert.equal(research.controlEngineId,'research');
  assert.throws(()=>assertControlWorkScope(coding,research),{code:'control-scope-mismatch'});
});
