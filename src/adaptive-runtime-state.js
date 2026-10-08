/**
 * Server-owned adaptive runtime projection.
 *
 * Decision authority lives in adaptive-decision-authority.js and the unified
 * workflow kernel. This module records bounded runtime history and recovery
 * lessons; it does not choose recovery actions or advance tasks.
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
