/**
 * Server-owned adaptive runtime projection.
 *
 * Decision authority lives in adaptive-decision-authority.js and the unified
 * workflow kernel. This module stores bounded runtime history and keeps a
 * small compatibility facade for older callers; it does not own recovery.
 */
import { classifyAdaptiveFailure, recoveryDecision } from './adaptive-decision-authority.js';

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
    version: 1,
    attempt: transition.attempt,
    currentTask: transition.nextTask,
    currentStage: transition.nextType,
    lastCompletedTask: transition.completedTask,
    lastCompletedType: transition.completedType,
    lastStatus: transition.status,
    evidenceObserved: transition.evidenceObserved,
    executionObserved: transition.executionObserved,
    verificationPassed: transition.verificationPassed
      || (prior.verificationPassed === true && transition.completedType !== 'verify'),
    lastTransition: transition,
    history: [...history, transition].slice(-32)
  };
  if (status === 'failed') {
    next.lastFailure = {
      task: transition.completedTask,
      type: transition.completedType,
      reason: clip(reason)
    };
  } else if (transition.completedType === 'verify' && transition.verificationPassed) {
    next.lastFailure = null;
  }
  return next;
}

/**
 * Compatibility classification for callers that still use this module.
 * The canonical failure taxonomy is shared with the main recovery authority.
 */
export function classifyRecoveryFailure(reason = '') {
  const canonical = classifyAdaptiveFailure(reason);
  if (canonical === 'implementation') return 'syntax';
  if (canonical === 'verification') {
    return /test|assert|regression/i.test(String(reason)) ? 'tests' : 'verification';
  }
  if (canonical === 'transient') {
    return /timeout|timed.?out|slow/i.test(String(reason)) ? 'timeout' : 'dependency';
  }
  if (canonical === 'missing-capability') return 'dependency';
  if (canonical === 'unknown' || canonical === 'fundamental' || canonical === 'wrong-assumption') return 'other';
  return canonical;
}

/**
 * Legacy compatibility facade. New run code uses unifiedRecoveryDecision()
 * directly; this function delegates to the canonical recovery authority.
 */
export function decideRecovery({
  taskType = '',
  reason = '',
  attempt = 1,
  maxAttempts = 1,
  governanceStatus = 'ready',
  humanReviewRequired = false,
  repairAvailable = false
} = {}) {
  const currentAttempt = Math.max(1, Number(attempt) || 1);
  const maximum = Math.max(1, Number(maxAttempts) || 1);
  const failureClass = classifyRecoveryFailure(reason);

  if (governanceStatus === 'blocked') {
    return { action: 'stop', failureClass, reason: 'governance-blocked', terminal: true };
  }

  // Human review remains a compatibility signal for callers that have not yet
  // moved to the unified workflow's authority contract.
  if (humanReviewRequired) {
    return { action: 'escalate', failureClass, reason: 'human-review-required', terminal: false };
  }

  const canonical = recoveryDecision({
    reason,
    attempts: currentAttempt,
    maxAttempts: maximum,
    humanControlRequired: false
  });

  const compatibilityAction = canonical.action === 'retry'
    ? 'retry'
    : canonical.action === 'stop'
      ? 'stop'
      : 'replan';

  // The old repair flag no longer creates a second decision path. Code repair
  // is now selected by the unified workflow after reassessment.
  void taskType;
  void repairAvailable;

  return {
    action: compatibilityAction,
    failureClass,
    reason: canonical.reason,
    terminal: compatibilityAction === 'stop'
  };
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
