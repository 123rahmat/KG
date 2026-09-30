import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSituationGovernance, reevaluateSituationGovernance, situationGovernanceExecutionGate } from '../src/situation-governance.js';

const base = {
  goal: 'Build a study schedule for my class',
  situation: { risk: 'ordinary', jurisdiction: 'PK', workspaceId: 'w1', user: { id: 'u1' } },
  goalModel: { actions: ['create'] },
  safety: { decision: 'allow', care: [] },
  dataClasses: ['user-content'],
  privacyConsent: { modelProvider: true },
  externalData: { sources: [], authorizationRequired: [] },
  candidateCapabilities: ['planning'],
  candidateTools: [],
  candidateSideEffects: []
};

test('ordinary workflow is ready while preserving privacy and verification invariants', () => {
  const governance = evaluateSituationGovernance(base);
  assert.equal(governance.status, 'ready');
  assert.equal(governance.risk, 'ordinary');
  assert.equal(governance.data.minimumNecessary, true);
  assert.equal(governance.data.noCrossWorkspaceAccess, true);
  assert.equal(governance.ethics.transparencyRequired, true);
  assert.equal(governance.verification.evidenceRequired, true);
});

test('people decisions require human autonomy controls and review', () => {
  const governance = evaluateSituationGovernance({
    ...base,
    goal: 'Rank these students for admission',
    goalModel: { actions: ['answer'] },
    safety: { decision: 'care', care: ['people-decisions'], requiresHumanDecision: true }
  });
  assert.equal(governance.status, 'care');
  assert.equal(governance.ethics.finalHumanDecisionRequired, true);
  assert.equal(governance.ethics.nonDiscriminationBoundary, true);
  assert.equal(governance.execution.humanApprovalRequired, true);
  assert.ok(governance.restrictions.some(item => item.includes('human')));
});

test('high-impact work without jurisdiction becomes review-only', () => {
  const governance = evaluateSituationGovernance({
    ...base,
    goal: 'Plan a medical treatment',
    situation: { risk: 'high-impact', jurisdiction: '' },
    safety: { decision: 'care', care: ['health'] }
  });
  assert.equal(governance.status, 'review');
  assert.equal(governance.jurisdiction.reviewRequired, true);
  assert.equal(governance.execution.allowed, false);
  assert.ok(governance.requiredChecks.includes('resolve-jurisdiction'));
});

test('private data without model consent remains non-exportable', () => {
  const governance = evaluateSituationGovernance({
    ...base,
    privacyConsent: { modelProvider: false },
    dataClasses: ['workspace-content']
  });
  assert.equal(governance.data.privateData, true);
  assert.equal(governance.status, 'review');
  assert.ok(governance.restrictions.some(item => item.includes('explicit consent')));
});

test('persisted blocked governance stops execution', () => {
  const run = {
    adaptation: {
      governance: {
        status: 'blocked',
        execution: { allowed: false }
      }
    }
  };
  const result = situationGovernanceExecutionGate(run, { id: 'test' });
  assert.equal(result.allowed, false);
});

test('governance never grants legal compliance merely because a jurisdiction is known', () => {
  const governance = evaluateSituationGovernance({
    ...base,
    goal: 'Prepare a tax filing workflow',
    situation: { risk: 'high-impact', jurisdiction: 'PK' },
    safety: { decision: 'care', care: ['money'] }
  });
  assert.equal(governance.jurisdiction.status, 'known');
  assert.equal(governance.policy.complianceClaim, false);
});

test('a discovered capability re-evaluates governance and can only make it stricter', () => {
  const planned = evaluateSituationGovernance(base);
  assert.equal(planned.status, 'ready');
  const adaptation = { governance: planned, safety: base.safety, goalModel: base.goalModel, privacy: { consent: { modelProvider: true } }, externalData: base.externalData };
  const next = reevaluateSituationGovernance({ goal: base.goal, situation: base.situation, adaptation }, [
    { id: 'room-actuator', physical: true, highImpact: false, sideEffects: true, tools: ['actuator'], dataClasses: [] }
  ]);
  assert.equal(next.risk, 'physical');
  assert.equal(next.escalated, true);
  assert.equal(next.reevaluations, 1);
  assert.ok(next.execution.sideEffects.includes('room-actuator'));
  assert.ok(next.execution.capabilities.includes('planning'), 'what was planned is kept');
  assert.equal(next.verification.humanCertificationRequired, true);

  // A later, harmless discovery does not lower what was already established.
  const later = reevaluateSituationGovernance({ goal: base.goal, situation: base.situation, adaptation: { ...adaptation, governance: next } }, [
    { id: 'summarise-notes', physical: false, sideEffects: false }
  ]);
  assert.equal(later.risk, 'physical');
  assert.ok(later.execution.sideEffects.includes('room-actuator'));
  assert.equal(later.reevaluations, 2);
});

