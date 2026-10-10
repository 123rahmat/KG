import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControlWorkflowPolicy, controlQualityRequirements
} from '../src/control-workflow-policy.js';
import { buildModeControllerContract } from '../src/mode-controllers.js';

const ids = policy => policy.candidateStages.map(stage => stage.id);

test('short coding questions are direct with no planning, agents or obligatory tests', () => {
  const p = buildControlWorkflowPolicy({ surface:'code', goal:'Explain how Python yield works' });
  assert.equal(p.controller,'coding');
  assert.equal(p.action,'answer');
  assert.deepEqual(ids(p), ['answer','deliver']);
  assert.equal(p.compute.modelEffort,'low');
  assert.equal(p.compute.optionalAgentCeiling,0);
  assert.equal(p.compute.mandatoryVerification,false);
});

test('small bug fix uses scoped implementation and authenticated checks, not gratuitous planning', () => {
  const p = buildControlWorkflowPolicy({ surface:'code', goal:'Fix a KeyError in my Python script' });
  assert.equal(p.action,'implement');
  assert.equal(p.understanding.needsPlan,false);
  assert.deepEqual(ids(p), ['inspect-revision','implement','test','review','verify','deliver']);
  assert.equal(p.compute.optionalAgentCeiling,1);
  assert.equal(p.quality.proposedAcceptanceOnly,true);
  assert.ok(p.quality.missingEvidence.includes('authenticated-test-receipt'));
});

test('large software platforms demand planning but do not build a duplicate runtime', () => {
  const p = buildControlWorkflowPolicy({
    surface:'code',
    goal:'Build a complete production Node API platform with auth, PostgreSQL and tests',
    complexity:.84, uncertainty:.62, observedIndependentWork:.8
  });
  assert.equal(p.understanding.needsPlan,true);
  assert.equal(p.action,'plan');
  assert.equal(p.compute.maxParallel,3);
  assert.equal(p.compute.modelEffort,'high');
  assert.deepEqual(p.candidateSpecialists.slice(0,2), ['architect','implementer']);
  assert.equal(p.safety.noSeparateRuntime,true);
  assert.equal(p.safety.authorizesMutations,false);
});

test('research paper covers sources claims methods writing and validation', () => {
  const p = buildControlWorkflowPolicy({
    surface:'research',
    goal:'Write a complete scientific research paper on a climate experiment with methodology and references',
    complexity:.78, uncertainty:.75, observedIndependentWork:.7
  });
  assert.equal(p.controller,'research');
  assert.equal(p.understanding.needsPlan,true);
  assert.ok(ids(p).includes('source-discovery'));
  assert.ok(ids(p).includes('claim-ledger'));
  assert.ok(ids(p).includes('methods'));
  assert.ok(ids(p).includes('manuscript'));
  assert.ok(ids(p).includes('verify'));
  assert.ok(p.quality.missingEvidence.includes('inspected-primary-or-credible-sources'));
  assert.equal(p.compute.maxParallel,3);
});

test('quantitative and chart research receives specific reproducibility requirements', () => {
  const p = buildControlWorkflowPolicy({
    surface:'research',goal:'Analyze quantitative experimental dataset using regression, show confidence intervals and figures'
  });
  assert.ok(ids(p).includes('quantitative-analysis'));
  assert.ok(ids(p).includes('figures'));
  assert.equal(p.quality.taskKind,undefined);
  assert.ok(p.quality.requirements.includes('reproducible-computation'));
});

test('small scholarly question does not get a compulsory brainstorm/plan/manuscript pipeline', () => {
  const p = buildControlWorkflowPolicy({ surface:'research',goal:'Explain the meaning of a hypothesis' });
  assert.deepEqual(ids(p),['answer','deliver']);
  assert.equal(p.compute.optionalAgentCeiling,0);
});

test('creative research planning brainstorms only when user needs alternatives', () => {
  const p = buildControlWorkflowPolicy({ surface:'research',
    goal:'Brainstorm alternative hypotheses for my research study' });
  assert.equal(p.action,'brainstorm');
  assert.equal(ids(p)[0],'alternatives');
});

test('scarce compute removes optional specialist calls, not essential verification', () => {
  const p = buildControlWorkflowPolicy({
    surface:'code',goal:'Fix and test my Python script',
    complexity:.95,uncertainty:.8,observedIndependentWork:1, remainingBudgetRatio:.15
  });
  assert.equal(p.compute.optionalAgentCeiling,0);
  assert.equal(p.compute.maxParallel,1);
  assert.equal(p.compute.mandatoryVerification,true);
  assert.ok(ids(p).includes('test'));
  assert.ok(ids(p).includes('verify'));
});
test('high-risk research gets critique when compute exists', () => {
  const p = buildControlWorkflowPolicy({
    surface:'research',goal:'Research current clinical trials and compare sources',
    risk:'high-impact',uncertainty:.75,observedIndependentWork:.85
  });
  assert.equal(p.compute.needIndependentCritique,true);
  assert.equal(p.compute.maxParallel,1,'high-risk jobs may be parallelizable only with explicit safeguards');
});

