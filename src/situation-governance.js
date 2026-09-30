/**
 * Situation-aware governance contract.
 *
 * Governance adapts to the actual task: risk, domain, data sensitivity,
 * jurisdiction, human autonomy, side effects, policy and verification.
 * It is a control layer, not a legal-compliance certificate.
 */

import { privacyDecision } from './privacy.js';

export const SITUATION_GOVERNANCE_CONTRACT_VERSION = '1';

const text = value => String(value ?? '').trim();
const uniq = value => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];

const RISK_ORDER = Object.freeze({ ordinary: 0, physical: 1, 'high-impact': 2, crisis: 3 });

function riskOf(...values) {
  return values.flatMap(value => [value])
    .map(text)
    .map(value => value.toLowerCase())
    .filter(value => Object.hasOwn(RISK_ORDER, value))
    .sort((a, b) => RISK_ORDER[b] - RISK_ORDER[a])[0] || 'ordinary';
}

function sensitivityOf(classes) {
  const data = uniq(classes);
  if (data.some(item => ['credentials', 'payment', 'workspace-secret'].includes(item))) return 'restricted';
  if (data.some(item => item.startsWith('private-') || item === 'identity')) return 'sensitive';
  if (data.some(item => ['user-content', 'workspace-content', 'external-service-data'].includes(item))) return 'confidential';
  return 'public';
}

function signalsFor(goal, situation, model) {
  const value = [
    goal,
    situation?.domain,
    ...(Array.isArray(model?.actions) ? model.actions : [])
  ].map(text).join(' ').toLowerCase();
  return {
    education: /education|school|student|teacher|course|class|exam|grade|learning/.test(value),
    business: /business|company|organization|customer|revenue|market|operations?|cost|budget/.test(value),
    scheduling: /schedule|calendar|deadline|appointment|reminder|timeline/.test(value),
    costing: /cost|price|budget|estimate|quote|financial|payment|tax/.test(value),
    engineering: /engineering|circuit|robot|vehicle|physics|model|experiment/.test(value),
    // A decision about people: who to hire, fire, admit, grade, lend to or
    // rank. Whole words and phrases, so "grade 8", "firefox", "frankly",
    // "benefits of exercise" and "credit card" are not decisions about anyone.
    peopleDecision: PEOPLE_DECISION.test(value),
    // Whole words and their forms (illegal, legally, taxable, financially,
    // clinically), never a part of another word ("syntax" is not a tax).
    regulated: /\b(?:medic(?:al|ally|ine|ines|ation|ations)|clinic(?:al|ally|s)?|patients|(?:a|the|my|our|this|that) patient|(?:il)?legal(?:ly|ity|ities|i[sz]e[ds]?)?|courts?|tax(?:es|ed|able|ation)?|financ(?:e|es|ial|ially|ing)|payments?|safety[- ]critical|life[- ]critical|chemicals?|hazard\w*|regulat(?:ed|ion|ions|ory))\b/.test(value)
  };
}

export const PEOPLE_DECISION = new RegExp([
  String.raw`\b(?:hir(?:e|es|ed|ing)|dismiss(?:es|ed|ing|al)?|lay(?:ing)? off|laid off|promot(?:e|ed|ing|ion) (?:him|her|them|someone|staff|an? employee))\b`,
  String.raw`\bfir(?:e|es|ed|ing) (?:him|her|them|someone|staff|an? (?:employee|worker|manager|teacher)|my (?:employee|worker|assistant))\b`,
  String.raw`\b(?:admissions?|admit(?:s|ted|ting)? (?:a |the |these |this )?(?:students?|applicants?|candidates?|patients?))\b`,
  String.raw`\bgrad(?:e|es|ed|ing) (?:the |my |their |these |this |all )?(?:students?|pupils?|essays?|papers?|exams?|assignments?|class)\b`,
  String.raw`\b(?:loan|mortgage|credit) (?:approvals?|applications?|decisions?|worthiness|scor(?:e|es|ing))\b|\bcreditworthiness\b`,
  String.raw`\b(?:benefits?|welfare|visa|asylum) (?:eligibility|claims?|decisions?|applications?)\b|\beligib\w* (?:for|to)\b`,
  String.raw`\b(?:rank|ranking|score|scoring|reject|rejecting|shortlist|shortlisting|select|selecting|screen|screening|evaluate|evaluating) (?:\w+ ){0,3}(?:candidates?|applicants?|employees?|students?|people|staff|tenants?|borrowers?)\b`,
  String.raw`\bstudent outcomes?\b`
].join('|'));

