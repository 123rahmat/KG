import test from 'node:test';
import assert from 'node:assert/strict';
import { codingMilestoneSuggestion } from '../public/coding-milestone-suggestions.js';

const run=(next,tasks=[],extra={})=>({id:'project-1',surface:'code',state:'running',
  next,tasks,...extra});

test('only meaningful Code project checkpoints can trigger one optional suggestion',()=>{
  const idea=run('explore',[{id:'explore',type:'step',status:'running',
    metadata:{ventureDiscovery:true,title:'Explore and test the idea'}}]);
  const hint=codingMilestoneSuggestion(idea);
  assert.equal(hint.kind,'ideation');
  assert.match(hint.why,/exploring product directions/);
  assert.match(hint.request,/Compare the candidate ideas/);
  assert.match(hint.provenance,/Nothing runs until you submit/);
  assert.equal(codingMilestoneSuggestion({...idea,surface:'research'}),null);
  assert.equal(codingMilestoneSuggestion({...idea,surface:'normal-chat'}),null);
  assert.equal(codingMilestoneSuggestion(run('understand',[
    {id:'understand',type:'understand',status:'running'}])),null);
});

test('a completed venture exploration triggers focused MVP planning, then user approval guidance',()=>{
  const explore={id:'step',type:'step',status:'complete',
    metadata:{ventureDiscovery:true,title:'Explore and test the idea'}};
  const plan={id:'plan',type:'plan',status:'running',metadata:{buildPlan:true}};
  const planned=codingMilestoneSuggestion(run('plan',[explore,plan]));
  assert.equal(planned.kind,'mvp-plan');
  assert.match(planned.why,/Idea exploration was recorded/);
  assert.match(planned.request,/MVP/);
  const approval={id:'approval',type:'approval',status:'pending',
    metadata:{planAgreement:true,title:'Agree the plan'}};
  const review=codingMilestoneSuggestion(run('approval',[
    explore,{...plan,status:'complete'},approval
  ]));
  assert.equal(review.kind,'scope-review');
  assert.match(review.why,/waiting for approval/);
  assert.match(review.request,/before approving/);
  assert.notEqual(planned.id,review.id);
});

test('recorded failed tests take priority and report a grounded failure count',()=>{
  const failed={id:'test-code',type:'code',status:'failed',
    evidence:{result:{output:{status:'failed',
      testSummary:{total:5,passed:3,failed:2}}}}};
  const current={id:'repair',type:'code',status:'pending'};
  const hint=codingMilestoneSuggestion(run('repair',[failed,current]));
  assert.equal(hint.kind,'repair');
  assert.match(hint.why,/2 failing tests recorded/);
  assert.match(hint.request,/root-cause fix/);
  assert.ok(!hint.request.includes('tests passed'));
});
test('after building, the next test stage suggests checking real code behavior',()=>{
  const built={id:'build-code',type:'code',status:'complete',
    evidence:{structured:{files:[{path:'src/a.js'}]}}};
  const testing={id:'test-code',type:'code',status:'pending'};
  const hint=codingMilestoneSuggestion(run('test-code',[built,testing]));
  assert.equal(hint.kind,'test-focus');
  assert.match(hint.request,/Report real test output/);
});

test('release suggestion requires server-recorded passing verification',()=>{
  const tasks=[{id:'verify',type:'verify',status:'complete',
    evidence:{verdict:{verdict:'pass'}}}];
  const hint=codingMilestoneSuggestion(run(null,tasks,{state:'complete'}));
  assert.equal(hint.kind,'release-readiness');
  assert.match(hint.request,/Do not claim a deployment/);
  assert.equal(codingMilestoneSuggestion(run(null,[
    {id:'verify',type:'verify',status:'complete',evidence:{verdict:{verdict:'fail'}}}
  ],{state:'complete'})),null);
});

test('same saved checkpoint has a stable identity and no model-driven content',()=>{
  const tasks=[{id:'approval',type:'approval',status:'pending',metadata:{planAgreement:true}}];
  const a=codingMilestoneSuggestion(run('approval',tasks));
  const b=codingMilestoneSuggestion(run('approval',tasks));
  assert.deepEqual(a,b);
  assert.ok(a.request.length<250);
  assert.ok(a.title.length<75);
  assert.ok(a.why.length<150);
});
