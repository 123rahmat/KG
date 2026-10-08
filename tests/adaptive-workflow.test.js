import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAdaptiveWorkflow } from '../src/unified-adaptive-workflow.js';

const caps = (...ids) => ids.map(id => ({ id }));

test('selection uses one adaptive contract rather than hard-coded workflows for each domain', () => {
  const cases = [
    { goal: 'hi', capabilities: caps('reasoning') },
    { goal: 'research a finding', capabilities: caps('evidence-retrieval') },
    { goal: 'fix code', capabilities: caps('code-generation','code-execution') },
    { goal: 'draw a picture', capabilities: caps('image-generation') },
    { goal: 'invent a mechanism', capabilities: caps('invention') },
    { goal: 'analyze unknown dataset', situation: { unknownSituation: true } }
  ].map(input => selectAdaptiveWorkflow(input));
  for (const item of cases) {
    assert.equal(item.strategy, 'incremental-open-world');
    assert.deepEqual(item.phases, []);
    assert.ok(['direct', 'adaptive'].includes(item.mode));
    assert.ok(item.stopConditions.some(s => s.includes('acceptance')));
  }
  assert.equal(cases[0].mode, 'direct');
  assert.equal(cases[1].nextAction, 'investigate');
  assert.equal(cases[2].mode, 'adaptive');
  assert.equal(cases[5].nextAction, 'investigate');
});

test('budget-bound evidence and acceptance remain deterministic', () => {
  const input = {
    goal: 'What is the current copper price?',
    need: { deliverable: 'the copper price per tonne today', form: 'number' },
    capabilities: caps('evidence-retrieval'),
    situation: { risk: 'high-impact' },
    resourcePlan: { contextPolicy: { maxItems: 16 }, executionPolicy: { maxToolCalls: 6 } }
  };
  const a = selectAdaptiveWorkflow(input);
  assert.deepEqual(a.evidence, { minimum: 0, maximum: 16 });
  assert.equal(a.deliverable, 'the copper price per tonne today');
  assert.equal(a.maxToolCalls, 6);
  assert.deepEqual(selectAdaptiveWorkflow(input), a);
});

test('adaptive loop preserves event triggers without materializing speculative steps', () => {
  const flow = selectAdaptiveWorkflow({
    goal: 'Build an application', capabilities: caps('code-generation', 'code-execution'),
    resourcePlan: { executionPolicy: { maxExecutionStages: 8 } }
  });
  assert.equal(flow.closedLoop.enabled, true);
  assert.equal(flow.closedLoop.checkpoint, 'after-each-material-step');
  assert.ok(flow.closedLoop.replanTriggers.length >= 4);
  assert.equal(flow.closedLoop.maxReplans, 8);
  assert.deepEqual(flow.phases, []);
});

test('unknown workflows investigate rather than falsely pretending the workflow exists', () => {
  const flow = selectAdaptiveWorkflow({goal: 'Study a brand new instrument',
    situation: { unknownSituation: true }});
  assert.equal(flow.mode, 'adaptive');
  assert.equal(flow.nextAction, 'investigate');
});

test('crisis requests remain immediate without complex orchestration', () => {
  const flow = selectAdaptiveWorkflow({goal: 'urgent help', situation: {crisis: true}});
  assert.equal(flow.mode, 'direct');
  assert.equal(flow.nextAction, 'direct');
  assert.equal(flow.closedLoop.enabled, false);
  assert.equal(flow.closedLoop.checkpoint, null);
});
