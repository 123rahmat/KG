import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOpenWorldGraph, appendOpenWorldWork, recordOpenWorldOutcome,
  openWorldFrontier, composeOpenWorldDecision
} from '../src/open-world-task-graph.js';
import { buildUnifiedAdaptiveWorkflow, reassessUnifiedWorkflow } from '../src/unified-adaptive-workflow.js';
import { adaptiveDecisionAuthority } from '../src/adaptive-decision-authority.js';
import { defineEvalCase, runEvalSuite, summarizeEval, regressionGate } from '../src/evals.js';

test('simple task keeps the direct path and does not synthesize a permanent workflow', () => {
  const d = composeOpenWorldDecision({ goal: 'Say hello', situation: { uncertainty: .1, complexity: .05 } });
  assert.equal(d.action, 'direct');
  assert.equal(d.frontier.ready.length, 0);
  assert.equal(d.next, null);
});

test('unfamiliar goal proposes evidence gathering only when warranted', () => {
  const d = composeOpenWorldDecision({ goal: 'Study a new material', situation: {
    uncertainty: .9, evidenceGap: true, unresolvedQuestions: ['What measurements exist?']
  } });
  assert.equal(d.action, 'investigate');
  assert.deepEqual(d.unknowns, ['What measurements exist?']);
  assert.equal(d.authority, 'proposal-only');
});

test('candidate selection honors explicit discovery and authorization, not prompt pressure', () => {
  const args = { goal: 'Analyze this', situation: { evidenceGap: true },
    candidates: [
      { id: 'read-data', requires: ['data-reader'], value: .8, evidenceGain: 1 },
      { id: 'run-sensitive-tool', requires: ['admin'], value: 1, evidenceGain: 1 }
    ], availableCapabilities: ['data-reader', 'admin'], authorizedCapabilities: ['data-reader'] };
  assert.equal(composeOpenWorldDecision(args).next.id, 'read-data');
  assert.equal(composeOpenWorldDecision({ ...args, authorizedCapabilities: [] }).action, 'capability-gap');
  assert.equal(composeOpenWorldDecision({ ...args, situation: { authorizationRequired: true, authorizationSatisfied: false } }).action, 'approval-required');
  assert.equal(composeOpenWorldDecision({ ...args, remainingBudgetRatio: .04 }).action, 'budget-gate');
  assert.equal(composeOpenWorldDecision({ ...args, remainingBudgetRatio: .04, situation: { authorizationRequired: true, authorizationSatisfied: false } }).action, 'approval-required');
});

test('graph prevents cycles, unknown dependencies and unauthorized capability escalation', () => {
  const empty = validateOpenWorldGraph();
  assert.throws(() => appendOpenWorldWork(empty, { id: 'web-read', requires: ['internet'] }), /unauthorized/);
  const next = appendOpenWorldWork(empty, { id: 'inspect' }, { expectedRevision: 0 });
  assert.equal(next.revision, 1);
  assert.throws(() => appendOpenWorldWork(next, { id: 'inspect' }), /invalid-id/);
  assert.throws(() => appendOpenWorldWork(next, { id: 'analyze', dependsOn: ['missing'] }), /missing-dependency/);
  assert.throws(() => appendOpenWorldWork(next, { id: 'analyze' }, { expectedRevision: 0 }), /stale-revision/);
  assert.throws(() => validateOpenWorldGraph({ nodes: [
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }
  ] }), /cycle/);
});

test('frontier schedules independent tasks together and blocks downstream until ready', () => {
  let graph = validateOpenWorldGraph();
  graph = appendOpenWorldWork(graph, { id: 'sources', metadata: { writeSet: ['sources'] } });
  graph = appendOpenWorldWork(graph, { id: 'images', metadata: { writeSet: ['images'] } });
  graph = appendOpenWorldWork(graph, { id: 'analysis', dependsOn: ['sources', 'images'] });
  assert.deepEqual(openWorldFrontier(graph, { maxParallel: 3 }).waves, [['sources', 'images']]);
  assert.deepEqual(openWorldFrontier(graph, { maxParallel: 3, risk: 'critical' }).waves, [['sources'], ['images']]);
  graph = recordOpenWorldOutcome(graph, 'sources', { status: 'complete' });
  assert.deepEqual(openWorldFrontier(graph).ready, ['images']);
  graph = recordOpenWorldOutcome(graph, 'images', { status: 'complete' });
  assert.deepEqual(openWorldFrontier(graph).ready, ['analysis']);
  graph = recordOpenWorldOutcome(graph, 'analysis', { status: 'complete' });
  graph = recordOpenWorldOutcome(graph, 'sources', { status: 'complete', changed: true });
  assert.equal(graph.nodes.find(item => item.id === 'images').status, 'complete');
  assert.equal(graph.nodes.find(item => item.id === 'analysis').status, 'stale');
});

test('material reassessment preserves existing graph revision instead of restarting work', () => {
  const graph = appendOpenWorldWork({}, { id: 'inspect' });
  const first = buildUnifiedAdaptiveWorkflow({
    goal: 'Explore unfamiliar sensor readings',
    taskGraph: graph, situation: { uncertainty: .8, unresolvedQuestions: ['What sensor?'] },
    acceptance: { criteria: ['Explain the signal'] }
  });
  assert.equal(first.openWorld.action, 'investigate');
  assert.equal(first.taskGraph.revision, 1);
  const second = reassessUnifiedWorkflow(first, { event: { type: 'new-evidence' },
    situation: { uncertainty: .2, unresolvedQuestions: [], evidenceGap: false } });
  assert.equal(second.openWorld.action, 'direct');
  assert.equal(second.taskGraph.revision, 1);
  assert.equal(second.reassessment.openWorldActionChanged, true);
  assert.equal(second.reassessment.graphRevisionChanged, false);
});

test('decision authority cannot choose excluded capabilities as a fallback', () => {
  const out = adaptiveDecisionAuthority({
    candidates: ['unsafe-write'], authorizedCapabilities: ['read-only'],
    acceptance: { satisfied: true, authorizationSatisfied: true }
  });
  assert.equal(out.candidate, null);
  assert.notEqual(out.action, 'execute');
});

test('evaluation tracks observed cost per accepted result and gates regressions', async () => {
  const report = await runEvalSuite([
    defineEvalCase({ id: 'a', goal: 'Test', expected: { success: true }, run: async () => ({ success: true, costUsd: .15, tokensUsed: 140 }) }),
    defineEvalCase({ id: 'b', goal: 'Test', expected: { success: true }, run: async () => ({ success: false, costUsd: .1, tokensUsed: 120 }) })
  ]);
  const summary = summarizeEval(report);
  assert.equal(summary.totalCostUsd, .25);
  assert.equal(summary.costPerAcceptedUsd, .25);
  assert.equal(summary.averageTokens, 130);
  const gate = regressionGate({ ...report, baselineCostPerAcceptedUsd: .10 }, {
    minPassRate: .5, maxFailed: 1, maxCostPerAcceptedIncreaseUsd: .05
  });
  assert.equal(gate.pass, false);
  assert.ok(gate.costIncrease > .05);
});
