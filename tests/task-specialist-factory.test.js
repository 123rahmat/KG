import test from 'node:test';
import assert from 'node:assert/strict';
import {taskSpecialistCandidates,taskSpecialistForRole} from '../src/task-specialist-factory.js';
import {rolesFor,agentMessages} from '../src/multi-agent.js';

const unusual=[
  'Analyze the undeciphered inscription sequence on a bronze astrolabe and document the uncertain glyph boundaries',
  'Classify unusual tidepool symbiosis patterns by their ecological interactions and distinguish independent observation methods',
  'Reconcile two competing historic textile dyeing processes from contradictory archival descriptions and experimental constraints'
];
const goal='Develop a rigorous interdisciplinary catalog of new discoveries';
const situation={risk:'low',complexity:.95,uncertainty:.9,unknownSituation:true,
 successCriteria:unusual,outputs:['Document a falsifiable workflow for each unknown finding']};
const task={id:'plan',type:'plan'};

test('unrepresented tasks generate evidence-scoped temporary main specialists',()=>{
 const specialists=taskSpecialistCandidates({
   surface:'research',goal,task,situation,maxCandidates:8
 });
 assert.ok(specialists.length>=2,JSON.stringify(specialists));
 assert.ok(new Set(specialists.map(x=>x.role)).size===specialists.length);
 assert.ok(specialists.every(x=>x.role.startsWith('situational-')
   && x.authority==='read-only-advisory'
   && x.mayAccessTools===false&&x.maySpawnAgents===false));
 assert.deepEqual(specialists,
   taskSpecialistCandidates({surface:'research',goal,task,situation,maxCandidates:8}));
 assert.notEqual(specialists[0].role,
   taskSpecialistCandidates({surface:'code',goal,task,situation,maxCandidates:8})[0]?.role);
});

test('known specialties and generic quality words do not create duplicate agents',()=>{
 const familiar=taskSpecialistCandidates({surface:'code',goal:'Improve website UI',
  task,situation:{successCriteria:[
    'Verify WCAG accessibility with keyboard navigation and clear ARIA labels',
    'Improve the database SQL query performance and PostgreSQL migrations',
    'Accuracy','Quality','Speed'
  ]},maxCandidates:10});
 assert.ok(familiar.length<=1,JSON.stringify(familiar));
});

test('specialist count follows explicit need and the trusted compute allowance',()=>{
 const few=taskSpecialistCandidates({surface:'research',goal,task,situation,maxCandidates:1});
 const all=taskSpecialistCandidates({surface:'research',goal,task,situation,maxCandidates:8});
 assert.equal(few.length,1);
 assert.ok(all.length>few.length);
 assert.equal(taskSpecialistCandidates({surface:'research',goal,task,situation,maxCandidates:0}).length,0);
 const r={surface:'research',goal,situation,
  adaptation:{scale:'advanced'},tasks:[],attempt:1};
 const team=rolesFor(r,task,{mode:'always',maxAgents:9});
 assert.ok(team.agentCount>=2);
 assert.ok(team.roles.some(role=>role.startsWith('situational-')),JSON.stringify(team.roles));
 assert.ok(team.agentCount<=9);
});

test('specialist prompt retains the precise user need without new execution rights',()=>{
 const role=taskSpecialistCandidates({surface:'research',goal,task,situation,maxCandidates:8})[0].role;
 const desc=taskSpecialistForRole(role,{surface:'research',goal,task,situation});
 assert.ok(desc?.purpose.includes('Focus on this unmet'));
 const messages=agentMessages(role,{goal,task,situation,specialistSurface:'research'});
 assert.match(messages[0].content,/Focus on this unmet/);
 assert.match(messages[0].content,/You are advisory only/);
 assert.match(messages[0].content,/do not have direct shell/);
 assert.match(messages[1].content,/read-only-advisory/);
});
