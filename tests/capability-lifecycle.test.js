import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityImplementationProposal,
  validateCapabilityImplementation,
  promoteCapabilityImplementation
} from '../src/capability-lifecycle.js';

test('unknown capability gets a deterministic non-executable implementation proposal', () => {
  const proposal = capabilityImplementationProposal({
    id: 'novel-fabrication-controller',
    source: 'discoverable',
    dynamic: true,
    risk: 'high',
    outputs: ['controller-plan']
  }, { situationId: 'situation-1' });

  assert.match(proposal.proposalId, /^cap-[a-f0-9]{24}$/);
  assert.equal(proposal.state, 'candidate');
  assert.equal(proposal.implementation.executable, false);
  assert.equal(validateCapabilityImplementation(proposal).valid, true);
});

test('a capability cannot become executable without a concrete runner', () => {
  const proposal = capabilityImplementationProposal({
    id: 'new-solver',
    source: 'discoverable',
    dynamic: true,
    outputs: ['result']
  });
  const result = promoteCapabilityImplementation(proposal, {
    verified: true,
    approved: true,
    executionEvidence: { executed: true }
  });
  assert.equal(result.promoted, false);
  assert.equal(result.state, 'verified');
});

test('side-effecting capability requires approval and execution evidence before promotion', () => {
  const proposal = capabilityImplementationProposal({
    id: 'robot-controller',
    source: 'discoverable',
    dynamic: true,
    risk: 'high',
    outputs: ['command']
  }, { implementationKind: 'hardware', runner: { id: 'robot-runner-v1' } });

  const blocked = promoteCapabilityImplementation(proposal, { verified: true });
  assert.equal(blocked.promoted, false);
  assert.equal(blocked.state, 'registered');

  const promoted = promoteCapabilityImplementation(proposal, {
    verified: true,
    approved: true,
    executionEvidence: { executed: true, status: 'completed', receiptId: 'r-1' }
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.proposal.implementation.executable, true);
  assert.equal(promoted.proposal.state, 'registered');
});
