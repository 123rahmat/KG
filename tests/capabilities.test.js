import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCapabilitySpec,
  normalizeCapabilityDiscovery,
  capabilityRequiresApproval,
  verificationContract
} from '../src/capabilities.js';

test('dynamic capability specs are normalized into a stable contract', () => {
  const spec = normalizeCapabilitySpec({
    id: 'future CAD Tool',
    purpose: 'Generate and inspect a parametric mechanical model.',
    inputs: ['geometry', 'constraints'],
    outputs: ['model'],
    executionModes: ['tool', 'local'],
    tools: ['freecad'],
    prerequisites: ['FreeCAD'],
    risk: 'high',
    physical: true,
    verification: {
      method: 'Compare model constraints with design criteria.',
      criteria: ['mass <= target']
    }
  });
  assert.equal(spec.id, 'future-cad-tool');
  assert.equal(spec.status, 'candidate');
  assert.deepEqual(spec.inputs, ['geometry', 'constraints']);
  assert.equal(spec.sideEffects, true);
  assert.equal(capabilityRequiresApproval(spec), true);
});

test('malformed discovery output is bounded and normalized', () => {
  const result = normalizeCapabilityDiscovery({
    capabilities: [
      { id: 'One', purpose: 'A', risk: 'critical' },
      { id: 'One', purpose: 'duplicate should be removed' },
      null
    ],
    executionRequirements: {
      code: {
        cpuCores: '16',
        memoryBytes: 17179869184,
        gpu: { required: true, memoryBytes: 8589934592 },
        software: { python: '3.12', 'bad name': 'x' }
      }
    }
  });
  assert.equal(result.capabilities.length, 1);
  assert.equal(result.capabilities[0].risk, 'critical');
  assert.equal(result.executionRequirements.code.cpuCores, 16);
  assert.equal(result.executionRequirements.code.gpu.required, true);
  assert.deepEqual(result.executionRequirements.code.software, { python: '3.12' });
});

test('physical and high-impact work can require human-certified verification', () => {
  const contract = verificationContract({ physical: true });
  assert.equal(contract.humanReviewRequired, true);
  assert.equal(contract.minimumLevel, 'human-certified');
});

test('ordinary work keeps evidence-backed verification', () => {
  const contract = verificationContract();
  assert.equal(contract.humanReviewRequired, false);
  assert.equal(contract.minimumLevel, 'evidence-backed');
});


test('rediscovery cannot rewrite an administrator-revoked capability contract', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rows: [] };
    }
  };
  const { CapabilityStore } = await import('../src/capability-store.js');
  const store = new CapabilityStore({});
  await store.upsertCandidatesTx(
    client,
    { workspaceId: 'ws' },
    { id: 'principal-1' },
    [{ id: 'revoked-capability', purpose: 'candidate', risk: 'medium' }]
  );
  const insert = queries.find(sql => /INSERT INTO capability_specs/.test(sql));
  assert.match(insert, /WHERE capability_specs\.status = 'candidate'/);
  assert.doesNotMatch(insert, /status <> 'approved'/);
});

test('capabilities the server already provides are never treated as discovered, so they need no approval', async () => {
  const { normalizeCapabilityDiscovery: discover } = await import('../src/capabilities.js');
  const { BUILT_IN_CAPABILITIES } = await import('../src/capability-compiler.js');
  // What Gemini returned for "write is_prime(n) with tests and run them".
  const found = discover({ capabilities: [
    { id: 'code-generation', name: 'Code Generation', risk: 'medium', tools: ['llm'] },
    { id: 'code-execution', name: 'Code Execution', risk: 'high', tools: ['python-runner'], sideEffects: true },
    { id: 'satellite-telemetry-decoder', name: 'Satellite telemetry decoder', risk: 'medium' }
  ] });
  assert.deepEqual(found.capabilities.map(item => item.id), ['satellite-telemetry-decoder']);
  assert.ok(BUILT_IN_CAPABILITIES.includes('code-execution') && !BUILT_IN_CAPABILITIES.some(id => /simulat/.test(id)));
  const { systemPromptFor } = await import('../src/reasoning-context.js');
  assert.match(systemPromptFor({ task: { type: 'discover-capabilities' } }), /already provides these capabilities[^.]*code-generation, code-execution/);
});
