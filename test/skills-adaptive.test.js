import test from 'node:test';
import assert from 'node:assert/strict';

import {
  builtinSkillDescriptors,
  selectSkillDescriptors,
  skillLearningAdjustment,
  skillContextSignature,
  composeSkillPlan,
  evaluateSkillRegistry,
  validateSkillDescriptor,
  classifySkillFailure
} from '../src/skills.js';

test('learned skill evidence is conservative for one-shot observations', () => {
  const oneShot = {
    skillName: 'coding',
    taskType: 'build-code',
    successCount: 1,
    failureCount: 0,
    uncertainCount: 0,
    confidence: 1,
    utility: 1
  };
  const manyGood = {
    ...oneShot,
    successCount: 8
  };
  assert.ok(skillLearningAdjustment(oneShot) < skillLearningAdjustment(manyGood));
  assert.ok(skillLearningAdjustment(oneShot) > 0);
});

test('negative learned evidence reduces a skill selection without becoming a permission rule', () => {
  const learned = [{
    skillName: 'debugging',
    taskType: 'build-code',
    successCount: 1,
    failureCount: 6,
    uncertainCount: 0,
    confidence: 0.2,
    utility: -0.8
  }];
  const selected = selectSkillDescriptors('debug the failing code', {
    taskType: 'build-code',
    intent: 'coding',
    capabilities: ['code-generation'],
    learnedSkills: learned,
    limit: 6
  });
  assert.ok(selected.every(skill => builtinSkillDescriptors().some(item => item.name === skill.name)));
  const debugging = selected.find(skill => skill.name === 'debugging');
  assert.ok(debugging);
  assert.ok(debugging.learning.attempts === 7);
  assert.ok(debugging.learning.adaptive);
});

test('positive learned skill evidence is scoped by task type', () => {
  const learned = [{
    skillName: 'testing',
    taskType: 'verify-code',
    successCount: 9,
    failureCount: 1,
    uncertainCount: 0,
    confidence: 0.9,
    utility: 0.8
  }];
  const verify = selectSkillDescriptors('verify this code', {
    taskType: 'verify-code',
    intent: 'coding',
    capabilities: ['verification'],
    learnedSkills: learned,
    limit: 4
  });
  const build = selectSkillDescriptors('build this code', {
    taskType: 'build-code',
    intent: 'coding',
    capabilities: ['code-generation'],
    learnedSkills: learned,
    limit: 4
  });
  assert.equal(verify.find(skill => skill.name === 'testing')?.learning.attempts, 10);
  assert.equal(build.find(skill => skill.name === 'testing')?.learning.attempts ?? 0, 0);
});

test('structural context signatures generalize across wording changes', () => {
  const a = skillContextSignature({
    goal: 'Fix the authentication tests in my repository',
    taskType: 'build-code',
    intent: 'coding',
    coding: true,
    projectWork: true,
    complexity: 0.7,
    scale: 'complex',
    verification: true
  });
  const b = skillContextSignature({
    goal: 'Repair the login code and make its tests pass',
    taskType: 'build-code',
    intent: 'coding',
    coding: true,
    projectWork: true,
    complexity: 0.7,
    scale: 'complex',
    verification: true
  });
  assert.equal(a, b);
});

test('learned selection marks low-reliability experience as adaptive evidence', () => {
  const selected = selectSkillDescriptors('fix this code', {
    taskType: 'build-code',
    intent: 'coding',
    capabilities: ['code-generation'],
    learnedSkills: [{
      skillName: 'debugging',
      taskType: 'build-code',
      successCount: 1,
      failureCount: 5,
      uncertainCount: 0,
      confidence: 0.2,
      utility: -0.7
    }],
    limit: 4
  });
  const debugging = selected.find(item => item.name === 'debugging');
  assert.ok(debugging);
  assert.ok(debugging.learning.adaptive);
  assert.ok(debugging.learning.confidence < 0.5);
});

test('skill contracts validate and composition resolves dependencies in execution order', () => {
  const registry = evaluateSkillRegistry();
  assert.equal(registry.valid, true);
  const selected = builtinSkillDescriptors().filter(skill => skill.name === 'deployment');
  const plan = composeSkillPlan(selected, { taskType: 'deliver', maxSkills: 8, maxCost: 12 });
  assert.deepEqual(plan.skills.map(skill => skill.name), ['testing', 'security-review', 'deployment']);
  assert.ok(plan.skills.every(skill => skill.contract?.evidence?.length));
  assert.equal(plan.skipped.length, 0);
});

test('skill composition stays inside its cost budget', () => {
  const selected = builtinSkillDescriptors().filter(skill => skill.name === 'deployment');
  const plan = composeSkillPlan(selected, { taskType: 'deliver', maxSkills: 8, maxCost: 5 });
  assert.ok(plan.totalCost <= 5);
  assert.ok(plan.skipped.some(item => item.name === 'deployment'));
});

test('failure patterns are reduced to deterministic bounded categories', () => {
  assert.equal(classifySkillFailure('verification failed: unsupported evidence'), 'verification');
  assert.equal(classifySkillFailure('stale workspace revision conflict'), 'stale-state');
  assert.equal(classifySkillFailure('test assertion failed'), 'tests');
  assert.equal(classifySkillFailure('permission denied'), 'authorization');
});

