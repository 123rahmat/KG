/**
 * Kindgleam's single task-entry policy interface.
 *
 * A deliberately small facade over proven independent checks: safety,
 * bounded execution, and situation/consent constraints. The controller
 * asks ONE question before scheduling any action. A failed gate never
 * creates a task, executes a tool or expands permissions.
 *
 * This replaces stacked orchestration decisions at task entry, NOT DB RLS,
 * tool permissions, payment/identity isolation, human approvals or the
 * privacy gate at a destination. Those remain mandatory enforcement.
 */
import { executionSafetyGate } from './adaptive-safety.js';
import { adaptiveExecutionBudgetStatus } from './adaptive-control.js';
import { situationGovernanceExecutionGate } from './situation-governance.js';

export const SIMPLE_POLICY_GATE_VERSION = '1';

const denied = (code, status, reason, detail = {}) => Object.freeze({
  allowed: false,
  code,
  status,
  reason: String(reason || 'This action is not permitted.'),
  detail: Object.freeze(detail),
  version: SIMPLE_POLICY_GATE_VERSION
});

/**
 * Enforce exactly the same ordering and denial codes as the previous
 * execution route: safety -> budget -> situation.
 * All inputs originate from the server's persisted run and scoped request.
 */
export function checkTaskPolicy(run, task, {
  blockedTopics = [],
  payload = null,
  external = false
} = {}) {
  const safety = executionSafetyGate(run, task, { blockedTopics, payload });
  if (!safety.allowed) return denied(
    'adaptive-safety-blocked', 422, safety.reason,
    { category: safety.category ?? null, source: safety.source ?? null }
  );

  const budget = adaptiveExecutionBudgetStatus(run, task);
  if (!budget.allowed) return denied(
    budget.code || 'adaptive-budget-exhausted', 409, budget.reason,
    {
      completedExecutionStages: budget.completedExecutionStages ?? null,
      maxExecutionStages: budget.maxExecutionStages ?? null,
      completedToolCalls: budget.completedToolCalls ?? null,
      maxToolCalls: budget.maxToolCalls ?? null
    }
  );

  const situation = situationGovernanceExecutionGate(run, task, { external });
  if (!situation.allowed) return denied(
    'situation-governance-blocked', 422, situation.reason,
    { source: situation.source ?? null }
  );

  return Object.freeze({
    allowed: true,
    code: 'allowed',
    status: 200,
    reason: 'Policy gate passed.',
    detail: Object.freeze({
      adaptiveReply: safety.adaptiveReply === true,
      humanApprovalRequired: situation.humanApprovalRequired === true,
      approvalReasons: Object.freeze([...(situation.approvalReasons ?? [])].slice(0, 8))
    }),
    version: SIMPLE_POLICY_GATE_VERSION
  });
}

/**
 * One readable policy view for task supervision and UI. This does not
 * execute the action or replace the specific execution-target approval.
 */
export function taskPolicySummary(decision = {}) {
  return Object.freeze({
    ready: decision.allowed === true,
    needsHumanApproval: decision.detail?.humanApprovalRequired === true,
    denialCode: decision.allowed === false ? String(decision.code || 'policy-blocked') : null,
    boundary: 'safety + budget + privacy/authorization',
    authority: 'server-only'
  });
}
