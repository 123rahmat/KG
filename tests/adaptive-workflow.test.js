import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAdaptiveWorkflow } from '../src/unified-adaptive-workflow.js';

const caps = (...ids) => ids.map(id => ({ id }));

test('the way of working follows the situation, strongest need first', () => {
  assert.equal(selectAdaptiveWorkflow({ goal: 'hi', capabilities: caps('reasoning') }).mode, 'answer');
  assert.equal(selectAdaptiveWorkflow({ goal: 'x', capabilities: caps('reasoning', 'evidence-retrieval') }).mode, 'evidence-first');
  assert.equal(selectAdaptiveWorkflow({ goal: 'x', capabilities: caps('code-generation', 'code-execution') }).mode, 'build-and-test');
  const compound = selectAdaptiveWorkflow({ goal: 'x', capabilities: caps('code-generation', 'file-analysis', 'evidence-retrieval') });
  assert.equal(compound.mode, 'build-and-test');
  assert.deepEqual(compound.secondary, ['evidence-first']);
  assert.equal(selectAdaptiveWorkflow({ goal: 'x', capabilities: caps('invention', 'design') }).mode, 'invent-and-test');
  assert.equal(selectAdaptiveWorkflow({ goal: 'x', situation: { unknownSituation: true } }).mode, 'adaptive-discovery');
  // A crisis leads whatever else applies.
  assert.equal(selectAdaptiveWorkflow({ goal: 'x', capabilities: caps('evidence-retrieval'), situation: { crisis: true } }).mode, 'crisis-response');
});

test('evidence is bounded by the budget, stopping is tied to the exact need, and the choice is stable', () => {
  const input = {
    goal: 'What is the current copper price?',
    need: { deliverable: 'the copper price per tonne today', form: 'number' },
    capabilities: caps('evidence-retrieval'),
    situation: { risk: 'high-impact' },
    resourcePlan: { contextPolicy: { maxItems: 16 }, executionPolicy: { maxToolCalls: 6 } }
  };
  const blueprint = selectAdaptiveWorkflow(input);
  assert.deepEqual(blueprint.evidence, { minimum: 2, maximum: 16 });
  assert.equal(blueprint.deliverable, 'the copper price per tonne today');
  assert.match(blueprint.stopConditions[0], /copper price per tonne today/);
  assert.ok(blueprint.expansionTriggers.some(item => /more than 6 tool calls/.test(item)));
  assert.deepEqual(selectAdaptiveWorkflow(input), blueprint, 'the same situation gets the same blueprint');
});


test('ordinary workflows continuously observe, reassess and replan before verification', () => {
  const workflow = selectAdaptiveWorkflow({
    goal: 'Build and test a small web app',
    capabilities: caps('reasoning', 'planning', 'verification', 'code-generation', 'code-execution'),
    need: { deliverable: 'a tested web app', form: 'code' },
    situation: { crisis: false },
    resourcePlan: { executionPolicy: { maxToolCalls: 16, maxExecutionStages: 8 } }
  });
  assert.equal(workflow.mode, 'build-and-test');
  assert.equal(workflow.closedLoop.enabled, true);
  assert.equal(workflow.closedLoop.checkpoint, 'after-each-material-step');
  assert.ok(workflow.phases.includes('observe'));
  assert.ok(workflow.phases.includes('reassess'));
  assert.ok(workflow.phases.includes('replan-if-needed'));
  assert.ok(workflow.phases.indexOf('reassess') < workflow.phases.indexOf('verify'));
  assert.ok(workflow.closedLoop.replanTriggers.length >= 4);
});

test('an attached file to change is composed in the chat with the closed loop', () => {
  const workflow = selectAdaptiveWorkflow({
    goal: 'Update the figures in the attached report',
    capabilities: caps('file-analysis', 'verification'),
    need: { deliverable: 'the updated report', form: 'document' },
    situation: { crisis: false }
  });
  assert.equal(workflow.mode, 'design-and-compose');
  assert.equal(workflow.closedLoop.enabled, true);
  assert.ok(workflow.phases.includes('observe'));
  assert.ok(workflow.phases.includes('reassess'));
  assert.ok(workflow.phases.includes('replan-if-needed'));
  assert.ok(workflow.phases.indexOf('replan-if-needed') < workflow.phases.indexOf('verify'));
});

test('unknown situations retain the closed loop', () => {
  const unknown = selectAdaptiveWorkflow({
    goal: 'Create a new mechanism that has never existed before',
    capabilities: caps('capability-discovery', 'invention', 'verification'),
    situation: { unknownSituation: true, crisis: false },
    resourcePlan: { executionPolicy: { maxExecutionStages: 8 } }
  });
  assert.equal(unknown.mode, 'adaptive-discovery');
  assert.equal(unknown.closedLoop.enabled, true);
  assert.ok(unknown.phases.includes('discover-capabilities'));
  assert.ok(unknown.phases.includes('reassess'));
});

test('crisis response remains immediate and does not enter an execution loop', () => {
  const workflow = selectAdaptiveWorkflow({
    goal: 'urgent help',
    capabilities: caps('reasoning', 'verification'),
    situation: { crisis: true },
    resourcePlan: { executionPolicy: { maxExecutionStages: 8 } }
  });
  assert.equal(workflow.mode, 'crisis-response');
  assert.equal(workflow.closedLoop.enabled, false);
  assert.equal(workflow.closedLoop.checkpoint, null);
  assert.ok(!workflow.phases.includes('replan-if-needed'));
});
