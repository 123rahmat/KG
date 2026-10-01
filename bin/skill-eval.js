#!/usr/bin/env node
import { builtinSkillDescriptors, discoverSkills, evaluateSkillRegistry, composeSkillPlan } from '../src/skills.js';

try {
  const discovered = await discoverSkills();
  const names = new Set();
  const merged = [];
  for (const skill of [...builtinSkillDescriptors(), ...discovered]) {
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    merged.push(skill);
  }
  const registry = evaluateSkillRegistry(merged);
  const deploymentPlan = composeSkillPlan(builtinSkillDescriptors().filter(skill => skill.name === 'deployment'), {
    taskType: 'deliver',
    maxSkills: 8,
    maxCost: 12
  });
  const codingPlan = composeSkillPlan(builtinSkillDescriptors().filter(skill => skill.name === 'coding'), {
    taskType: 'build-code',
    maxSkills: 8,
    maxCost: 12
  });
  const plansValid = deploymentPlan.skills.map(skill => skill.name).join(',') === 'testing,security-review,deployment'
    && codingPlan.skills.map(skill => skill.name).join(',') === 'testing,coding';
  if (!plansValid) {
    throw new Error('skill composition evaluation failed');
  }
  if (!registry.valid) {
    console.error(JSON.stringify(registry, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      ok: true,
      skills: registry.skillCount,
      contractVersion: '1',
      intelligenceVersion: '1',
      evaluatedPlans: {
        deployment: deploymentPlan.skills.map(skill => skill.name),
        coding: codingPlan.skills.map(skill => skill.name)
      }
    }));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
