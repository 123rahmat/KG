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
