/**
 * Deterministic, offline adversarial scenario matrix for the KG Code controls.
 * These are repeatable behavioral tests, not a claim to cover every possible
 * repository, provider, language, OS, sandbox, or malicious input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorkDomain } from '../src/work-domain.js';
import { buildControlWorkflowPolicy, controlQualityRequirements } from '../src/control-workflow-policy.js';
import {
  parallelWaves, tasksConflict, resourceScopesOverlap, workspaceLanesConflict
} from '../src/parallel-orchestrator.js';
import {
  appendOpenWorldWork, validateOpenWorldGraph, recordOpenWorldOutcome, openWorldFrontier
} from '../src/open-world-task-graph.js';
import { codingProgressSnapshot } from '../public/coding-progress-model.js';

const codeGoals=[
  'Build a web app to summarize research papers',
  'Implement a Node.js API with unit tests',
  'Fix the Python compiler error',
  'Debug the repository build on Linux',
  'Write a Python script for my thesis experiment',
  'Create a plugin for formatting journal manuscripts',
  'Refactor the parser for thesis files',
  'Build a React editor for academic authors',
  'Repair a PostgreSQL database migration',
  'Review our API access-control implementation'
];
const paperGoals=[
  'Write a full research paper with methodology and citations',
  'Prepare a thesis on algorithmic fairness',
  'Draft a journal manuscript about API reliability',
  'Design a qualitative thesis study of migration interviews',
  'Revise my dissertation literature review'
];
const unrelated=[
  'Book a restaurant tonight',
  'Plan my holiday itinerary',
  'Tell me the football match score',
  'Write birthday wishes for my brother',
  'Find the weather forecast'
];
test('scenario matrix: software deliverables are code; academic manuscripts are not',()=>{
  for (const goal of codeGoals){
    const view=assessWorkDomain({request:goal});
    assert.equal(view.status,'in-scope',goal);
    assert.equal(view.domain,'coding',goal);
    assert.equal(view.supportedRequest,goal,'original user text must survive classification');
  }
  for(const goal of paperGoals) assert.equal(assessWorkDomain({request:goal}).domain,'research',goal);
  for(const goal of unrelated) assert.equal(assessWorkDomain({request:goal}).status,'out-of-scope',goal);
});
test('agent control stays bounded as budget, risk, and uncertainty change',()=>{
  const budgets=[0,.01,.05,.15,.25,.5,.85,1];
  const complexities=[0,.2,.5,.85,1];
  const risks=['ordinary','high-impact'];
  for(const budget of budgets) for(const complexity of complexities) for(const risk of risks){
    const policy=buildControlWorkflowPolicy({
      surface:'code',goal:'Build a complete Node API service with automated tests',
      complexity,uncertainty:.8,observedIndependentWork:.8,
      remainingBudgetRatio:budget,risk
    });
    assert.equal(policy.safety.noSeparateRuntime,true);
    assert.equal(policy.safety.authorizesMutations,false);
    assert.ok(policy.compute.optionalAgentCeiling>=0);
    assert.ok(policy.compute.maxParallel>=1);
    if(budget<.06)assert.equal(policy.action,'budget-gate');
    if(budget<.25)assert.equal(policy.compute.optionalAgentCeiling,0);
  }
  for(const evidence of [
    {},
    {testsPassed:true},
    {testsPassed:true,receiptAuthenticated:true},
    {testsPassed:true,receiptAuthenticated:true,revisionMatched:true}
  ]){
    const result=controlQualityRequirements({
      surface:'code',taskKind:'implement',runtimeEvidence:evidence
    });
    assert.equal(result.proposedAcceptanceOnly,true);
    assert.equal(result.evidenceNotExecution,true);
    assert.ok(result.missingEvidence.length>0,'partial evidence must never self-accept');
  }
});
test('scheduler property: every wave is disjoint, bounded, and contains no overlapping concurrent work',()=>{
  const paths=['src/api.js','src/auth.js','src/routes/a.js','src/routes/b.js',
    'tests/api.test.js','docs/readme.md','src/routes','./src/auth.js','src/routes/../auth.js'];
  for(let seed=0;seed<48;seed++){
    const tasks=Array.from({length:12},(_,i)=>{
      const path=paths[(i*7+seed)%paths.length];
      const kind=(i+seed)%4;
      return {id:`task-${seed}-${i}`,metadata:kind===0?{}
        :kind===1?{readSet:[path]}
        :kind===2?{writeSet:[path]}
        :{writeSet:[path],readSet:['README.md']}};
    });
    const maxParallel=1+seed%6;
    const waves=parallelWaves(tasks,{maxParallel});
    assert.deepEqual(waves.flat().map(x=>x.id).sort(),
      tasks.map(x=>x.id).sort(),'all tasks scheduled once');
    for(const wave of waves){
      assert.ok(wave.length>0&&wave.length<=maxParallel);
      for(let i=0;i<wave.length;i++)for(let j=i+1;j<wave.length;j++){
        assert.equal(tasksConflict(wave[i],wave[j]),false,
          `unsafe concurrent tasks ${wave[i].id} / ${wave[j].id}`);
      }
    }
  }
});
test('resource canonicalization and unknown reader scopes prevent parallel mutation races',()=>{
  const aliases=[
    ['./src/main.js','src/main.js'],
    ['src/./main.js','src/main.js'],
    ['src/lib/../main.js','src/main.js'],
    ['src\\main.js','src/main.js'],
    ['src/routes','src/routes/index.js'],
    ['../escape','unrelated.js']
  ];
  for(const [a,b] of aliases){
    assert.equal(resourceScopesOverlap(a,b),true,a+'/'+b);
    assert.equal(resourceScopesOverlap(b,a),true,'symmetry '+a+'/'+b);
  }
  const anchored={projectId:'proj',revisionId:'commit-1'};
  assert.equal(workspaceLanesConflict(
    {...anchored,writeSet:['src/main.js']},{...anchored,readSet:[]}),true);
  assert.equal(workspaceLanesConflict(
    {...anchored,writeSet:['src/main.js']},
    {...anchored,revisionId:'commit-2',writeSet:['docs/readme.md']}),true);
  assert.equal(workspaceLanesConflict(
    {...anchored,writeSet:['src/main.js']},
    {...anchored,writeSet:['docs/readme.md']}),false);
});
test('task DAG invariants: identity, revisions, capability allow-lists and changed descendants',()=>{
  let graph=validateOpenWorldGraph();
  for(let i=0;i<20;i++){
    graph=appendOpenWorldWork(graph,{
      id:'n'+i,dependsOn:i?['n'+(i-1)]:[],
      metadata:{readSet:['docs/task'+i+'.md']}
    },{expectedRevision:i});
  }
  assert.equal(graph.revision,20);
  assert.deepEqual(openWorldFrontier(graph).ready,['n0']);
  assert.throws(()=>appendOpenWorldWork(graph,{id:'privileged',requires:['deploy-prod']},
    {authorizedCapabilities:[]}),/unauthorized/);
  assert.throws(()=>appendOpenWorldWork(graph,{id:'n0'}),/invalid-id/);
  assert.throws(()=>appendOpenWorldWork(graph,{id:'n20'},{expectedRevision:10}),/stale-revision/);
  for(let i=0;i<20;i++)graph=recordOpenWorldOutcome(graph,'n'+i,{
    status:'complete',expectedRevision:20+i
  });
  assert.equal(openWorldFrontier(graph).ready.length,0);
  graph=recordOpenWorldOutcome(graph,'n0',{status:'complete',changed:true,
    expectedRevision:40});
  assert.equal(graph.nodes[1].status,'stale');
  assert.equal(graph.nodes[19].status,'stale');
});
test('test receipts and repeated changes never authorize an inaccurate completed badge',()=>{
  const pass={id:'test-code',type:'test-code',status:'complete',
    evidence:{executionReceipt:{serverAuthenticated:true},
      result:{output:{testSummary:{total:2,passed:2,failed:0}}}}};
  const verify={id:'verify',type:'verify',status:'complete',
    evidence:{verdict:{verdict:'pass'}}};
  const build={id:'build-code',type:'build-code',status:'complete'};
  assert.equal(codingProgressSnapshot({state:'complete',tasks:[build,pass,verify]}).verified,true);
  const mutations=[
    {id:'build-later',type:'build-code',status:'complete'},
    {id:'test-later',type:'test-code',status:'pending'},
    {id:'test-later',type:'test-code',status:'failed'},
    {id:'test-later',type:'test-code',status:'stale'},
    {id:'test-later',type:'test-code',status:'running'}
  ];
  for(const mutation of mutations){
    assert.equal(codingProgressSnapshot({state:'complete',tasks:[
      build,pass,verify,mutation
    ]}).verified,false,mutation.status+'/'+mutation.type);
  }
  for(const state of ['running','queued','waiting','blocked','exhausted','iterate']){
    assert.equal(codingProgressSnapshot({state,tasks:[build,pass,verify]}).verified,false,state);
  }
});
