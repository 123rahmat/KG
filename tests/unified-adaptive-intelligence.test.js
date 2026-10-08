import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedAdaptiveIntelligence } from '../src/unified-adaptive-intelligence.js';

test('normal chat and coding share one adaptive intelligence contract', () => {
  const chat = buildUnifiedAdaptiveIntelligence('Explain heat in thermodynamics.', {
    activeSurface: 'chat'
  });
  const code = buildUnifiedAdaptiveIntelligence('Fix the authentication bug across the project.', {
    activeSurface: 'code',
    files: ['src/auth.js', 'src/routes/login.js', 'tests/auth.test.js', 'package.json']
  });

  assert.equal(chat.unified, true);
  assert.equal(code.unified, true);
  assert.equal(chat.surface, 'chat');
  assert.equal(code.surface, 'code');
  assert.ok(chat.capabilities.includes('adaptive-verification'));
  assert.ok(code.capabilities.includes('repository-intelligence'));
});

test('a multi-file coding request escalates without forcing parallel agents', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Refactor the entire application authentication system and fix all related tests.',
    {
      activeSurface: 'code',
      files: [
        'src/auth.js',
        'src/routes/login.js',
        'src/routes/session.js',
        'src/db.js',
        'tests/auth.test.js',
        'tests/session.test.js',
        'package.json'
      ]
    }
  );

  assert.equal(intelligence.projectWork, true);
  assert.ok(['multi-file', 'complex', 'large-project'].includes(intelligence.scale));
  assert.equal(intelligence.execution.neverParallelizeUntilDependenciesKnown, true);
  assert.ok(intelligence.capabilities.includes('dependency-aware-task-graph'));
  assert.ok(intelligence.capabilities.includes('regression-verification'));
});

test('large coding projects retain persistent project intelligence and are parallel-agent ready', () => {
  const files = Array.from({ length: 30 }, (_, i) => `src/module-${i}.js`);
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Rebuild the entire repository and verify the complete system.',
    {
      activeSurface: 'code',
      files,
      project: { id: 'project-1' }
    }
  );

  assert.equal(intelligence.projectWork, true);
  assert.equal(intelligence.scale, 'large-project');
  assert.equal(intelligence.state.persistent, true);
  assert.ok(intelligence.capabilities.includes('long-running-project-state'));
  assert.ok(intelligence.capabilities.includes('parallel-agent-ready'));
});

test('chat stays lightweight when no project work exists', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence('Why does metal expand when heated?', {
    activeSurface: 'chat'
  });
  assert.equal(intelligence.scale, 'single');
  assert.equal(intelligence.execution.strategy, 'direct');
  assert.equal(intelligence.projectWork, false);
  assert.deepEqual(intelligence.context.sources, []);
});

test('verification escalates with coding complexity', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence('Build and test a complete web application.', {
    activeSurface: 'code',
    files: ['package.json', 'src/app.js', 'src/ui.jsx', 'src/api.js', 'tests/app.test.js']
  });
  assert.equal(intelligence.verification.required, true);
  assert.ok(intelligence.verification.stages.length >= 3);
  assert.equal(intelligence.verification.rerunOnChange, true);
});


test('intelligence includes explicit reasoning and management, not adaptation alone', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Investigate why this full application is failing, repair it, test it, and verify the complete result.',
    {
      activeSurface: 'code',
      files: Array.from({ length: 30 }, (_, i) => `src/module-${i}.js`),
      project: { id: 'project-2' },
      currentState: { failing: true }
    }
  );

  assert.equal(intelligence.reasoning.depth, 'deep');
  assert.equal(intelligence.reasoning.hypothesisDriven, true);
  assert.equal(intelligence.reasoning.evidenceRequired, true);
  assert.equal(intelligence.management.enabled, true);
  assert.ok(intelligence.management.managers.includes('objective-manager'));
  assert.ok(intelligence.management.managers.includes('task-manager'));
  assert.ok(intelligence.management.managers.includes('execution-manager'));
  assert.ok(intelligence.management.managers.includes('failure-manager'));
  assert.ok(intelligence.management.managers.includes('project-state-manager'));
  assert.deepEqual(intelligence.management.controlLoop, [
    'observe', 'decide', 'act', 'measure', 'verify', 'replan'
  ]);
  assert.equal(intelligence.management.uncertainty.confidenceIsNotProof, true);
  assert.equal(intelligence.decisionModel.policy.evidenceBeforeCompletion, true);
});

