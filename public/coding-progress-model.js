/**
 * Evidence-first engineering progress snapshot.
 * Never estimates percentage of the request completed, model confidence,
 * number of tests passed, or time left from unfinished workflow steps.
 */
const safe = (value, limit=110) => String(value ?? '').trim().slice(0, limit);
const TERMINAL = new Set(['complete','failed','blocked','exhausted','iterate']);
const LABELS = {
  understand:'Understand the request',discover:'Inspect project context',
  'discover-capabilities':'Choose tools',plan:'Plan the change',adapt:'Adapt the plan',
  'build-code':'Implement changes','test-code':'Run code checks',
  verify:'Verify the result', deliver:'Deliver changes',
  approval:'Review requested approval',clarify:'Clarify the request',
  respond:'Prepare the response',prototype:'Build a prototype'
};
const STATUSES = new Set(['complete','skipped','running','failed','blocked','pending','queued','waiting']);
const publicStatus = status => ({
  complete:'Done',skipped:'Skipped',running:'Running',failed:'Failed',
  blocked:'Blocked',pending:'Waiting',queued:'Queued',waiting:'Needs input'
})[status] || 'Recorded';

export function codingProgressSnapshot(run) {
  if (!run || !Array.isArray(run.tasks)) return null;
  const tasks = run.tasks.filter(task => task && typeof task === 'object');
  const count = tasks.length;
  const completed = tasks.filter(task => task.status === 'complete').length;
  const skipped = tasks.filter(task => task.status === 'skipped').length;
  const failures = tasks.filter(task => ['failed','blocked'].includes(task.status)).length;
  const running = tasks.filter(task => task.status === 'running').length;
  const waiting = tasks.filter(task => task.status === 'waiting').length;
  const terminal = TERMINAL.has(run.state);
  const next = terminal ? null : tasks.find(task => safe(task.id,120) === safe(run.next,120))
    || tasks.find(task => task.status === 'running')
    || tasks.find(task => ['pending','queued','waiting'].includes(task.status)) || null;
  const label = task => safe(task?.metadata?.title || LABELS[task?.id] || LABELS[task?.type]
    || task?.purpose || task?.id || 'Recorded step', 110);
  // A passing verdict on an earlier revision is not certification for
  // subsequent changes. Also never celebrate a terminal state that still
  // contains failed, running or pending mandatory code checks.
  const lastWorkIndex = tasks.reduce((index, task, i) =>
    ['build-code','test-code'].includes(task?.id) ||
    ['build-code','test-code'].includes(task?.type) ? i : index, -1);
  const lastVerifyIndex = tasks.reduce((index, task, i) =>
    task?.type === 'verify' || task?.id === 'verify' ? i : index, -1);
  const candidate = tasks[lastVerifyIndex];
  const verdict = candidate?.evidence?.verdict;
  const requiredChecks = tasks.filter(task =>
    task?.id === 'test-code' || task?.type === 'test-code');
  const runState = safe(run.state,24);
  const verified = runState === 'complete'
    && lastVerifyIndex >= 0 && lastVerifyIndex >= lastWorkIndex
    && candidate.status === 'complete'
    && (verdict?.verdict === 'pass' || verdict?.status === 'pass')
    && !tasks.some(task => ['failed','blocked','stale','running'].includes(task?.status))
    && requiredChecks.every(task => task.status === 'complete')
    && !tasks.slice(lastVerifyIndex+1).some(task =>
      ['build-code','test-code'].includes(task?.id) ||
      ['build-code','test-code'].includes(task?.type));
  let headline = next ? label(next) : 'Review your coding task';
  let status = 'Ready';
  let tone = 'neutral';
  if (runState === 'complete') {
    headline = verified ? 'Completed with recorded verification' : 'Completed — verification not confirmed';
    status = verified ? 'Verified' : 'Completed'; tone = verified ? 'success' : 'neutral';
  } else if (['failed','blocked','exhausted'].includes(runState)) {
    headline = 'Work stopped — inspect the recorded result';
    status = 'Needs attention'; tone = 'danger';
  } else if (runState === 'waiting' || next?.type === 'approval' || next?.type === 'clarify' || waiting) {
    status = 'Action needed'; tone = 'warning';
  } else if (runState === 'running' || running) {
    status = 'Working'; tone = 'active';
  } else if (runState === 'queued') {
    status = 'Queued'; tone = 'neutral';
  } else if (runState === 'iterate') {
    headline = 'Review the latest result'; status = 'Ready for review';
  }
  // A completed task count is a fraction of RECORDED steps only.
  // New tasks can be added while an agent works; it is NOT total completion.
  const checkpoints = tasks.slice(-6).map(task => {
    const raw = safe(task.status,24);
    const state = STATUSES.has(raw) ? raw : 'pending';
    return Object.freeze({
      label:label(task), status:state, statusLabel:publicStatus(state),
      current: Boolean(next && next === task)
    });
  });
  const testTasks = tasks.filter(task => task.id === 'test-code' || task.type === 'test-code');
  const testState = testTasks.some(task => task.status === 'failed') ? 'Test step failed'
    : testTasks.some(task => task.status === 'running') ? 'Test step running'
    : testTasks.some(task => task.status === 'complete') ? 'Test step recorded'
    : testTasks.length ? 'Test step pending' : 'No test step recorded';
  return Object.freeze({
    runId:safe(run.id,120),status,tone,headline,terminal,verified,
    recorded:count,completed,skipped,failures,running,
    testState,checkpoints:Object.freeze(checkpoints),
    hiddenCount:Math.max(0,count-checkpoints.length),
    progressLabel:`${completed} of ${count} recorded steps done`,
    // Explicit evidence note avoids translating a planned test into a pass.
    evidence:verified ? 'A passing verification verdict is recorded.'
      : 'No passing verification verdict has been recorded for this run.'
  });
}
