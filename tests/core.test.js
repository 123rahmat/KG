import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT, buildTasks, capabilityCatalog, classifyIntent, decideAdvance,
  evaluatePolicy, planGoal, policyAllows, requiredCapabilities
} from '../src/core.js';

const ids = plan => plan.tasks.map(task => task.id);

/* ------------------------------------------------------------------ intent */

test('an ordinary question stays a lightweight chat workflow', () => {
  const plan = planGoal('Explain how a transformer works.');
  assert.equal(plan.contract, CONTRACT);
  assert.equal(plan.intent.kind, 'chat');
  // Nothing to execute, nothing risky: materialize only the response now.
  // Verification is created after the response if the current evidence says it is needed.
  assert.equal(plan.workflow, 'direct');
  assert.equal(plan.state, 'respond');
  assert.deepEqual(ids(plan), ['respond']);
  assert.equal(plan.tasks[0].metadata.verificationPending, true);
});

test('work, risk or novelty keeps the full workflow', () => {
  const coding = planGoal('Run this Python script.');
  assert.equal(coding.workflow, 'full');
  assert.deepEqual(ids(coding), ['understand']);

  const unfamiliar = planGoal('Explain an unfamiliar concept.');
  assert.equal(unfamiliar.workflow, 'full');
  assert.deepEqual(ids(unfamiliar), ['understand']);

  const governed = planGoal('Explain recursion.', {
    policies: { platform: { id: 'p', requireHumanApproval: true } }
  });
  assert.equal(governed.workflow, 'full');
  assert.deepEqual(ids(governed), ['understand']);
  assert.ok(governed.adaptation.governance);
});

test('simulation goals, in any word form, are code projects', () => {
  for (const goal of [
    'Simulate a robotic arm controller.',
    'Run a simulation of the circuit.',
    'I am simulating orbital dynamics.',
    'Build a numerical model of the beam.'
  ]) {
    assert.equal(classifyIntent(goal).kind, 'coding', goal);
  }
  const plan = planGoal('Simulate a damped oscillator and verify it.');
  assert.equal(plan.intent.kind, 'coding');
  assert.deepEqual(ids(plan), ['understand']);
});

test('coding goals select execution capabilities without prebuilding execution tasks', () => {
  const plan = planGoal('Build and test a Python API that validates uploaded data.');
  assert.equal(plan.intent.kind, 'coding');
  assert.equal(plan.surface, 'code');
  assert.ok(plan.capabilities.required.includes('code-execution'));
  assert.ok(plan.capabilities.required.includes('file-analysis'));
  assert.deepEqual(ids(plan), ['understand']);
});

test('open-world work starts from understanding and discovers later from evidence', () => {
  const plan = planGoal('Invent an unfamiliar device from scratch and test it.');
  assert.equal(plan.mode, 'creation');
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.adaptation.openWorld, true);
  assert.ok(plan.capabilities.required.includes('capability-discovery'));
});

test('compound work starts with one adaptive task and grows only after evidence', () => {
  const plan = planGoal('Build code and then simulate the result.');
  assert.equal(plan.workflow, 'full');
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.adaptation.openWorld, true);
  assert.equal(plan.adaptation.resourcePlan.mode, 'minimum-necessary');
});

test('invention is represented as an adaptive creation need, not a prebuilt prototype chain', () => {
  const plan = planGoal('Invent a new energy storage mechanism for an unfamiliar problem.');
  assert.equal(plan.intent.kind, 'invention');
  assert.equal(plan.mode, 'creation');
  assert.deepEqual(ids(plan), ['understand']);
  assert.ok(plan.capabilities.required.includes('capability-discovery'));
});

test('capability selection is deterministic and catalogue-ordered', () => {
  assert.deepEqual(requiredCapabilities('Explain this.'), ['reasoning', 'adaptive-safety-governance', 'situation-understanding', 'capability-compilation', 'planning', 'verification']);
  assert.deepEqual(requiredCapabilities('Explain this.'), requiredCapabilities('Explain this.'));
  assert.deepEqual(requiredCapabilities(''), []);
  assert.ok(capabilityCatalog().length >= 14);
});

