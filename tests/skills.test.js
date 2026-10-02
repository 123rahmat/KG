import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinSkillDescriptors, selectSkillDescriptors, loadSelectedSkills, composeSkillPlan } from '../src/skills.js';

test('skills are discoverable by task without granting authority', () => {
  const selected = selectSkillDescriptors('secure authentication refactor', { taskType: 'build-code', intent: 'coding', capabilities: ['code-execution'], limit: 6 });
  assert.ok(selected.some(item => item.name === 'coding'));
  assert.ok(selected.some(item => item.name === 'security-review'));
  assert.equal(selected.some(item => item.canAuthorize), false);
  assert.equal(builtinSkillDescriptors().length >= 9, true);
});

test('selected built-in skills load procedural instructions with bounded progressive disclosure', async () => {
  const selected = await loadSelectedSkills('debug login timeout', { taskType: 'build-code', limit: 2, maxInstructionChars: 64 });
  assert.ok(selected.length >= 1);
  assert.ok(selected.every(item => item.name && item.description));
  assert.ok(selected.every(item => item.progressiveDisclosure === true));
  assert.ok(selected.some(item => typeof item.instructions === 'string' && item.instructions.length > 0));
  assert.ok(selected.every(item => item.instructions.length <= 64));
  assert.ok(selected.every(item => item.fullInstructionsLoaded !== true));
});

test('skill composition preserves prerequisite closure', () => {
  const deployment = composeSkillPlan(
    builtinSkillDescriptors().filter(skill => skill.name === 'deployment'),
    { taskType: 'deliver', maxSkills: 8, maxCost: 12 }
  );
  assert.deepEqual(
    deployment.skills.map(skill => skill.name),
    ['testing', 'security-review', 'deployment']
  );
  for (const skill of deployment.skills) {
    for (const dependency of skill.contract.requiresSkills) {
      assert.ok(deployment.skills.some(item => item.name === dependency));
    }
  }
});
