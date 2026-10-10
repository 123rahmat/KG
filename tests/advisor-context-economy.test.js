import test from 'node:test';
import assert from 'node:assert/strict';
import { advisorContextEnvelope } from '../src/advisor-context-economy.js';
import { agentMessages } from '../src/multi-agent.js';
const conversation=Array.from({length:8},(_,i)=>({user:'request '+i+' '.repeat(1500)+'u'.repeat(1200),
  assistant:'answer '+i+' '+'a'.repeat(1200)}));
const remembered=Array.from({length:18},(_,i)=>'memory '+i+' '+'m'.repeat(600));
const skills=Array.from({length:7},(_,i)=>({name:'skill'+i,instructions:'s'.repeat(4100)}));
const codeIntelligence={project:{revisionId:'v4'},focus:{paths:['a.js']},
  files:[{path:'a.js',content:'SECRET_INFORMATION_MUST_NOT_BE_IN_IDEA_ADVISORS'}]};
test('Research specialists keep bounded relevant history but full grounded evidence arrives separately',()=>{
  const scoped=advisorContextEnvelope({surface:'research',task:{type:'investigate'},
    conversation,remembered,skills});
  assert.equal(scoped.mode,'bounded-advisory');
  assert.equal(scoped.conversation.length,3);
  assert.equal(scoped.remembered.length,5);
  assert.equal(scoped.skills.length,3);
  assert.ok(scoped.skills[0].instructions.length<=900);
  assert.equal(scoped.conversation.at(-1).user.includes('request 7'),true);
  const expanded=advisorContextEnvelope({surface:'research',
    task:{type:'investigate'},situation:{risk:'high'},
    conversation,remembered,skills});
  assert.equal(expanded.conversation.length,5);
  assert.equal(expanded.skills.length,5);
});
test('Code builders preserve source and approved history, idea advisers see safe project summary',()=>{
  const implementation=advisorContextEnvelope({surface:'code',task:{type:'code',id:'build-code'},
    codeIntelligence,conversation,remembered,skills});
  assert.equal(implementation.codeIntelligence.files[0].content,
    codeIntelligence.files[0].content);
  assert.equal(implementation.skills.length,6);
  assert.equal(implementation.conversation.length,6);
  const ideation=advisorContextEnvelope({surface:'code',task:{type:'step',
    ventureDiscovery:true},codeIntelligence,conversation,remembered,skills});
  assert.equal(ideation.mode,'bounded-advisory');
  assert.equal(ideation.codeIntelligence.files[0].path,'a.js');
  assert.equal(ideation.codeIntelligence.files[0].content,undefined);
  const messages=agentMessages('venture-ideation-lead',{
    specialistSurface:'code',goal:'Brainstorm ideas for a new SaaS app then build an MVP',
    task:{type:'step',ventureDiscovery:true},situation:{complexity:.3},
    codeIntelligence,conversation,remembered,skills
  });
  const payload=JSON.parse(messages[1].content);
  assert.equal(payload.codeIntelligence.files[0].content,undefined);
  assert.equal(payload.conversation.length,3);
  assert.equal(payload.remembered.length,5);
  assert.equal(payload.skills.length,3);
  assert.ok(!messages[1].content.includes('SECRET_INFORMATION_MUST_NOT_BE_IN_IDEA_ADVISORS'));
});
