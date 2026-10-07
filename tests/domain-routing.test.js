import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/core.js';
import { normalizeClassification } from '../src/classifier.js';
import { PEOPLE_DECISION } from '../src/situation-governance.js';

// Each domain, planned from the words alone (the fallback when the model
// cannot classify) and from a careful model reading: the flow, the size of
// the plan and the stages it must or must not have.
const s = (over = {}) => ({ research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false, ...over });
// [domain, goal, what a careful model reading returns, what the plan must be]
const CASES = [
  ['chat', 'hi', { actions: ['answer'], signals: s(), need: { form: 'conversation', depth: 'brief' } }, { workflow: 'direct' }],
  ['fact', 'What is the capital of Japan?', { actions: ['answer'], signals: s(), need: { form: 'fact', depth: 'brief' } }, { workflow: 'direct' }],
  ['explain', 'Explain how a transformer neural network works.', { actions: ['answer'], signals: s(), need: { form: 'explanation', depth: 'standard' } }, { workflow: 'direct' }],
  ['math', 'Solve 3x^2 - 12x + 9 = 0 and show the steps.', { actions: ['answer'], signals: s(), need: { form: 'steps', depth: 'standard' } }, { workflow: 'direct' }],
  ['writing', 'Write a polite email asking my landlord to fix the heater.', { actions: ['create'], signals: s({ creation: true }), need: { form: 'document', depth: 'brief' } }, { workflow: 'direct' }],
  ['translate', 'Translate "good morning, how are you" into Urdu.', { actions: ['transform'], signals: s(), need: { form: 'fact', depth: 'brief' } }, { workflow: 'direct' }],
  ['current', 'What is the gold price today?', { actions: ['investigate'], signals: s({ research: true, uncertainty: true }), need: { form: 'number', depth: 'brief' } }, { workflow: 'full', has: ['investigation-work'] }],
  ['research', 'Compare the latest studies on intermittent fasting for weight loss, with sources.', { actions: ['investigate'], signals: s({ research: true }), need: { form: 'comparison', depth: 'thorough' } }, { workflow: 'full', has: ['investigation-work'] }],
  ['paper', 'Write a research paper on perovskite solar cell stability with references.', { actions: ['investigate', 'create'], signals: s({ research: true, creation: true }), need: { form: 'document', depth: 'thorough' } }, { workflow: 'full', has: ['investigation-work'] }],
  ['code-small', 'Write a Python function to check if a number is prime, with tests.', { actions: ['create', 'execute'], signals: s({ code: true, creation: true }), need: { form: 'code', depth: 'standard' } }, { workflow: 'full', scale: 'small', has: ['build-code', 'test-code'] }],
  ['code-go', 'Write a Go program that reverses a string, with tests.', { actions: ['create', 'execute'], signals: s({ code: true, creation: true }), need: { form: 'code', depth: 'standard' } }, { workflow: 'full', scale: 'small', has: ['build-code', 'test-code'] }],
  ['code-review', 'Review this Python for security problems: query = "SELECT * FROM users WHERE id=" + user_id', { actions: ['answer'], signals: s({ code: true }), need: { form: 'explanation', depth: 'standard' } }, { notHas: ['test-code'] }],
  ['code-explain', 'What does the Python "yield" keyword do?', { actions: ['answer'], signals: s({ code: true }), need: { form: 'explanation', depth: 'brief' } }, { workflow: 'direct' }],
  ['code-debug', 'My Python script crashes with KeyError: \'name\' when the JSON has no name field. How do I fix it?', { actions: ['answer'], signals: s({ code: true }), need: { form: 'code', depth: 'brief' } }, {}],
  ['code-big', 'Build a Node REST API with login, a Postgres-like in-memory store, and tests for every route.', { actions: ['create', 'execute'], signals: s({ code: true, creation: true }), need: { form: 'code', depth: 'thorough' } }, { workflow: 'full', has: ['build-code', 'test-code'] }],
  ['sim', 'Simulate how long a 200 L water tank takes to heat from 15 to 60 °C with a 3 kW heater.', { actions: ['execute'], signals: s({ code: true, physical: true }), need: { form: 'code', depth: 'standard' } }, { workflow: 'full', has: ['build-code', 'test-code'] }],
  ['calc-physics', 'How many amps does a 2 kW kettle draw on 230 V?', { actions: ['answer'], signals: s({ physical: true }), need: { form: 'number', depth: 'brief' } }, {}],
  ['electrical', 'What cable size do I need for a 32 A circuit over 25 m in my house?', { actions: ['answer'], signals: s({ physical: true, highImpact: true }), need: { form: 'recommendation', depth: 'standard' } }, { workflow: 'full' }],
  ['medical', 'I have had a mild headache for two days, what can I do?', { actions: ['answer'], signals: s({ highImpact: true }), need: { form: 'recommendation', depth: 'brief' } }, {}],
  ['legal', 'My landlord kept my deposit. What are my options in Pakistan?', { actions: ['answer', 'investigate'], signals: s({ highImpact: true, research: true }), need: { form: 'recommendation', depth: 'standard' } }, { workflow: 'full' }],
  ['finance', 'Project 12 months of cash flow for a small bakery with 300,000 start-up cost.', { actions: ['model'], signals: s({ uncertainty: true }), need: { form: 'plan', depth: 'standard' } }, {}],
  ['data', 'Which product sold most in this sales file?', { actions: ['answer'], signals: s({ file: true }), need: { form: 'fact', depth: 'brief' } }, {}],
  ['schedule', 'Remind me every Monday at 9 am to send the report.', { actions: ['answer'], signals: s(), need: { form: 'plan', depth: 'brief' } }, { workflow: 'direct' }],
  ['plan-trip', 'Plan a 3-day trip to Istanbul on a small budget.', { actions: ['create'], signals: s({ creation: true }), need: { form: 'plan', depth: 'standard' } }, {}],
  ['invent', 'Invent a low-cost way for a small farm to detect water leaks in buried pipes.', { actions: ['invent'], signals: s({ invention: true, physical: true }), need: { form: 'design', depth: 'thorough' } }, { workflow: 'full' }],
  ['unknown', 'Set up a quantum-safe key exchange between two of our IoT sensors.', { actions: ['execute'], signals: s({ code: true, uncertainty: true }), unknownSituation: true, need: { form: 'plan', depth: 'thorough' } }, { workflow: 'full', scale: 'complex' }],
  ['tutor', 'I am in grade 8. Help me solve 3x + 5 = 20 but let me try the steps myself.', { actions: ['answer'], signals: s(), need: { form: 'steps', depth: 'standard' } }, { workflow: 'direct' }],
  ['crisis', "I don't want to live anymore", { actions: ['answer'], signals: s({ highImpact: true }), crisis: 'self-harm', need: { form: 'conversation', depth: 'brief' } }, { workflow: 'direct' }],
  ['design', 'Design a logo concept for a coffee shop called Bean There.', { actions: ['create'], signals: s({ creation: true }), need: { form: 'design', depth: 'standard' } }, {}],
  ['civil', 'Check if a 4 m steel I-beam can carry 10 kN in the middle.', { actions: ['answer'], signals: s({ physical: true, highImpact: true }), need: { form: 'yes-no', depth: 'standard' } }, { workflow: 'full' }]
];


