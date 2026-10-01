/**
 * Server-owned adaptive runtime projection.
 * run_tasks remains authoritative; this is a bounded recovery/UI projection.
 */
const text = value => String(value ?? '').trim();
const clip = (value, max = 500) => {
  const raw = text(value);
  return raw.length > max ? raw.slice(0, max) + '…' : raw;
};
export function updateAdaptiveRuntimeState(previous = {}, {
  run, target, nextTask = null, status = 'complete', evidence = null,
  execution = false, verification = null, reason = ''
} = {}) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const transition = {
    at: new Date().toISOString(),
    attempt: Number(run?.attempt ?? prior.attempt ?? 1),
    completedTask: text(target?.id) || null,
    completedType: text(target?.type) || null,
    status: text(status) || 'complete',
    nextTask: text(nextTask?.id) || null,
    nextType: text(nextTask?.type) || null,
    evidenceObserved: evidence !== null && evidence !== undefined,
    executionObserved: execution === true,
    verificationPassed: verification?.verdict === 'pass',
    reason: clip(reason)
  };
  const history = Array.isArray(prior.history) ? prior.history : [];
  const next = {
    version: 1, attempt: transition.attempt,
    currentTask: transition.nextTask, currentStage: transition.nextType,
    lastCompletedTask: transition.completedTask,
    lastCompletedType: transition.completedType,
    lastStatus: transition.status,
    evidenceObserved: transition.evidenceObserved,
    executionObserved: transition.executionObserved,
    verificationPassed: transition.verificationPassed
      || (prior.verificationPassed === true && transition.completedType !== 'verify'),
    lastTransition: transition, history: [...history, transition].slice(-32)
  };
  if (status === 'failed') next.lastFailure = {
    task: transition.completedTask, type: transition.completedType, reason: clip(reason)
  };
  else if (transition.completedType === 'verify' && transition.verificationPassed) next.lastFailure = null;
  return next;
}


const RETRYABLE_RECOVERY = new Set(['timeout', 'dependency', 'stale-state']);
const REPLAN_RECOVERY = new Set(['tests', 'syntax', 'verification', 'other']);
const ESCALATE_RECOVERY = new Set(['authorization', 'security']);

export function classifyRecoveryFailure(reason = '') {
  const value = text(reason).toLowerCase();
  if (!value) return 'other';
  if (/syntax|parse/.test(value)) return 'syntax';
  if (/test|assert|regression/.test(value)) return 'tests';
  if (/timeout|timed.?out|slow/.test(value)) return 'timeout';
  if (/permission|forbidden|unauthori[sz]ed|approval/.test(value)) return 'authorization';
  if (/stale|revision|conflict|concurrency/.test(value)) return 'stale-state';
  if (/security|secret|injection|privacy/.test(value)) return 'security';
  if (/provider|model|network|connector|dependency/.test(value)) return 'dependency';
  if (/verification|evidence|unsupported/.test(value)) return 'verification';
  return 'other';
}

export function decideRecovery({
  taskType = '',
  reason = '',
  attempt = 1,
  maxAttempts = 1,
  governanceStatus = 'ready',
  humanReviewRequired = false,
  repairAvailable = false
} = {}) {
  const failureClass = classifyRecoveryFailure(reason);
  const currentAttempt = Math.max(1, Number(attempt) || 1);
  const maximum = Math.max(1, Number(maxAttempts) || 1);

  if (governanceStatus === 'blocked') {
    return { action: 'stop', failureClass, reason: 'governance-blocked', terminal: true };
  }
  if (humanReviewRequired || ESCALATE_RECOVERY.has(failureClass)) {
    return {
      action: 'escalate',
      failureClass,
      reason: humanReviewRequired ? 'human-review-required' : 'safety-or-authorization-boundary',
      terminal: false
    };
  }
  if (currentAttempt >= maximum) {
    return { action: 'stop', failureClass, reason: 'attempt-budget-exhausted', terminal: true };
  }
  if (repairAvailable && ['tests', 'syntax', 'other'].includes(failureClass) && String(taskType).startsWith('code')) {
    return { action: 'repair', failureClass, reason: 'targeted-code-repair-available', terminal: false };
  }
  if (RETRYABLE_RECOVERY.has(failureClass)) {
    return { action: 'retry', failureClass, reason: 'transient-failure-class', terminal: false };
  }
  if (REPLAN_RECOVERY.has(failureClass)) {
    return { action: 'replan', failureClass, reason: 'new-plan-needed-from-failure-evidence', terminal: false };
  }
  return { action: 'replan', failureClass, reason: 'bounded-general-recovery', terminal: false };
}

export function recoveryLesson(decision, { taskId = '', summary = '' } = {}) {
  return {
    version: 1,
    taskId: text(taskId) || null,
    action: decision?.action ?? 'replan',
    failureClass: decision?.failureClass ?? 'other',
    reason: decision?.reason ?? 'unknown',
    summary: text(summary).slice(0, 300)
  };
}
