import test from 'node:test';
import assert from 'node:assert/strict';
import { subsystemWorkPolicy } from '../src/subsystem-work-policy.js';
import { codeSpecialistTeam, researchSpecialistTeams, specialistRemit } from '../src/specialist-hierarchy.js';
import { runAdaptiveAgentPanel } from '../src/multi-agent.js';

const code = (extra = {}) => subsystemWorkPolicy({
  surface: 'code', focus: 'frontend',
  subsystem: { id: 'web-ui', roots: ['src/ui'],
    files: ['src/ui/Button.tsx'], dependencies: [], tests: [] },
  goal: 'Update a button label', ...extra
});

test('every subsystem has access to a complete adaptive toolbox without a fixed multi-agent pipeline', () => {
  const p = code();
  assert.ok(['inspect','research','plan','implement','test','debug','review','verify','integrate']
    .every(item => p.available.includes(item)));
  assert.equal(p.activities.implement.needed, true);
  assert.equal(p.activities.test.needed, true, 'real test remains a required parent-workflow capability');
  assert.equal(p.activities.verify.needed, true);
  assert.equal(p.activities.debug.needed, false);
  assert.equal(p.activities.research.needed, false);
  assert.equal(p.activities.plan.needed, false);
  assert.equal(p.activities.integrate.needed, false);
  assert.equal(p.activities.test.status, 'requested-not-executed');
  assert.equal(p.activities.verify.authority, 'parent-verification-only');
  assert.equal(p.authority.agentMayEdit, false);
  assert.equal(p.authority.agentMayDeclareTestsPassed, false);
});

test('Code specialty comes from the actual file-level subsystem rather than a permanent team', () => {
  for (const [root, expected] of [
    ['src/ui','code-ui-engineering-lead'], ['src/frontend','frontend-engineer'],
    ['src/backend','backend-engineer'], ['src/auth','security-reviewer'],
    ['src/db/migrations','backend-engineer'],
    ['tests/api','test-engineer']
  ]) {
    const team = codeSpecialistTeam({
      id: 'owned', roots: [root], files: [root + '/entry.js']
    }, { goal: 'Fix this subsystem', maxRoles: 4 });
    assert.equal(team.leadRole, expected, root);
    assert.equal(team.workPolicy.workspace, 'code');
    assert.equal(team.workPolicy.subsystemId, 'owned');
    assert.equal(team.workPolicy.authority.executionOwner, 'parent-run');
    assert.ok(team.workPolicy.available.includes('debug'));
  }
});

test('a difficult multi-file change activates planning and independent research when justified', () => {
  const p = code({
    goal: 'Design and refactor an API with unclear dependencies',
    complexity: 0.9, uncertainty: 0.85,
    subsystem: { id: 'api', files: ['src/api/a.js','src/api/b.js'],
      dependencies: ['auth','db'], consumers: ['frontend'], tests: ['tests/api.test.js'] }
  });
  assert.equal(p.activities.plan.needed, true);
  assert.equal(p.activities.research.needed, true);
  assert.equal(p.activities.integrate.needed, true);
  assert.equal(p.evidence.hasTests, true);
  assert.equal(p.activities.debug.needed, false);
  assert.equal(p.activities.verify.status, 'requested-not-executed');
});

test('actual failing test evidence recruits debugging; model optimism alone does not', () => {
  const failed = code({ failure: { status: 'failed', exitCode: 1, failedTests: ['test login'] } });
  assert.equal(failed.evidence.observedFailure, true);
  assert.equal(failed.activities.debug.needed, true);
  assert.equal(failed.nextDecision, 'repair-after-observed-failure');
  const confident = code({ findings: [{ recommendation: 'proceed', confidence: 0.99 }] });
  assert.equal(confident.activities.debug.needed, false);
  assert.equal(confident.activities.test.status, 'requested-not-executed');
  assert.equal(confident.activities.verify.status, 'requested-not-executed');
  const disputed = code({
    iteration: 2, findings: [{ recommendation: 'revise', summary: 'File contract mismatch' }]
  });
  assert.equal(disputed.activities.debug.needed, true);
});