export function evaluateSituationGovernance({
  goal = '',
  situation = {},
  goalModel = {},
  safety = {},
  policyDecision = null,
  dataClasses = [],
  privacyConsent = {},
  externalData = {},
  candidateCapabilities = [],
  candidateTools = [],
  candidateSideEffects = []
} = {}) {
  const risk = riskOf(situation?.risk, situation?.highImpact ? 'high-impact' : '', situation?.physical ? 'physical' : '',
    safety?.decision === 'refuse' ? 'crisis' : '');
  const domains = signalsFor(goal, situation, goalModel);
  const sensitivity = sensitivityOf(dataClasses);
  const privateData = sensitivity !== 'public';
  const modelProviderConsent = privacyConsent?.modelProvider === true;
  const externalEgress = Boolean(externalData?.sources?.length || externalData?.authorizationRequired?.length || privateData);

  const privacy = privacyDecision({
    workspaceScope: text(situation?.workspaceId || situation?.workspace?.id) || 'authenticated-workspace',
    principalScope: text(situation?.principalId || situation?.user?.id) || 'authenticated-user',
    dataClasses: dataClasses.length ? dataClasses : ['user-content'],
    destination: externalEgress ? 'external-model-or-connector' : 'internal',
    connectionAuthorized: externalData?.authorizationRequired?.length === 0,
    explicitConsent: modelProviderConsent
  });

  const jurisdiction = text(situation?.jurisdiction);
  const jurisdictionRequired = risk === 'high-impact' || domains.regulated;
  const jurisdictionPolicyConfigured = Boolean(policyDecision?.sources?.some(source => source.layer === 'jurisdiction'));
  const jurisdictionReviewRequired = jurisdictionRequired && (!jurisdiction || !jurisdictionPolicyConfigured);
  const peopleDecision = domains.peopleDecision
    || safety?.requiresHumanDecision === true
    || safety?.care?.includes?.('people-decisions') === true;

  const approvalReasons = uniq([
    risk === 'physical' ? 'physical or real-world action' : '',
    risk === 'high-impact' ? 'high-impact or regulated workflow' : '',
    peopleDecision ? 'consequential decision must remain with a human' : '',
    candidateSideEffects.length ? 'external side effect' : '',
    policyDecision?.constraints?.requireHumanApproval ? 'server policy requires human approval' : ''
  ]);

  const policyIncomplete = policyDecision?.status === 'incomplete';
  const constraints = policyDecision?.constraints ?? {};
  const matches = (rule, value) => rule === '*' || rule === text(value)
    || (String(rule).endsWith('*') && text(value).startsWith(String(rule).slice(0, -1)))
    || (String(rule).startsWith('*') && text(value).endsWith(String(rule).slice(1)));
  const deniedCapability = candidateCapabilities.some(capability =>
    (constraints.deniedCapabilities ?? []).some(rule => matches(rule, capability))
  );
  const deniedTool = candidateTools.some(tool =>
    (constraints.deniedTools ?? []).some(rule => matches(rule, tool))
  );
  const deniedDataClass = dataClasses.some(dataClass =>
    (constraints.deniedDataClasses ?? []).some(rule => matches(rule, dataClass))
  );
  const capabilityNotAllowed = (constraints.allowedCapabilities ?? []).length > 0
    && candidateCapabilities.some(capability => !(constraints.allowedCapabilities ?? []).some(rule => matches(rule, capability)));
  const toolNotAllowed = (constraints.allowedTools ?? []).length > 0
    && candidateTools.some(tool => !(constraints.allowedTools ?? []).some(rule => matches(rule, tool)));
  const dataClassNotAllowed = (constraints.allowedDataClasses ?? []).length > 0
    && dataClasses.some(dataClass => !(constraints.allowedDataClasses ?? []).some(rule => matches(rule, dataClass)));
  const riskNotAllowed = (constraints.allowedRiskClasses ?? []).length > 0
    && !(constraints.allowedRiskClasses ?? []).some(rule => matches(rule, risk));
  const blockedByPolicy = deniedCapability || deniedTool || deniedDataClass
    || capabilityNotAllowed || toolNotAllowed || dataClassNotAllowed || riskNotAllowed;

  const restrictions = uniq([
    privateData && !modelProviderConsent ? 'Do not send private data to an external model or connector without explicit consent.' : '',
    jurisdictionReviewRequired ? 'Do not claim legal or regulatory compliance until the jurisdiction and applicable rules are verified.' : '',
    peopleDecision ? 'AI may assist with information and analysis, but a human person makes the consequential decision.' : '',
    risk === 'physical' || risk === 'high-impact' ? 'Model output is not professional, legal, safety or regulatory certification.' : '',
    candidateSideEffects.length ? 'Require explicit approval immediately before a side effect.' : '',
    candidateTools.length ? 'Authorize each external tool and scope it to the minimum necessary data.' : ''
  ]);

  let status = 'ready';
  if (safety?.decision === 'refuse' || blockedByPolicy) status = 'blocked';
  else if (jurisdictionReviewRequired || policyIncomplete || (privateData && !modelProviderConsent)) status = 'review';
  else if (risk !== 'ordinary' || approvalReasons.length) status = 'care';

  const requiredChecks = uniq([
    'authenticate-and-scope',
    'apply-safety-decision',
    'minimize-data',
    'check-server-policy',
    'preserve-provenance',
    'verify-before-delivery',
    privateData ? 'obtain-external-data-consent' : '',
    jurisdictionReviewRequired ? 'resolve-jurisdiction' : '',
    peopleDecision ? 'human-decision-required' : '',
    risk === 'physical' || risk === 'high-impact' ? 'independent-verification' : '',
    candidateTools.length ? 'authorize-tools' : '',
    candidateCapabilities.length ? 'verify-capabilities' : '',
    candidateSideEffects.length ? 'side-effect-approval' : ''
  ]);

  return {
    contractVersion: SITUATION_GOVERNANCE_CONTRACT_VERSION,
    status,
    risk,
    domains,
    data: {
      classes: uniq(dataClasses.length ? dataClasses : ['user-content']),
      sensitivity,
      privateData,
      externalEgress,
      modelProviderConsent,
      privacyReason: privacy.reason,
      minimumNecessary: true,
      noCrossWorkspaceAccess: true,
      noCrossPrincipalAccess: true
    },
    jurisdiction: {
      value: jurisdiction || null,
      status: jurisdiction ? 'known' : jurisdictionRequired ? 'required' : 'not-required',
      required: jurisdictionRequired,
      policyConfigured: jurisdictionPolicyConfigured,
      reviewRequired: jurisdictionReviewRequired
    },
    ethics: {
      humanAutonomy: peopleDecision || risk !== 'ordinary',
      finalHumanDecisionRequired: peopleDecision,
      transparencyRequired: true,
      explainMaterialDecisions: risk !== 'ordinary' || peopleDecision,
      antiManipulationBoundary: true,
      nonDiscriminationBoundary: peopleDecision,
      noModelAuthority: true
    },
    execution: {
      allowed: status !== 'blocked' && !jurisdictionReviewRequired,
      humanApprovalRequired: approvalReasons.length > 0,
      approvalReasons,
      sideEffects: uniq(candidateSideEffects),
      tools: uniq(candidateTools),
      capabilities: uniq(candidateCapabilities)
    },
    verification: {
      evidenceRequired: true,
      provenanceRequired: true,
      independentVerificationRequired: risk !== 'ordinary' || candidateSideEffects.length > 0,
      humanCertificationRequired: risk === 'physical' || risk === 'high-impact' || peopleDecision
    },
    requiredChecks,
    restrictions,
    reasons: uniq([
      safety?.decision === 'refuse' ? 'safety refused the situation' : '',
      deniedCapability || capabilityNotAllowed ? 'server policy does not allow a required capability' : '',
      deniedTool || toolNotAllowed ? 'server policy does not allow a required tool' : '',
      deniedDataClass || dataClassNotAllowed ? 'server policy does not allow a required data class' : '',
      riskNotAllowed ? 'server policy does not allow this risk class' : '',
      jurisdictionReviewRequired ? 'jurisdiction is missing' : '',
      policyIncomplete ? 'server policy is incomplete' : ''
    ]),
    policy: {
      status: policyDecision?.status || 'unconfigured',
      complianceClaim: false
    },
    principle: 'Adapt the workflow to the situation without adapting away safety, privacy, authorization, human autonomy, provenance or verification.'
  };
}