test('an empty goal asks a question rather than planning', () => {
  const plan = planGoal('   ');
  assert.equal(plan.state, 'needs-input');
  assert.ok(plan.questions.length > 0);
  assert.deepEqual(classifyIntent(''), { kind: 'empty', confidence: 1, signals: [] });
});

/* ------------------------------------------------------------------ policy */

test('layered policy unions denials and takes the tightest budget', () => {
  const decision = evaluatePolicy({
    platform: { id: 'p' },
    organization: { id: 'o', deniedTools: ['external-web'], requireHumanApproval: true, maxTokens: 5000 },
    workspace: { id: 'w', maxTokens: 2000 }
  });
  assert.equal(decision.status, 'evaluated');
  assert.equal(decision.constraints.maxTokens, 2000);
  assert.equal(decision.constraints.requireHumanApproval, true);
  assert.equal(policyAllows(decision, { tool: 'external-web' }), false);
  assert.equal(policyAllows(decision, { tool: 'calculator' }), true);
});

test('a higher layer denial survives a lower layer allowance', () => {
  const decision = evaluatePolicy({
    platform: { id: 'p', deniedCapabilities: ['code-execution'] },
    organization: { id: 'o', allowedCapabilities: ['code-execution'] }
  });
  assert.equal(policyAllows(decision, { capability: 'code-execution' }), false);
});

test('multiple non-empty allow-lists intersect rather than union', () => {
  const decision = evaluatePolicy({
    platform: { id: 'p', allowedCapabilities: ['reasoning', 'planning'] },
    organization: { id: 'o', allowedCapabilities: ['reasoning'] },
    workspace: { id: 'w', allowedCapabilities: ['reasoning'] }
  });
  assert.deepEqual(decision.constraints.allowedCapabilities, ['reasoning']);
  assert.equal(policyAllows(decision, { capability: 'reasoning' }), true);
  assert.equal(policyAllows(decision, { capability: 'planning' }), false);
});

test('no policy means ungoverned, and the decision says so', () => {
  const decision = evaluatePolicy({});
  assert.equal(decision.status, 'unconfigured');
  assert.equal(policyAllows(decision, { capability: 'code-execution' }), true);
  assert.equal(planGoal('Write a Python script.').governance.status, 'unconfigured');
});

test('policy without its platform layer grants nothing', () => {
  // A half-configured control plane is a misconfiguration, not a permission.
  const decision = evaluatePolicy({ organization: { id: 'o' } });
  assert.equal(decision.status, 'incomplete');
  assert.deepEqual(decision.missingRequired, ['platform']);
  assert.equal(policyAllows(decision, { capability: 'reasoning' }), false);
});

test('policy is applied while planning, not audited afterwards', () => {
  const plan = planGoal('Write and run a Python script.', {
    policies: { platform: { id: 'p', deniedCapabilities: ['code-execution'] } }
  });
  assert.equal(plan.state, 'blocked');
  assert.deepEqual(plan.capabilities.blocked, ['code-execution']);
  assert.equal(plan.next, null);
});

test('approval requirements are recorded without precreating a future approval task', () => {
  const plan = planGoal('Write a Python script.', {
    policies: { platform: { id: 'p', requireHumanApproval: true } }
  });
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.execution.approvalRequired, true);
  assert.equal(plan.tasks.some(task => task.type === 'approval'), false);
});

test('decideAdvance refuses a task whose dependencies are open', () => {
  const tasks = [
    { id: 'first', type: 'step', status: 'pending', dependsOn: [] },
    { id: 'second', type: 'step', status: 'pending', dependsOn: ['first'] }
  ];
  const decision = decideAdvance(tasks, 'second');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'unmet-dependencies');
  assert.deepEqual(decision.unmet, ['first']);
});

test('non-direct workflows begin with exactly one server-owned adaptive root', () => {
  const plan = planGoal('Explain an unfamiliar concept.');
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.tasks[0].metadata.dynamicGraph, true);
  assert.equal(plan.tasks[0].metadata.oneStepAtATime, true);
});

test('decideAdvance completes the current node without inventing future nodes', () => {
  const tasks = buildTasks({ kind: 'chat' }, ['reasoning'], false);
  const decision = decideAdvance(tasks, 'understand');
  assert.equal(decision.ok, true);
  assert.equal(decision.next, null);
  assert.equal(decision.state, 'complete');
  assert.equal(decision.tasks[0].status, 'complete');
});