test('safe independent analysis can parallelize but security, unknown independence and low budgets serialize', () => {
  const s = code({
    complexity: .85, uncertainty: .7, independentWork: true
  });
  assert.ok(s.advisory.parallel > 1);
  assert.equal(code({ complexity: .9, independentWork: false }).advisory.parallel, 1);
  assert.equal(code({ complexity: .9, independentWork: true,
    risk: 'high-impact' }).advisory.parallel, 1);
  const lowBudget = code({ complexity: .9, uncertainty: .9,
    remainingBudgetRatio: .08, independentWork: true });
  assert.equal(lowBudget.advisory.parallel, 1);
  assert.equal(lowBudget.advisory.optionalRecruitment, false);
  assert.ok(lowBudget.optionalRoles.length <= 1);
  assert.equal(lowBudget.activities.verify.needed, true, 'budget must not skip required verification');
});

test('accepted outcome stops optional work rather than inventing an iteration', () => {
  const p = code({ accepted: true });
  assert.equal(p.nextDecision, 'stop-accepted');
  assert.deepEqual(p.activated, []);
  assert.deepEqual(p.optionalRoles, []);
});

test('unverified Research with no sources requests retrieval but not writing or statistical conclusions', () => {
  const plan = subsystemWorkPolicy({
    surface: 'research', focus: 'literature',
    goal: 'Review current scientific evidence',
    researchState: { sourceCount: 0, evidenceCount: 0,
      unresolvedQuestions: ['Find primary studies'] }
  });
  assert.equal(plan.activities.retrieve.needed, true);
  assert.equal(plan.activities.synthesize.needed, false);
  assert.equal(plan.activities.analyze.needed, false);
  assert.equal(plan.activities.verify.authority, 'parent-verification-only');
  assert.equal(plan.authority.agentMayRunTools, false);
  assert.equal(plan.evidence.sourceCount, 0);
});

test('Research conflicts recruit critical reassessment, while supported evidence permits synthesis advice', () => {
  const disputed = subsystemWorkPolicy({
    surface: 'research', focus: 'literature', goal: 'Compare study findings',
    researchState: { sourceCount: 4, evidenceCount: 3,
      conflicts: ['Two studies disagree'] }
  });
  assert.equal(disputed.activities.reconcile.needed, true);
  assert.equal(disputed.activities.synthesize.needed, false);
  assert.equal(disputed.nextDecision, 'investigate-material-gap');
  const supported = subsystemWorkPolicy({
    surface: 'research', focus: 'literature',
    goal: 'Summarize the well-supported findings',
    researchState: { sourceCount: 4, evidenceCount: 3 }
  });
  assert.equal(supported.activities.retrieve.needed, false);
  assert.equal(supported.activities.synthesize.needed, true);
  assert.equal(supported.activities.verify.status, 'requested-not-executed');
});

test('Research teams receive bounded nested specialty policy without independent authority', () => {
  const h = researchSpecialistTeams({
    goal: 'Write a thesis based on quantitative statistics, methods and research evidence',
    researchState: { sourceCount: 5, evidenceCount: 2,
      unresolvedQuestions: ['What do the latest papers establish?'] },
    maxTeams: 6, maxRoles: 4
  });
  assert.ok(h.teams.length >= 3);
  assert.ok(h.teams.every(t => t.workPolicy?.workspace === 'research'));
  assert.ok(h.teams.every(t => t.workPolicy?.authority?.executionOwner === 'parent-run'));
  for (const t of h.teams) {
    const remit = specialistRemit(t, t.leadRole);
    assert.equal(remit.maySpawnAgents, false);
    assert.equal(remit.adaptiveWork.subsystemId, t.id);
    assert.equal(remit.adaptiveWork.activities.verify.status, 'requested-not-executed');
  }
});

