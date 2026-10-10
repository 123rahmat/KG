import test from 'node:test';
import assert from 'node:assert/strict';
import { ventureIntent, ventureDiscoveryStep, ventureRolePriority,
  ventureRoleScore, ventureRoleAssignment, VENTURE_AGENTS } from '../src/venture-ideation.js';
import { rolesFor, agentMessages, multiAgentDecision } from '../src/multi-agent.js';
import { systemPromptFor } from '../src/reasoning-context.js';

const codeGoal='Brainstorm three innovative startup SaaS app ideas, validate the best and then build an MVP';
const researchGoal='Research a new business startup idea, analyze competing services and its business model';
const codeRun={surface:'code',goal:codeGoal,adaptation:{scale:'advanced'},
  situation:{risk:'low',complexity:.74,uncertainty:.62,successCriteria:[
    'Select a feasible startup concept before code',
    'Define a customer-focused tested MVP'
  ]},tasks:[]};
const ventureTask={id:'step',type:'step',metadata:{ventureDiscovery:true},
  purpose:'Explore alternative startup ideas and decide the MVP'};

test('only explicit idea- or venture-led projects start a discovery phase',()=>{
  const idea=ventureIntent({goal:codeGoal,surface:'code'});
  assert.equal(idea.kind,'idea-to-build');
  assert.equal(idea.buildAfterDiscovery,true);
  assert.equal(ventureIntent({goal:researchGoal,surface:'research'}).kind,'venture-discovery');
  assert.equal(ventureIntent({goal:'Fix broken UI button',surface:'code'}).enabled,false);
  assert.equal(ventureIntent({goal:'Fix the broken idea service module',surface:'code'}).enabled,false);
  assert.equal(ventureIntent({goal:'Debug business model calculation error',surface:'code'}).enabled,false);
  assert.equal(ventureIntent({goal:'Brainstorm solutions to fix a startup MVP flaw',surface:'code'}).enabled,true);
  assert.equal(ventureIntent({goal:'Write a thank-you note',surface:'normal-chat'}).enabled,false);
  assert.equal(ventureIntent({goal:'Just build it: startup SaaS app',surface:'code'}).enabled,false);
  assert.equal(ventureIntent({goal:'Skip brainstorming and build a startup SaaS app',surface:'code'}).enabled,false);
  assert.equal(ventureIntent({goal:'Build a startup SaaS app for restaurants',surface:'code'}).enabled,true);
  assert.equal(ventureDiscoveryStep({goal:'Fix a cache regression',surface:'code'}),null);
  const step=ventureDiscoveryStep({goal:codeGoal,surface:'code'});
  assert.equal(step.type,'step');
  assert.equal(step.ventureDiscovery,true);
  assert.match(step.purpose,/three meaningfully different/);
  assert.match(step.purpose,/Do not invent market numbers/);
});

test('idea agents have domain-specific advisory subagent skills and no fixed active team',()=>{
  assert.ok(Object.keys(VENTURE_AGENTS).length>=6);
  assert.ok(VENTURE_AGENTS['business-model-lead'].children.includes('unit-economics'));
  assert.ok(VENTURE_AGENTS['venture-ideation-lead'].children.includes('smallest-experiment'));
  const ranked=ventureRolePriority({goal:codeGoal,surface:'code',task:ventureTask});
  assert.equal(ranked[0],'venture-ideation-lead');
  assert.ok(ranked.includes('business-model-lead'));
  assert.ok(ventureRoleScore('venture-ideation-lead',{goal:codeGoal,surface:'code',task:ventureTask})>0.9);
  const assignment=ventureRoleAssignment('business-model-lead',{
    goal:codeGoal,surface:'code',task:ventureTask
  });
  assert.ok(assignment.skills.length>=2);
  assert.ok(assignment.skills.length<VENTURE_AGENTS['business-model-lead'].children.length);
  const expanded=ventureRoleAssignment('business-model-lead',{
    goal:codeGoal,surface:'code',task:ventureTask,
    run:{situation:{complexity:.94,uncertainty:.82,
      successCriteria:['Price an MVP','Test customer acquisition','Document unit economics']}},
    remainingBudgetRatio:1
  });
  const scarce=ventureRoleAssignment('business-model-lead',{
    goal:codeGoal,surface:'code',task:ventureTask,
    run:{situation:{complexity:.94,uncertainty:.82}},remainingBudgetRatio:.1
  });
  assert.ok(expanded.skills.length>assignment.skills.length);
  assert.equal(scarce.skills.length,1);
  assert.equal(expanded.selectedSkills,expanded.skills.length);
  assert.equal(expanded.availableSkills,VENTURE_AGENTS['business-model-lead'].children.length);
  assert.match(assignment.approvalBoundary,/not-approval/);
  assert.equal(ventureRoleAssignment('business-model-lead',{
    goal:'Fix code formatting',surface:'code',task:ventureTask}),null);
});

