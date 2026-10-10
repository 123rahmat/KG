/**
 * One KG execution runtime; two independent, cost-aware control policies.
 *
 * This pure controller recommends *candidate* work, not a competing task
 * lifecycle. The shared RunStore, authorization gates and execution receipts
 * are authoritative. Never interpret a role, stage or acceptance suggestion
 * as permission to invoke a tool or as proof that work ran.
 */
import { controlEngineForSurface } from './work-control-engines.js';
import { understandTask } from './task-understanding.js';

const t = v => String(v ?? '').trim();
const clamp = v => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0));
const riskHigh = value => /^(?:high|critical|high-impact|regulated|physical)$/i.test(t(value));
const CODE_EXECUTE = /\b(?:build|implement|fix|repair|debug|create|refactor|modify|update|integrate|deploy|write|migrate)\b/i;
const LONG_BUILD = /\b(?:full|entire|complete|production|multi[- ]file|from scratch|system|platform|several modules|end[- ]to[- ]end)\b/i;
const RESEARCH_MANUSCRIPT = /\b(?:thesis|dissertation|manuscript|research paper|scientific paper|journal article|paper draft|literature review|systematic review)\b/i;
const RESEARCH_WRITE = /\b(?:draft|write|revise|edit|format|prepare|produce|complete|submit)\b/i;
const RESEARCH_QUANT = /\b(?:statistic\w*|regression|anova|p[- ]values?|confidence interval|hypothes\w* test|simulate|quantitative|equation|derive|mathematic\w*|dataset|data analys\w*|experiment\w*)\b/i;
const RESEARCH_VISUAL = /\b(?:figures?|plots?|graphs?|charts?|diagram\w*|visuali[sz]\w*|graphical abstract)\b/i;
const RESEARCH_METHODS = /\b(?:methods?|methodology|experimental design|study design|sampling|protocol|data collection)\b/i;
const RESEARCH_EXPLORE = /\b(?:brainstorm|alternatives?|possible topics?|hypothes(?:is|es)|research gaps?|novel approaches)\b/i;

function stage(id, reason, required = true) {
  return Object.freeze({ id, reason, required });
}

/**
 * Evidence checks deliberately return missing requirements and never a
 * manufactured "pass". Only the shared runtime may validate and persist
 * signed receipts, inspected source excerpts, approval or final acceptance.
 */
export function controlQualityRequirements({
  surface = 'code', taskKind = 'answer', requiresEvidence = false,
  sourceEvidence = {}, runtimeEvidence = {}, authorization = {}
} = {}) {
  const engine = controlEngineForSurface(surface);
  const requirements = engine === 'coding'
    ? (taskKind === 'implement'
      ? ['revision-bound-change', 'reviewed-diff', 'authenticated-test-receipt', 'regression-assessment']
      : ['accurate-technical-answer'])
    : [
      ...(requiresEvidence ? ['inspected-primary-or-credible-sources', 'claim-to-source-traceability'] : []),
      ...(taskKind === 'quantitative' ? ['reproducible-computation', 'units-and-assumptions-checked'] : []),
      ...(taskKind === 'manuscript' ? ['complete-requested-sections', 'citation-integrity', 'method-limitations'] : []),
      ...(taskKind === 'figure' ? ['data-provenance-and-axis-integrity'] : [])
    ];
  const missing = [];
  if (engine === 'coding' && taskKind === 'implement') {
    if (runtimeEvidence?.revisionMatched !== true) missing.push('revision-bound-change');
    if (runtimeEvidence?.diffReviewed !== true) missing.push('reviewed-diff');
    if (runtimeEvidence?.receiptAuthenticated !== true
      || runtimeEvidence?.testsPassed !== true) missing.push('authenticated-test-receipt');
    if (runtimeEvidence?.regressionAssessed !== true) missing.push('regression-assessment');
  }
  if (engine === 'research' && requiresEvidence) {
    // A source URL alone never counts as an inspected passage.
    if (!Array.isArray(sourceEvidence?.inspectedSources)
      || !sourceEvidence.inspectedSources.some(s => s?.inspectionReceiptVerified === true))
      missing.push('inspected-primary-or-credible-sources');
    if (!Array.isArray(sourceEvidence?.materialClaims) || !sourceEvidence.materialClaims.length
      || sourceEvidence.materialClaims.some(c => !c?.sourceInspectionId || c?.supported !== true))
      missing.push('claim-to-source-traceability');
  }
  if (authorization?.required === true && authorization?.approved !== true) missing.push('human-authorization');
  return Object.freeze({
    engine, requirements: Object.freeze(requirements),
    missingEvidence: Object.freeze([...new Set(missing)]),
    evidenceNotExecution: true,
    receiptValidationOwner: 'shared-server-runtime',
    proposedAcceptanceOnly: true
  });
}