const STATUS_ORDER = Object.freeze({ ready: 0, care: 1, review: 2, blocked: 3 });

/**
 * Re-evaluate governance after the workflow discovers capabilities it did
 * not plan for. The inputs only grow — capabilities, tools, side effects,
 * data classes and risk seen so far are all kept — so a discovery can make
 * governance stricter, never looser. Consent is read as it stands now.
 */
export function reevaluateSituationGovernance({ goal = '', situation = {}, adaptation = {}, policyDecision = null } = {}, discovered = []) {
  const previous = adaptation?.governance ?? null;
  const specs = (Array.isArray(discovered) ? discovered : []).filter(item => item && typeof item === 'object');
  const physical = specs.some(item => item.physical === true);
  const highImpact = specs.some(item => item.highImpact === true || item.risk === 'critical');
  const fresh = evaluateSituationGovernance({
    goal,
    situation: {
      ...situation,
      risk: riskOf(situation?.risk, previous?.risk, highImpact ? 'high-impact' : '', physical ? 'physical' : '')
    },
    goalModel: adaptation?.goalModel ?? null,
    safety: adaptation?.safety ?? {},
    policyDecision,
    dataClasses: uniq([
      ...(previous?.data?.classes ?? adaptation?.dataClasses ?? []),
      ...specs.flatMap(item => item.dataClasses ?? [])
    ]),
    privacyConsent: adaptation?.privacy?.consent ?? {},
    externalData: adaptation?.externalData ?? {},
    candidateCapabilities: uniq([...(previous?.execution?.capabilities ?? []), ...specs.map(item => item.id)]),
    candidateTools: uniq([...(previous?.execution?.tools ?? []), ...specs.flatMap(item => item.tools ?? [])]),
    candidateSideEffects: uniq([
      ...(previous?.execution?.sideEffects ?? []),
      ...specs.filter(item => item.sideEffects === true).map(item => item.id)
    ])
  });
  const merged = previous ? stricterOf(previous, fresh) : fresh;
  return {
    ...merged,
    reevaluations: (previous?.reevaluations ?? 0) + 1,
    escalated: Boolean(previous) && STATUS_ORDER[merged.status] > (STATUS_ORDER[previous.status] ?? 0)
  };
}

