import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClassification } from '../src/classifier.js';

const reply = extra => ({
  actions: ['answer'],
  signals: { research: false, file: false, code: false, creation: false, invention: false, uncertainty: false, physical: false, highImpact: false },
  unknownSituation: false,
  confidence: 0.8,
  ...extra
});

test('a crisis reading is kept only when it is one of the known kinds', () => {
  assert.equal(normalizeClassification(reply({ crisis: 'emergency' })).crisis, 'emergency');
  assert.equal(normalizeClassification(reply({ crisis: 'self-harm' })).crisis, 'self-harm');
  // "none", a missing field or an unknown value classify normally, without a crisis.
  for (const crisis of ['none', undefined, 'panic', 7]) {
    const hints = normalizeClassification(reply({ crisis }));
    assert.ok(hints, String(crisis));
    assert.equal('crisis' in hints, false, String(crisis));
  }
  // A malformed reply still falls back to the keyword rules.
  assert.equal(normalizeClassification({ ...reply({ crisis: 'emergency' }), actions: ['fly'] }), null);
});


test('the classifier preserves the user need form and depth', () => {
  const hints = normalizeClassification(reply({
    need: {
      deliverable: 'the monthly repayment',
      form: 'number',
      depth: 'brief',
      exclude: ['loan history', 'unrequested alternatives']
    }
  }));
  assert.deepEqual(hints.need, {
    deliverable: 'the monthly repayment',
    form: 'number',
    depth: 'brief',
    exclude: ['loan history', 'unrequested alternatives']
  });
});
