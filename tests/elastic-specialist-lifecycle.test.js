import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIALIST_FAMILIES, specialistFamilyMatches } from '../src/adaptive-specialist-focus.js';
import { FAMILY_MAIN_AGENTS } from '../src/family-main-agents.js';
import { selectFamilySubagents } from '../src/adaptive-family-subagents.js';
import { taskSpecialistCandidates } from '../src/task-specialist-factory.js';
import { reconcileTaskRecruitment } from '../src/situational-recruitment-supervisor.js';
import { agentMessages } from '../src/multi-agent.js';
import { taskSpecificSubagentNeeds } from '../src/situational-subagent-needs.js';
import { agentActivitySnapshot } from '../public/agent-activity.js';

test('main agent families own a variable number of domain-specific subagent skills',()=>{
  const sizes=new Set();
  for(const [surface,families] of Object.entries(SPECIALIST_FAMILIES)){
    for(const [family,skills] of Object.entries(families)){
      assert.ok(skills.length>8,surface+'/'+family);
      assert.equal(new Set(skills).size,skills.length);
      assert.deepEqual([...FAMILY_MAIN_AGENTS[(surface==='normal-chat'?'chat':surface)+'-'+family+'-lead'].subagents],skills);
      sizes.add(skills.length);
    }
  }
  assert.ok(sizes.size>=5);
  const selected=selectFamilySubagents({surface:'code',role:'code-ui-engineering-lead',
    goal:'Build a responsive, accessible UI',task:{type:'plan'},
    situation:{complexity:.9},remainingBudgetRatio:.9});
  assert.ok(selected.available>8);
  assert.ok(selected.active.length<selected.available);
  assert.ok(SPECIALIST_FAMILIES.code['ui-engineering'].includes('screenshot-provenance'));
  assert.ok(SPECIALIST_FAMILIES.code['database-engineering'].includes('transaction-integrity'));
  assert.ok(SPECIALIST_FAMILIES.code['agent-runtime-engineering'].includes('adaptive-agent-retirement'));
  assert.ok(SPECIALIST_FAMILIES.research['systematic-review-methods'].includes('publication-bias'));
  assert.ok(SPECIALIST_FAMILIES.research['quantitative-analysis'].includes('effect-size-uncertainty'));
});

test('shared foundational checks do not turn every family into a false match',()=>{
  const code=specialistFamilyMatches({surface:'code',goal:'Check revision consistency'});
  const research=specialistFamilyMatches({surface:'research',goal:'Check source provenance'});
  assert.ok(code.length<20,'revision-consistency is a common skill, not a domain trigger');
  assert.ok(research.length<20,'source-provenance is a common skill, not a domain trigger');
});

test('specialists and child lenses admit and retire at evidence-driven safe wave boundaries',()=>{
  const runId='run-1',taskId='audit-task';
  const situation={risk:'high',complexity:.88,uncertainty:.8,
    successCriteria:['Check responsive interactions and actual UI runtime behavior']};
  const requirement='Verify tooltip keyboard focus after profile layout changes';
  const task=(status)=>({id:taskId,type:'code',metadata:{acceptanceCriteria:[
    {description:requirement,status}
  ]}});
  const basic={runId,taskId,surface:'code',
    goal:'Review responsive UI and keyboard focus',
    situation,budgetRatio:.9,mode:'auto',maxAgents:5};
  const first=reconcileTaskRecruitment({...basic,
    task:task('open'),desiredRoles:['frontend-engineer'],waveIndex:0});
  const criterion=first.subagents.find(x=>x.id.startsWith('frontend-engineer:task-verify-tooltip'));
  assert.ok(criterion,'a criterion-specific child was admitted');
  const evidence=[{status:'complete',recommendation:'investigate',
    unknowns:['Investigate unexpected cross-browser pointer latency during profile rebuild']}];
  const second=reconcileTaskRecruitment({...basic,
    task:task('verified'),desiredRoles:['frontend-engineer','security-reviewer'],
    findings:evidence,previous:first,waveIndex:1});
  assert.ok(second.lifecycle.retireSubagents.includes(criterion.id));
  assert.ok(second.lifecycle.recruitSubagents.some(id=>id.includes('investigate-unexpected-cross-browser')));
  assert.ok(second.lifecycle.recruitRoles.includes('security-reviewer'));
  assert.equal(second.lifecycle.inFlightCanceled,false);
  assert.equal(second.lifecycle.externalToolsExecuted,false);
  const third=reconcileTaskRecruitment({...basic,
    task:task('verified'),desiredRoles:['security-reviewer'],
    findings:[],previous:second,waveIndex:2});
  assert.ok(third.lifecycle.retireRoles.includes('frontend-engineer'));
  assert.ok(third.lifecycle.retireSubagents.some(id=>id.includes('investigate-unexpected-cross-browser')));
  const finished=reconcileTaskRecruitment({...basic,
    task:task('verified'),desiredRoles:['security-reviewer'],
    previous:third,acceptanceSatisfied:true,waveIndex:3});
  assert.deepEqual(finished.activeRoles,[]);
  assert.deepEqual(finished.subagents,[]);
  assert.ok(finished.lifecycle.retireRoles.includes('security-reviewer'));
});