/**
 * Keep the stricter of two governance records, field by field: the higher
 * status and risk, any requirement either demands, the intersection of
 * permissions, and every restriction, reason and check. A changed situation
 * or recorded consent can therefore never relax governance mid-run.
 */
function stricterOf(previous, fresh) {
  const status = (STATUS_ORDER[previous.status] ?? 0) > (STATUS_ORDER[fresh.status] ?? 0) ? previous.status : fresh.status;
  const either = (a, b) => a === true || b === true;
  const both = (a, b) => a !== false && b !== false;
  return {
    ...fresh,
    status,
    risk: riskOf(previous.risk, fresh.risk),
    data: {
      ...fresh.data,
      classes: uniq([...(previous.data?.classes ?? []), ...(fresh.data?.classes ?? [])]),
      privateData: either(previous.data?.privateData, fresh.data?.privateData),
      externalEgress: either(previous.data?.externalEgress, fresh.data?.externalEgress)
    },
    jurisdiction: {
      ...fresh.jurisdiction,
      required: either(previous.jurisdiction?.required, fresh.jurisdiction?.required),
      reviewRequired: either(previous.jurisdiction?.reviewRequired, fresh.jurisdiction?.reviewRequired)
    },
    ethics: Object.fromEntries(Object.keys({ ...previous.ethics, ...fresh.ethics })
      .map(key => [key, either(previous.ethics?.[key], fresh.ethics?.[key])])),
    execution: {
      ...fresh.execution,
      allowed: both(previous.execution?.allowed, fresh.execution?.allowed) && status !== 'blocked',
      humanApprovalRequired: either(previous.execution?.humanApprovalRequired, fresh.execution?.humanApprovalRequired),
      approvalReasons: uniq([...(previous.execution?.approvalReasons ?? []), ...(fresh.execution?.approvalReasons ?? [])])
    },
    verification: Object.fromEntries(Object.keys({ ...previous.verification, ...fresh.verification })
      .map(key => [key, either(previous.verification?.[key], fresh.verification?.[key])])),
    requiredChecks: uniq([...(previous.requiredChecks ?? []), ...(fresh.requiredChecks ?? [])]),
    restrictions: uniq([...(previous.restrictions ?? []), ...(fresh.restrictions ?? [])]),
    reasons: uniq([...(previous.reasons ?? []), ...(fresh.reasons ?? [])])
  };
}

