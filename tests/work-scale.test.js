import test from 'node:test';
import assert from 'node:assert/strict';
import { workScale, taskTools, BUILT_IN } from '../src/work-scale.js';
import { planBrief } from '../src/plan-brief.js';
import { compactResourcePlan, adaptationFor } from '../src/prompt-scope.js';
import { planGoal } from '../src/core.js';
import { withServer } from './helpers.js';

test('the size of the work decides the size of the plan', () => {
  const code = ['reasoning', 'planning', 'code-generation', 'code-execution'];
  assert.equal(workScale({ capabilities: code }), 'small');
  assert.equal(workScale({ capabilities: ['code-generation', 'code-execution'], physical: true }), 'small', 'code that computes something physical is still only code');
  assert.equal(workScale({ capabilities: ['design'] }), 'small');
  // Anything that raises the stakes or the unknowns makes it standard or complex.
  assert.equal(workScale({ capabilities: code, depth: 'thorough' }), 'standard');
  assert.equal(workScale({ capabilities: code, attachments: 1 }), 'standard');
  assert.equal(workScale({ capabilities: code, investigation: true }), 'standard');
  assert.equal(workScale({ capabilities: code, clarification: true }), 'standard');
  assert.equal(workScale({ capabilities: code, highImpact: true }), 'standard');
  assert.equal(workScale({ capabilities: ['design'], physical: true }), 'standard');
  assert.equal(workScale({ capabilities: [...code, 'evidence-retrieval'] }), 'standard');
  assert.equal(workScale({ capabilities: [...code, 'evidence-retrieval', 'file-analysis'] }), 'complex');
  assert.equal(workScale({ capabilities: [...code, 'evidence-retrieval'], depth: 'thorough' }), 'complex');
  assert.equal(workScale({ capabilities: code, unknownSituation: true }), 'complex');
  assert.equal(workScale({ capabilities: ['quantum-lab-scheduler'] }), 'complex', 'an unfamiliar tool');
});

test('only task tools count: the system\'s own machinery is not a tool', () => {
  assert.deepEqual(taskTools([...BUILT_IN, 'code-generation', 'code-execution']), ['code-generation', 'code-execution']);
  const sent = compactResourcePlan({ selected: { capabilities: [...BUILT_IN, 'code-generation'] }, omitted: { capabilities: ['planning', 'file-analysis'] } });
  assert.deepEqual(sent.selected.capabilities, ['code-generation']);
  assert.deepEqual(sent.omitted.capabilities, ['file-analysis']);
});

test('understanding and planning are told the size of the work; other steps are not', () => {
  const run = { workflow: 'full', adaptation: { scale: 'small' } };
  assert.equal(adaptationFor(run, { type: 'understand' }).scale, 'small');
  assert.equal(adaptationFor(run, { type: 'plan' }).scale, 'small');
  assert.equal(adaptationFor(run, { type: 'respond' }).scale, undefined);
});

test('the plan says what it brings in, what it leaves out, and why', () => {
  const plan = planGoal('Build and run a Python script.');
  const brief = planBrief({ ...plan, workflow: 'full' });
  assert.equal(brief.scale, 'small');
  assert.equal(brief.headline, 'Small, familiar task');
  assert.deepEqual(brief.bring.map(item => item.label), ['Code writer', 'Sealed sandbox']);
  assert.ok(brief.bring.every(item => item.why));
  const left = Object.fromEntries(brief.leaveOut.map(item => [item.label, item.why]));
  assert.match(left['Web research'], /does not depend on outside facts/);
  assert.match(left['Tool discovery'], /built-in tools cover it/);
  assert.match(left['Extra review checkpoints'], /test run is the check/);

  const research = planBrief({ ...planGoal('Research the latest evidence on perovskite solar cell stability and write a report with sources.'), workflow: 'full' });
  assert.ok(research.bring.some(item => item.label === 'Web research'));
  assert.ok(!research.leaveOut.some(item => item.label === 'Web research'));

  assert.equal(planBrief({ workflow: 'direct', tasks: [] }), null, 'a direct answer has nothing to plan');
});

test('a small plan grows when understanding finds the situation needs more', () =>
  withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    const auth = { token, workspace };
    const { body: run } = await call('POST', '/api/runs', { ...auth, body: { goal: 'Build and run a Python script.' } });
    assert.equal(run.adaptation.scale, 'small');
    assert.ok(!run.tasks.some(task => task.id === 'discover-capabilities'));
    const understood = await call('POST', `/api/runs/${run.id}/advance`, {
      ...auth, body: { taskId: 'understand', evidence: { structured: { needsCapabilityDiscovery: true, successCriteria: ['runs'] } } }
    });
    assert.equal(understood.status, 200);
    const { body: grown } = await call('GET', `/api/runs/${run.id}`, auth);
    const ids = grown.tasks.map(task => task.id);
    assert.ok(ids.includes('discover-capabilities'), 'discovery is added back');
    assert.equal(grown.next, 'discover-capabilities');
    // The brief follows the plan: tool discovery is now brought in, not left out.
    assert.ok(grown.brief.bring.some(item => item.id === 'capability-discovery'));
    assert.ok(!grown.brief.leaveOut.some(item => item.label === 'Tool discovery'));
  }));
