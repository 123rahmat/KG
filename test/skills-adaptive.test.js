import test from 'node:test';
import assert from 'node:assert/strict';

import {
  builtinSkillDescriptors,
  selectSkillDescriptors,
  skillLearningAdjustment,
  skillContextSignature
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
