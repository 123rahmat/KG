/**
 * What one step sends the model: only what that step uses.
 *
 * The server keeps its full planning records (implementation plan, goal
 * model, resource plan, governance record) for itself. A step is sent the
 * parts it acts on, in compact form, and nothing that is empty: a greeting
 * does not carry the capability graph, and a verifier does not carry the
 * implementation plan. The records themselves are unchanged and still
 * enforced by the server.
 */

import { taskTools } from './work-scale.js';
import { adaptiveStepScope } from './adaptive-control.js';

const PLANNING = new Set(['discover-capabilities', 'reassess']);
const ANSWERING = new Set(['respond', 'deliver', 'prototype', 'step', 'investigate', 'tool']);

const present = value => (Array.isArray(value) ? value.length > 0
  : value && typeof value === 'object' ? Object.keys(value).length > 0
    : value !== undefined && value !== null && value !== '');

/** Drop empty fields, so the request carries only what exists. */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => present(value)));
}

/** The governance record as the model follows it: status, restrictions, and the flags that change what it may do. */
export function compactGovernance(governance) {
  if (!governance || typeof governance !== 'object') return null;
  const flags = record => (record && typeof record === 'object'
    ? Object.fromEntries(Object.entries(record).filter(([, value]) => value === true))
    : {});
  return compact({
    status: governance.status,
    restrictions: governance.restrictions,
    reasons: governance.reasons,
    jurisdiction: governance.jurisdiction?.reviewRequired ? { reviewRequired: true } : null,
    ethics: flags(governance.ethics),
    requiredChecks: governance.requiredChecks
  });
}

/** The working scope: what is selected, and the budget it must stay within. */
export function compactResourcePlan(plan, task = null, need = null) {
  if (!plan || typeof plan !== 'object') return null;
  const selected = plan.selected ?? {};
  const step = task ? adaptiveStepScope(plan, task, { need }) : null;
  const scopedSelected = step ? {
    capabilities: step.capabilities,
    dataSources: step.dataSources,
    artifacts: step.artifacts,
    tools: step.tools
  } : selected;
  return compact({
    level: step ? 'step' : 'task',
    // The system's own machinery is in every run; only the current scope is listed.
    selected: compact({
      capabilities: taskTools(scopedSelected.capabilities),
      dataSources: scopedSelected.dataSources,
      artifacts: scopedSelected.artifacts,
      tools: scopedSelected.tools
    }),
    ...(step?.surfaces?.length ? { surfaces: step.surfaces } : {}),
    exactNeed: step?.exactNeed ?? null,
    adaptiveControl: step?.adaptiveControl ? {
      depth: step.adaptiveControl.depth,
      intensity: step.adaptiveControl.intensity,
      capabilityInvestment: step.adaptiveControl.capabilityInvestment,
      allowAdaptiveExpansion: step.adaptiveControl.allowAdaptiveExpansion,
      budget: {
        maxToolCalls: step.adaptiveControl.budget?.maxToolCalls,
        maxContextItems: step.adaptiveControl.budget?.maxContextItems,
        maxDiscoveryRounds: step.adaptiveControl.budget?.maxDiscoveryRounds
      }
    } : null,
    budget: plan.budget ? {
      maxToolCalls: plan.budget.maxToolCalls,
      maxContextItems: plan.budget.maxContextItems,
      maxExternalSources: plan.budget.maxExternalSources
    } : null,
    omitted: compact({ capabilities: taskTools(plan.omitted?.capabilities), dataSources: plan.omitted?.dataSources }),
    expansion: plan.expansion?.rule ?? null
  });
}

/** Which capabilities can run here and which cannot, without their full specs. */
export function compactImplementationPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return compact({
    state: plan.state,
    available: (plan.implementations ?? []).filter(item => item.executable).map(item => item.capabilityId),
    missing: plan.missing,
    blocked: plan.blocked
  });
}

/**
 * The adaptation block for one step. Planning steps (discovery and
 * reassessment) see the capability picture; answering steps see the scope
 * and limits they must respect; every step sees governance.
 */
export function adaptationFor(run, task) {
  const adaptation = run.adaptation ?? {};
  const type = task?.type ?? '';
  const planning = PLANNING.has(type);
  const scoped = run.workflow !== 'direct' && (ANSWERING.has(type) || planning || type === 'plan');
  const scopedPlan = scoped
    ? compactResourcePlan(adaptation.resourcePlan, task, run.situation?.need ?? null)
    : null;
  return compact({
    governance: compactGovernance(adaptation.governance),
    notAvailableHere: adaptation.notAvailableHere,
    // Only for the attempt it happened in: a later attempt's code did run.
    codeNotRun: adaptation.codeNotRun && Number(adaptation.codeNotRun.attempt ?? run.attempt) === Number(run.attempt ?? 1) ? adaptation.codeNotRun : null,
    // A check sees one list of criteria, the one it is graded on
    // (situation.successCriteria); the understanding's own wording of them
    // would compete with it.
    understanding: type === 'understand' ? null
      : type === 'verify' && adaptation.understanding ? { ...adaptation.understanding, successCriteria: undefined, outputs: undefined, requirements: undefined }
        : adaptation.understanding,
    exactNeed: run.situation?.need ?? adaptation.need ?? null,
    adaptiveLevels: scoped ? {
      order: ['user', 'task', 'step', 'need'],
      current: type ? 'step' : 'task'
    } : null,
    scale: ['understand', 'plan'].includes(type) ? adaptation.scale : null,
    resourcePlan: scopedPlan,
    ...(planning ? {
      requirements: adaptation.requirements,
      dynamicRequirements: adaptation.dynamicRequirements,
      capabilityContracts: adaptation.capabilityContracts,
      implementationPlan: compactImplementationPlan(adaptation.implementationPlan),
      lastDiscovery: type === 'reassess' ? adaptation.lastDiscovery : null,
      lastReassessment: type === 'reassess' ? adaptation.lastReassessment : null
    } : {}),
    ...(type === 'plan' ? { requirements: adaptation.requirements } : {})
  });
}