for (const mode of ['keywords', 'model']) {
  test(`every domain gets the plan it needs (${mode})`, () => {
    const problems = [];
    for (const [domain, goal, hints, expect] of CASES) {
      const classifierHints = mode === 'model'
        ? normalizeClassification({ confidence: 0.9, unknownSituation: false, policy: { decision: 'allow' }, ...hints, need: { deliverable: goal, ...hints.need } })
        : null;
      const plan = planGoal(goal, { classifierHints, attachments: domain === 'data' ? [{ name: 'sales.csv' }] : [] });
      // A plan starts from understanding and grows its stages as the work
      // proceeds; what each stage needs is selected up front.
      const STAGE_CAPABILITY = { 'investigation-work': 'evidence-retrieval', 'build-code': 'code-generation', 'test-code': 'code-execution' };
      const selected = new Set(plan.capabilities?.required ?? []);
      const ids = Object.keys(STAGE_CAPABILITY).filter(stage => selected.has(STAGE_CAPABILITY[stage]));
      if (expect.workflow && plan.workflow !== expect.workflow) problems.push(`${domain}: flow ${plan.workflow}, expected ${expect.workflow}`);
      if (expect.scale && plan.adaptation?.scale !== expect.scale) problems.push(`${domain}: size ${plan.adaptation?.scale}, expected ${expect.scale}`);
      for (const id of expect.has ?? []) if (!ids.includes(id)) problems.push(`${domain}: missing ${id}`);
      for (const id of expect.notHas ?? []) if (ids.includes(id)) problems.push(`${domain}: should not have ${id}`);
    }
    assert.deepEqual(problems, []);
  });
}

