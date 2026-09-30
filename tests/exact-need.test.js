import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeed, normalizeClassification } from '../src/classifier.js';
import { planGoal } from '../src/core.js';
import { mergeSituationEvidence } from '../src/situation.js';
import { situationBrief, SYSTEM_PROMPT } from '../src/reasoning-context.js';

const hints = need => ({
  actions: ['answer'],
  signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
  unknownSituation: false, confidence: 0.9, need
});

test('the exact need is read, validated, and never guessed', () => {
  assert.deepEqual(normalizeNeed({ deliverable: '  the monthly   repayment ', form: 'number', depth: 'brief', exclude: ['amortisation table', ''] }),
    { deliverable: 'the monthly repayment', form: 'number', depth: 'brief', exclude: ['amortisation table'] });
  // An unknown form or depth is dropped; without a deliverable there is no need reading.
  assert.deepEqual(normalizeNeed({ deliverable: 'x', form: 'essay', depth: 'huge' }), { deliverable: 'x' });
  assert.equal(normalizeNeed({ form: 'number' }), null);
  assert.equal(normalizeClassification({ ...hints(null), need: { deliverable: 'a fixed function', form: 'code' } }).need.form, 'code');
});

test('every step sees the need, and it survives the situation being rebuilt', () => {
  const need = { deliverable: 'the monthly repayment', form: 'number', depth: 'brief', exclude: ['history of mortgages'] };
  const plan = planGoal('Loan of 200000 at 6% over 20 years, what do I pay each month?', { classifierHints: hints(need) });
  assert.deepEqual(plan.situation.need, need);
  assert.deepEqual(mergeSituationEvidence(plan.situation, { completedSteps: ['respond'] }).need, need);
  assert.deepEqual(situationBrief({ goal: 'x', situation: plan.situation }).need, need);
  // Without a model reading there is no invented need.
  assert.equal('need' in planGoal('Loan of 200000 at 6% over 20 years, what do I pay each month?').situation, false);
});

test('answers put the deliverable first and add nothing unasked, but never drop safety', () => {
  assert.match(SYSTEM_PROMPT, /Put the deliverable first/);
  assert.match(SYSTEM_PROMPT, /Never drop a safety warning/);
  assert.match(SYSTEM_PROMPT, /overrides need\.depth/);
  assert.match(SYSTEM_PROMPT, /fail if the answer does not deliver need\.deliverable/);
});