/**
 * Compute the smallest useful next-work profile.
 * Independence must be OBSERVED in the authorised graph, not guessed from
 * complexity. Resource decisions remain ceilings rather than mandatory calls.
 */
export function buildControlWorkflowPolicy({
  surface = 'code', goal = '', understanding = null,
  complexity = 0, uncertainty = 0, risk = 'ordinary', failedAttempts = 0,
  remainingBudgetRatio = null, observedIndependentWork = 0,
  verifiedStateReusable = false, conflictingEvidence = false,
  sourceEvidence = {}, runtimeEvidence = {}, authorization = {},
  acceptanceSatisfied = false
} = {}) {
  const engine = controlEngineForSurface(surface);
  const request = t(goal).slice(0, 12000);
  const understood = understanding ?? understandTask({
    request,
    // This is explicitly a *suggestion* for an already server-admitted
    // controller. It is not, and cannot replace, the scope/auth gate.
    assessment: { status: 'in-scope', domain: engine, supportedRequest: request }
  });
  const intent = understood.intent || 'answer';
  const complex = clamp(complexity);
  const unknown = clamp(uncertainty);
  const independent = clamp(observedIndependentWork);
  const highRisk = riskHigh(risk);
  const failure = Math.max(0, Math.min(5, Math.floor(Number(failedAttempts) || 0)));
  const budgetKnown = remainingBudgetRatio !== null && remainingBudgetRatio !== undefined
    && Number.isFinite(Number(remainingBudgetRatio));
  const remaining = budgetKnown ? clamp(remainingBudgetRatio) : null;
  const scarce = remaining !== null && remaining < .25;
  const exhausted = remaining !== null && remaining < .06;
  const codingWork = engine === 'coding' && (intent === 'implement' || CODE_EXECUTE.test(request));
  const scholarlyDraft = engine === 'research' && RESEARCH_MANUSCRIPT.test(request) && RESEARCH_WRITE.test(request);
  const quantitative = engine === 'research' && RESEARCH_QUANT.test(request);
  const figure = engine === 'research' && RESEARCH_VISUAL.test(request);
  const methods = engine === 'research' && RESEARCH_METHODS.test(request);
  const researchDiscovery = engine === 'research' && (
    /(?:review|search|evidence|compare|survey|sources?|citations?|literature|references?|latest|investigate|systematic)/i.test(request)
    || unknown > .5 || conflictingEvidence
    || (scholarlyDraft && /\b(?:write|draft|produce|prepare|complete)\b/i.test(request)));
  const fullManuscript = scholarlyDraft && RESEARCH_MANUSCRIPT.test(request)
    && (LONG_BUILD.test(request) || /\b(?:write|draft|produce)\b.*\b(?:thesis|dissertation|paper)\b/i.test(request));
  const brainstorm = Boolean(understood.needsBrainstorming
    || (engine === 'research' && RESEARCH_EXPLORE.test(request)));
  const needsPlan = Boolean(understood.needsPlan || (codingWork && LONG_BUILD.test(request))
    || fullManuscript || (quantitative && methods && complex >= .65));
  const mandatoryVerification = codingWork || scholarlyDraft || quantitative || figure
    || researchDiscovery || highRisk || failure > 0;
  const substantial = codingWork || fullManuscript || quantitative || researchDiscovery;
  const shouldSeekIndependentCritique = !acceptanceSatisfied && !scarce
    && (highRisk || failure > 0 || conflictingEvidence || complex >= .72)
    && substantial;
  const frontier = [];
  if (brainstorm) frontier.push(stage('alternatives', 'Compare independent plausible approaches', false));
  if (needsPlan) frontier.push(stage('plan', 'Agree on dependencies, criteria and scoped resources', true));
  if (engine === 'coding') {
    if (codingWork) {
      frontier.push(stage('inspect-revision', 'Inspect repository changes and affected dependencies'));
      frontier.push(stage('implement', 'Apply only authorized changes to pinned revision'));
      frontier.push(stage('test', 'Execute relevant tests and record signed receipts'));
      frontier.push(stage('review', 'Check diff, regressions and security impact'));
    } else {
      frontier.push(stage('answer', 'Give precise technical explanation'));
    }
  } else {
    if (researchDiscovery) frontier.push(stage('source-discovery', 'Retrieve nonduplicative sources for material open questions'));
    if (researchDiscovery || scholarlyDraft) frontier.push(stage('claim-ledger', 'Link each significant claim to inspected provenance'));
    if (methods) frontier.push(stage('methods', 'Inspect and describe reproducible methodology'));
    if (quantitative) frontier.push(stage('quantitative-analysis', 'Compute reproducibly, check assumptions and units'));
    if (figure) frontier.push(stage('figures', 'Create traceable figures and verify axes and labels'));
    if (scholarlyDraft) frontier.push(stage('manuscript', 'Write requested sections with citation links'));
    if (!researchDiscovery && !scholarlyDraft && !methods && !quantitative && !figure)
      frontier.push(stage('answer', 'Answer the research question with appropriately qualified evidence'));
  }
  if (mandatoryVerification) frontier.push(stage('verify', 'Validate material acceptance evidence'));
  frontier.push(stage('deliver', 'Deliver the verified requested outcome; disclose any unmet checks'));

  const qualityKind = engine === 'coding' ? (codingWork ? 'implement' : 'answer')
    : scholarlyDraft ? 'manuscript' : quantitative ? 'quantitative' : figure ? 'figure' : 'answer';
  const quality = controlQualityRequirements({
    surface, taskKind: qualityKind,
    requiresEvidence: engine === 'research' && (scholarlyDraft || researchDiscovery),
    sourceEvidence, runtimeEvidence, authorization
  });
  const possibleRoles = engine === 'coding'
    ? [
      ...(codingWork && (needsPlan || complex >= .65) ? ['architect'] : []),
      ...(codingWork ? ['implementer'] : []),
      ...(failure ? ['debugger'] : []),
      ...(codingWork ? ['test-engineer'] : []),
      ...(highRisk ? ['security-reviewer'] : [])
    ] : [
      ...(researchDiscovery ? ['researcher'] : []),
      ...(methods ? ['methods-analyst'] : []),
      ...(quantitative ? ['statistician'] : []),
      ...(figure ? ['figure-specialist'] : []),
      ...(scholarlyDraft ? ['academic-writer'] : []),
      ...(conflictingEvidence || highRisk ? ['critic'] : [])
    ];
  // A list of roles is NOT a team recruited: specialist use is conditional
  // on actual independent work, available budget and shared execution policy.
  const roleCandidates = [...new Set(possibleRoles)];
  const optionalAgentCeiling = acceptanceSatisfied || scarce || !substantial
    ? 0 : Math.min(4, independent >= .65 ? 3 : independent >= .35 ? 2 : 1,
      roleCandidates.length);
  const maxParallel = optionalAgentCeiling >= 2 && independent >= .45 && !highRisk
    ? Math.min(optionalAgentCeiling, 4) : 1;
  const modelEffort = (highRisk || failure > 0 || unknown >= .7 || complex >= .78)
    ? 'high' : (substantial || unknown >= .35 || complex >= .4) ? 'medium' : 'low';
  const action = authorization?.required === true && authorization?.approved !== true
    ? 'approval-required'
    : acceptanceSatisfied ? 'deliver'
      : exhausted && substantial ? 'budget-gate'
        : understood.needsClarification ? 'clarify'
          : failure > 0 ? 'repair-from-evidence'
            : conflictingEvidence ? 'resolve-evidence-conflict'
              : verifiedStateReusable && !substantial ? 'reuse-verified-answer'
                : brainstorm ? 'brainstorm'
                  : needsPlan ? 'plan'
                    : engine === 'research' && researchDiscovery ? 'investigate'
                      : codingWork ? 'implement'
                        : 'answer';

  return Object.freeze({
    version: 1,
    controller: engine,
    advisoryOnly: true,
    action,
    understanding: Object.freeze({
      intent, needsPlan, needsBrainstorming: brainstorm,
      requiresClarification: understood.needsClarification === true
    }),
    candidateStages: Object.freeze(frontier),
    quality,
    candidateSpecialists: Object.freeze(roleCandidates),
    compute: Object.freeze({
      modelEffort,
      optionalAgentCeiling,
      maxParallel,
      needIndependentCritique: shouldSeekIndependentCritique,
      reuseVerifiedState: verifiedStateReusable === true,
      budgetKnown, remainingBudgetRatio: remaining,
      mandatoryVerification,
      noOptionalSpendWhenSatisfied: true
    }),
    safety: Object.freeze({
      authorizesTools: false,
      authorizesMutations: false,
      canDeclareCompletion: false,
      actualTasksAreOwnedBy: 'shared-RunStore',
      noSeparateRuntime: true
    })
  });
}