test('a failed task routes to iterate instead of onwards', () => {
  const tasks = buildTasks({ kind: 'chat' }, ['reasoning'], false);
  const decision = decideAdvance(tasks, 'understand', { status: 'failed' });
  assert.equal(decision.state, 'iterate');
  assert.equal(decision.next, null);
});

test('decideAdvance never mutates the graph it was given', () => {
  const tasks = buildTasks({ kind: 'chat' }, ['reasoning'], false);
  const before = JSON.stringify(tasks);
  decideAdvance(tasks, 'understand');
  assert.equal(JSON.stringify(tasks), before);
});

test('an unknown task is reported, not ignored', () => {
  const decision = decideAdvance(buildTasks({ kind: 'chat' }, ['reasoning'], false), 'nope');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'unknown-task');
});


test('unknown goals retain open-world capability discovery without a fixed future graph', () => {
  const plan = planGoal('Solve an unfamiliar problem that has never existed before and invent a new mechanism from scratch.');
  assert.equal(plan.mode, 'creation');
  assert.equal(plan.adaptation.openWorld, true);
  assert.deepEqual(ids(plan), ['understand']);
  assert.ok(plan.capabilities.required.includes('capability-discovery'));
});

test('risk policy can block a discovered high-risk requirement', () => {
  const plan = planGoal(
    'Invent an industrial safety-critical machine for an unfamiliar process.',
    { policies: { platform: { id: 'p', deniedRiskClasses: ['high'] } } }
  );
  assert.equal(plan.state, 'blocked');
  assert.ok(plan.capabilities.blocked.length > 0);
  assert.ok(plan.capabilities.blocked.includes('adaptive-execution'));
});


test('physical or high-impact workflows require human-certified verification', () => {
  const plan = planGoal('Design and test a safety-critical industrial robot.');
  // No verify step exists yet; the contract it will be created with does.
  const verification = plan.adaptation.verification;
  assert.equal(verification.humanReviewRequired, true);
  assert.equal(verification.minimumLevel, 'human-certified');
});


test('data-class policy allow-lists intersect and denials remain authoritative', () => {
  const decision = evaluatePolicy({
    platform: {
      id: 'platform',
      allowedDataClasses: ['user-content', 'workspace-content']
    },
    organization: {
      id: 'org',
      allowedDataClasses: ['user-content'],
      deniedDataClasses: ['workspace-secret']
    }
  });
  assert.deepEqual(decision.constraints.allowedDataClasses, ['user-content']);
  assert.equal(policyAllows(decision, { dataClass: 'user-content' }), true);
  assert.equal(policyAllows(decision, { dataClass: 'workspace-content' }), false);
  assert.equal(policyAllows(decision, { dataClass: 'workspace-secret' }), false);
});


test('building and simulating a model is one code project, without precreating execution stages', () => {
  const plan = planGoal('Build and test a new computational model, then simulate it.');
  assert.deepEqual(ids(plan), ['understand']);
  assert.ok(plan.capabilities.required.includes('code-generation'));
  assert.ok(plan.capabilities.required.includes('code-execution'));
  assert.ok(!plan.capabilities.required.some(id => /simulat/.test(id)), 'there is no simulation capability');
});

test('planning carries the whole user situation into adaptation', () => {
  const plan = planGoal('Continue and improve the current project.', {
    user: { id: 'u1', role: 'engineer' },
    workspace: { id: 'w1' },
    project: { id: 'p1' },
    files: ['design.md'],
    priorWork: ['prototype'],
    constraints: ['budget'],
    resources: ['simulator'],
    successCriteria: ['passes validation'],
    environment: 'staging',
    skillLevel: 'expert',
    currentState: 'prototype ready',
    completedSteps: ['requirements'],
    evidence: ['prototype report'],
    jurisdiction: 'PK'
  });
  assert.equal(plan.situation.project.id, 'p1');
  assert.equal(plan.situation.state.current, 'prototype ready');
  assert.equal(plan.situation.userProfile.skillLevel, 'expert');
  assert.equal(plan.situation.jurisdiction, 'PK');
  assert.equal(plan.adaptation.situation.project.id, 'p1');
  assert.equal(plan.adaptation.situation.state.current, 'prototype ready');
});

