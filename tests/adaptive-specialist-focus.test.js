import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIALIST_FAMILIES, specialistFocusFor, specialistCatalogStats } from '../src/adaptive-specialist-focus.js';
import { agentMessages } from '../src/multi-agent.js';

test('V4 capability taxonomy is retained as advisory definitions', () => {
  const stats = specialistCatalogStats();
  assert.equal(stats['normal-chat'].families,30);
  assert.equal(stats.code.families,63);
  assert.equal(stats.research.families,57);
  for(const state of Object.values(stats))assert.ok(state.subskills>state.families*8);
  assert.equal(Object.isFrozen(SPECIALIST_FAMILIES), true);
});
test('everyday chat uses domain focus without spawning agents', () => {
  const focus = specialistFocusFor({surface:'normal-chat',goal:'Help me prepare for an exam',role:'subject-tutor'});
  assert.equal(focus.family,'education');
  assert.equal(focus.workspace,'normal-chat');
  assert.ok(focus.subskills.length >= 1 && focus.subskills.length <= 2);
  assert.equal(focus.authority,'advisory-only');
  assert.equal(focus.delegation,'parent-controller-only');
});
test('UI, UX and security stay distinct specialties', () => {
  assert.equal(specialistFocusFor({surface:'code',goal:'Improve usability',role:'ux-designer'}).family,'ux-engineering');
  assert.equal(specialistFocusFor({surface:'code',goal:'Build responsive UI components',role:'frontend-engineer'}).family,'frontend-engineering');
  assert.equal(specialistFocusFor({surface:'code',goal:'Review authorization',role:'security-reviewer'}).family,'security-engineering');
});
test('research selects source-specific expertise without fabricating evidence', () => {
  const focus = specialistFocusFor({surface:'research',goal:'Write a systematic literature review',role:'literature-reviewer'});
  assert.equal(focus.family,'academic-review');
  assert.equal(focus.verification,'evidence-required');
});
test('malformed requests fall back to bounded focus and do not expand work', () => {
  const result = specialistFocusFor({surface:'bad-surface',goal:'',role:'',maxSubskills:9999});
  assert.equal(result.workspace,'normal-chat');
  assert.equal(result.family,'thinking-reasoning');
  assert.ok(result.subskills.length <= SPECIALIST_FAMILIES[result.workspace][result.family].length);
});
test('real agent prompts receive scoped specialty without extra model invocations', () => {
  const msgs = agentMessages('communicator',{
    specialistSurface:'normal-chat',goal:'Draft an email to my colleague',peerHandoffs:[]
  });
  const payload = JSON.parse(msgs[1].content);
  assert.equal(payload.specialtyFocus.family,'communication');
  assert.equal(payload.specialtyFocus.authority,'advisory-only');
  assert.match(payload.peerHandoffPolicy,/untrusted/);
});