test('simple chat remains intelligent without unnecessary project management', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Explain why hot air rises, with an intuitive example.',
    { activeSurface: 'chat' }
  );

  assert.equal(intelligence.reasoning.depth, 'focused');
  assert.equal(intelligence.management.enabled, true);
  assert.equal(intelligence.management.state, 'task-state');
  assert.equal(intelligence.management.resourcePolicy, 'minimum-sufficient-work');
  assert.equal(intelligence.management.escalation.parallelWork, 'not-needed');
  assert.equal(intelligence.projectWork, false);
});


test('advanced intelligence challenges assumptions and selects investigation only when material', () => {
  const uncertain = buildUnifiedAdaptiveIntelligence(
    'Fix the application but I am not sure what is causing the failure.',
    {
      activeSurface: 'code',
      files: ['src/app.js'],
      currentState: { failing: true },
      successCriteria: ['all tests pass']
    }
  );

  assert.equal(uncertain.controlLoop.oneWorkflow, true);
  assert.ok(uncertain.capabilities.includes('assumption-challenge'));
  assert.ok(uncertain.metaReasoning.hypothesisSpace.length > 0);
  assert.ok(uncertain.metaReasoning.evidenceState.unknowns.length > 0);
  assert.ok(uncertain.metaReasoning.missingRequirements.length >= 0);
  assert.ok(uncertain.metaReasoning.challenge.enabled);
  assert.equal(uncertain.metaReasoning.brainstorm.bounded, true);
  assert.equal(uncertain.metaReasoning.brainstorm.selectedInitial, 'observe-first');
  assert.ok(uncertain.metaReasoning.alternatives.every(option => option.tradeOff && option.evidenceNeeded?.length));
});

test('advanced intelligence keeps simple chat focused while preserving the same control model', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'What is entropy in thermodynamics?',
    { activeSurface: 'chat' }
  );

  assert.equal(intelligence.controlLoop.oneWorkflow, true);
  assert.equal(intelligence.reasoning.depth, 'focused');
  assert.ok(intelligence.capabilities.includes('goal-understanding'));
  assert.ok(intelligence.capabilities.includes('alternative-evaluation'));
  assert.equal(intelligence.metaReasoning.nextDecision.investigate.length, 0);
  assert.equal(intelligence.metaReasoning.brainstorm.selectedInitial, 'direct-answer');
});

test('advanced intelligence treats verification failure as a reason to reopen reasoning', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Repair the complete project and verify the result.',
    {
      activeSurface: 'code',
      files: Array.from({ length: 20 }, (_, i) => `src/module-${i}.js`),
      project: { id: 'p1' },
      currentState: { verificationFailed: true }
    }
  );

  assert.ok(intelligence.controlLoop.replanningGate.includes('verification outcome'));
  assert.ok(intelligence.management.escalation.triggers.includes('verification-failure'));
});


