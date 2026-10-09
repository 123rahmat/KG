import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_SPECIALISTS, domainSpecialistMatch } from '../src/domain-specialists.js';
import { taskSpecialization } from '../src/task-specialization.js';
import { rolesFor } from '../src/multi-agent.js';
import { agentActivitySnapshot } from '../public/agent-activity.js';
import { workspaceProgressPanel } from '../public/work-progress-panels.js';

test('one bounded specialist catalog covers daily needs, professional engineering and evidence research', () => {
  assert.ok(Object.keys(DOMAIN_SPECIALISTS).length >= 20);
  for (const [role, item] of Object.entries(DOMAIN_SPECIALISTS)) {
    assert.ok(item.purpose && item.specialty && item.assignment, role);
    assert.ok(item.pattern instanceof RegExp, role);
    assert.ok(item.workspaces.every(mode => ['normal-chat','code','research'].includes(mode)));
  }
  const checks = [
    ['normal-chat', 'Plan a monthly household budget', 'financial-analyst'],
    ['normal-chat', 'Explain a calculus proof in a tutoring session', 'math-verifier'],
    ['normal-chat', 'Help teach a student a lesson', 'subject-tutor'],
    ['normal-chat', 'Edit multiple files into one document', 'document-specialist'],
    ['normal-chat', 'Summarize my Excel spreadsheet', 'spreadsheet-analyst'],
    ['normal-chat', 'Translate this letter into Urdu', 'language-specialist'],
    ['code', 'Implement a new GraphQL API endpoint', 'api-engineer'],
    ['code', 'Optimize a postgres database migration', 'database-engineer'],
    ['code', 'Fix a Docker CI/CD deployment', 'devops-engineer'],
    ['code', 'Run an end-to-end integration test', 'integration-tester'],
    ['code', 'Audit keyboard navigation accessibility', 'accessibility-auditor'],
    ['code', 'Review source dependency and package.json', 'dependency-auditor'],
    ['code', 'Fix retry and timeout reliability', 'reliability-engineer'],
    ['research', 'Perform a systematic review', 'systematic-reviewer'],
    ['research', 'Fact-check these sources', 'fact-checker'],
    ['research', 'Plan a randomized experiment', 'experimental-designer'],
    ['research', 'Analyze my survey questionnaire', 'survey-analyst'],
    ['research', 'Compare conflicting sources', 'source-comparator']
  ];
  for (const [surface, goal, role] of checks) {
    assert.ok(domainSpecialistMatch(role, { surface, goal, task: {type:'analyze'} }) >= 0.90,
      surface + ': ' + goal + ' must match ' + role);
  }
});

test('task signatures prevent unrelated and cross-workspace agents', () => {
  assert.equal(domainSpecialistMatch('api-engineer', {
    surface: 'normal-chat', goal: 'Explain what an API is'
  }), 0);
  assert.equal(domainSpecialistMatch('financial-analyst', {
    surface: 'code', goal: 'Implement a financial dashboard'
  }), 0);
  assert.equal(domainSpecialistMatch('systematic-reviewer', {
    surface: 'research', goal: 'What is a quantum particle?'
  }), 0);
  assert.equal(domainSpecialistMatch('accessibility-auditor', {
    surface: 'code', goal: 'Fix a database transaction'
  }), 0);
});

test('specialized agents inherit the same advisory and exact-scope task instructions', () => {
  const payload = {
    goal: 'Improve API versioning and error handling',
    task: { id:'build-code',type:'code',purpose:'Update the API contract' },
    workspacePanel: { ownedFiles:['src/api/routes.js','src/api/schema.js'] },
    situation: { successCriteria:['Both endpoints keep backwards compatibility'] }
  };
  const info = taskSpecialization('api-engineer',payload);
  assert.match(info.specialty,/API contracts/i);
  assert.match(info.assignment,/endpoint behavior/i);
  assert.deepEqual(info.scope.ownedFiles,['src/api/routes.js','src/api/schema.js']);
  assert.equal(info.expectedEvidence.length,1);
  assert.match(info.authority,/Advisory only/);
  assert.match(info.stopRule,/evidence is sufficient/);
});

test('existing agent allocator can choose domain expertise without a separate permanent orchestration system', () => {
  const run = {
    surface:'research',goal:'Perform a systematic review of sources',
    adaptation:{scale:'complex',researchWorkspace:{
      sourceCount:0,unresolvedQuestions:['Find studies']
    }},situation:{risk:'low',unknownSituation:true},maxTokens:200000
  };
  const plan = rolesFor(run,{id:'investigate',type:'investigate'},
    { mode:'always',maxAgents:6 });
  assert.ok(plan.roles.includes('systematic-reviewer'), JSON.stringify(plan.roles));
  assert.ok(plan.agentCount <= 6);
});

test('task-based adaptive UI only groups saved agent work with a real subsystem cycle', () => {
  const run = {
    state:'complete',
    tasks:[{id:'build-code',status:'complete',purpose:'Update the API',
      evidence:{multiAgent:{
        agentStates:[
          {role:'api-engineer',status:'complete',specialty:'API contracts and integration',
            summary:'API schema requires an optional compatibility check.',
            subsystemId:'api',iteration:2},
          {role:'integration-tester',status:'complete',
            summary:'Add a targeted contract test.',subsystemId:'api',iteration:2}
        ],
        allocation: {
          subsystemPlan:{subsystems:[{id:'api',roots:['src/api']}]},
          subsystemPanels:[{subsystemId:'api',iterations:2,status:'complete',
            adaptiveWork:{activated:['plan','test','verify']}}]
        }, waves:[{index:0,parallel:true}]
      }}}],
    next:null
  };
  const view = agentActivitySnapshot(run);
  assert.equal(view.sourceTask.title,'Update the API');
  assert.equal(view.groups.length,1);
  assert.equal(view.groups[0].label,'src/api');
  assert.equal(view.groups[0].agentCount,2);
  assert.deepEqual(view.groups[0].needed,['plan','test','verify']);
  assert.equal(view.roles[0].specialty,'API contracts and integration');
  assert.equal(view.observedParallel,true);
  assert.deepEqual(view.active,[]);
});

test('proposed-only subsystems and guessed active roles never appear as executed work', () => {
  const result = agentActivitySnapshot({
    state:'complete',
    tasks:[{ id:'plan',status:'complete',evidence:{multiAgent:{
      allocation:{subsystemPanels:[{subsystemId:'pending-api',iterations:0,status:'pending'}]},
      agentStates:[{role:'api-engineer',status:'running'}]
    }}}]
  });
  assert.deepEqual(result.groups,[]);
  assert.deepEqual(result.active,[]);
  assert.equal(result.roles[0].status,'running', 'stored snapshot is not mislabeled as current');
  assert.equal(result.sourceTask.id,'plan');
});

test('workspace task panel remains grounded in persisted execution stages alongside specialists', () => {
  const run = { next:'test-code',tasks:[
    {id:'build-code',type:'code',status:'complete'},
    {id:'test-code',type:'code',status:'running',metadata:{title:'Run backend API tests'}}
  ] };
  const task = workspaceProgressPanel(run,'code');
  assert.equal(task.focus,'Run backend API tests');
  assert.equal(task.stageCount,2);
  assert.equal(task.stages[1].status,'running');
});