test('real Code panel model calls receive scoped adaptive work without any new permissions', async () => {
  const project = {
    revisionId: 'rev-subsystem',
    contentHash: 'hash-subsystem',
    scale: 'small', fileCount: 2,
    files: [{ path: 'src/ui/button.js', bytes: 50 },
      { path: 'tests/button.test.js', bytes: 45, test: true }],
    dependencies: [], totals: { bytes: 95, dependencies: 0 },
    hierarchy: { scale: 'small', root: { path: '', depth: 0,
      fileCount: 2, bytes: 95, digest: 'subsystem-root' } }
  };
  const observed = [];
  const result = await runAdaptiveAgentPanel({
    run: {
      id: 'run-subsystem', surface: 'code',
      goal: 'Update button label',
      situation: { risk: 'low' },
      adaptation: { scale: 'small' },
      maxTokens: 100000, tokensUsed: 0
    },
    task: { id: 'build-code', type: 'code' },
    basePayload: {
      goal: 'Update button label',
      task: { id: 'build-code', type: 'code' },
      workspace: { projectId: 'project-ui', revisionId: 'rev-subsystem',
        paths: project.files.map(file => file.path) },
      codeIntelligence: { project, files: project.files }
    },
    selection: {}, primaryModelId: 'google:gemini-3.8-flash',
    config: { agents: { multiAgent: 'always', maxAgents: 3 } },
    canSpend: async () => true,
    modelCaller: async messages => {
      const payload = JSON.parse(messages[1].content);
      observed.push(payload.workspacePanel);
      return {
        text: JSON.stringify({ recommendation: 'proceed', summary: 'The change is scoped.',
          confidence: .96, explanation: 'No unresolved changes.',
          risks: [], unknowns: [], actions: [], evidence: [] }),
        provider: 'google', model: 'google:gemini-3.8-flash', usage: null
      };
    }
  });
  assert.ok(observed.length >= 1);
  assert.ok(observed.every(p => p.adaptiveWork.authority.agentMayEdit === false));
  assert.ok(observed.every(p => p.adaptiveWork.available.includes('debug')));
  assert.ok(observed.every(p => p.lifecycle.finalVerificationIsParentOwned === true));
  assert.ok(result.waves.every(w => w.lifecycle.verificationPassed === false));
  assert.ok(result.allocation.subsystemPanels.every(s => s.adaptiveWork?.authority?.executionOwner === 'parent-run'));
});


test('observed backend test failure recruits a scoped debugger rather than an unassigned child agent', async () => {
  const project = {
    revisionId: 'failure-rev', contentHash: 'failure-hash', scale: 'small',
    fileCount: 2,
    files: [{ path: 'src/backend/api.js', bytes: 100 },
      { path: 'src/backend/service.js', bytes: 70 }],
    dependencies: [], totals: { bytes: 170, dependencies: 0 },
    hierarchy: { scale: 'small', root: { path: '', depth: 0, fileCount: 2,
      bytes: 170, digest: 'failure-root' } }
  };
  const observed = [];
  await runAdaptiveAgentPanel({
    run: {
      id: 'backend-failure', surface: 'code', goal: 'Repair failing API tests',
      situation: { risk: 'low' }, adaptation: { scale: 'small' },
      maxTokens: 100000, tokensUsed: 0
    },
    task: { id: 'build-code', type: 'code' },
    basePayload: {
      goal: 'Repair failing API tests',
      task: { id: 'build-code', type: 'code' },
      workspace: { projectId: 'backend', revisionId: 'failure-rev',
        paths: project.files.map(item => item.path) },
      codeIntelligence: {
        project, files: project.files,
        failure: { status: 'failed', exitCode: 1, failedTests: ['api integration'] }
      }
    },
    selection: {}, primaryModelId: 'google:gemini-3.8-flash',
    config: { agents: { multiAgent: 'always', maxAgents: 3 } },
    canSpend: async () => true,
    modelCaller: async messages => {
      const body = JSON.parse(messages[1].content);
      observed.push(body);
      return {
        text: JSON.stringify({ recommendation: 'proceed',
          summary: 'Diagnose the failing API test.', confidence: 0.94,
          explanation: 'A patch remains for parent execution.',
          risks: [], unknowns: [], actions: [], evidence: [] }),
        provider: 'google', model: 'google:gemini-3.8-flash', usage: null
      };
    }
  });
  const debuggerCall = observed.find(body =>
    body.specialistAssignment?.role === 'debugger');
  assert.ok(debuggerCall, 'an observed failed test must recruit a debugger');
  assert.equal(debuggerCall.specialistAssignment.maySpawnAgents, false);
  assert.equal(debuggerCall.specialistAssignment.authority, 'advisory-only');
  assert.equal(debuggerCall.specialistAssignment.adaptiveWork.evidence.observedFailure, true);
  assert.equal(debuggerCall.specialistAssignment.adaptiveWork.authority.agentMayRunTools, false);
  assert.equal(debuggerCall.specialistAssignment.scope.files.some(path =>
    path.endsWith('/api.js')), true);
  assert.equal(debuggerCall.workspacePanel.lifecycle.testsRequireRealParentExecution, true);
});
