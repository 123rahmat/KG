import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_MAIN_AGENTS, familyMainAgentMatch, familyMainAgentStats } from '../src/family-main-agents.js';
import { specialistFocusFor } from '../src/adaptive-specialist-focus.js';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';
import { domainSpecialistMatch } from '../src/domain-specialists.js';
import { rolesFor } from '../src/multi-agent.js';

test('all 55 families register main agents and keep their eight distinct subagents',()=>{
  const counts=familyMainAgentStats();
  assert.deepEqual(counts['normal-chat'],{mainAgents:20,subagents:160});
  assert.deepEqual(counts.code,{mainAgents:20,subagents:160});
  assert.deepEqual(counts.research,{mainAgents:15,subagents:120});
  assert.equal(Object.keys(FAMILY_MAIN_AGENTS).length,55);
  for(const role of Object.values(FAMILY_MAIN_AGENTS)){
    assert.equal(role.subagents.length,8,role.role);
    assert.equal(new Set(role.subagents).size,8,role.role);
    assert.ok(Object.isFrozen(role));
  }
});
test('scoped main agents do not activate from an unrelated or empty request',()=>{
  assert.ok(familyMainAgentMatch('code-ui-engineering-lead',{surface:'code',
    goal:'Build a responsive UI component',task:{type:'code'}} >= .89);
  assert.equal(familyMainAgentMatch('code-ui-engineering-lead',{
    surface:'normal-chat',goal:'Build a responsive UI component'}),0);
  assert.equal(familyMainAgentMatch('chat-thinking-reasoning-lead',{
    surface:'normal-chat',goal:'hello'}),0);
  assert.ok(domainSpecialistMatch('research-evidence-verification-lead',{
    surface:'research',goal:'Fact check and verify a scientific claim',task:{type:'investigate'}}) > 0);
});
test('main agents select own subagents but never self-grant tools',()=>{
  const examples=[
    ['normal-chat','chat-education-lead','Teach a lesson and prepare an exam','education'],
    ['code','code-security-engineering-lead','Review authentication and authorization','security-engineering'],
    ['research','research-quantitative-analysis-lead','Evaluate quantitative statistics of a dataset','quantitative-analysis']
  ];
  for(const [surface,role,goal,family] of examples){
    assert.equal(specialistFocusFor({surface,role,goal}).family,family);
    const p=selectFamilySubagents({surface,role,goal,task:{type:'plan'},
      situation:{complexity:.85,uncertainty:.7},remainingBudgetRatio:.8});
    assert.equal(p.family,family);
    assert.ok(p.active.length>=1&&p.active.length<=3);
    assert.ok(p.active.every(child=>!child.mayInvokeTools&&!child.maySpawnAgents));
  }
});
test('actual existing recruiter can choose a family main agent',()=>{
  const run={surface:'normal-chat',goal:'Design a quiz with exam preparation and learning objectives',
    adaptation:{scale:'complex'},situation:{complexity:.9,risk:'low'},tasks:[]};
  const result=rolesFor(run,{id:'plan',type:'plan'},{mode:'always',maxAgents:6});
  assert.ok(result.roles.some(role=>role==='chat-education-lead'),result.roles.join(','));
  assert.ok(result.agentCount<=6);
});
