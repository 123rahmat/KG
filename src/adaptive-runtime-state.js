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
