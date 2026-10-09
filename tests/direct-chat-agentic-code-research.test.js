import test from 'node:test';
import assert from 'node:assert/strict';
import { multiAgentDecision,rolesFor,runAdaptiveAgentPanel } from '../src/multi-agent.js';
import { reviewDecision } from '../src/agents.js';
import { decideAgentTopology } from '../src/adaptive-agents.js';
import { workspaceComputePolicy,buildModeControllerContract } from '../src/mode-controllers.js';
import { normalChatTaskProfile } from '../src/normal-chat-task-profile.js';
import { surfaceRuntimePolicy } from '../src/surface-policy.js';
import { taskSpecialistCandidates } from '../src/task-specialist-factory.js';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';
import { reconcileTaskRecruitment } from '../src/situational-recruitment-supervisor.js';

const selection={
  planModelIds:['google:gemini-3.8-flash'],
  enabledModelIds:['google:gemini-3.8-flash'],
  configuredModelIds:['google:gemini-3.8-flash']
};
const goal='Compare a complex personal budget and explain calculus without any recruited specialist';
const task={id:'plan',type:'plan',metadata:{
  acceptanceCriteria:['Show a rigorous calculation with checked assumptions'] 
}};
const chatRun={surface:'normal-chat',goal,
  situation:{risk:'high',uncertainty:.9,complexity:.98,unknownSituation:true,
    successCriteria:['Explain assumptions and any remaining uncertainty']},
  adaptation:{scale:'advanced',effortProfile:{maturity:{pressure:.99}}},
  maxTokens:100000,tasks:[],attempt:2};

test('Normal Chat never recruits even with deep uncertainty, risk or always-agent setting',async()=>{
  for(const surface of ['normal-chat','chat','visual','design']){
    const run={...chatRun,surface};
    const decision=multiAgentDecision(run,task,{mode:'always'});
    assert.equal(decision.enabled,false,surface);
    assert.equal(decision.reason,'direct-conversation-no-agent-recruitment');
    assert.deepEqual(rolesFor(run,task,{mode:'always',maxAgents:11}).roles,[]);
    let calls=0,waves=0,recorded=0;
    const result=await runAdaptiveAgentPanel({
      run,task,basePayload:{goal,task,surface,attachments:[{name:'budget.xlsx'}]},
      selection,primaryModelId:'google:gemini-3.8-flash',
      config:{agents:{multiAgent:'always',maxAgents:11}},
      modelCaller:async()=>{calls++;throw new Error('No agent may be called in Normal Chat');},
      recordWave:async()=>{waves++;},recordAgent:async()=>{recorded++;}
    });
    assert.equal(result.enabled,false);
    assert.equal(result.brief,null);
    assert.deepEqual(result.agents,[]);
    assert.equal(calls,0);
    assert.equal(waves,0);
    assert.equal(recorded,0);
    assert.deepEqual(decideAgentTopology({workspace:surface,tasks:[task],
      complexity:.99,uncertainty:.99,budget:{maxAgents:11}}).agents,[]);
    assert.equal(reviewDecision(run,{mode:'always'}).review,false);
  }
});

test('Direct chat still supports deep reasoning, file/visual tools and verification contracts',()=>{
 const profile=normalChatTaskProfile({
   goal:'Explain this difficult multi-step mathematical theorem and compare uploaded documents',
   attachments:[{name:'notes.docx'},{name:'numbers.xlsx'}],
   complexity:.99,uncertainty:.8,risk:'high',verificationRequired:true
 });
 assert.equal(profile.reasoningDepth,'deep');
 assert.equal(profile.toolPolicy,'just-in-time-authorized-only');
 assert.equal(profile.verification,'check-observable-claims-and-artifacts');
 assert.equal(profile.agentPolicy,'single-primary-model-no-specialist-recruitment');
 const controller=buildModeControllerContract({
   surface:'normal-chat',situation:{goal:chatRun.goal},complexity:1,
   uncertainty:1,risk:'high',remainingBudgetRatio:1
 });
 assert.equal(controller.decision.recruitSpecialist,false);
 assert.equal(controller.decision.parallelIndependentWork,false);
 assert.deepEqual(controller.roles,[]);
 assert.equal(controller.compute.recommendedAgents,1);
 assert.equal(controller.compute.maxParallel,1);
 assert.equal(surfaceRuntimePolicy('normal-chat').adaptiveAgents,false);
 assert.equal(surfaceRuntimePolicy('normal-chat').adaptiveTools,true);
 assert.equal(surfaceRuntimePolicy('normal-chat').adaptiveVerification,true);
});

test('Coding and Research retain separate agent recruitment, advisory subagents and resource lifecycles',()=>{
 for(const surface of ['code','research']){
   const run={...chatRun,surface,goal:surface==='code'
     ? 'Build and test a complex project with backend APIs and regression tests'
     : 'Investigate contradictory historical manuscripts, verify uncertain references and document methods',
     situation:{risk:'medium',complexity:.85,uncertainty:.8,unknownSituation:true,
       successCriteria:['Verify the principal claims with independent evidence and acceptance checks']},
     adaptation:{scale:'advanced'},attempt:1};
   const decision=multiAgentDecision(run,task,{mode:'always'});
   assert.equal(decision.enabled,true,surface);
   const roles=rolesFor(run,task,{mode:'always',maxAgents:6});
   assert.ok(roles.agentCount>=1,surface);
   assert.ok(roles.agentCount<=6);
   const topology=decideAgentTopology({workspace:surface,
     tasks:[{id:'investigate',type:'investigate'},{id:'verify',type:'verify'}],
     scale:'medium',complexity:.8,uncertainty:.7});
   assert.ok(topology.agents.length>0);
   const child=selectFamilySubagents({surface,goal:run.goal,role:roles.roles[0],
     task,situation:run.situation,remainingBudgetRatio:1});
   assert.ok(child.active.length>=1);
   const hired=reconcileTaskRecruitment({
     runId:'r',taskId:'t',surface,goal:run.goal,
     desiredRoles:roles.roles,task,situation:run.situation,
     maxAgents:6,budgetRatio:1
   });
   assert.ok(hired.activeRoles.length>0);
   assert.ok(hired.subagents.length>0);
   const retired=reconcileTaskRecruitment({
     runId:'r',taskId:'t',surface,goal:run.goal,
     desiredRoles:[],completedRoles:hired.activeRoles,
     previous:hired,maxAgents:6,budgetRatio:1
   });
   assert.equal(retired.activeRoles.length,0);
   assert.equal(retired.lifecycle.retireRoles.length,hired.activeRoles.length);
 }
});

test('Previously unknown main specialties remain available inside agentic workspaces',()=>{
 const situation={successCriteria:[
   'Analyze an undocumented hexagonal geophysical artifact and map conflicting sediment signatures',
   'Compare the acoustic absorption of a novel synthetic mineral sample under low-temperature stress'
 ]};
 assert.ok(taskSpecialistCandidates({
   surface:'research',goal:'Analyze unfamiliar artifacts with independent evidence',
   situation,task,maxCandidates:6
 }).length>=1);
 assert.equal(taskSpecialistCandidates({surface:'normal-chat',
   goal:'I need a direct answer',task,situation:{},maxCandidates:0}).length,0);
});