test('a question about code is answered; code is written and run only when asked for', () => {
  const hints = (actions, form) => normalizeClassification({ actions, signals: s({ code: true }), unknownSituation: false, confidence: 0.9, need: { deliverable: 'x', form } });
  const uses = (plan, capability) => plan.capabilities.required.includes(capability);
  assert.ok(!uses(planGoal('What does the Python yield keyword do?', { classifierHints: hints(['answer'], 'explanation') }), 'code-generation'));
  assert.ok(uses(planGoal('Write a Python function that sorts a list, with tests.', { classifierHints: hints(['create', 'execute'], 'code') }), 'code-execution'));
});

test('a question about physical things is answered with care but needs no approval; acting on them does', () => {
  const physical = actions => normalizeClassification({ actions, signals: s({ physical: true }), unknownSituation: false, confidence: 0.9, need: { deliverable: 'x', form: 'number' } });
  const question = planGoal('How many amps does a 2 kW kettle draw on 230 V?', { classifierHints: physical(['answer']) });
  assert.equal(question.workflow, 'direct');
  const check = question.adaptation.verification;
  assert.equal(check.humanReviewRequired, false, 'an answer is checked against its evidence, not held for a person');
  const acting = planGoal('Wire a 2 kW heater to my panel.', { classifierHints: physical(['execute']) });
  assert.equal(acting.workflow, 'full');
  assert.ok(acting.execution.approvalReasons.length > 0);
  // Its verify step is created later, with this contract.
  assert.equal(acting.adaptation.verification.humanReviewRequired, true, 'acting in the world is certified by a person');
});

test('only real decisions about people must stay with a person', () => {
  for (const text of ['i am in grade 8. help me solve 3x + 5 = 20', 'my firefox keeps crashing', 'frankly, what are the benefits of exercise', 'which credit card has the lowest fee', 'score of the cricket match']) {
    assert.equal(PEOPLE_DECISION.test(text), false, text);
  }
  for (const text of ['rank these three job candidates and tell me whom to reject', 'should i hire alice or bob', 'help me grade these essays', 'decide the loan application for this customer', 'am i eligible for a student visa']) {
    assert.equal(PEOPLE_DECISION.test(text), true, text);
  }
});

test('building a whole system is never planned as a small task', () => {
  assert.equal(planGoal('Build a Node REST API with login, an in-memory store, and tests for every route.').adaptation.scale, 'standard');
  assert.equal(planGoal('Write a Python function to check if a number is prime, with tests.').adaptation.scale, 'small');
});

test('integrating or simplifying code builds it; simplifying maths answers it', () => {
  const builds = goal => planGoal(goal).capabilities.required.includes('code-generation');
  assert.ok(builds('Integrate Stripe checkout into my Express app.'));
  assert.ok(builds('Simplify this Python function so it is easier to read.'));
  assert.equal(planGoal('Simplify (x^2-1)/(x-1)').workflow, 'direct');
});

test('regulated work is recognised in its word forms, not inside other words', async () => {
  const { evaluateSituationGovernance } = await import('../src/situation-governance.js');
  const regulated = goal => evaluateSituationGovernance({ goal }).domains.regulated;
  for (const goal of ['is this illegal', 'is my income taxable', 'financially plan my year', 'clinically proven?', 'our patients need forms']) assert.equal(regulated(goal), true, goal);
  for (const goal of ['fix this syntax error', 'a legalese-free summary of my notes', 'ask the medic-bot']) assert.equal(regulated(goal), false, goal);
});
