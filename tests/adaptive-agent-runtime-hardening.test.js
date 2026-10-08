import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentTopology, adaptAgentTopology, agentModelFor } from '../src/adaptive-agents.js';

test('serialized and retrying topologies retain every selected task', () => {
  for (const options of [{ risk: 'high-impact' }, { retrying: true }]) {
    const plan = decideAgentTopology({ tasks: [{ id: 'a', type: 'analyze' }, { id: 'b', type: 'analyze' }, { id: 'c', type: 'verify' }], ...options });
    assert.equal(plan.waves.every(wave => wave.length === 1), true);
    assert.deepEqual(plan.waves.flat().sort(), plan.agents.map(agent => agent.id).sort());
  }
});

test('planned waves respect the parallel budget without discarding work', () => {
  const plan = decideAgentTopology({ tasks: ['a', 'b', 'c', 'd'].map(id => ({ id, type: 'analyze' })), scale: 'medium', budget: { maxAgents: 4, maxParallelAgents: 2 } });
  assert.equal(plan.waves.every(wave => wave.length <= 2), true);
  assert.equal(plan.waves.flat().length, 4);
  const recovered = adaptAgentTopology(plan, { failed: true, taskId: 'a' });
  assert.equal(recovered.maxParallel, 1);
  assert.deepEqual(recovered.waves.flat(), plan.waves.flat());
});

test('agent model policy spends frontier capacity only where quality pressure justifies it', () => {
  assert.equal(agentModelFor({ workspace: 'normal-chat', role: 'lead', complexity: 0.2 }), 'google:gemini-3.5-flash-lite');
  assert.equal(agentModelFor({ workspace: 'normal-chat', role: 'reviewer', complexity: 0.2 }), 'google:gemini-3.8-flash');
  assert.equal(agentModelFor({ workspace: 'code', role: 'lead', complexity: 0.2 }), 'google:gemini-3.5-flash-lite');
  assert.equal(agentModelFor({ workspace: 'code', role: 'builder', complexity: 0.2 }), 'google:gemini-3.8-flash');
  assert.equal(agentModelFor({ workspace: 'research', role: 'lead', complexity: 0.2 }), 'google:gemini-3.5-flash-lite');
  assert.equal(agentModelFor({ workspace: 'research', role: 'research', complexity: 0.2 }), 'google:gemini-3.8-flash');
  assert.equal(agentModelFor({ workspace: 'normal-chat', role: 'lead', risk: 'high-impact' }), 'google:gemini-3.8-flash');

  const plan = decideAgentTopology({
    workspace: 'normal-chat',
    tasks: [{ id: 'a', type: 'analyze' }, { id: 'b', type: 'verify' }],
    scale: 'medium',
    complexity: 0.4,
    budget: { maxAgents: 2, maxParallelAgents: 2 }
  });
  assert.equal(plan.modelPolicy, 'adaptive-per-role');
  assert.equal(plan.agents.find(agent => agent.role === 'analyst')?.model, 'google:gemini-3.5-flash-lite');
  assert.equal(plan.agents.find(agent => agent.role === 'reviewer')?.model, 'google:gemini-3.8-flash');
});


test('simple medium Normal Chat does not pay multi-agent overhead without real pressure', () => {
  const plan = decideAgentTopology({
    workspace: 'normal-chat',
    tasks: [{ id:'answer', type:'analyze' }],
    scale: 'medium',
    complexity: .3,
    uncertainty: .15,
    budget: { maxAgents: 4, maxParallelAgents: 4 }
  });
  assert.equal(plan.mode, 'single');
  assert.equal(plan.agentCount, 1);
  assert.equal(plan.computePolicy.recommendedAgents, 1);
  assert.equal(plan.agents[0].model, 'google:gemini-3.5-flash-lite');
});

test('Code and Research preserve frontier models on quality-critical roles while bounding concurrency', () => {
  const code = decideAgentTopology({
    workspace:'code',
    tasks:[{id:'analyze',type:'analyze'},{id:'build',type:'code'},{id:'test',type:'test'}],
    scale:'medium', complexity:.6, uncertainty:.35,
    budget:{maxAgents:6,maxParallelAgents:6}
  });
  assert.ok(code.maxParallel <= code.computePolicy.maxParallel);
  assert.equal(code.agents.find(agent=>agent.role==='builder')?.model,'google:gemini-3.8-flash');
  assert.equal(code.agents.find(agent=>agent.role==='tester')?.model,'google:gemini-3.8-flash');

  const research = decideAgentTopology({
    workspace:'research',
    tasks:[{id:'scope',type:'analyze'},{id:'source',type:'research'},{id:'review',type:'verify'}],
    scale:'medium', complexity:.55, uncertainty:.55,
    budget:{maxAgents:6,maxParallelAgents:6}
  });
  assert.ok(research.maxParallel <= research.computePolicy.maxParallel);
  assert.equal(research.agents.find(agent=>agent.role==='research')?.model,'google:gemini-3.8-flash');
  assert.equal(research.agents.find(agent=>agent.role==='reviewer')?.model,'google:gemini-3.8-flash');
});

test('topology plans describe advisory assignments without execution authority', () => {
  for (const tasks of [[{ id: 'answer', type: 'analyze' }], [{ id: 'inspect', type: 'analyze' }, { id: 'verify', type: 'verify' }]]) {
    const plan = decideAgentTopology({ tasks, scale: 'medium' });
    assert.equal(plan.authority.proposalOnly, true);
    assert.ok(plan.agents.every(agent => agent.authority === 'advisory-only'));
    const recovered = adaptAgentTopology(plan, { failed: true });
    assert.equal(recovered.authority.proposalOnly, true);
  }
});
