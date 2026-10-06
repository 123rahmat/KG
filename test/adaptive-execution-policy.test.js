import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWebSearch, adaptiveExecutionEnvelope } from '../src/adaptive-execution-policy.js';

test('adaptive web search stays off for ordinary chat', () => {
  const d = decideWebSearch({ goal: 'Explain recursion simply.' });
  assert.equal(d.shouldSearch, false);
});

test('adaptive web search activates for current research', () => {
  const d = decideWebSearch({ goal: 'Research the latest Node.js release and cite sources.', research: true });
  assert.equal(d.shouldSearch, true);
  assert.equal(d.budget.stopWhenSufficientEvidence, true);
  assert.equal(d.provenance.citationsRequired, true);
});

test('explicit disable wins over inferred freshness', () => {
  const d = decideWebSearch({ goal: 'What is the latest version?', requested: false });
  assert.equal(d.shouldSearch, false);
  assert.equal(d.mode, 'disabled');
});

test('execution envelope adapts effort and skill budget to pressure', () => {
  const low = adaptiveExecutionEnvelope({ goal: 'Write a short function.', complexity: 0.1 });
  const high = adaptiveExecutionEnvelope({ goal: 'Research the latest security guidance and verify it.', complexity: 0.9, uncertainty: 0.8, research: true, evidenceRequired: true });
  assert.equal(low.effort, 'minimal');
  assert.equal(high.effort, 'deep');
  assert.ok(high.skills.maxCost > low.skills.maxCost);
  assert.equal(high.webSearch.shouldSearch, true);
  assert.equal(high.verification.strength, 'strong');
});


test('zero search budget cannot be bypassed by an explicit search request', () => {
  const decision = decideWebSearch({
    goal: 'search the web for the latest documentation',
    requested: 'required',
    budget: { maxSearches: 0 }
  });
  assert.equal(decision.shouldSearch, false);
  assert.equal(decision.reason, 'search-budget-exhausted');
  assert.equal(decision.budget.maxSearches, 0);
});
