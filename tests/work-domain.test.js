import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorkDomain } from '../src/work-domain.js';

test('purpose, not a Research workspace label, determines scope', () => {
  assert.equal(assessWorkDomain({ request: 'Plan my holiday itinerary',
    projectContext: { engineId: 'research' } }).status, 'out-of-scope');
  assert.equal(assessWorkDomain({ request: 'Build a holiday itinerary API' }).domain, 'coding');
  assert.equal(assessWorkDomain({ request: 'Design a qualitative thesis study of migration interviews' }).domain, 'research');
});
test('academic and software deliverables stay admitted regardless of subject', () => {
  for (const goal of ['Write a research paper on drought resilience with methods',
    'Edit my scholarly manuscript discussion', 'Help me develop my thsis chapter',
    'Compare the literature review for ethnographic fieldwork',
    'Derive equations for a study of turbulence']) {
    const result = assessWorkDomain({ request: goal });
    assert.equal(result.status, 'in-scope', goal);
    assert.equal(result.domain, 'research', goal);
  }
  for (const goal of ['Debug my TypeScript code', 'Explain Python yield', 'Review a React UI',
    'Build a tourism booking app', 'Fix the repository tests']) {
    assert.equal(assessWorkDomain({ request: goal }).domain, 'coding', goal);
  }
});
test('mixed everyday request is separated and cannot grant permissions', () => {
  const assessment = assessWorkDomain({
    request: 'Fix my Python script and remind me to buy groceries tomorrow'
  });
  assert.equal(assessment.status, 'mixed');
  assert.equal(assessment.domain, 'coding');
  assert.equal(assessment.supportedRequest, 'Fix my Python script');
  assert.match(assessment.unsupportedSummary, /remind me/i);
});
test('continuations require admitted conversation state, not a UI mode label', () => {
  assert.equal(assessWorkDomain({
    request: 'Plan this', projectContext: { engineId: 'coding' }
  }).status, 'needs-clarification');
  assert.equal(assessWorkDomain({
    request: 'Plan this',
    conversation: [{ scopeDecision: { status: 'in-scope', domain: 'coding' } }]
  }).domain, 'coding');
  assert.equal(assessWorkDomain({
    request: 'Plan my holiday itinerary',
    conversation: [{ scopeDecision: { status: 'in-scope', domain: 'research' } }]
  }).status, 'out-of-scope');
});
test('untrusted model output cannot launder unrelated work into Research', () => {
  const decision = assessWorkDomain({
    request: 'Tell me the match score',
    modelAssessment: { status: 'in-scope', domain: 'research' },
    projectContext: { verifiedDomain: 'research', lastInScope: true }
  });
  assert.equal(decision.status, 'out-of-scope');
});
test('greetings respond without starting agentic work', () => {
  const answer = assessWorkDomain({ request: 'Hello' });
  assert.equal(answer.status, 'needs-clarification');
  assert.match(answer.reply, /coding project or research paper/i);
});

test('academic deliverables win over incidental software vocabulary', () => {
  assert.equal(assessWorkDomain({
    request: 'Write a research paper on software testing methods'
  }).domain, 'research');
  assert.equal(assessWorkDomain({
    request: 'Write a Python script for my thesis experiment'
  }).domain, 'coding', 'the requested artifact is a script, not a thesis');
  assert.equal(assessWorkDomain({
    request: 'Build a laboratory software application for my research project'
  }).domain, 'coding');
});
test('generic household repairs do not recruit a coding engine', () => {
  assert.notEqual(assessWorkDomain({request: 'Fix my washing machine'}).domain, 'coding');
});

test('misspelled domain work remains in scope with original spelling retained', () => {
  const a=assessWorkDomain({request:'Help with codong in Python'});
  assert.equal(a.domain,'coding');
  assert.equal(a.supportedRequest,'Help with codong in Python');
  const b=assessWorkDomain({request:'Write a reasech thsis with references'});
  assert.equal(b.domain,'research');
  assert.equal(b.supportedRequest,'Write a reasech thsis with references');
});

test('software artifact beats incidental research topic, with scholarly deliverable still protected',()=>{
  const software=[
    'Build a web app to summarize research papers',
    'Write a Python script for my thesis experiment',
    'Create a plugin for formatting journal manuscripts',
    'Refactor the parser for thesis files',
    'Build a code editor for academic paper authors',
    'Develop a React app for my research lab',
    'Debug the API that imports scientific citations',
    'Write unit tests for our manuscript formatting package'
  ];
  for (const goal of software) {
    const d=assessWorkDomain({request:goal});
    assert.equal(d.status,'in-scope',goal);
    assert.equal(d.domain,'coding',goal);
  }
  const scholarly=[
    'Write a research paper about software testing',
    'Write an academic paper on building a website',
    'Design a qualitative thesis study of migration interviews',
    'Draft a journal manuscript about API reliability',
    'Prepare my dissertation with scientific citations'
  ];
  for (const goal of scholarly) {
    const d=assessWorkDomain({request:goal});
    assert.equal(d.domain,'research',goal);
  }
});

test('coding-only intent understands developer vocabulary without a literal code keyword',()=>{
  for (const request of [
    'Fix login and add retry handling, and run integration tests',
    'Fix failing regression tests',
    'Create integration tests for my service'
  ]) {
    const result=assessWorkDomain({request});
    assert.equal(result.domain,'coding',request);
    assert.equal(result.status,'in-scope',request);
  }
  const paper=assessWorkDomain({request:'Write a thesis about integration testing'});
  assert.equal(paper.domain,'research');
  assert.notEqual(assessWorkDomain({request:'Send birthday wishes and a weather forecast'}).domain,'coding');
});
