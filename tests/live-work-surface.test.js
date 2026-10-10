import test from 'node:test';
import assert from 'node:assert/strict';
import { liveWorkSnapshot } from '../public/live-work-model.js';

const run = (tasks,other={})=>({
  id:'run-one',surface:'code',state:'running',next:'test-code',tasks,...other
});
test('main output shows only real server-recorded execution stdout, stderr and test counts',()=>{
  const output=liveWorkSnapshot(run([
    {id:'build-code',type:'code',status:'complete',evidence:{}},
    {id:'test-code',type:'code',status:'running',metadata:{title:'Execute checks'},
      evidence:{result:{output:{
        status:'failed',program:{stdout:'3 suites passed\n',stderr:'timeout in payment check\n'},
        testSummary:{passed:3,failed:1,total:4}
      }},executionReceipt:{serverAuthenticated:true}}}
  ]));
  assert.equal(output.domain,'code');
  assert.equal(output.currentStep,'Execute checks');
  assert.equal(output.completedSteps,1);
  assert.deepEqual(output.steps.map(item=>item.status),['complete','running']);
  const execution=output.entries.find(item=>item.type==='execution');
  assert.ok(execution);
  assert.equal(execution.receiptVerified,true);
  assert.equal(execution.stdout,'3 suites passed\n');
  assert.equal(execution.stderr,'timeout in payment check\n');
  assert.deepEqual(execution.tests,{total:4,passed:3,failed:1});
  assert.equal(output.terminal,false);
});
test('queued or merely proposed execution never produces an invented live terminal',()=>{
  const output=liveWorkSnapshot(run([
    {id:'test-code',type:'code',status:'pending',purpose:'Run the tests',
      evidence:{result:{stdout:'not yet executed'}}}
  ]));
  assert.deepEqual(output.entries,[]);
  assert.match(output.emptyMessage,/after the server records it/);
  assert.equal(output.steps[0].status,'pending');
  assert.equal(output.currentStep,'Run the tests');
});
test('read-only tables are shown as bounded samples, not charts with invented data',()=>{
  const rows=Array.from({length:35},(_,n)=>({method:'Sample '+n,score:n}));
  const output=liveWorkSnapshot(run([
    {id:'analyze',type:'investigate',status:'complete',
      evidence:{structured:{tables:[{name:'Evaluation',sample:rows}]}}}
  ],{state:'complete',next:null}));
  const table=output.entries.find(item=>item.type==='table');
  assert.ok(table);
  assert.deepEqual(table.table.header,['method','score']);
  assert.equal(table.table.rows.length,10);
  assert.equal(table.table.truncatedRows,true);
  assert.equal(output.currentStep,'');
});
test('research shows tracked sources, evidence table and unresolved gaps only',()=>{
  const output=liveWorkSnapshot({
    surface:'research',state:'complete',tasks:[
      {id:'investigate',type:'investigate',status:'complete',evidence:{}}
    ],adaptation:{researchWorkspace:{
      sourceSet:[
        {title:'Primary study',url:'https://example.org/source'},
        {title:'Unsafe link',url:'javascript:alert(1)'}
      ],
      evidenceLedger:[
        {summary:'First supported observation',sourceKeys:['first']},
        {summary:'Second supported observation',sourceKeys:['second']}
      ],
      unresolvedQuestions:['The sample size is not independently confirmed']
    }}
  });
  assert.ok(output.entries.some(x=>x.type==='table'&&x.table.rows.length===2));
  const source=output.entries.find(x=>x.type==='sources');
  assert.equal(source.sources[0].url,'https://example.org/source');
  assert.equal(source.sources[1].url,null);
  assert.ok(output.entries.some(x=>x.type==='gaps'));
});
test('only authorized saved artifacts with object IDs reach the visual preview',()=>{
  const output=liveWorkSnapshot(run([
    {id:'capture',type:'tool',status:'complete',evidence:{
      artifacts:[
        {id:'obj-one',contentType:'image/png',name:'Desktop screenshot'},
        {contentType:'image/png',name:'Unstored reference'},
        {id:'obj-two',contentType:'application/pdf',name:'Findings'}
      ]
    }}
  ],{state:'complete',next:null}));
  const artifacts=output.entries.filter(item=>item.type==='artifact');
  assert.deepEqual(artifacts.map(item=>item.artifact.name),['Desktop screenshot','Findings']);
});
test('chat and non-evidence tasks never create a synthetic work-output surface',()=>{
  assert.equal(liveWorkSnapshot({surface:'normal-chat',state:'running',tasks:[
    {id:'respond',status:'running',evidence:{text:'hello'}}]}),null);
  assert.equal(liveWorkSnapshot({surface:'code',state:'running',tasks:[]}),null);
  const output=liveWorkSnapshot(run([
    {id:'respond',type:'respond',status:'complete',evidence:{text:'Final answer'}}
  ]));
  assert.deepEqual(output.entries,[]);
});

test('only server-recorded applied changes appear in the main Coding output',()=>{
  const tasks=[{id:'build-code',type:'code',status:'complete',
    evidence:{structured:{files:[{path:'src/proposed-only.js'}]}}}];
  const without=liveWorkSnapshot(run(tasks,{state:'complete'}));
  assert.equal(without.entries.some(x=>x.type==='changes'),false);
  const applied=liveWorkSnapshot(run(tasks,{
    state:'complete',adaptation:{unifiedWorkContext:{
      lastChange:{files:['src/updated.js',{path:'src/created.js'}],
        deleted:['src/obsolete.js']}
    }}
  }));
  const change=applied.entries.find(x=>x.type==='changes');
  assert.deepEqual(change.paths,['src/updated.js','src/created.js','src/obsolete.js']);
  assert.equal(change.paths.includes('src/proposed-only.js'),false);
});
test('verification renders only real completed criterion verdicts',()=>{
  const tasks=[{id:'verify',type:'verify',status:'complete',evidence:{
    verdict:{verdict:'fail',criteria:[
      {criterion:'Correct authentication response',met:true},
      {criterion:'No cross-tenant access',met:false}
    ]}
  }}];
  const output=liveWorkSnapshot(run(tasks,{state:'complete'}));
  const table=output.entries.find(x=>x.type==='table');
  assert.equal(table.title,'Recorded verification criteria');
  assert.deepEqual(table.table.rows[1],['No cross-tenant access','Not met']);
  assert.equal(liveWorkSnapshot(run([{...tasks[0],status:'pending'}]))
    .entries.some(x=>x.title==='Recorded verification criteria'),false);
});
