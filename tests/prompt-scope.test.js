import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptationFor, compactGovernance, compactImplementationPlan, compact } from '../src/prompt-scope.js';
import { systemPromptFor, SYSTEM_PROMPT, PROMPT_RULES } from '../src/reasoning-context.js';
import { planGoal } from '../src/core.js';

const runFrom = (goal, extra = {}) => {
  const plan = planGoal(goal);
  return { goal, workflow: plan.workflow, adaptation: plan.adaptation, situation: plan.situation, capabilities: plan.capabilities, tasks: plan.tasks, ...extra };
};

test('a step is sent only the planning records it acts on', () => {
  const run = runFrom('Research the latest evidence about an unfamiliar topic.');
  const answering = adaptationFor(run, { type: 'investigate' });
  assert.equal('implementationPlan' in answering, false, 'an answer does not carry the implementation plan');
  assert.equal('goalModel' in answering, false);
  assert.ok(answering.governance.status);
  assert.ok(answering.resourcePlan.selected.capabilities.length, 'a full workflow keeps its working scope');
  assert.deepEqual(answering.resourcePlan.selected.tools, ['web.search', 'web.fetch', 'web.download'], 'an evidence step sees only research tools');
  const discovery = adaptationFor(run, { type: 'discover-capabilities' });
  assert.ok(discovery.implementationPlan.available.length, 'discovery sees what can run');
  assert.equal('implementations' in discovery.implementationPlan, false, 'but not every full specification');
  // A direct chat has no working scope to respect.
  const chat = runFrom('What is the capital of France?');
  assert.equal('resourcePlan' in adaptationFor(chat, { type: 'respond' }), false);
});

test('compact forms keep what the rules refer to and drop the rest', () => {
  const governance = compactGovernance({ status: 'care', restrictions: ['a'], reasons: [], jurisdiction: { reviewRequired: true, detail: 'x' }, ethics: { finalHumanDecisionRequired: true, noModelAuthority: false }, policy: { big: 'x'.repeat(500) } });
  assert.deepEqual(governance, { status: 'care', restrictions: ['a'], jurisdiction: { reviewRequired: true }, ethics: { finalHumanDecisionRequired: true } });
  assert.deepEqual(compactImplementationPlan({ state: 'ready', implementations: [{ capabilityId: 'reasoning', executable: true }, { capabilityId: 'code', executable: false }], missing: ['code'], blocked: [] }), { state: 'ready', available: ['reasoning'], missing: ['code'] });
  assert.deepEqual(compact({ a: [], b: {}, c: '', d: null, e: 0, f: 'x' }), { e: 0, f: 'x' });
});

test('each step is sent only the rules that apply to it', () => {
  const greeting = systemPromptFor({ task: { type: 'respond', id: 'respond' }, run: { workflow: 'direct', situation: {} }, payload: {} });
  const verify = systemPromptFor({ task: { type: 'verify' }, run: { workflow: 'direct' }, payload: {} });
  assert.ok(greeting.length < SYSTEM_PROMPT.length / 2, 'a greeting carries well under half the rules');
  assert.doesNotMatch(greeting, /task\.method is "invention"|codeRepair|For discover-capabilities tasks|For verify tasks/);
  assert.match(greeting, /Exact need/);
  assert.match(verify, /For verify tasks/);
  assert.doesNotMatch(verify, /For build-code tasks/);
  // Rules about data the request does not carry are left out; they come back when it does.
  assert.doesNotMatch(greeting, /When attachments are present/);
  assert.match(systemPromptFor({ task: { type: 'respond' }, run: {}, payload: { attachments: [{ name: 'a.txt' }] } }), /When attachments are present/);
  assert.match(systemPromptFor({ task: { type: 'respond' }, run: { situation: { risk: 'crisis' } }, payload: {} }), /situation\.risk is "crisis"/);
  assert.match(systemPromptFor({ task: { type: 'prototype', method: 'invention' }, run: {}, payload: {} }), /invent like an engineer/);
  // Code that could not be run is said so only when it happened.
  assert.doesNotMatch(greeting, /adaptation\.codeNotRun/);
  assert.match(systemPromptFor({ task: { type: 'deliver' }, run: {}, payload: { adaptation: { codeNotRun: { language: 'go' } } } }), /never imply it was tested/);
  // Every rule still reaches the steps it is for: none is dropped for everyone.
  const all = ['respond', 'verify', 'understand', 'discover-capabilities', 'plan', 'step', 'reassess', 'prototype', 'code']
    .map(type => systemPromptFor({ task: { type, id: type === 'code' ? 'build-code' : type, method: 'invention' }, run: { workflow: 'full', situation: { risk: 'crisis', ethics: {} }, adaptation: { notAvailableHere: ['simulation'], codeNotRun: { language: 'go', reason: 'Not run: Go is not turned on' } } }, payload: { adaptation: { codeNotRun: { language: 'go' } }, attachments: [1], conversation: [1], previousAttempts: [1], remembered: [1], codeRepair: {} } })).join(' ');
  const researchAnswer = systemPromptFor({task:{type:'deliver'},run:{surface:'research',workflow:'full'},payload:{}});
  const buildPlan = systemPromptFor({ task: { type: 'plan', buildPlan: true }, run: {}, payload: {} });
  assert.doesNotMatch(buildPlan, /at most ONE first useful work step/, 'a build plan is not a workflow plan');
  for (const [when, rule] of PROMPT_RULES) assert.ok(`${all} ${researchAnswer} ${buildPlan}`.includes(rule), `rule "${when}" reaches no step: ${rule.slice(0, 60)}`);
});