// Steps that act (run code or tools, research outside) rather than reason.
const ACTING_TASKS = new Set(['code', 'tool', 'investigate']);

/**
 * Receipts and approved actions pass `external: true`: they report or cause
 * work outside the model whatever the task they are attached to.
 */
export function situationGovernanceExecutionGate(run, task, { external = false } = {}) {
  const governance = run?.adaptation?.governance;
  if (!governance) return { allowed: true, source: 'legacy-no-governance' };
  // A declined request understood adaptively: one reasoning-only reply to the
  // person's real need and its check, never tools or execution.
  if (run?.adaptation?.safetyAdaptive === true
    && ((task?.type === 'respond' && task?.metadata?.declined === true) || task?.type === 'verify')) {
    return { allowed: true, humanApprovalRequired: false, approvalReasons: [], source: 'adaptive-decline', taskId: text(task?.id) || null };
  }
  if (governance.status === 'blocked') {
    const reasons = uniq(governance.reasons);
    return {
      allowed: false,
      reason: reasons.length ? `Situation governance blocks this execution: ${reasons.join('; ')}.` : 'Situation governance blocks this execution.',
      source: 'persisted-situation-governance'
    };
  }
  // An unknown jurisdiction stops steps that act; reasoning steps still help,
  // with general information and the restriction that rules depend on it.
  const acts = external || task?.metadata?.execution === true || ACTING_TASKS.has(task?.type);
  if (governance.jurisdiction?.reviewRequired && acts) {
    return { allowed: false, reason: 'The applicable jurisdiction must be established before this governed execution.', source: 'persisted-situation-governance' };
  }
  if (governance.execution?.allowed === false && !(governance.jurisdiction?.reviewRequired && !acts)) {
    return { allowed: false, reason: 'Situation governance does not permit this execution.', source: 'persisted-situation-governance' };
  }
  return {
    allowed: true,
    humanApprovalRequired: governance.execution?.humanApprovalRequired === true,
    approvalReasons: governance.execution?.approvalReasons ?? [],
    source: 'persisted-situation-governance',
    taskId: text(task?.id) || null
  };
}