test('custom skill descriptors use the same contract validation', () => {
  const custom = { name: 'example', description: 'A test skill', version: '1', taskTypes: ['respond'], requiresSkills: [], evidence: ['answer'], phases: ['execute'], costClass: 'light' };
  assert.equal(validateSkillDescriptor(custom, { registry: builtinSkillDescriptors().concat(custom) }).valid, true);
});

test('skill registry rejects dependency cycles instead of silently dropping prerequisites', () => {
  const a = { name: 'alpha', description: 'A', version: '1', taskTypes: ['demo'], requiresSkills: ['beta'], phases: ['execute'], evidence: ['a'], costClass: 'light' };
  const b = { name: 'beta', description: 'B', version: '1', taskTypes: ['demo'], requiresSkills: ['alpha'], phases: ['execute'], evidence: ['b'], costClass: 'light' };
  const result = evaluateSkillRegistry([a, b]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.startsWith('dependency-cycle:')));
});

test('skill composition never keeps a parent when a required dependency misses the budget', () => {
  const testing = builtinSkillDescriptors().find(skill => skill.name === 'testing');
  const security = builtinSkillDescriptors().find(skill => skill.name === 'security-review');
  const deployment = builtinSkillDescriptors().find(skill => skill.name === 'deployment');
  const plan = composeSkillPlan([deployment, security, testing], { taskType: 'deploy', maxSkills: 8, maxCost: 1 });
  assert.equal(plan.skills.length, 1);
  assert.equal(plan.skills[0].name, 'testing');
  assert.ok(plan.skipped.some(item => item.name === 'security-review'));
  assert.ok(plan.skipped.some(item => item.name === 'deployment' && item.reason === 'required-dependency-unavailable'));
});

test('unified recovery remains bounded and records a machine-readable lesson', async () => {
  const { classifyRecoveryFailure, decideRecovery, recoveryLesson } = await import('../src/adaptive-runtime-state.js');
  assert.equal(classifyRecoveryFailure('provider timeout'), 'timeout');
  const decision = decideRecovery({ taskType: 'code', reason: 'test assertion failed', attempt: 1, maxAttempts: 3, repairAvailable: true });
  assert.equal(decision.action, 'repair');
  assert.deepEqual(recoveryLesson(decision, { taskId: 'test-code', summary: 'one regression failed' }), {
    version: 1,
    taskId: 'test-code',
    action: 'repair',
    failureClass: 'tests',
    reason: 'targeted-code-repair-available',
    summary: 'one regression failed'
  });
  assert.equal(decideRecovery({ reason: 'security finding', attempt: 1, maxAttempts: 3 }).action, 'escalate');
  assert.equal(decideRecovery({ reason: 'anything', attempt: 3, maxAttempts: 3 }).action, 'stop');
});

test('evaluation summary exposes quality and efficiency metrics', async () => {
  const { summarizeEval, compareEvalReports, regressionGate } = await import('../src/evals.js');
  const baseline = { results: [
    { id: 'a', pass: true, elapsedMs: 100, tokens: 100, tags: ['code'] },
    { id: 'b', pass: true, elapsedMs: 200, tokens: 200, tags: ['research'] }
  ] };
  const candidate = { results: [
    { id: 'a', pass: true, elapsedMs: 120, tokens: 110, tags: ['code'] },
    { id: 'b', pass: false, elapsedMs: 250, tokens: 240, tags: ['research'] }
  ] };
  const summary = summarizeEval(candidate);
  assert.equal(summary.failed, 1);
  assert.equal(summary.total, 2);
  const comparison = compareEvalReports(candidate, baseline);
  assert.equal(comparison.passRateDelta, -0.5);
  assert.ok(comparison.averageTokensDelta > 0);
  const gate = regressionGate({
    ...candidate,
    baselinePassRate: 1,
    baselineAverageTokens: summarizeEval(baseline).averageTokens
  }, { minPassRate: 0.5, maxFailed: 1, maxPassRateDrop: 0.4 });
  assert.equal(gate.pass, false);
});


test('project change-risk signals widen verification for broad-impact changes', async () => {
  const { buildProjectIndex, changeRiskSignals } = await import('../src/project-index.js');
  const files = [
    { path: 'src/core.js', content: 'import { helper } from "./helper.js"; export function core(){ return helper(); }' },
    { path: 'src/helper.js', content: 'export function helper(){ return 1; }' },
    { path: 'src/a.js', content: 'import { helper } from "./helper.js";' },
    { path: 'src/b.js', content: 'import { helper } from "./helper.js";' },
    { path: 'src/c.js', content: 'import { helper } from "./helper.js";' },
    { path: 'src/d.js', content: 'import { helper } from "./helper.js";' },
    { path: 'test/helper.test.js', content: 'test("helper", () => assert.equal(1, 1));' }
  ];
  const index = buildProjectIndex(files, { revisionId: 'test-revision' });
  const signals = changeRiskSignals(index, ['src/helper.js']);
  assert.equal(signals.changedFiles, 1);
  assert.ok(signals.impactedFiles >= 5);
  assert.ok(signals.relatedTests >= 1);
  assert.equal(signals.verificationScope, 'broad');
  assert.ok(signals.highFanInChangedFiles.includes('src/helper.js'));
});
