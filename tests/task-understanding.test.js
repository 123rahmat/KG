import test from 'node:test';
import assert from 'node:assert/strict';
import { understandTask } from '../src/task-understanding.js';
test('simple research paper summary does not insert a compulsory plan', () => {
  const assessment = understandTask({ request: 'Summarize this inspected academic paper' });
  assert.equal(assessment.domain, 'research');
  assert.equal(assessment.intent, 'answer');
  assert.equal(assessment.needsPlan, false);
  assert.equal(assessment.needsBrainstorming, false);
});
test('explicit planning and exploration are deliverables, not forced stages', () => {
  const plan = understandTask({ request: 'Plan the methodology for my research thesis' });
  assert.equal(plan.intent, 'plan');
  assert.equal(plan.needsPlan, true);
  const explore = understandTask({ request: 'Brainstorm alternative hypotheses for my study' });
  assert.equal(explore.intent, 'explore');
  assert.equal(explore.needsBrainstorming, true);
  const fix = understandTask({ request: 'Fix my Python script KeyError bug' });
  assert.equal(fix.intent, 'implement');
  assert.equal(fix.needsPlan, false);
});
test('large builds plan conditionally and retain project constraints', () => {
  const task = understandTask({
    request: 'Build the complete coding research platform',
    projectContext: { constraints: ['Vertex AI only', 'No Cloud SQL'] }
  });
  assert.equal(task.domain, 'coding');
  assert.equal(task.needsPlan, true);
  assert.deepEqual(task.constraints, ['Vertex AI only', 'No Cloud SQL']);
});