test('resource intelligence decides what to bring, when to bring it, and effort depth', () => {
  const simple = buildUnifiedAdaptiveIntelligence(
    'What is heat in thermodynamics?',
    { activeSurface: 'chat' }
  );
  assert.equal(simple.resourceDecision.effort, 'minimal');
  assert.equal(simple.resourceDecision.rules.activateToolsJustInTime, true);
  assert.equal(simple.resourceDecision.rules.stopWhenAcceptanceEvidenceIsSufficient, true);
  assert.deepEqual(simple.resourceDecision.bring, []);

  const complex = buildUnifiedAdaptiveIntelligence(
    'Investigate and repair the complete application, then verify the result.',
    {
      activeSurface: 'code',
      files: ['package.json', 'src/app.js', 'src/auth.js', 'tests/app.test.js'],
      project: { id: 'project-3' },
      currentState: { failing: true },
      successCriteria: ['tests pass']
    }
  );

  assert.ok(['standard', 'deep'].includes(complex.resourceDecision.effort));
  assert.ok(complex.resourceDecision.bring.some(item => item.id === 'working-files'));
  assert.ok(complex.resourceDecision.bring.some(item => item.id === 'project-state'));
  assert.ok(complex.resourceDecision.bring.some(item => item.id === 'current-state'));
  assert.equal(complex.resourceDecision.rules.investigateHighestImpactUnknownFirst, true);
  assert.equal(complex.resourceDecision.rules.expandOnMaterialChangeOnly, true);
  assert.ok(complex.metaReasoning.resourceDecision);
  assert.ok(complex.controlLoop.resourceDecision);
});


test('extreme intelligence builds explicit failure diagnosis and competing hypotheses', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Find and repair why the complete application is failing, then verify it.',
    {
      activeSurface: 'code',
      files: ['src/auth.js', 'src/routes/login.js', 'package.json', 'tests/auth.test.js'],
      project: { id: 'failure-project' },
      currentState: { failing: true, errorMessage: 'login request fails' }
    }
  );

  assert.equal(intelligence.failureDiagnosis.active, true);
  assert.ok(intelligence.failureDiagnosis.hypotheses.length >= 2);
  assert.equal(intelligence.failureDiagnosis.competingHypotheses, true);
  assert.equal(intelligence.failureDiagnosis.diagnosisPolicy.testHighestInformationGainFirst, true);
  assert.ok(intelligence.failureDiagnosis.nextDiscriminatingTest);
});

test('extreme situation awareness tracks changes and selectively invalidates affected evidence', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Fix the changed authentication code without unnecessarily rechecking unrelated work.',
    {
      activeSurface: 'code',
      files: ['src/auth.js', 'src/ui.js', 'tests/auth.test.js'],
      project: { id: 'impact-project' },
      currentState: { changedFiles: ['src/auth.js', 'tests/auth.test.js'] }
    }
  );

  assert.ok(intelligence.changeImpact.changedArtifacts.includes('src/auth.js'));
  assert.ok(intelligence.changeImpact.impactedAreas.includes('verification'));
  assert.equal(intelligence.changeImpact.invalidation.selective, true);
  assert.equal(intelligence.changeImpact.invalidation.preserveUnaffectedVerifiedEvidence, true);
  assert.ok(intelligence.changeImpact.reverify.includes('regression-surface'));
  assert.equal(intelligence.situationalControl.control.observeBeforeAssume, true);
  assert.equal(intelligence.situationalControl.control.invalidateSelectiveEvidenceOnly, true);
});

test('verification depth is driven by actual changes and failure, not complexity alone', () => {
  const intelligence = buildUnifiedAdaptiveIntelligence(
    'Repair the failing project and verify only what the evidence requires.',
    {
      activeSurface: 'code',
      files: ['src/app.js'],
      currentState: {
        errorMessage: 'runtime failure',
        changedFiles: ['src/app.js']
      }
    }
  );

  assert.ok(intelligence.verification.stages.includes('reproduce-diagnosis'));
  assert.ok(intelligence.verification.stages.includes('regression-surface'));
  assert.equal(intelligence.verification.selectiveReverification, true);
  assert.equal(intelligence.verification.drivenBy.actualChanges, true);
});

test('all surfaces describe incremental work under RunStore scheduling authority', () => {
  for (const activeSurface of ['chat', 'code', 'research']) {
    const intelligence = buildUnifiedAdaptiveIntelligence('Investigate a changed requirement and verify the result', { activeSurface });
    assert.equal(intelligence.controlLoop.strategy, 'incremental-open-world');
    assert.equal(intelligence.controlLoop.schedulingAuthority, 'RunStore');
    assert.equal(intelligence.controlLoop.stages, undefined);
    assert.equal(intelligence.controlLoop.oneWorkflow, true);
  }
});
