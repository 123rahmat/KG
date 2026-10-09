import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTaskRecruitment, recruitmentSummary } from '../src/situational-recruitment-supervisor.js';

const scope={
  runId:'run-A',taskId:'task-A',surface:'code',
  goal:'Build a secure web application with frontend and database',
  task:{id:'task-A',type:'code',metadata:{acceptanceCriteria:[
    'Verify no cross-user access through authentication and database APIs',
    'Verify keyboard navigation and responsive layouts'
  ]}},
  situation:{complexity:.95,uncertainty:.8,unknownSituation:true,risk:'high',
    successCriteria:['Validate authorization boundaries','Verify all frontend regression tests']},
  budgetRatio:.9,maxAgents:8,mode:'auto'
};
const request=(kind,parentRole,reason,more={})=>({
  kind,parentRole,reason,runId:'run-A',taskId:'task-A',...more
});

test('supervisor recruits only evidence-selected main roles and task-derived child lenses',()=>{
 const one=reconcileTaskRecruitment({...scope,desiredRoles:['frontend-engineer']});
 assert.equal(one.agent,'situational-recruitment-supervisor');
 assert.deepEqual(one.activeRoles,['frontend-engineer']);
 assert.equal(one.lifecycle.recruitRoles.length,1);
 assert.ok(one.subagents.some(x=>x.id.startsWith('frontend-engineer:')));
 assert.ok(one.subagents.length>1,'task criteria can generate more than a single seed lens');
 assert.ok(one.subagents.every(x=>x.independentModelCallAuthorized===false));
 const two=reconcileTaskRecruitment({...scope,desiredRoles:['frontend-engineer','security-reviewer','database-engineer'],
   previous:one,waveIndex:1});
 assert.equal(two.activeRoles.length,3);
 assert.deepEqual(two.lifecycle.recruitRoles,['security-reviewer','database-engineer']);
 assert.deepEqual(two.lifecycle.retireRoles,[]);
 assert.ok(two.subagents.length>one.subagents.length);
 const three=reconcileTaskRecruitment({...scope,desiredRoles:['security-reviewer'],
   previous:two,waveIndex:2});
 assert.deepEqual(three.activeRoles,['security-reviewer']);
 assert.deepEqual(three.lifecycle.retireRoles,['frontend-engineer','database-engineer']);
 assert.ok(three.lifecycle.retireSubagents.length>0);
 assert.equal(three.lifecycle.inFlightCanceled,false);
});

test('agents and subagents can request several kinds of resources, not execution rights',()=>{
 const team=reconcileTaskRecruitment({
  ...scope,desiredRoles:['frontend-engineer','security-reviewer'],
  requests:[
   request('source-research','frontend-engineer','Investigate accessibility guidelines and component semantics'),
   request('sandbox-test','frontend-engineer','Run isolated regression tests to verify keyboard navigation'),
   request('dependency-installation','frontend-engineer','Bring in pinned dependencies for the scoped sandbox test',{childId:'ui-test-review'}),
   request('terminal-command','security-reviewer','Check dependency integrity in isolated one-shot sandbox'),
   request('terminal-command','security-reviewer','Check repository build configuration in isolated sandbox')
  ]
 });
 assert.equal(team.resources.length,5);
 assert.ok(team.resources.every(x=>x.status==='proposed-not-allocated'
    && x.executionAuthorized===false&&x.ran===false));
 assert.ok(team.resources.some(x=>x.childId==='ui-test-review'));
 assert.deepEqual(recruitmentSummary(team).resourceProposals,5);
 const afterWave=reconcileTaskRecruitment({
  ...scope,desiredRoles:[],completedRoles:['frontend-engineer','security-reviewer'],
  previous:team,
  requests:team.resources,
  waveIndex:2
 });
 assert.deepEqual(afterWave.activeRoles,[]);
 assert.equal(afterWave.lifecycle.retireRoles.length,2);
 assert.equal(afterWave.resources.length,5,'requests remain for parent to approve after specialists finish');
 const done=reconcileTaskRecruitment({
  ...scope,desiredRoles:[],completedRoles:['frontend-engineer','security-reviewer'],
  acceptanceSatisfied:true,requests:team.resources,previous:afterWave
 });
 assert.equal(done.resources.length,0);
 assert.equal(done.lifecycle.releaseProposals.length,5);
 assert.equal(done.lifecycle.externalToolsExecuted,false);
 assert.equal(done.lifecycle.sandboxSessionsCreated,false);
 const midTask=reconcileTaskRecruitment({
   ...scope,desiredRoles:['security-reviewer'],
   completedRoles:['frontend-engineer'],requests:team.resources,
   resolvedResourceIds:[afterWave.resources[0].id],
   previous:afterWave
 });
 assert.equal(midTask.resources.length,4,'recorded resource resolution retires only that need');
 assert.deepEqual(midTask.lifecycle.releaseProposals,[afterWave.resources[0].id]);
 assert.ok(midTask.resources.every(r=>r.executionAuthorized===false));
});