test('answers the person reads are result first with main points; working steps stay brief', () => {
  for (const type of ['respond', 'deliver', 'prototype']) {
    const rules = systemPromptFor({ task: { type }, run: {}, payload: {} });
    assert.match(rules, /the result first/, type);
    assert.match(rules, /never generic labels such as "Key assumption"/, type);
    assert.match(rules, /never a bare value unless only the value was asked for/, type);
    assert.match(rules, /definition together with its defining equation/, type);
    assert.match(rules, /in any field, answer in this shape: the definition first/, type);
    assert.match(rules, /set the length or shape \(two sentences[^)]*\), give exactly that and nothing more/, type);
    assert.doesNotMatch(rules, /read by the server and the next steps/, type);
  }
  for (const type of ['understand', 'plan', 'reassess', 'step', 'investigate']) {
    const rules = systemPromptFor({ task: { type }, run: {}, payload: {} });
    assert.match(rules, /read by the server and the next steps, not by the person/, type);
    assert.doesNotMatch(rules, /Shape of the answer the person reads/, type);
  }
  assert.match(systemPromptFor({ task: { type: 'verify' }, run: {}, payload: {} }), /one short sentence/);
});

test('understanding asks only what the person must decide, and picks sensible defaults itself', () => {
  const rules = systemPromptFor({ task: { type: 'understand' }, run: { workflow: 'full' }, payload: {} });
  assert.match(rules, /List in "questions" only what the person must decide/);
  assert.match(rules, /a method, a numerical tolerance, a format or a library is yours to choose/);
});

test('the final answer keeps a "not checked against current sources" caveat from earlier steps', () => {
  assert.match(systemPromptFor({ task: { type: 'deliver' }, run: {} }), /could not be checked against current sources/);
  assert.doesNotMatch(systemPromptFor({ task: { type: 'understand' }, run: {} }), /could not be checked against current sources/);
});

test('Research output guidance favors concise public points with evidence instead of verbose internal reasoning',()=>{
  const brief=systemPromptFor({task:{type:'deliver'},run:{surface:'research',workflow:'full',situation:{}},payload:{}});
  const code=systemPromptFor({task:{type:'deliver'},run:{surface:'code',workflow:'full',situation:{}},payload:{}});
  assert.match(brief,/Research answer economy/);
  assert.match(brief,/evidence-backed bullet points/);
  assert.match(brief,/internal chain of thought/);
  assert.doesNotMatch(code,/Research answer economy/);
  assert.match(code,/public reasoning points/);
  const verify=systemPromptFor({task:{type:'verify'},run:{surface:'research',workflow:'full',situation:{}},payload:{}});
  assert.doesNotMatch(verify,/Research answer economy/);
});
