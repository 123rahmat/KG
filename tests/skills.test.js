import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinSkillDescriptors, selectSkillDescriptors, loadSelectedSkills } from '../src/skills.js';
test('skills are discoverable by task without granting authority', () => {
  const selected = selectSkillDescriptors('secure authentication refactor', { taskType: 'build-code', intent: 'coding', capabilities: ['code-execution'], limit: 6 });
  assert.ok(selected.some(item => item.name === 'coding'));
  assert.ok(selected.some(item => item.name === 'security-review'));
  assert.equal(selected.some(item => item.canAuthorize), false);
  assert.equal(builtinSkillDescriptors().length >= 9, true);
});
test('selected built-in skills load procedural instructions', async () => {
  const selected = await loadSelectedSkills('debug login timeout', { taskType: 'build-code', limit: 2 });
  assert.ok(selected.length >= 1);
  assert.ok(selected.every(item => item.name && item.description));
});