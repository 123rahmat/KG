import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODEL_CATALOG } from '../src/model-catalog.js';
import { SURFACE_WORKSPACE_CONTRACTS, WORKSPACE_ENVIRONMENT_CONTRACTS } from '../src/surface-policy.js';
import { decideAgentTopology } from '../src/adaptive-agents.js';
import { multiAgentDecision } from '../src/multi-agent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('production model boundary is Grok 4.7 only', () => {
  assert.deepEqual(Object.keys(MODEL_CATALOG), ['xai:grok-4.7']);
  for (const file of ['src/model-routing.js', 'src/config.js', 'src/agents.js', 'src/multi-agent.js', 'src/adaptive-agents.js']) {
    const source = read(file).toLowerCase();
    assert.equal(/(?:gemini|claude|anthropic|openai)\b/.test(source), false, file + ' contains a retired model/provider reference');
  }
});

test('the four workspaces are complete operating environments, not cosmetic tabs', () => {
  const names = ['normal-chat', 'code', 'research', 'design'];
  assert.deepEqual(Object.keys(SURFACE_WORKSPACE_CONTRACTS).sort(), names.slice().sort());
  assert.deepEqual(Object.keys(WORKSPACE_ENVIRONMENT_CONTRACTS).sort(), names.slice().sort());
  for (const name of names) {
    const env = WORKSPACE_ENVIRONMENT_CONTRACTS[name];
    const contract = SURFACE_WORKSPACE_CONTRACTS[name];
    assert.ok(env.environment && env.stateModel && env.canonicalArtifacts && env.primaryTools && env.verification && env.mutationBoundary);
    assert.ok(contract.objective && contract.contextPolicy && contract.toolPolicy && contract.agentPolicy && contract.verificationPolicy);
  }
});

test('adaptive topology is server-owned and bounded', () => {
  const plan = decideAgentTopology({
    workspace: 'code',
    tasks: [
      { id: 'a', type: 'code', writePaths: ['src/a.js'] },
      { id: 'b', type: 'code', writePaths: ['src/b.js'] }
    ],
    scale: 'complex',
    complexity: 0.9,
    uncertainty: 0.5,
    budget: { maxAgents: 6, maxParallelAgents: 3 }
  });
  assert.ok(plan.agentCount >= 1 && plan.agentCount <= 6);
  assert.ok(plan.maxParallel >= 1 && plan.maxParallel <= 3);
  assert.equal(plan.authority.serverOwned, true);
  assert.equal(plan.authority.modelCannotAuthorize, true);
  assert.equal(plan.authority.modelCannotGrantCapabilities, true);
  assert.equal(plan.authority.modelCannotDeclareWorldOutcome, true);
  assert.ok(plan.agents.every(agent => agent.model === 'xai:grok-4.7'));
});

test('normal chat does not pay multi-agent coordination cost for simple work', () => {
  const decision = multiAgentDecision(
    { goal: 'answer a simple question', situation: { risk: 'low', uncertainty: 0 }, adaptation: { scale: 'small' } },
    { id: 'respond', type: 'respond' },
    { mode: 'auto' }
  );
  assert.equal(decision.enabled, false);
});

test('browser and workflow boundaries remain explicit', () => {
  const app = read('src/app.js');
  const runs = read('src/runs.js');
  assert.match(app, /Content-Security-Policy|contentSecurityPolicy/i);
  assert.match(app, /helmet/i);
  assert.match(runs, /server owns the graph/i);
  assert.doesNotMatch(runs, /function\\s+buildTasks\\s*\\(/);
});
