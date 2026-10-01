#!/usr/bin/env node
import { builtinSkillDescriptors, discoverSkills, evaluateSkillRegistry } from '../src/skills.js';

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
  if (!registry.valid) {
    console.error(JSON.stringify(registry, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, skills: registry.skillCount, contractVersion: '1', intelligenceVersion: '1' }));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
