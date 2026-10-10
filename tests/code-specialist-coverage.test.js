import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_MAIN_AGENTS, familyMainAgentMatch, familyMainAgentStats } from '../src/family-main-agents.js';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';
import { codeExpertFocus, codeSpecialistTeam } from '../src/specialist-hierarchy.js';
import { rolesFor } from '../src/multi-agent.js';
import { surfaceRuntimePolicy } from '../src/surface-policy.js';

const cases=[
 ['ui-engineering','src/ui/components','Design responsive UI components','ui'],
 ['ux-engineering','src/ux/journeys','Improve user journeys and usability','ux'],
 ['frontend-engineering','src/frontend','Improve React frontend routing','frontend'],
 ['backend-engineering','src/backend/services','Develop the backend service','backend'],
 ['api-engineering','src/api/routes','Create REST API endpoints','api'],
 ['database-engineering','src/db/migrations','Optimize PostgreSQL SQL migrations','storage'],
 ['security-engineering','src/auth','Review security authentication controls','security'],
 ['data-management-engineering','src/data-governance','Improve data governance, lineage and retention','data'],
 ['identity-access-engineering','src/identity','Implement SSO and RBAC identity management','identity'],
 ['file-rendering-engineering','src/file-preview','Implement secure file preview and PDF rendering for Office documents','files']
];
test('Coding has distinct main-agent families for UI, UX, APIs, backend, data, DB, identity, files and security',()=>{
 const summary=familyMainAgentStats();
 assert.equal(summary.code.mainAgents,63);
 assert.ok(summary.code.subagents>63*8);
 for(const [family,path,goal,focus] of cases){
   const role='code-'+family+'-lead';
   assert.ok(FAMILY_MAIN_AGENTS[role],role);
   assert.ok(FAMILY_MAIN_AGENTS[role].subagents.length>8,role);
   const sub={id:family,roots:[path],files:[path+'/index.js']};
   assert.equal(codeExpertFocus(sub,goal),focus,path);
   const plan=codeSpecialistTeam(sub,{goal,maxRoles:4});
   assert.equal(plan.authority,'advisory-only');
   assert.ok(plan.leadRole,role);
   assert.ok(plan.roles.length<=4);
   const child=selectFamilySubagents({
     surface:'code',role,goal,task:{type:'code',id:'build-code'},
     situation:{complexity:.88,uncertainty:.7,risk:'medium',
       successCriteria:['Check concrete integration and security failure cases']},
     remainingBudgetRatio:.85
   });
   assert.equal(child.family,family);
   assert.ok(child.active.length>=1,role);
   assert.ok(child.active.every(s=>s.authority==='read-only-advisory'
     && !s.mayInvokeTools&&!s.maySpawnAgents));
   assert.ok(familyMainAgentMatch(role,{surface:'code',goal,task:{type:'code'}})>0,role);
 }
});
test('Code recruiter can select required specialist families from the actual goal',()=>{
 for(const goal of [
  'Design UI components, focus states and accessible layout',
  'Implement identity management with RBAC and single sign-on',
  'Improve data governance and data retention',
  'Build a safe PDF document rendering preview'
 ]){
   const run={surface:'code',goal,maxTokens:100000,
      situation:{risk:'medium',complexity:.95,uncertainty:.7},
      adaptation:{scale:'advanced'},attempt:1};
   const panel=rolesFor(run,{id:'plan',type:'plan'},
      {mode:'always',maxAgents:8});
   assert.ok(panel.roles.some(role=>role.startsWith('code-')&&role.endsWith('-lead')),
     JSON.stringify({goal,roles:panel.roles}));
   assert.ok(panel.agentCount<=8);
 }
});
test('Normal Chat stays direct with files and visuals, without specialist recruitment',()=>{
 assert.equal(surfaceRuntimePolicy('normal-chat').adaptiveAgents,false);
 const run={surface:'normal-chat',goal:'Preview this PDF and edit the attached Word document',
   adaptation:{scale:'advanced'},situation:{complexity:1,uncertainty:1},attempt:1};
 const panel=rolesFor(run,{id:'plan',type:'plan'},
   {mode:'always',maxAgents:11});
 assert.equal(panel.agentCount,0);
 assert.deepEqual(panel.roles,[]);
});
