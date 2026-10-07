/**
 * The situation matrix: how the planner responds to known work, unknown and
 * vague goals, high-stakes and crisis situations, the physical world, the
 * user's own situation, and governance. Each row states what a careful
 * person would expect, not what the code happens to do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';
import { mergeSituationEvidence } from '../src/situation.js';
import { normalizeClassification } from '../src/classifier.js';

// A plan starts from understanding and grows its stages as the work proceeds;
// what each stage needs, whether acting needs approval, and how the result is
// verified are decided up front. These read a plan in those terms.
const STAGE_CAPABILITY = {
  'investigation-work': 'evidence-retrieval', 'build-code': 'code-generation', 'test-code': 'code-execution',
  'artifact-work': 'file-analysis', 'discover-capabilities': 'capability-discovery'
};
const ids = plan => [
  ...plan.tasks.map(task => task.id),
  ...Object.keys(STAGE_CAPABILITY).filter(stage => plan.capabilities.required.includes(STAGE_CAPABILITY[stage])),
  ...(plan.execution?.approvalRequired ? ['approval'] : [])
];
const humanVerify = plan => (plan.tasks.find(task => task.id === 'verify')?.metadata?.verification ?? plan.adaptation?.verification)?.humanReviewRequired === true;

test('known work gets the workflow its kind needs', () => {
  const question = planGoal('What is the capital of France?');
  assert.equal(question.workflow, 'direct');
  assert.deepEqual(question.situation.questions, [], 'a plain question is not quizzed about environments');

  const coding = planGoal('Write a Python function to reverse a string and test it.');
  assert.equal(coding.intent.kind, 'coding');
  assert.ok(ids(coding).includes('test-code') && ids(coding).includes('approval'));

  const simulation = planGoal('Simulate a damped pendulum.');
  assert.ok(ids(simulation).includes('build-code') && ids(simulation).includes('test-code'), 'a simulation is a code project, run in the sandbox');

  const research = planGoal('Research the latest studies on intermittent fasting.');
  assert.ok(ids(research).includes('investigation-work') && ids(research).includes('approval'));

  const writing = planGoal('Draft an email to my landlord about a broken heater.');
  assert.equal(writing.intent.kind, 'creation');
  assert.equal(writing.execution.approvalRequired, false, 'writing a draft executes nothing');
});

test('attached files are worked on, never answered blind', () => {
  const plan = planGoal('Summarize this report.', { files: ['report.pdf'] });
  assert.equal(plan.workflow, 'full');
  assert.ok(plan.capabilities.required.includes('file-analysis'));
  assert.ok(ids(plan).includes('artifact-work'));
  assert.equal(plan.situation.presentation.mode, 'artifact-first');
});

test('unknown goals are discovered; goals too thin to act on are asked about', () => {
  for (const goal of ['Zyxora quentel navo.', 'My small shop is losing customers and I have no idea why.']) {
    const plan = planGoal(goal);
    assert.equal(plan.workflow, 'full', goal);
    // What the situation is and what it needs are found out: research and
    // capability discovery are in scope, and the steps grow from what they find.
    assert.ok(ids(plan).includes('discover-capabilities'), goal);
    assert.ok(ids(plan).includes('investigation-work'), goal);
    assert.equal(plan.adaptation.openWorld, true, goal);
  }
  const invention = planGoal('Invent a new way to store energy for my off-grid cabin.');
  assert.equal(invention.intent.kind, 'invention');
  assert.ok(ids(invention).includes('discover-capabilities'));
  assert.ok(invention.capabilities.required.includes('invention'));

  const thin = planGoal('Help.');
  assert.equal(thin.state, 'needs-input');
  assert.ok(thin.questions.length > 0);
});

test('medical, legal and financial stakes get research, approval, human review and jurisdiction', () => {
  for (const goal of [
    'What dose of ibuprofen can I give my child?',
    'Should I sign this contract?',
    'Wire 5000 dollars to this account.'
  ]) {
    const plan = planGoal(goal);
    assert.equal(plan.workflow, 'full', goal);
    assert.equal(plan.adaptation.highImpactContext, true, goal);
    assert.equal(plan.execution.approvalRequired, true, goal);
    assert.equal(humanVerify(plan), true, goal);
    assert.ok(plan.situation.unknowns.some(item => item.includes('jurisdiction')), goal);
  }
});

test('a person in crisis gets an immediate, caring answer, not a workflow', () => {
  for (const goal of ['I feel like hurting myself.', 'I want to end my life.', "I don't want to live anymore."]) {
    const plan = planGoal(goal);
    assert.equal(plan.workflow, 'direct', goal);
    assert.deepEqual(plan.tasks.map(task => task.id), ['respond'], goal);
    assert.equal(plan.execution.approvalRequired, false, goal);
    assert.equal(plan.situation.risk, 'crisis', goal);
    assert.deepEqual(plan.situation.questions, [], 'nobody in crisis is asked for success criteria');
    const respond = plan.tasks.find(task => task.id === 'respond');
    assert.equal(respond.metadata.crisis, true);
    assert.match(respond.purpose, /emergency services or a crisis line/);
  }
});

test('the model reads a crisis in any language and however it is phrased; it can raise one, never clear one', () => {
  const hints = crisis => ({
    actions: ['answer'],
    signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
    unknownSituation: false, confidence: 0.9, ...(crisis ? { crisis } : {})
  });
  for (const goal of ['میرے بچے کو تیز بخار ہے اور وہ جاگ نہیں رہا', 'My dog ate a bar of dark chocolate an hour ago', 'I took twenty paracetamol tablets']) {
    // The English keyword rules do not recognise these.
    assert.notEqual(planGoal(goal).situation.risk, 'crisis', goal);
    const plan = planGoal(goal, { classifierHints: hints('emergency') });
    assert.equal(plan.workflow, 'direct', goal);
    assert.deepEqual(plan.tasks.map(task => task.id), ['respond'], goal);
    assert.equal(plan.situation.crisisKind, 'emergency', goal);
    const respond = plan.tasks.find(task => task.id === 'respond');
    assert.match(respond.purpose, /emergency number[\s\S]*emergency vet[\s\S]*language the person wrote in/);
  }
  assert.equal(planGoal('Ya no quiero seguir viviendo', { classifierHints: hints('self-harm') }).situation.crisisKind, 'self-harm');
  // A crisis the model read stays when the situation is rebuilt after a step.
  const read = planGoal('My dog ate a bar of dark chocolate', { classifierHints: hints('emergency') }).situation;
  assert.equal(mergeSituationEvidence(read, { completedSteps: ['respond'] }).crisisKind, 'emergency');
  // The model cannot talk a crisis the rules found out of existence.
  assert.equal(planGoal('I want to end my life.', { classifierHints: hints(null) }).situation.risk, 'crisis');
});

test('the physical world gets approval and human certification', () => {
  const plan = planGoal('Program my robot arm to pick up boxes.');
  assert.equal(plan.adaptation.physicalContext, true);
  assert.ok(ids(plan).includes('approval'));
  assert.equal(humanVerify(plan), true);
});

test('the user’s own situation changes presentation, phase and criteria', () => {
  assert.equal(planGoal('Explain recursion.', { skillLevel: 'beginner' }).situation.presentation.mode, 'guided');
  assert.equal(planGoal('Explain recursion.', { skillLevel: 'expert' }).situation.presentation.mode, 'dense');
  assert.equal(planGoal('Summarise this report.', { files: [{ name: 'report.pdf' }] }).situation.presentation.mode, 'artifact-first', 'work on files leads with the files');

  const recovering = planGoal('Explain recursion.', { failedSteps: ['first explanation'], priorWork: ['draft'] });
  assert.equal(recovering.situation.phase, 'recovery');
  assert.equal(recovering.workflow, 'full', 'continuing after a failure is not a fresh question');

  const criteria = planGoal('Explain recursion.', { successCriteria: ['has an example'], constraints: ['under 100 words'] });
  assert.ok(criteria.situation.successCriteria.includes('has an example'));
  assert.ok(criteria.situation.constraints.includes('under 100 words'));

  const privateData = planGoal('Use my Google Drive files to prepare a summary.');
  assert.ok(privateData.situation.gaps.some(item => item.includes('google drive must be attached')));
  assert.ok(!privateData.situation.unknowns.some(item => item.includes('google')), 'no pretend connection is waited on');
});

test('governance is applied while planning', () => {
  const denied = planGoal('Write and run a Python script.', {
    policies: { platform: { id: 'p', deniedCapabilities: ['code-execution'] } }
  });
  assert.equal(denied.state, 'blocked');
  assert.deepEqual(denied.capabilities.blocked, ['code-execution']);

  const governed = planGoal('Explain recursion.', { policies: { platform: { id: 'p', requireHumanApproval: true } } });
  assert.equal(governed.workflow, 'full');
  assert.ok(ids(governed).includes('approval'));
});

test('a simulation is code: run where a code runner exists, handed over as code where none does', () => {
  const run = planGoal('Simulate a damped pendulum.', { executionAvailable: { code: true } });
  assert.ok(ids(run).includes('build-code') && ids(run).includes('test-code'));
  assert.ok(ids(run).includes('approval'));

  const noRunner = planGoal('Simulate a damped pendulum.', { executionAvailable: { code: false } });
  assert.ok(ids(noRunner).includes('build-code'));
  assert.ok(!ids(noRunner).includes('test-code'));
  assert.deepEqual(noRunner.adaptation.notAvailableHere, ['code-execution']);

  // Talking about a simulation is an answer, not code.
  const explain = planGoal('Explain what my simulation results mean: the average wait went from 4 to 9 minutes.');
  assert.ok(!ids(explain).includes('build-code'));

  // "…that I can run myself": code only, nothing executed here.
  const selfRun = planGoal('Write a Python simulation of a queue at a bank that I can run myself.');
  assert.ok(ids(selfRun).includes('build-code'));
  assert.ok(!ids(selfRun).includes('test-code'));
});

test('code is only tested where a code runner exists', () => {
  const withRunner = planGoal('Write a Python function to reverse a string and test it.', { executionAvailable: { code: true } });
  assert.ok(ids(withRunner).includes('test-code'));
  const without = planGoal('Write a Python function to reverse a string and test it.', { executionAvailable: { code: false } });
  assert.ok(!ids(without).includes('test-code'));
  assert.deepEqual(without.adaptation.notAvailableHere, ['code-execution']);
});

test('a medical or physical emergency gets an immediate answer that sends for help first', () => {
  for (const goal of ['I have chest pain and my left arm hurts', 'My son swallowed bleach', 'I can smell gas in the kitchen', 'my father is unconscious and not breathing']) {
    const plan = planGoal(goal);
    assert.equal(plan.situation.risk, 'crisis', goal);
    assert.equal(plan.situation.crisisKind, 'emergency', goal);
    assert.deepEqual(plan.tasks.map(task => task.id), ['respond'], goal);
    assert.match(plan.tasks[0].purpose, /emergency number/, goal);
  }
  assert.equal(planGoal('I want to end my life').situation.crisisKind, 'self-harm');
});

test('greetings, simple writing and reminders take the short path; real work does not', () => {
  for (const goal of ['hi', 'Thanks!', 'Assalam o alaikum', 'Write a cover letter for a junior engineer job', 'Translate this paragraph into Urdu: good morning', 'Remind me every Monday at 9 to check the tank']) {
    assert.equal(planGoal(goal).workflow, 'direct', goal);
  }
  assert.match(planGoal('Remind me every Monday at 9 to check the tank').tasks[0].purpose, /schedule\.create/);
  assert.equal(planGoal('Help.').state, 'needs-input');
  for (const goal of ['Write a Python script that renames photos by date', 'Design a new type of bicycle brake']) {
    assert.equal(planGoal(goal).workflow, 'full', goal);
  }
  assert.equal(planGoal('Write a summary of this report', { attachments: [{ id: 'a', name: 'r.pdf' }] }).workflow, 'full');
});

test('words are read in context: a rulebook "code", a landlord dispute, a letter about electrical work', () => {
  const afci = planGoal('What does the current US National Electrical Code require for AFCI protection in bedrooms?');
  assert.notEqual(afci.intent.kind, 'coding');
  assert.ok(!afci.tasks.some(task => task.type === 'code'));
  assert.equal(planGoal('Fix the bug in my code: TypeError x is undefined').intent.kind, 'coding');
  assert.equal(planGoal('My landlord kept my whole security deposit after I moved out. What can I do?').situation.risk, 'high-impact');
  assert.notEqual(planGoal('Draft an email to my landlord about a broken heater.').situation.risk, 'high-impact', 'an ordinary letter to a landlord is not a dispute');
  const letter = planGoal('Write a short cover letter for a junior electrical engineer job at a solar company.');
  assert.equal(letter.workflow, 'direct');
  assert.equal(planGoal('Write instructions for rewiring my house panel').workflow, 'full', 'instructions for physical work are not just writing');
});

test('a topic that needs care is not treated as high-impact because of the server\'s own care note', async () => {
  const { buildSituationModel } = await import('../src/situation.js');
  const { careNote, CARE_NOTES } = await import('../src/safety.js');
  // Everyday questions about health, money or the law, with the caution the server adds.
  for (const [goal, area] of [
    ['I feel stressed about my exams next week, what should I do?', 'health'],
    ['How do I sleep better?', 'health'],
    ['How can I save a little each month?', 'money']
  ]) {
    assert.ok(area in CARE_NOTES);
    const situation = buildSituationModel(goal, { constraints: [careNote(area)] });
    assert.equal(situation.risk, 'ordinary', goal);
    assert.deepEqual(situation.clarificationQuestions, [], `${goal}: no question about which country's rules apply`);
  }
  // What the person says still decides: real medical and legal questions stay high-impact.
  assert.equal(buildSituationModel('What dose of ibuprofen is safe for a child?', { constraints: [careNote('health')] }).risk, 'high-impact');
  assert.equal(buildSituationModel('My landlord kept my security deposit, can I sue?', { constraints: [careNote('legal')] }).risk, 'high-impact');
});

test('netlists, model scripts and CAD macros are code projects; questions about them are answered', () => {
  const required = goal => planGoal(goal).capabilities.required;
  for (const goal of [
    'Make an LTspice netlist for an RC low-pass filter with R = 1 kΩ and C = 100 nF, and tell me its cutoff frequency.',
    'Give me a MATLAB script that builds a Simulink model of a DC motor with speed control.',
    'Write a FreeCAD Python macro for an L-shaped mounting bracket, 50 × 50 × 5 mm, with two 6 mm holes.',
    'Write a Python script to parse an LTspice netlist and list the resistors.'
  ]) {
    assert.ok(required(goal).includes('code-generation'), goal);
    assert.ok(!required(goal).some(id => /simulat/.test(id)), goal);
  }
  assert.ok(!required('What is a Monte Carlo simulation?').includes('code-generation'));
});

test('an attached project or code file is code work, and fixing it needs the files, not the web', () => {
  const required = (goal, attachments = []) => planGoal(goal, { attachments }).capabilities.required;
  const zip = [{ name: 'inventory.zip', format: 'project' }];
  const fix = required('The tests in this project fail. Find the bugs, fix them, and run the tests.', zip);
  assert.ok(fix.includes('code-generation') && fix.includes('code-execution'));
  assert.ok(!fix.includes('evidence-retrieval'));
  assert.ok(required('Add type hints to this module.', [{ name: 'pricing.py', format: 'text' }]).includes('code-generation'));
  // Asking for research about it still researches.
  assert.ok(required('Compare this code with the latest published best practices, with sources.', zip).includes('evidence-retrieval'));
});

test('a model reading "find the bugs" as research does not send the person\'s own project to the web', () => {
  const hints = normalizeClassification({
    actions: ['investigate', 'transform', 'execute'],
    signals: { research: true, file: true, code: true, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
    unknownSituation: false, confidence: 0.9, need: { deliverable: 'the fixed project with passing tests', form: 'code' }
  });
  const plan = planGoal('The tests in this project fail. Find the bugs, fix them, and run the tests.', { classifierHints: hints, attachments: [{ name: 'inventory.zip', format: 'project' }] });
  assert.ok(plan.capabilities.required.includes('code-execution'));
  assert.ok(!plan.capabilities.required.includes('evidence-retrieval'));
});