test('verified criteria retire matching child lenses even when repeated as plain text',()=>{
  const requirement='Verify tooltip keyboard focus after profile layout changes';
  const result=taskSpecificSubagentNeeds({
    situation:{successCriteria:[requirement]},
    task:{metadata:{acceptanceCriteria:[{description:requirement,status:'verified'}]}}
  });
  assert.ok(!result.some(child=>child.requirement===requirement));
  assert.equal(result.length,0);
});

test('newly observed unknown can create a temporary main agent with its actual mission',()=>{
  const unknown='Investigate unusual mesospheric ion channel patterns in an unclassified sensor trace';
  const observed=[{recommendation:'investigate',status:'complete',unknowns:[unknown]}];
  const task={id:'investigate',type:'investigate'};
  const args={surface:'research',goal:'Assess a novel measurement observation',
    task,situation:{risk:'medium',unknowns:[]},maxCandidates:6};
  assert.equal(taskSpecialistCandidates(args).length,0);
  const newRoles=taskSpecialistCandidates({...args,observedFindings:observed});
  assert.equal(newRoles.length,1);
  assert.equal(newRoles[0].source,'observed-gap');
  assert.equal(newRoles[0].confidence,'agent-observation-unverified');
  const prompt=agentMessages(newRoles[0].role,{
    specialistSurface:'research',goal:args.goal,task,situation:args.situation,
    observedFindings:observed
  });
  assert.ok(prompt[0].content.includes(unknown));
  const payload=JSON.parse(prompt[1].content);
  assert.ok(payload.taskSpecialization.assignment.includes(unknown));
  assert.equal(payload.taskSpecialization.authority.startsWith('Advisory only'),true);
});

test('UI shows only saved admission and retirement as advisory selections',()=>{
  const event={waveIndex:2,recruitRoles:['code-ui-engineering-lead'],
    retireRoles:['backend-engineer'],
    recruitSubagents:['code-ui-engineering-lead:ui-testing'],
    retireSubagents:['backend-engineer:api-contract'],
    reason:'current-task-requirements-reconciled'};
  const view=agentActivitySnapshot({surface:'code',state:'complete',
    tasks:[{id:'plan',type:'plan',status:'complete',evidence:{multiAgent:{
      allocation:{recruitmentHistory:[event]},agentStates:[],
      waves:[]}}}]});
  assert.equal(view.lifecycleChanges.length,1);
  assert.deepEqual(view.lifecycleChanges[0].recruitedRoles,['code-ui-engineering-lead']);
  assert.equal(view.lifecycleChanges[0].retiredChildren,1);
  assert.equal(view.lifecycleChanges[0].status,'saved-advisory-selection');
  assert.deepEqual(view.active,[]);
});
