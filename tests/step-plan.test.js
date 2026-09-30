import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNextStep, readStepAnswer, workPlan } from '../src/step-plan.js';

const task = (id, type, dependsOn = [], status = 'pending', extra = {}) => ({ id, type, dependsOn, status, ...extra });

test('the model can propose exactly one adaptive next step with its execution metadata', () => {
  assert.deepEqual(
    normalizeNextStep({
      next: {
        type: 'tool',
        title: 'Read the sensor log',
        purpose: 'Read the attached sensor log with the discovered parser.',
        capability: 'adaptive-execution',
        requirementIds: ['req-log', 'req-log'],
        requires: ['adaptive-execution'],
        approvalRequired: true
      }
    }),
    {
      title: 'Read the sensor log',
      purpose: 'Read the attached sensor log with the discovered parser.',
      type: 'tool',
      requirementIds: ['req-log'],
      
      capability: 'adaptive-execution',
      requires: ['adaptive-execution'],
      approvalRequired: true
    }
  );
  assert.equal(normalizeNextStep({ next: { title: 'No purpose' } }), null);
});

test('a step answer can finish the need or propose one next action', () => {
  assert.deepEqual(readStepAnswer('The load is 3.2 kW.'), {
    text: 'The load is 3.2 kW.', enough: false, revise: null, judged: false
  });
  const done = readStepAnswer('{"result":"Done.","enough":true}');
  assert.equal(done.enough, true);

  const next = readStepAnswer('{"result":"The cable is aluminium.","next":{"type":"step","title":"Derate","purpose":"Derate for aluminium."}}');
  assert.equal(next.next.type, 'step');
  assert.equal(next.next.title, 'Derate');
});

test('the UI work-plan view reports only the steps that actually exist', () => {
  const tasks = [
    task('step', 'step', [], 'complete', { summary: 'Loads listed.', metadata: { title: 'List loads' }, purpose: 'List the loads.' }),
    task('step-1', 'step', ['step'], 'pending', { metadata: { title: 'Size cable' }, purpose: 'Size the cable.' })
  ];
  const plan = workPlan(tasks, 'step-1');
  assert.equal(plan.current, 'step-1');
  assert.deepEqual(
    plan.steps.map(item => [item.title, item.status, item.result ?? null]),
    [['List loads', 'complete', 'Loads listed.'], ['Size cable', 'pending', null]]
  );
});