test('a failed attempt gets evidence-led repair, not endless speculative brainstorming', () => {
  const p = buildControlWorkflowPolicy({
    surface:'code',goal:'Fix my TypeScript runtime bug',
    failedAttempts:2,observedIndependentWork:.8,complexity:.6
  });
  assert.equal(p.action,'repair-from-evidence');
  assert.ok(p.candidateSpecialists.includes('debugger'));
  assert.equal(p.compute.modelEffort,'high');
});

test('accepted tasks use zero optional agents and cannot claim authorization', () => {
  const p = buildControlWorkflowPolicy({
    surface:'code',goal:'Build an API',acceptanceSatisfied:true, observedIndependentWork:1
  });
  assert.equal(p.action,'deliver');
  assert.equal(p.compute.optionalAgentCeiling,0);
  assert.equal(p.safety.canDeclareCompletion,false);
});

test('budget gate or human authorization cannot be bypassed by agent suggestions', () => {
  const req={surface:'code',goal:'Build an API',complexity:.8,observedIndependentWork:1};
  assert.equal(buildControlWorkflowPolicy({
    ...req,remainingBudgetRatio:.02
  }).action,'budget-gate');
  assert.equal(buildControlWorkflowPolicy({
    ...req,remainingBudgetRatio:.02,authorization:{required:true,approved:false}
  }).action,'approval-required');
});

test('full paper with figures and statistics requires all three evidence classes', () => {
  const p=buildControlWorkflowPolicy({
    surface:'research',
    goal:'Write a full research thesis with regression statistics, confidence intervals, experimental figures and bibliography'
  });
  for (const condition of [
    'reproducible-computation',
    'units-and-assumptions-checked',
    'data-provenance-and-axis-integrity',
    'complete-requested-sections',
    'citation-integrity',
    'method-limitations'
  ]) {
    assert.ok(p.quality.requirements.includes(condition), condition);
    assert.ok(p.quality.missingEvidence.includes(condition), condition);
  }
});
test('signed computational receipts alone cannot imply valid figure or manuscript', () => {
  const p=buildControlWorkflowPolicy({
    surface:'research',goal:'Write a full thesis with regression analysis and charts',
    runtimeEvidence:{
      computationReceiptAuthenticated:true,
      unitsAndAssumptionsVerified:true,
      requestedSectionsVerified:true
    }
  });
  assert.ok(!p.quality.missingEvidence.includes('reproducible-computation'));
  assert.ok(p.quality.missingEvidence.includes('data-provenance-and-axis-integrity'));
  assert.ok(p.quality.missingEvidence.includes('citation-integrity'));
});

test('test results and research links are not self-authenticating evidence', () => {
  let checks=controlQualityRequirements({
    surface:'code',taskKind:'implement',runtimeEvidence:{testsPassed:true}
  });
  assert.ok(checks.missingEvidence.includes('authenticated-test-receipt'));
  checks=controlQualityRequirements({
    surface:'research',taskKind:'manuscript',requiresEvidence:true,
    sourceEvidence:{inspectedSources:[{url:'https://example.org'}],
      materialClaims:[{sourceInspectionId:'unverified',supported:true}]}
  });
  assert.ok(checks.missingEvidence.includes('inspected-primary-or-credible-sources'));
  assert.equal(checks.receiptValidationOwner,'shared-server-runtime');
});

test('shared mode-controller actually projects domain workflow into saved run contract', () => {
  const code = buildModeControllerContract({
    surface:'code',situation:{goal:'Build a complete Python REST service',independentWork:.8},
    complexity:.8,uncertainty:.8
  });
  const research = buildModeControllerContract({
    surface:'research',situation:{goal:'Write a complete research paper with figures'}
  });
  assert.equal(code.workflowPolicy.controller,'coding');
  assert.equal(research.workflowPolicy.controller,'research');
  assert.equal(code.workflowPolicy.safety.actualTasksAreOwnedBy,'shared-RunStore');
  assert.equal(research.sharedRuntime.runStore,'shared-single-source-of-truth');
  assert.equal(buildModeControllerContract({surface:'normal-chat'}).workflowPolicy,undefined);
});

test('advisory Coding policy exposes user-defined acceptance gaps but never authorizes completion',()=>{
  const policy=buildControlWorkflowPolicy({surface:'code',
    goal:'Build an API and add retries, and run integration tests without deleting old routes',
    complexity:.65,remainingBudgetRatio:.6});
  assert.equal(policy.controller,'coding');
  assert.equal(policy.understanding.intent,'implement');
  assert.ok(policy.understanding.explicitUserCriteria.some(item=>/without deleting old routes/.test(item)));
  assert.equal(policy.action,'plan');
  assert.equal(policy.safety.canDeclareCompletion,false);
  assert.equal(policy.quality.proposedAcceptanceOnly,true);
  const vague=buildControlWorkflowPolicy({surface:'code',goal:'Make the best coding agent'});
  assert.equal(vague.understanding.intent,'implement');
  assert.equal(vague.understanding.qualityTargetUnspecified,true);
});
