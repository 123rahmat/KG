import test from 'node:test';
import assert from 'node:assert/strict';
import { codeExpertFocus, codeSpecialistTeam, codeSpecialistLeadsFor, researchSpecialistTeams, specialistRemit } from '../src/specialist-hierarchy.js';
import { agentMessages, rolesFor } from '../src/multi-agent.js';

test('Code selects subsystem-specific experts from real paths, not generic headcount', () => {
  for(const [path,focus,role] of [
    ['src/ui/components','ui','code-ui-engineering-lead'],
    ['src/frontend','frontend','frontend-engineer'],
    ['src/backend','backend','backend-engineer'],
    ['src/auth','security','security-reviewer'],
    ['src/db/migrations','storage','backend-engineer'],
    ['tests/api','testing','test-engineer'],
    ['infra/docker','infrastructure','architect']
  ]) {
    const subsystem={id:'module',roots:[path],files:[path+'/file.js']};
    assert.equal(codeExpertFocus(subsystem),focus,path);
    const team=codeSpecialistTeam(subsystem);
    assert.equal(team.leadRole,role,path);
    assert.equal(team.depth,2);
    assert.equal(team.authority,'advisory-only');
  }
});

test('Small Code change stays cheap; complex teams have strict specialist caps', () => {
  const sub={id:'ui',roots:['src/ui'],files:['src/ui/app.tsx']};
  assert.deepEqual(codeSpecialistTeam(sub,{remainingBudgetRatio:.1}).roles,['code-ui-engineering-lead']);
  assert.equal(codeSpecialistTeam(sub,{remainingBudgetRatio:.36}).roles.length,2);
  assert.ok(codeSpecialistTeam(sub,{maxRoles:100}).roles.length<=4);
  assert.equal(codeSpecialistTeam(sub,{risk:'high-impact',independent:true}).parallelEligible,false);
  const remit=specialistRemit(codeSpecialistTeam(sub),'code-ui-engineering-lead');
  assert.equal(remit.maySpawnAgents,false);
  assert.equal(remit.scope.files[0],'src/ui/app.tsx');
  assert.equal(specialistRemit(codeSpecialistTeam(sub),'unknown-role'),null);
});

test('Unsourced thesis does not manufacture results or prematurely recruit writer', () => {
  const h=researchSpecialistTeams({goal:'Write a thesis on energy technology'});
  assert.equal(h.thesis,true);
  assert.equal(h.evidenceReady,false);
  assert.equal(h.noSourceFabrication,true);
  assert.equal(h.teams[0].leadRole,'literature-reviewer');
  assert.equal(h.teams.some(t=>t.focus==='writing'),false);
  assert.equal(h.teams.every(t=>t.verifiedSources===false),true);
});

test('Evidence-backed thesis can recruit methods, statistics, citations, writing within caps', () => {
  const h=researchSpecialistTeams({
    goal:'Write a thesis using quantitative data, methodology and sample results',
    researchState:{sourceCount:12,evidenceCount:8,unresolvedQuestions:['Which paper explains X?'],
      conflicts:['Study A and B disagree']},
    maxTeams:6,maxRoles:4
  });
  assert.deepEqual(h.teams.map(t=>t.focus),['literature','methodology','analysis','citations','writing']);
  assert.ok(h.teams.every(t=>t.roles.length<=4 && t.depth===2));
  assert.equal(h.teams.at(-1).leadRole,'academic-writer');
  assert.equal(researchSpecialistTeams({goal:'Write a thesis',remainingBudgetRatio:.1}).teams.length,1);
  assert.equal(researchSpecialistTeams({goal:'Literature review',risk:'regulated',
    researchState:{unresolvedQuestions:['A','B']}}).teams[0].parallelEligible,false);
});

test('Research specialists inherit advisory prompt contracts without new permissions', () => {
  const h=researchSpecialistTeams({goal:'Academic thesis on methods'});
  const remit=specialistRemit(h.teams[0],'literature-reviewer');
  const messages=agentMessages('literature-reviewer',{
    goal:'Academic thesis on methods',task:{type:'investigate',id:'investigate'},
    specialistAssignment:remit
  });
  assert.match(messages[0].content,/never invent citations/i);
  const body=JSON.parse(messages[1].content);
  assert.equal(body.specialistAssignment.authority,'advisory-only');
  assert.equal(body.specialistAssignment.maySpawnAgents,false);
});

test('Thesis Research role allocation prefers evidence expertise; Normal Chat stays direct first', () => {
  const research={surface:'research',goal:'Systematic literature review for a thesis',maxTokens:100000,
    situation:{risk:'low'},adaptation:{scale:'complex',researchWorkspace:{sourceCount:0,
    unresolvedQuestions:['Find primary research']}}};
  const selected=rolesFor(research,{id:'investigate',type:'investigate'},
    {mode:'always',maxAgents:4});
  assert.ok(selected.roles.includes('literature-reviewer'));
  const simple=rolesFor({surface:'normal-chat',situation:{risk:'low'},adaptation:{scale:'small'}},
    {id:'respond',type:'respond'});
  assert.equal(simple.agentCount,0);
});

test('unknown budgets preserve task-specific Code and Research breadth', () => {
  for (const remainingBudgetRatio of [null, undefined, '', ' ', NaN, Infinity]) {
    const team = codeSpecialistTeam({ id: 'ui', roots: ['src/ui'] }, {
      maxRoles: 3, remainingBudgetRatio
    });
    assert.deepEqual(team.roles, ['code-ui-engineering-lead', 'frontend-engineer', 'accessibility-auditor']);
    const hierarchy = researchSpecialistTeams({
      goal: 'Write a thesis methodology using quantitative results',
      researchState: { sourceCount: 4 }, remainingBudgetRatio
    });
    assert.deepEqual(hierarchy.teams.map(item => item.focus),
      ['literature', 'methodology', 'analysis', 'writing']);
  }
});

test('extended Code specialists join real subsystem panels only on matching task needs',()=>{
 for(const [goal,expected] of [
   ['Implement Stripe billing checkout and invoice system','code-billing-payments-engineering-lead'],
   ['Build a full text search relevance system with Elasticsearch','code-search-index-engineering-lead'],
   ['Implement an offline-first synchronization protocol','code-offline-first-app-engineering-lead'],
   ['Create a rich Storybook component library with design tokens','code-design-system-components-lead'],
   ['Review RLS policy for tenant isolation','code-multi-tenant-isolation-engineering-lead'],
   ['Add a type-safe API client SDK','code-api-sdk-client-engineering-lead']
 ]){
   const matched=codeSpecialistLeadsFor({id:'feature'},{
     goal,task:{id:'build-code',type:'code'},limit:5
   });
   assert.ok(matched.some(item=>item.role===expected),goal+': '+matched.map(x=>x.role).join(', '));
 }
 assert.deepEqual(codeSpecialistLeadsFor({id:'general'},{
   goal:'Write a friendly greeting in normal prose'
 }),[]);
 assert.deepEqual(codeSpecialistLeadsFor({id:'billing'},{
   goal:'Implement billing checkout',limit:0
 }),[]);
});
