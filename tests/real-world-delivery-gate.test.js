import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealWorldOutcomeContract } from '../src/real-world-outcome.js';
import { completionGate } from '../src/unified-adaptive-workflow.js';

const realWorld = { intent: 'action', signals: { externalAction: true } };
const successCriteria = ['Only an approved tool is made available'];
const observed = { kind: 'observed', provenance: { executed: true, source: 'sandbox-receipt' } };

function gate(evidence, verificationSatisfied) {
  const outcomeContract = buildRealWorldOutcomeContract({
    realWorld, successCriteria, evidence, authorizationSatisfied: true
  });
  const decision = completionGate({
    workflow: { outcomeContract, acceptance: {
      satisfied: verificationSatisfied, verificationSatisfied,
      verificationRequired: true, criteria: successCriteria
    } },
    status: 'complete', taskType: 'deliver', evidence,
    verification: verificationSatisfied ? { verdict: 'pass' } : null
  });
  return { outcomeContract, decision };
}

test('world-changing delivery remains blocked on observation without verified outcome', () => {
  const { outcomeContract, decision } = gate([observed], false);
  assert.equal(outcomeContract.evidence.observed, true);
  assert.equal(outcomeContract.evidence.verified, false);
  assert.equal(decision.allowed, false);
  assert.ok(decision.gaps.includes('outcome-verification-required'));
});

test('saved server-checked verification satisfies the action delivery outcome', () => {
  const verified = {
    kind: 'verified', state: 'verified', verdict: { verdict: 'pass' },
    provenance: { source: 'server-recorded-verification', taskId: 'verify' }
  };
  const { outcomeContract, decision } = gate([observed, verified], true);
  assert.equal(outcomeContract.evidence.observed, true);
  assert.equal(outcomeContract.evidence.verified, true);
  assert.equal(decision.allowed, true, JSON.stringify(decision.gaps));
});

test('a model claiming high confidence does not satisfy the real-world verification gate', () => {
  const { outcomeContract, decision } = gate([
    observed, { kind: 'inference', confidence: 1, text: 'Everything succeeded' }
  ], false);
  assert.equal(outcomeContract.evidence.verified, false);
  assert.equal(decision.allowed, false);
});
