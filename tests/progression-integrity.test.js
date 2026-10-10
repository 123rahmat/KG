import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceRequiredProgression } from '../src/progression-integrity.js';
const run=(surface='code',required=['code-generation'],extra={})=>({
  surface,adaptation:{workflow:'full'},capabilities:{required,granted:required},
  ...extra
});
const t=(id,type,status='complete',metadata={})=>({id,type,status,metadata});
const next=(r,tasks,candidate,target=t('understand','understand'))=>
  enforceRequiredProgression({run:r,tasks,target,candidate,planRequired:true});

test('explicit Research evidence requirement runs before answer, verification or delivery',()=>{
  const research=run('research',['evidence-retrieval','verification']);
  for(const type of ['respond','verify','deliver']){
    const got=next(research,[t('understand','understand')],{type,title:'Skip to '+type});
    assert.equal(got.candidate.type,'investigate');
    assert.equal(got.reason,'planned-evidence-gathering-before-conclusion');
  }
  const after=next(research,[t('understand','understand'),
    t('investigate','investigate')],{type:'respond'});
  assert.equal(after.changed,false);
  const unplanned=next(run('research',['reasoning']),[t('understand','understand')],
    {type:'respond'});
  assert.equal(unplanned.changed,false,'optional web research is never forced');
});

test('model enough/early code cannot bypass a scoped Code plan and human agreement',()=>{
  const code=run();
  const understand=t('understand','understand');
  const attempted={type:'verify',title:'The model says it is done'};
  const first=next(code,[understand],attempted);
  assert.equal(first.candidate.type,'plan');
  assert.equal(first.candidate.buildPlan,true);
  const plan=t('plan','plan','complete',{buildPlan:true});
  const second=next(code,[understand,plan],{type:'code'},plan);
  assert.equal(second.candidate.type,'approval');
  assert.equal(second.candidate.planAgreement,true);
  const approval=t('approval','approval','complete',{planAgreement:true});
  const third=next(code,[understand,plan,approval],{type:'verify'},approval);
  assert.equal(third.candidate.type,'code');
  assert.equal(third.reason,'implementation-required-before-final-checks');
  const built=t('build-code','code','complete',{execution:false});
  const fourth=next(code,[understand,plan,approval,built],{type:'verify'},built);
  assert.equal(fourth.candidate.type,'code');
  assert.equal(fourth.candidate.title,'Test the generated code');
  const tested=t('test-code','code','complete',{execution:true});
  const fifth=next(code,[understand,plan,approval,built,tested],{type:'verify'},tested);
  assert.equal(fifth.changed,false);
});

test('skip optional planning still requires genuine code and tests before delivery',()=>{
  const code=run();
  const a=enforceRequiredProgression({run:code,tasks:[t('understand','understand')],
    target:t('understand','understand'),candidate:{type:'deliver'},planRequired:false});
  assert.equal(a.candidate.type,'code');
  assert.equal(a.candidate.title,'Write the approved code');
  const b=enforceRequiredProgression({run:{...code,adaptation:{workflow:'full',codeNotRun:true}},
    tasks:[t('understand','understand'),t('build-code','code','complete',{execution:false})],
    candidate:{type:'verify'},planRequired:false});
  assert.equal(b.changed,false,'unavailable runner is handled as unrun evidence, not fake execution');
});

test('planned discovery and evidence gathering precede even a premature Code plan',()=>{
  const r=run('code',['capability-discovery','evidence-retrieval','code-generation']);
  const understanding=t('understand','understand');
  const first=next(r,[understanding],{type:'plan'});
  assert.equal(first.candidate.type,'discover-capabilities');
  const discover=t('discover-capabilities','discover-capabilities');
  const second=next(r,[understanding,discover],{type:'code'});
  assert.equal(second.candidate.type,'investigate');
  const research=t('investigate','investigate');
  const third=next(r,[understanding,discover,research],{type:'code'});
  assert.equal(third.candidate.type,'plan');
});

test('human governance and optional next actions remain outside mandatory control',()=>{
  const r=run();
  for(const type of ['clarify','approval','reassess','investigate','step']){
    const c={type,title:'Preserve optional human and evidentiary stage'};
    const out=next(r,[t('understand','understand')],c);
    assert.equal(out.candidate,c);
    assert.equal(out.changed,false);
  }
  assert.equal(next(run('normal-chat',['code-generation']),[t('understand','understand')],
    {type:'verify'}).changed,false);
  const plan=t('plan','plan','pending',{buildPlan:true});
  const blocked=next(r,[t('understand','understand'),plan],{type:'code'});
  assert.equal(blocked.candidate,null);
  assert.equal(blocked.reason,'await-persisted-plan-or-approval');
});

test('pending test and optional-but-started build plan cannot be bypassed',()=>{
  const r=run();
  const plan=t('plan','plan','complete',{buildPlan:true});
  const noOption=enforceRequiredProgression({run:r,tasks:[
    t('understand','understand'),plan],
    candidate:{type:'code'},planRequired:false});
  assert.equal(noOption.candidate.type,'approval');
  const built=t('build-code','code','complete',{execution:false});
  const testTask=t('test-code','code','pending',{execution:true});
  const queued=next(r,[t('understand','understand'),plan,
    t('approval','approval','complete',{planAgreement:true}),built,testTask],
    {type:'deliver'},built);
  assert.equal(queued.candidate,null);
  assert.equal(queued.reason,'await-persisted-test-checkpoint');
});
