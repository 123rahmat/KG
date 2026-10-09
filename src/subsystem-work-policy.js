/**
 * Shared, evidence-aware work policy for Code and Research subsystems.
 *
 * A subsystem has access to the full set of relevant capabilities; it does
 * not automatically execute a fixed research -> plan -> test -> debug chain.
 * This is advisory scheduling only. The parent run alone owns edits, tool
 * authorization, real execution receipts and final verification.
 */
const value = input => String(input ?? '').trim();
const list = input => (Array.isArray(input) ? input : []).filter(Boolean);
const unique = input => [...new Set(input)];
const risky = risk => ['high', 'critical', 'high-impact', 'physical', 'regulated']
  .includes(value(risk).toLowerCase());
const budgetRatio = input => {
  if (input === null || input === undefined || value(input) === '') return 1;
  const n = Number(input);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
};
const triggered = (needed, reason, role = null, authority = 'advisory') =>
  Object.freeze({ needed: Boolean(needed), reason, role, authority,
    status: needed ? 'requested-not-executed' : 'not-needed-now' });

/**
 * The returned activities are possibilities, NOT executed stage receipts.
 * Independent advisory reads may overlap. Writes, testing and authoritative
 * verification must be executed and recorded through the parent workflow.
 */
export function subsystemWorkPolicy({
  surface = 'code', subsystem = {}, focus = 'general', goal = '',
  iteration = 1, findings = [], failure = null, researchState = {},
  uncertainty = 0, complexity = 0, remainingBudgetRatio = null,
  risk = 'ordinary', independentWork = false, accepted = false
} = {}) {
  const workspace = surface === 'research' ? 'research' : 'code';
  const budget = budgetRatio(remainingBudgetRatio);
  const scarce = budget < 0.25;
  const consequential = risky(risk);
  const reported = list(findings);
  const openQuestions = unique([
    ...list(researchState?.unresolvedQuestions).map(value),
    ...reported.flatMap(item => list(item?.unknowns).map(value))
  ].filter(Boolean));
  const conflicts = unique([
    ...list(researchState?.conflicts).map(value),
    ...reported.filter(item => item?.recommendation === 'revise')
      .map(item => value(item.summary)).filter(Boolean)
  ]);
  const failedExecution = failure?.status === 'failed'
    || (Number.isFinite(failure?.exitCode) && failure.exitCode !== 0)
    || list(failure?.failedTests).length > 0
    || list(failure?.testFailures).length > 0;
  const failedReview = reported.some(item =>
    ['stop', 'revise', 'investigate'].includes(value(item?.recommendation)));
  const recovery = failedExecution || (iteration > 1 && failedReview);
  const description = value(goal);
  const requestedDebug = /\b(debug|fix|repair|regression|broken|failing|failure|crash)\b/i.test(description);
  const sourceCount = Math.max(0, Number(researchState?.sourceCount) || 0);
  const evidenceCount = Math.max(0, Number(researchState?.evidenceCount) || 0);
  const projectSize = list(subsystem?.files).length;
  const dependencies = list(subsystem?.dependencies).length;
  const hasTests = list(subsystem?.tests).length > 0;
  const needsArchitecture = complexity >= 0.65 || dependencies > 1
    || /\b(architect|design|new system|refactor|integrat|migration|build (?:an? )?(?:app|platform|system))\b/i.test(description);
  const scopeChanged = subsystem?.topologyChanged === true;
  const finalAccepted = accepted === true && !failedExecution && !failedReview;
  const activities = workspace === 'code' ? {
    inspect: triggered(!finalAccepted, 'read the current revision, owned paths and dependencies', 'analyst'),
    research: triggered(!finalAccepted && (openQuestions.length > 0 || uncertainty >= 0.65),
      'investigate material uncertainty; do not invent retrieved evidence', 'researcher'),
    plan: triggered(!finalAccepted && (needsArchitecture || scopeChanged),
      'clarify interfaces, ownership and integration contract', 'architect'),
    implement: triggered(!finalAccepted, 'propose scoped edits against the current revision', 'implementer'),
    test: triggered(!finalAccepted, hasTests
      ? 'propose targeted existing regression tests for the parent executor'
      : 'identify missing tests; parent executor must run actual validation',
      'test-engineer', 'parent-executor-only'),
    debug: triggered(!finalAccepted && (recovery || requestedDebug),
      'inspect observed failures and propose a narrow repair', 'debugger'),
    review: triggered(!finalAccepted && (consequential || failedReview || focus === 'security'),
      'critique security, safety and correctness from existing evidence', 'security-reviewer'),
    verify: triggered(!finalAccepted,
      'only the parent run may verify test receipts and acceptance criteria',
      'test-engineer', 'parent-verification-only'),
    integrate: triggered(!finalAccepted && (dependencies > 0 || list(subsystem?.consumers).length > 0),
      'coordinate dependency-scoped handoff and revision-safe integration',
      'architect', 'parent-integration-only')
  } : {
    scope: triggered(!finalAccepted, 'define the research question and evidence gaps', 'researcher'),
    retrieve: triggered(!finalAccepted && (sourceCount === 0 || openQuestions.length > 0),
      'request real sources from authorized research tools', 'researcher', 'parent-tool-only'),
    methodology: triggered(!finalAccepted && (focus === 'methodology'
      || /\b(methodology|methods|study design|sampling)\b/i.test(description)),
      'critique study quality, bias and methods', 'methodology-reviewer'),
    analyze: triggered(!finalAccepted && (evidenceCount > 0 || focus === 'analysis'),
      'analyze existing evidence, do not invent data', 'quantitative-analyst'),
    reconcile: triggered(!finalAccepted && conflicts.length > 0,
      'resolve conflicting observations before synthesis', 'critic'),
    synthesize: triggered(!finalAccepted && evidenceCount > 0 && conflicts.length === 0,
      'synthesize supported findings while preserving uncertainty', 'academic-writer'),
    verify: triggered(!finalAccepted,
      'the parent run must check claims, source provenance and citations',
      'citation-auditor', 'parent-verification-only'),
    revise: triggered(!finalAccepted && (openQuestions.length > 0 || conflicts.length > 0),
      'reassess only unresolved material evidence gaps', 'researcher')
  };
  const activated = Object.entries(activities)
    .filter(([, item]) => item.needed).map(([name]) => name);
  // Suggest only genuinely useful optional specialists. Do not spend optional
  // model calls to repeat a test or certification controlled by the server.
  const optionalRoles = unique(Object.entries(activities)
    .filter(([name, item]) => item.needed && item.authority === 'advisory'
      && !['inspect', 'scope'].includes(name))
    .map(([, item]) => item.role).filter(Boolean));
  const maxParallel = scarce || consequential || independentWork !== true ? 1
    : Math.min(workspace === 'code' ? 3 : 4, Math.max(1, optionalRoles.length));
  return Object.freeze({
    version: 1,
    workspace,
    subsystemId: value(subsystem?.id) || null,
    focus: value(focus) || 'general',
    available: Object.freeze(Object.keys(activities)),
    activities: Object.freeze(activities),
    activated: Object.freeze(activated),
    optionalRoles: Object.freeze(scarce ? optionalRoles.slice(0, 1) : optionalRoles),
    evidence: Object.freeze({ observedFailure: failedExecution, unresolvedQuestions: openQuestions.length,
      conflicts: conflicts.length, sourceCount, evidenceCount, projectSize, hasTests }),
    advisory: Object.freeze({ roleExecution: 'read-only', optionalRecruitment: !scarce,
      parallel: maxParallel, provenIndependence: independentWork === true }),
    authority: Object.freeze({
      agentMayEdit: false, agentMayRunTools: false, agentMayDeclareTestsPassed: false,
      agentMayVerifyCompletion: false, executionOwner: 'parent-run',
      writes: 'revision-bound-owner-controlled', tests: 'real-execution-receipts-required'
    }),
    nextDecision: finalAccepted ? 'stop-accepted'
      : failedExecution ? 'repair-after-observed-failure'
        : openQuestions.length || conflicts.length ? 'investigate-material-gap'
          : 'proceed-with-required-work'
  });
}