test('Coding and Research recruit venture expertise within existing budgeted panels',()=>{
  const selection=rolesFor(codeRun,ventureTask,{mode:'always',maxAgents:5});
  assert.ok(selection.roles.includes('venture-ideation-lead'),selection.roles.join(','));
  assert.ok(selection.roles.length<=5);
  assert.ok(selection.allocation);
  const researchRun={surface:'research',goal:researchGoal,
    adaptation:{scale:'complex'},
    situation:{risk:'ordinary',uncertainty:.8,complexity:.8},tasks:[]};
  const roles=rolesFor(researchRun,{id:'investigate',type:'investigate'},
    {mode:'always',maxAgents:5});
  assert.ok(roles.roles.includes('market-validation-lead'),roles.roles.join(','));
  assert.ok(roles.roles.length<=5);
  const direct={...codeRun,surface:'normal-chat'};
  assert.equal(multiAgentDecision(direct,ventureTask,{mode:'always'}).enabled,false);
  const none=rolesFor(codeRun,ventureTask,{mode:'off',maxAgents:6});
  assert.deepEqual(none.roles,[]);
});

test('idea specialist messages are limited to advisory evidence, not executable authority',()=>{
  const messages=agentMessages('venture-ideation-lead',{
    specialistSurface:'code',goal:codeGoal,
    task:{...ventureTask,ventureDiscovery:true},
    situation:codeRun.situation
  });
  assert.match(messages[0].content,/Advisory only/);
  const payload=JSON.parse(messages[1].content);
  assert.equal(payload.ventureAssignment.role,'venture-ideation-lead');
  assert.equal(payload.ventureAssignment.phase,'explore-and-select');
  assert.ok(payload.ventureAssignment.skills.length<VENTURE_AGENTS['venture-ideation-lead'].children.length);
  assert.equal(payload.ventureAssignment.approvalBoundary,'proposed-idea-is-not-approval-to-build-or-launch');
});

test('the ideation step and approved build plan have their own minimal model rules',()=>{
  const ideation=systemPromptFor({task:{...ventureTask,ventureDiscovery:true},
    run:codeRun,payload:{}});
  assert.match(ideation,/Idea discovery before building/);
  assert.match(ideation,/Set enough:false/);
  const build=systemPromptFor({task:{id:'plan',type:'plan',buildPlan:true},
    run:codeRun,payload:{}});
  assert.match(build,/Idea-to-build handoff/);
  assert.match(build,/user-approvable coding plan/);
  const unrelated=systemPromptFor({task:{id:'respond',type:'respond'},
    run:{surface:'normal-chat',goal:'Explain a word',situation:{}},payload:{}});
  assert.doesNotMatch(unrelated,/Idea discovery before building|Idea-to-build handoff/);
});

test('saved venture selection can hand off to a product-focused implementation agent',()=>{
  const built=ventureRolePriority({goal:codeGoal,surface:'code',
    task:{id:'build-code',type:'code'},
    run:{tasks:[{metadata:{ventureDiscovery:true},status:'complete'}]}});
  assert.ok(built.includes('product-mvp-lead'));
  assert.ok(!built.includes('venture-ideation-lead'));
  assert.deepEqual(ventureRolePriority({goal:'Refactor a file',surface:'code',
    task:{id:'build-code',type:'code'}}),[]);
});
