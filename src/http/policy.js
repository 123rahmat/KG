/**
 * Governance and privacy checks applied at execution time, and which
 * execution targets this deployment has configured.
 */

import { privacyDecision, normalizeDataClasses } from '../privacy.js';
import { executionTargetsFor } from '../execution.js';
import { policyAllows } from '../core.js';

export function targetConfigured(config, target) {
  if (target === 'local') return Boolean(config.execution.localAgentUrl && config.execution.localAgentSharedSecret);
  if (target === 'general-ai-sandbox') return Boolean(config.runners.sandbox);
  if (target === 'generic-tool-router') return Boolean(config.runners.tools);
  // Research uses the AI model's own web search and this app's fetcher.
  // Kindgleam's own toolbox needs only the AI model.
  if (target === 'builtin-tools') return Boolean(config.ai);
  if (target === 'builtin-research') return Boolean(config.ai) && config.tools?.webAccess !== false;
  return false;
}

export function configuredExecutionTargets(config, taskType) {
  return executionTargetsFor(taskType).filter(target => targetConfigured(config, target));
}

export function runnerForTarget(config, target) {
  if (target === 'general-ai-sandbox') return config.runners.sandbox;
  if (target === 'generic-tool-router') return config.runners.tools;
  return null;
}

export function planPolicyAllows(run, target, risk, dataClass = '') {
  return !run.governance?.constraints || policyAllows(run.governance, { tool: target, risk, dataClass });
}

export function dataPolicyAllows(run, dataClasses, destination, options) {
  return dataPolicyDecision(run, dataClasses, destination, options).allowed;
}

export function dataPolicyDecision(run, dataClasses = ['user-content'], destination = 'external-provider', {
  connectionAuthorized = true,
  explicitConsent = false
} = {}) {
  const constraints = run.governance?.constraints ?? {};
  const classes = normalizeDataClasses(dataClasses);
  // Fail closed only where governance actually speaks about data classes. If
  // any layer declares an allow-list, the intersection governs, even when
  // it is empty. If none does (the seeded platform default is `{}`),
  // there is no allow-list to enforce, and consent and deny rules decide.
  const sources = Array.isArray(run.governance?.sources) ? run.governance.sources : [];
  const allowListDeclared = sources.some(source => source?.allowedDataClassesSpecified === true);
  const allowedDataClasses = allowListDeclared
    ? classes.filter(dataClass => policyAllows(run.governance, { dataClass }))
    : ['*'];
  const decision = privacyDecision({
    workspaceScope: run.workspaceId ?? run.situation?.workspace?.id ?? null,
    principalScope: run.principalId ?? null,
    dataClasses: classes,
    destination,
    allowedDataClasses,
    deniedDataClasses: constraints.deniedDataClasses ?? [],
    connectionAuthorized,
    explicitConsent
  });
  if (decision.allowed && run.governance && classes.some(dataClass => !policyAllows(run.governance, { dataClass }))) {
    return { ...decision, allowed: false, reason: 'data-class-not-authorized-by-policy' };
  }
  return decision;
}

export function modelPolicyAllows(run, model, risk = 'medium') {
  return !run.governance?.constraints || policyAllows(run.governance, { model, risk });
}
