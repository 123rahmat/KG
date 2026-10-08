import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdaptiveTaskMatrix } from '../bin/adaptive-task-matrix.js';
import { appendOpenWorldWork, recordOpenWorldOutcome, openWorldFrontier, composeOpenWorldDecision } from '../src/open-world-task-graph.js';

test('representative unknown and known tasks use evidence-driven branches', () => {
  const report = runAdaptiveTaskMatrix();
  assert.equal(report.total, 17);
  assert.equal(report.passed, report.total, JSON.stringify(report.cases.filter(x => !x.matched)));
  assert.equal(report.legacyPhaseListRemoved, true);
  assert.equal(report.highRiskMaxParallel, 1);
  assert.deepEqual(report.staleNodeReady, ['modify']);
  assert.equal(report.modelResponsesGenerated, false);
});

test('a direct response beats an unnecessary tool candidate when quality is already sufficient', () => {
  const r = composeOpenWorldDecision({goal:'Hello', situation:{uncertainty:.02,complexity:.02},
    candidates:[{id:'slow-tool',requires:['tool']}],authorizedCapabilities:['tool'],availableCapabilities:['tool']});
  assert.equal(r.action,'direct');
});

test('changed evidence reopens stale work but never re-executes unrelated completed work', () => {
  let graph = appendOpenWorldWork({}, {id:'inspect',metadata:{writeSet:['input']}});
  graph = appendOpenWorldWork(graph,{id:'review',dependsOn:['inspect']});
  graph = appendOpenWorldWork(graph,{id:'unrelated'});
  graph = recordOpenWorldOutcome(graph,'inspect',{status:'complete'});
  graph = recordOpenWorldOutcome(graph,'review',{status:'complete'});
  graph = recordOpenWorldOutcome(graph,'unrelated',{status:'complete'});
  graph = recordOpenWorldOutcome(graph,'inspect',{status:'complete',changed:true});
  assert.deepEqual(openWorldFrontier(graph).ready,['review']);
  assert.equal(graph.nodes.find(x=>x.id==='unrelated').status,'complete');
});

test('no completed task graph is called verified solely because a model thinks it is', () => {
  const graph = appendOpenWorldWork({}, {id:'write'});
  const outcome = composeOpenWorldDecision({goal:'write',graph,acceptance:{satisfied:true}});
  assert.equal(outcome.action,'continue-work');
  const done = recordOpenWorldOutcome(graph,'write',{status:'complete'});
  const projected = composeOpenWorldDecision({goal:'write',graph:done,acceptance:{satisfied:true}});
  assert.equal(projected.action,'ready-to-deliver');
  assert.equal(projected.authority,'proposal-only');
});


test('additional language, planning, analysis and document tasks take the correct paths', () => {
  const results = Object.fromEntries(runAdaptiveTaskMatrix().cases.map(item => [item.name, item]));
  for (const [name, expected] of [
    ['translation', 'direct'],
    ['planning', 'reason'],
    ['data-analysis', 'investigate'],
    ['document-conversion-unavailable', 'capability-gap']
  ]) {
    assert.equal(results[name]?.actual, expected, name);
    assert.equal(results[name]?.matched, true, name);
  }
});