test('a discovered capability the server policy denies blocks the situation', () => {
  const planned = evaluateSituationGovernance(base);
  const next = reevaluateSituationGovernance({
    goal: base.goal,
    situation: base.situation,
    adaptation: { governance: planned, safety: base.safety, privacy: { consent: { modelProvider: true } } },
    policyDecision: { status: 'governed', constraints: { deniedCapabilities: ['payments-transfer'] } }
  }, [{ id: 'payments-transfer', sideEffects: true }]);
  assert.equal(next.status, 'blocked');
  const gate = situationGovernanceExecutionGate({ adaptation: { governance: next } }, { id: 'respond', type: 'respond' });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /server policy (?:denied|does not allow) a required capability/);
});

test('receipts and approved actions count as acting when a jurisdiction is missing', () => {
  const run = { adaptation: { governance: { status: 'review', jurisdiction: { reviewRequired: true }, execution: { allowed: false } } } };
  const deliver = { id: 'deliver', type: 'deliver' };
  assert.equal(situationGovernanceExecutionGate(run, deliver).allowed, true, 'reasoning still helps');
  assert.equal(situationGovernanceExecutionGate(run, deliver, { external: true }).allowed, false);
});

test('a person can always decline a proposed action; only approving passes the governance gate', async () => {
  const { withServer } = await import('./helpers.js');
  await withServer(async ({ call, seed }) => {
    const { token, workspace } = await seed();
    // High-impact work with no jurisdiction: governance requires review before acting.
    const { body: run } = await call('POST', '/api/runs', { token, workspace, body: { goal: 'My landlord kept my whole security deposit after I moved out. What can I do?' } });
    assert.equal(run.adaptation.governance.jurisdiction.reviewRequired, true);
    const approve = await call('POST', `/api/runs/${run.id}/actions/missing-action`, { token, workspace, body: { approve: true, taskId: run.next } });
    assert.equal(approve.status, 422, 'approving an action is governed');
    assert.equal(approve.body.code, 'situation-governance-blocked');
    const decline = await call('POST', `/api/runs/${run.id}/actions/missing-action`, { token, workspace, body: { approve: false, taskId: run.next } });
    assert.equal(decline.status, 404, 'declining is never blocked; it reaches the action lookup');
    assert.equal(decline.body.code, 'action-not-found');
  });
});

test('re-evaluation never relaxes governance, even when the situation now looks milder', () => {
  const strict = evaluateSituationGovernance({
    ...base,
    goal: 'Plan a medical treatment',
    situation: { risk: 'high-impact' },
    privacyConsent: { modelProvider: false }
  });
  assert.equal(strict.status, 'review');
  assert.equal(strict.jurisdiction.reviewRequired, true);
  // The stored situation has since been edited to look ordinary, and consent recorded.
  const next = reevaluateSituationGovernance({
    goal: 'Plan a study schedule',
    situation: { risk: 'ordinary', jurisdiction: 'PK' },
    adaptation: { governance: strict, safety: base.safety, privacy: { consent: { modelProvider: true } } }
  }, [{ id: 'summarise-notes' }]);
  assert.equal(next.status, 'review', 'status keeps the stricter value');
  assert.equal(next.risk, 'high-impact');
  assert.equal(next.jurisdiction.reviewRequired, true);
  assert.equal(next.execution.allowed, false);
  assert.equal(next.verification.humanCertificationRequired, true);
  assert.ok(strict.restrictions.every(item => next.restrictions.includes(item)), 'no restriction is dropped');
  assert.equal(next.escalated, false);
});


test('governance blocks capabilities, tools, data classes and risks excluded by allow-lists', () => {
  const governed = evaluateSituationGovernance({
    ...base,
    goal: 'Run a robot arm test',
    situation: { risk: 'physical', jurisdiction: 'PK' },
    policyDecision: {
      status: 'evaluated',
      sources: [{ layer: 'platform', id: 'platform-1', allowedCapabilities: ['reasoning'], allowedRiskClasses: ['ordinary'] }],
      constraints: {
        allowedCapabilities: ['reasoning'],
        allowedTools: ['math.*'],
        allowedDataClasses: ['public-web'],
        allowedRiskClasses: ['ordinary'],
        deniedCapabilities: [],
        deniedTools: [],
        deniedDataClasses: []
      }
    },
    dataClasses: ['user-content'],
    candidateCapabilities: ['robot-control'],
    candidateTools: ['robot.execute']
  });
  assert.equal(governed.status, 'blocked');
  assert.ok(governed.reasons.some(reason => /does not allow/.test(reason)));
});
