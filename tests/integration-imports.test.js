import test from 'node:test';
import assert from 'node:assert/strict';
test('unified runtime modules import cleanly', async () => {
  const modules = [
    '../src/fleet-control.js',
    '../src/parallel-orchestrator.js',
    '../src/skills.js',
    '../src/rag.js',
    '../src/blackboard.js',
    '../src/adaptive-cache.js',
    '../src/feedback.js',
    '../src/agent-harness.js',
    '../src/protocols.js',
    '../src/evals.js',
    '../src/multi-agent.js',
    '../src/routes/runs.js',
    '../src/routes/execution.js'
  ];
  for (const spec of modules) {
    const mod = await import(spec);
    assert.ok(mod);
  }
});