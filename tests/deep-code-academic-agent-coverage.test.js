import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_MAIN_AGENTS, familyMainAgentMatch, familyMainAgentStats } from '../src/family-main-agents.js';
import { specialistFamilyMatches, specialistFocusFor } from '../src/adaptive-specialist-focus.js';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';
import { rolesFor, runAdaptiveAgentPanel } from '../src/multi-agent.js';
import { reconcileTaskRecruitment } from '../src/situational-recruitment-supervisor.js';

const cases=[
  ['code','design-system-components','Build Storybook component library with design tokens'],
  ['code','forms-validation-engineering','Implement accessible complex form validation using a form schema'],
  ['code','billing-payments-engineering','Build a Stripe billing checkout payment integration'],
  ['code','multi-tenant-isolation-engineering','Implement per-tenant encryption and tenant isolation'],
  ['code','database-migrations-engineering','Plan a zero downtime migration with database rollback'],
  ['code','rag-knowledge-systems','Improve retrieval augmented generation with evaluation'],
  ['code','file-storage-lifecycle','Build a secure S3 upload pipeline'],
  ['code','agent-runtime-engineering','Build an agent runtime with agent harness and tool approval'],
  ['research','thesis-proposal-design','Write a doctoral dissertation proposal with research methods'],
  ['research','dissertation-architecture','Create a dissertation structure and thesis chapter plan'],
  ['research','research-gap-novelty','Find original contribution to knowledge in prior literature'],
  ['research','academic-manuscript-planning','Create a scientific manuscript structure using IMRAD'],
  ['research','research-methodology-writing','Draft a methodology chapter using documented sampling'],
  ['research','research-discussion-synthesis','Synthesize the thesis discussion against previous studies'],
  ['research','research-integrity-auditing','Check research integrity and fabricated citations'],
  ['research','academic-peer-review-response','Prepare a point by point response to reviewers'],
  ['research','journal-submission-preparation','Prepare journal submission files and cover letter to editor'],
  ['research','dissertation-defense-preparation','Prepare viva voce presentation and difficult questions']
];

test('specific Coding and thesis/paper main agents are registered, matched, and isolated by workspace',()=>{
 const counts=familyMainAgentStats();
 assert.deepEqual(counts['normal-chat'],{mainAgents:30,subagents:240});
 assert.deepEqual(counts.code,{mainAgents:63,subagents:504});
 assert.deepEqual(counts.research,{mainAgents:57,subagents:456});
 for(const [surface,family,goal] of cases){
   const role=surface+'-'+family+'-lead';
   assert.equal(FAMILY_MAIN_AGENTS[role]?.surface,surface,role);
   assert.equal(FAMILY_MAIN_AGENTS[role]?.subagents?.length,8,role);
   assert.ok(familyMainAgentMatch(role,{surface,goal,task:{type:'plan'}})>=.89,role);
   assert.equal(familyMainAgentMatch(role,{surface:surface==='code'?'research':'code',goal}),0,role);
   assert.equal(specialistFocusFor({surface,goal,role}).family,family,role);
   assert.ok(specialistFamilyMatches({surface,goal}).some(x=>x.family===family),role);
 }
});

test('specialty-specific subagents stay scoped to their main role and expand only if justified',()=>{
 for(const [surface,family,goal] of cases){
   const role=surface+'-'+family+'-lead';
   const selected=selectFamilySubagents({surface,goal,role,
     task:{id:'plan',type:'plan'},situation:{
       complexity:.9,uncertainty:.85,risk:'medium',
       successCriteria:['Verify the relevant evidence, negative cases and accuracy']
     },remainingBudgetRatio:.8});
   assert.equal(selected.family,family,role);
   assert.equal(selected.available>=8,true,role);
   assert.ok(selected.active.length>=1,role);
   assert.ok(selected.active.every(c=>!c.mayInvokeTools&&!c.maySpawnAgents),role);
   const depleted=selectFamilySubagents({surface,goal,role,
     situation:{complexity:.9},remainingBudgetRatio:.1});
   assert.equal(depleted.active.length,1,role);
   assert.equal(depleted.executionPolicy.extraModelChildLimit,0,role);
 }
});

test('Coding and Research roster is hired and retired by the same task supervisor',()=>{
 const code=rolesFor({
   surface:'code',goal:'Build a payment integration and subscription billing checkout',
   situation:{risk:'medium',complexity:.9,uncertainty:.85},
   adaptation:{scale:'complex'},attempt:1
 },{id:'plan',type:'plan'},{mode:'always',maxAgents:8});
 const research=rolesFor({
   surface:'research',goal:'Write dissertation proposal and thesis chapter plan using documented sources',
   situation:{risk:'medium',complexity:.9,uncertainty:.85},
   adaptation:{scale:'complex'},attempt:1
 },{id:'plan',type:'plan'},{mode:'always',maxAgents:8});
 for(const [surface,allocation] of [['code',code],['research',research]]){
   assert.ok(allocation.agentCount>=1,surface);
   assert.ok(allocation.agentCount<=8,surface);
   assert.ok(allocation.roles.some(role=>role.endsWith('-lead')),allocation.roles.join(','));
   const args={runId:'run-one',taskId:'task-one',surface,goal:surface==='code'
     ?'Implement a subscription billing checkout':'Write a dissertation proposal and thesis structure',
     task:{id:'plan',type:'plan'},situation:{complexity:.9,uncertainty:.85},
     maxAgents:8,budgetRatio:.85};
   const active=reconcileTaskRecruitment({...args,desiredRoles:allocation.roles});
   assert.ok(active.activeRoles.length>0);
   assert.ok(active.subagents.length>0);
   const finished=reconcileTaskRecruitment({...args,previous:active,
     desiredRoles:allocation.roles,completedRoles:allocation.roles,
     acceptanceSatisfied:true});
   assert.deepEqual(finished.activeRoles,[]);
   assert.deepEqual(finished.subagents,[]);
   assert.deepEqual(finished.lifecycle.retireRoles,active.activeRoles);
 }
});

test('Simple and complex Normal Chat never invokes an agent even if specialized keywords match',async()=>{
 const run={surface:'normal-chat',goal:'Explain how to write a thesis and debug an API',
   situation:{complexity:1,uncertainty:1},adaptation:{scale:'advanced'}};
 const task={id:'plan',type:'plan'};
 assert.deepEqual(rolesFor(run,task,{mode:'always',maxAgents:11}).roles,[]);
 let calls=0;
 const out=await runAdaptiveAgentPanel({
   run,task,basePayload:{goal:run.goal,task,surface:'normal-chat'},
   config:{agents:{multiAgent:'always',maxAgents:11}},modelCaller:async()=>{calls++;return {}; }
 });
 assert.equal(out.enabled,false);
 assert.equal(calls,0);
});