test('everyday goals route by what they ask, and health questions are high impact', () => {
  const route = goal => planGoal(goal);
  assert.equal(route('Which planet is largest?').workflow, 'direct', 'a question is answered directly');
  const debug = route('Debug my Python script that crashes on startup.');
  assert.equal(debug.intent.kind, 'coding');
  assert.deepEqual(ids(debug), ['understand']);
  assert.equal(route('Help me plan a wedding budget.').intent.kind, 'creation');
  const health = route('Is this mole on my arm dangerous?');
  assert.equal(health.workflow, 'full', 'health questions never take the direct path');
  assert.equal(health.adaptation.highImpactContext, true);
  assert.equal(health.tasks.find(task => task.id === 'understand').metadata.verification.humanReviewRequired, true);
});


test('material ambiguity is recorded as a requirement before a clarification task is created', () => {
  const plan = planGoal('Build the best production-ready system for my company.');
  assert.equal(plan.workflow, 'full');
  assert.equal(plan.clarification.required, true);
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.tasks.some(task => task.type === 'clarify'), false);
});

test('ordinary unknown exploration does not add needless clarification', () => {
  const plan = planGoal('Solve an unfamiliar problem and invent a new mechanism from scratch.');
  assert.equal(plan.clarification.required, false);
  assert.ok(!ids(plan).includes('clarify'));
});

test('continuation without current state records the missing material state without prebuilding clarification', () => {
  const plan = planGoal('Continue the current deployment.', { priorWork: ['deployment notes'] });
  assert.equal(plan.clarification.required, true);
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.tasks.some(task => task.type === 'clarify'), false);
});

test('evidence and files affect the adaptive scope without precreating their workflow stages', () => {
  const plan = planGoal('Research how solar panel output changes with temperature, then write Python code that models it for a 5 kW system.');
  assert.deepEqual(ids(plan), ['understand']);
  assert.equal(plan.adaptation.openWorld, true);
  assert.ok(plan.resourceScope);
  assert.ok(plan.capabilities.required.includes('evidence-retrieval'));
  assert.ok(plan.capabilities.required.includes('code-generation'));
});

test('an explicitly empty allow-list means nothing is permitted', () => {
  const decision = evaluatePolicy({
    platform: { id: 'platform', allowedCapabilities: [] }
  });
  assert.equal(decision.constraints.allowedCapabilitiesSpecified, true);
  assert.equal(decision.constraints.allowedCapabilities.length, 0);
  assert.equal(policyAllows(decision, { capability: 'reasoning' }), false);
});


test('a user-selected capability budget does not silently expand the working scope', () => {
  const plan = planGoal('Build and run a Python API with tests.', {
    adaptiveControl: { depth: 'brief', budget: { maxCapabilities: 6 } }
  });
  assert.notEqual(plan.state, 'blocked');
  assert.ok(plan.resourceScope);
  assert.equal(plan.resourceScope.control.userControlled, true);
  assert.equal(plan.scopeStatus, 'expansion-available');
  assert.ok(plan.resourceScope.omitted.capabilities.length > 0);
});

test('generated code is re-evaluated from the current situation instead of a prebuilt chain', () => {
  const plan = planGoal('Research current best practice, then build and run a Python script that analyses my sales data.');
  assert.notEqual(plan.adaptation.scale, 'small');
  assert.deepEqual(ids(plan), ['understand']);
  assert.ok(plan.capabilities.required.includes('code-generation'));
  assert.ok(plan.capabilities.required.includes('code-execution'));
});

test('a small, familiar coding task starts with only the necessary adaptive root', () => {
  const plan = planGoal('Build and run a Python script.');
  assert.equal(plan.adaptation.scale, 'small');
  assert.deepEqual(ids(plan), ['understand']);
  assert.ok(!ids(plan).includes('discover-capabilities'));
  assert.ok(!ids(plan).includes('test-code'));
  assert.equal(plan.resourceScope.mode, 'minimum-necessary');
});