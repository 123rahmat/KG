import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';
import { withServer, codeWritten } from './helpers.js';

const extra = plan => plan.capabilities.required.filter(id => !['reasoning', 'adaptive-safety-governance', 'situation-understanding',
  'capability-compilation', 'planning', 'verification', 'adaptive-composition', 'design'].includes(id));

test('there is no simulation concept: a request to simulate is a code project', () => {
  for (const goal of [
    'Simulate a damped pendulum.',
    'Make an LTspice netlist for an RC low-pass filter with R = 1 kΩ and C = 100 nF, and tell me its cutoff frequency.',
    'Write a Python simulation of a queue at a bank.'
  ]) {
    const plan = planGoal(goal);
    assert.ok(plan.capabilities.required.includes('code-generation'), goal);
    assert.ok(!plan.capabilities.required.some(id => /simulat/.test(id)), `${goal}: no simulation capability`);
    assert.notEqual(plan.intent.kind, 'simulation');
    assert.ok(!(plan.adaptation.surfaces ?? []).includes('simulation'));
  }
  // Someone who will run it themselves gets the code, nothing is run here.
  assert.deepEqual(extra(planGoal('Write a Python simulation of a queue at a bank that I can run myself.')), ['code-generation']);
});

test('a question about simulations is answered in the chat', () => {
  for (const goal of ['What is a Monte Carlo simulation?', 'Explain what my simulation results mean: the average wait went from 4 to 9 minutes.']) {
    const plan = planGoal(goal);
    assert.ok(!plan.capabilities.required.includes('code-generation'), goal);
    assert.ok(!plan.capabilities.required.includes('code-execution'), goal);
  }
});

test('the run engine has no simulate step: an old "simulate" next step becomes code', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Simulate a damped pendulum over 30 seconds.' } });
    const ready = await codeWritten(call, auth, run.id, { source: 'print(0.5)\n', tests: '' });
    assert.equal(ready.next, 'test-code');
    assert.equal(ready.tasks.some(task => task.type === 'simulate'), false);
  }, { env: { SANDBOX_RUNNER_URL: 'http://sandbox.test', RUNNER_TOKEN: 'runner-' + 'x'.repeat(31) } }));