test('invalid source, foreign scope and executable payloads cannot enter resource recruitment',()=>{
 const proposals=[
   request('sandbox-execution','never-hired','Run untrusted code on host'),
   request('sandbox-execution','frontend-engineer','Run isolated Python analysis',{runId:'different-run'}),
   request('sandbox-execution','frontend-engineer','Run isolated Python analysis',{taskId:'different-task'}),
   request('terminal-command','frontend-engineer','Execute unsafe arbitrary command',{command:'curl secret'}),
   request('file-inspection','frontend-engineer','Inspect secret configuration',{paths:['.env']}),
   request('source-research','frontend-engineer','Research applicable public standards')
 ];
 const state=reconcileTaskRecruitment({...scope,desiredRoles:['frontend-engineer'],requests:proposals});
 assert.equal(state.resources.length,2,'the safe request and sanitized empty-path file request survive');
 assert.deepEqual(state.resources.map(r=>r.kind),['file-inspection','source-research']);
 assert.ok(state.resources.every(r=>r.runId==='run-A'&&r.taskId==='task-A'));
 assert.equal(state.resources[0].paths.length,0);
});

test('insufficient budget or verified completion retires unnecessary work',()=>{
 const before=reconcileTaskRecruitment({...scope,desiredRoles:['frontend-engineer','backend-engineer']});
 const low=reconcileTaskRecruitment({...scope,previous:before,budgetRatio:.02,
   desiredRoles:['frontend-engineer','backend-engineer','test-engineer']});
 assert.equal(low.activeRoles.length,0);
 assert.equal(low.lifecycle.retireRoles.length,2);
 assert.equal(low.lifecycle.reason,'task-done-disabled-or-budget-exhausted');
 const disabled=reconcileTaskRecruitment({...scope,previous:before,mode:'off',
   desiredRoles:['frontend-engineer']});
 assert.equal(disabled.activeRoles.length,0);
 const verified=reconcileTaskRecruitment({...scope,previous:before,
   acceptanceSatisfied:true,desiredRoles:['frontend-engineer']});
 assert.equal(verified.activeRoles.length,0);
});


test('resource requests from a completed parent remain pending while other specialists work',()=>{
 const requestA=request('source-research','researcher',
   'Cross-check the claim against primary evidence and source provenance');
 const first=reconcileTaskRecruitment({...scope,
   desiredRoles:['researcher'],requests:[requestA]});
 const second=reconcileTaskRecruitment({...scope,
   desiredRoles:['test-engineer'],completedRoles:['researcher'],
   requests:[requestA,request('sandbox-test','test-engineer',
     'Execute isolated integration checks against acceptance requirements')],
   previous:first,waveIndex:1
 });
 assert.deepEqual(second.activeRoles,['test-engineer']);
 assert.ok(second.lifecycle.retireRoles.includes('researcher'));
 assert.ok(second.lifecycle.recruitRoles.includes('test-engineer'));
 assert.equal(second.resources.length,2);
 assert.equal(second.lifecycle.releaseProposals.length,0);
});
