import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileGoalModel,
  discoverCapabilityRequirements,
  inspectGoal,
  resolveAdaptiveContext
} from '../src/adaptive.js';
import { planGoal } from '../src/core.js';

test('unfamiliar language or domain text enters unresolved open-world adaptation', () => {
  const goal = 'Zyxora quentel navo 7 delta — make this useful in whatever way is actually required.';
  const model = compileGoalModel(goal);
  assert.equal(model.openWorld, true);
  assert.equal(model.unknownSituation, true);
  assert.equal(model.resolution, 'unresolved-domain');

  const analysis = inspectGoal(goal);
  assert.equal(analysis.unknownSituation, true);
  assert.ok(analysis.goalModel);
  const requirements = discoverCapabilityRequirements(goal, analysis).map(item => item.id);
  assert.ok(requirements.includes('situation-understanding'));
  assert.ok(requirements.includes('capability-discovery'));
  assert.ok(requirements.includes('adaptive-execution'));
});

test('a normal explanatory request still avoids unnecessary discovery', () => {
  const model = compileGoalModel('Explain how a transformer works.');
  assert.equal(model.unknownSituation, false);
  assert.equal(model.actions.includes('answer'), true);
  assert.equal(model.openWorld, true);
  assert.equal(resolveAdaptiveContext('Explain how a transformer works.').primarySurface, 'chat');
  assert.deepEqual(discoverCapabilityRequirements('Explain how a transformer works.').map(item => item.id), [
    'reasoning', 'adaptive-safety-governance', 'situation-understanding', 'capability-compilation', 'planning', 'verification'
  ]);
});

test('compound goals receive adaptive composition', () => {
  const plan = planGoal('Research the problem, design a solution, build a prototype and test it.');
  assert.equal(plan.adaptation.compound, true);
  assert.ok(plan.capabilities.required.includes('adaptive-composition'));
  assert.ok(plan.adaptation.surfaceDescriptors.length >= 2);
  assert.ok(plan.adaptation.surfaceDescriptors.every(surface => ['chat', 'code', 'research'].includes(surface.id)));
});

test('novel invention stays governed while preserving an invention loop', () => {
  const plan = planGoal('Invent a new mechanism for an unfamiliar industrial process.');
  assert.equal(plan.intent.kind, 'invention');
  assert.ok(plan.capabilities.required.includes('invention'));
  assert.ok(plan.capabilities.required.includes('capability-discovery'));
  assert.equal(plan.adaptation.openWorld, true);
  assert.equal(plan.adaptation.goalModel.unknownSituation, true);
});


test('adaptive compilation keeps high-impact discovery capable of adding an approval gate', () => {
  const plan = planGoal('Help with an unfamiliar task.');
  // The plan starts from understanding alone; discovery is the planned stage
  // the run adds next, where a high-impact finding can add an approval gate.
  assert.deepEqual(plan.tasks.map(task => task.id), ['understand']);
  assert.ok(plan.capabilities.granted.includes('capability-discovery'));
  assert.ok(plan.tasks[0].metadata.candidateCapabilities.includes('capability-discovery'));
  assert.equal(plan.adaptation.openWorld, true);
});

test('a website to build is code work, not a request to search the web', () => {
  const plan = planGoal('Build a website for my restaurant with a menu, opening hours and a reservation form, in a single HTML file.');
  assert.ok(plan.capabilities.granted.includes('code-generation'));
  assert.ok(!plan.capabilities.granted.includes('external-data-routing'));
  assert.ok(!plan.capabilities.granted.includes('evidence-retrieval'));
  // Searching the web is still understood when asked for.
  assert.ok(planGoal('Search the web for the latest copper price.').capabilities.granted.includes('evidence-retrieval'));
});

test('everyday chat is answered directly, work follow-ups still get the full workflow', () => {
  // A scientific law is not a legal matter; a machine that runs is not code to run.
  assert.equal(planGoal('What is Ohm\'s law? Two sentences.').workflow, 'direct');
  assert.equal(planGoal('Explain the law of gravity simply').workflow, 'direct');
  assert.equal(planGoal('My 1.5 ton inverter AC runs 8 hours a day in Lahore. Roughly how many units per month?').workflow, 'direct');
  assert.equal(planGoal('My landlord broke the law by keeping my deposit').workflow, 'full');
  assert.equal(planGoal('Run this Python script and tell me the output').workflow, 'full');
  // In an ongoing chat, writing and translation are still answered directly.
  const chat = { priorWork: ['Built a circuit example'], currentState: { runId: 'earlier', completed: ['Built a circuit example'] } };
  assert.equal(planGoal('Translate into Urdu: "The meeting is moved to Monday morning."', chat).workflow, 'direct');
  assert.equal(planGoal('Write a short thank-you note to my teacher', chat).workflow, 'direct');
  assert.equal(planGoal('Now fix the bug in that function', chat).workflow, 'full');
});

test('a message of a word or two is judged on its words, not on a vague model reading', () => {
  const vague = { actions: ['answer'], signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false }, unknownSituation: false, confidence: 0.5 };
  assert.equal(planGoal('Help.', { classifierHints: vague }).state, 'needs-input');
  assert.notEqual(planGoal('Explain recursion', { classifierHints: { ...vague, confidence: 0.9 } }).state, 'needs-input');
  assert.notEqual(planGoal('hi', { classifierHints: vague }).state, 'needs-input');
});
