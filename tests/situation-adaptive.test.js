import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSituationModel,
  mergeSituationEvidence,
  evolveSituation,
  situationQualityGate,
  inspectGoal,
  discoverCapabilityRequirements,
  resolveAdaptiveContext,
  connectorCatalog,
  buildExternalDataPlan
} from '../src/adaptive.js';

test('models an unfamiliar goal without requiring a domain keyword', () => {
  const situation = buildSituationModel(
    'Help me turn this new problem into a practical solution and tell me what I need before we begin.',
    {
      user: { id: 'u1', skillLevel: 'beginner' },
      resources: ['notes'],
      constraints: ['limited time']
    }
  );

  assert.equal(situation.openWorld, true);
  assert.equal(situation.userProfile.skillLevel, 'beginner');
  assert.ok(situation.constraints.includes('limited time'));
  assert.ok(situation.suggestions.length > 0);
  assert.equal(situation.presentation.mode, 'guided');
});

test('uses workflow state as part of the situation, not just the latest prompt', () => {
  const first = buildSituationModel('Continue the project from the previous work.', {
    priorWork: ['initial prototype'],
    completedSteps: ['requirements'],
    currentState: 'prototype ready'
  });
  assert.equal(first.phase, 'in-progress');

  const next = mergeSituationEvidence(first, {
    completedSteps: ['prototype'],
    failedSteps: ['first validation'],
    evidence: ['validation failed because input was incomplete']
  });
  assert.equal(next.phase, 'recovery');
  assert.ok(next.state.completedSteps.includes('prototype'));
  assert.ok(next.evidence.includes('validation failed because input was incomplete'));
});

test('unknown domain still receives open-world capability discovery', () => {
  const analysis = inspectGoal('Create a solution for an unfamiliar problem that has no predefined workflow.');
  assert.equal(analysis.openWorld, true);
  assert.equal(analysis.situation.openWorld, true);
  assert.equal(analysis.situation.needsCapabilityDiscovery, true);

  const requirements = discoverCapabilityRequirements('Create a solution for an unfamiliar problem that has no predefined workflow.', analysis);
  assert.ok(requirements.some(item => item.id === 'capability-discovery'));
  assert.ok(requirements.some(item => item.id === 'adaptive-execution'));
});

test('adaptive context exposes situation and dynamic workspace without inventing execution', () => {
  const context = resolveAdaptiveContext(
    'Develop, test and refine a new computational model from these requirements.',
    { workspaceType: 'personal', runtimeMode: 'auto' }
  );

  assert.equal(context.openWorld, true);
  assert.ok(context.surfaces.includes('adaptive'));
  assert.ok(context.surfaces.includes('code'));
  assert.equal(context.execution.approvalRequired, true);
  // The plan reports its real implementation state; nothing is ready to run yet.
  assert.equal(context.resourcePlan.status, 'implementation-required');
});


test('persists structured situation evolution and exposes a quality gate', () => {
  const first = buildSituationModel('Build the requested artifact and prove it works.', {
    user: { id: 'u1', skillLevel: 'expert' },
    successCriteria: ['artifact is produced', 'artifact passes verification'],
    resources: ['workspace'],
    environment: 'test'
  });
  const next = evolveSituation(first, {
    type: 'execution', taskId: 'build', status: 'complete',
    summary: 'Artifact produced', evidence: ['artifact checksum recorded']
  });
  assert.equal(next.timeline.length, 1);
  assert.equal(next.timeline[0].taskId, 'build');
  assert.ok(next.adaptation.user.skillLevel === 'expert');
  assert.equal(situationQualityGate(next).ready, true);
});


test('outside accounts are never connected: their data arrives as attached files', () => {
  const plan = resolveAdaptiveContext(
    'Use my Google Drive document and Gmail instructions to prepare the report.',
    {
      user: { id: 'u1' },
      dataSources: ['google-drive', 'google-gmail'],
      verifiedConnections: [
        { id: 'google-drive', status: 'connected', scopes: ['https://www.googleapis.com/auth/drive.file'], verified: true }
      ]
    }
  );
  // Even a "verified" connection cannot connect a service Kindgleam does not integrate.
  assert.deepEqual(plan.externalData.connected, []);
  assert.ok(plan.situation.gaps.some(gap => gap.includes('google drive, gmail must be attached')));
});

test('the connector catalog holds only the public web', () => {
  assert.deepEqual(connectorCatalog().map(item => item.id), ['public-web']);
  const dataPlan = buildExternalDataPlan('Read my Google Drive files and Google Calendar events.', { user: { id: 'u1' } });
  assert.deepEqual(dataPlan.requested, []);
  assert.equal(dataPlan.connected.length, 0);
});

test('generic wording does not silently become Google access', () => {
  const dataPlan = buildExternalDataPlan(
    'Read my email and calendar and summarize them.',
    { user: { id: 'u1' } }
  );
  assert.deepEqual(dataPlan.requested, []);
  assert.equal(dataPlan.state, 'not-required');
});

test('public web is distinct from private provider data', () => {
  const dataPlan = buildExternalDataPlan('Research the latest public information about this topic.');
  assert.equal(dataPlan.state, 'available');
  assert.deepEqual(dataPlan.authorizationRequired, []);
  assert.deepEqual(dataPlan.connected, []);
  assert.ok(dataPlan.connectors.includes('public-web'));
  assert.ok(dataPlan.unavailableClaims.some(item => item.includes('entire internet')));
});


test('high-impact situations require jurisdiction context before verification', () => {
  const situation = buildSituationModel('Help me with a medical diagnosis.');
  assert.ok(situation.highImpact);
  assert.ok(situation.unknowns.some(item => item.includes('jurisdiction is required')));
});

test('a plain question still has a success criterion to verify against', () => {
  // "need for a 3.5 kW circuit" reads like an outcome, but it is not a checkable criterion.
  const situation = buildSituationModel('What breaker size do I need for a 3.5 kW circuit?');
  assert.ok(situation.successCriteria.length > 0);
});
