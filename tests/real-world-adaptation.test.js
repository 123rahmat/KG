import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRealWorldTaskModel, realWorldExecutionPolicy } from '../src/real-world-adaptation.js';
import { buildSituationModel } from '../src/situation.js';

test('models a deadline-driven external action without claiming completion', () => {
  const model = buildRealWorldTaskModel('Send the proposal to the client by 2026-10-06T12:00:00Z', {
    dueAt: '2026-10-06T12:00:00Z',
    now: '2026-10-05T12:00:00Z',
    userBehavior: { autonomy: 'act-with-approval', interruption: 'avoid' }
  });
  assert.equal(model.realWorld, true);
  assert.equal(model.intent, 'action');
  assert.equal(model.temporal.status, 'due-soon');
  assert.equal(model.signals.externalAction, true);
  assert.equal(model.nextAction, 'prepare-then-request-approval');
  assert.equal(model.observability.mayClaimPresenceOrCompletionWithoutEvidence, false);
  assert.equal(model.userBehavior.autonomy, 'act-with-approval');
  assert.equal(model.userBehavior.interruption, 'avoid');
  assert.equal(model.observedBehavior.notPersonalityInference, true);
});

test('tracks commitments, dependencies and coordination as operational state', () => {
  const model = buildRealWorldTaskModel('Coordinate the team meeting', {
    commitments: ['Ali will provide the draft', 'I will send the agenda'],
    dependencies: [
      { id: 'draft', status: 'blocked' },
      { id: 'calendar-time', status: 'ready' }
    ]
  });
  assert.equal(model.intent, 'coordination');
  assert.equal(model.commitments.length, 2);
  assert.deepEqual(model.blockedDependencies.map(item => item.id), ['draft']);
  assert.equal(model.nextAction, 'resolve-blocking-dependency');
  assert.equal(model.controls.includes('actor-and-commitment-tracking'), true);
});

test('preserves explicit user behavior preferences without inventing personality', () => {
  const model = buildRealWorldTaskModel('Help me finish this today', {
    preferences: ['brief', 'avoid interruptions'],
    userBehavior: { pace: 'fast' }
  });
  assert.equal(model.userBehavior.pace, 'fast');
  assert.equal(model.userBehavior.detail, 'minimal');
  assert.equal(model.userBehavior.interruption, 'avoid');
  assert.equal(model.userBehavior.inferredPersonality, false);
});

test('situation model exposes the operational real-world layer', () => {
  const situation = buildSituationModel('Book the appointment for tomorrow', {
    dueAt: '2026-10-06T10:00:00Z',
    now: '2026-10-05T10:00:00Z',
    commitments: ['I will attend'],
    dependencies: [{ id: 'availability', status: 'unknown' }]
  });
  assert.ok(situation.realWorld);
  assert.equal(situation.realWorld.signals.externalAction, true);
  assert.equal(situation.realWorld.commitments.length, 1);
  assert.equal(situation.adaptation.operational.nextAction, 'prepare-then-request-approval');
});

test('reduces an actionable workload when the user explicitly reports high attention load', () => {
  const model = buildRealWorldTaskModel('Finish the work and send it to the team', {
    capacity: { attention: 0.9 },
    completedSteps: [],
    failedSteps: []
  });
  assert.equal(model.capacity.attentionLoad, 0.9);
  assert.equal(model.nextAction, 'reduce-to-smallest-next-action');
});

test('execution policy carries operational urgency and observed task behavior', () => {
  const policy = realWorldExecutionPolicy({
    realWorld: true,
    controls: ['external-action-boundary'],
    temporal: { urgency: 0.9, status: 'due-soon' },
    userBehavior: { autonomy: 'act-with-approval', interruption: 'avoid' },
    nextAction: 'prepare-then-request-approval',
    capacity: { attentionLoad: 0.8 },
    observedBehavior: { completionRatio: 0.75 }
  });
  assert.equal(policy.externalAction, 'approval-or-existing-authority');
  assert.equal(policy.urgency, 0.9);
  assert.equal(policy.autonomy, 'act-with-approval');
  assert.equal(policy.interruption, 'avoid');
  assert.equal(policy.attentionLoad, 0.8);
  assert.equal(policy.observedCompletionRatio, 0.75);
});
