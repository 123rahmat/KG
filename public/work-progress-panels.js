/**
 * Pure, evidence-grounded UI view of an ongoing run. Never controls execution.
 * Counters and stages represent recorded server data, not estimated progress.
 */
const safe = (value, max = 100) => String(value ?? '').trim().slice(0, max);
const tasksOf = run => Array.isArray(run?.tasks) ? run.tasks : [];
const array = value => Array.isArray(value) ? value : [];
const count = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.floor(Number(value)) : 0;

const LABELS = Object.freeze({
  understand: 'Understand the request', discover: 'Gather context',
  'discover-capabilities': 'Choose tools', plan: 'Plan the work',
  adapt: 'Adapt the approach', investigate: 'Investigate evidence',
  'build-code': 'Apply code changes', 'test-code': 'Run tests',
  prototype: 'Prepare a draft', respond: 'Prepare an answer',
  verify: 'Verify the result', deliver: 'Deliver the result',
  approval: 'Request approval', clarify: 'Clarify the request'
});
const STATUSES = Object.freeze({
  complete: 'Done', failed: 'Failed', skipped: 'Skipped', running: 'Working',
  pending: 'Queued', queued: 'Queued', waiting: 'Waiting', blocked: 'Blocked'
});

export function workspaceProgressPanel(run, workspace = 'normal-chat') {
  const mode = ['code', 'research'].includes(workspace) ? workspace : 'normal-chat';
  const tasks = tasksOf(run);
  const liveTask = tasks.find(item => item?.id === run?.next)
    ?? tasks.find(item => item?.status === 'running') ?? null;
  const stages = tasks.slice(-12).map(task => ({
    label: safe(task?.metadata?.title || LABELS[task?.id] || LABELS[task?.type] || task?.purpose || task?.id || 'Work step', 120),
    status: safe(task?.status || 'pending', 24),
    statusLabel: STATUSES[task?.status] || 'Recorded',
    active: task?.id === liveTask?.id && task?.status === 'running'
  }));
  const attachments = array(run?.adaptation?.attachments);
  const overlay = array(run?.adaptation?.projectOverlay);
  // Names are only for the current run's scoped attachments/overlay; no extra reads.
  const fileNames = [...new Set([...attachments, ...overlay]
    .map(item => safe(item?.name || item?.path, 120)).filter(Boolean))].slice(0, 12);
  const research = run?.adaptation?.researchWorkspace ?? {};
  const reasoning = safe(run?.intelligence?.reasoning?.depth
    || run?.adaptation?.resourcePlan?.control?.depth, 24);
  const sourceCount = count(research.sourceCount);
  const evidenceCount = count(research.evidenceCount);
  const gaps = array(research.unresolvedQuestions).length || count(research.unresolvedCount);
  const conflicts = array(research.conflicts).length || count(research.conflictCount);
  const verified = tasks.filter(task => {
    const verdict = task?.evidence?.verdict;
    return task?.type === 'verify' && task?.status === 'complete'
      && (verdict?.verdict === 'pass' || verdict?.status === 'pass');
  }).length;
  const codeChecks = tasks.filter(task => task?.id === 'test-code'
    || /test|verif/i.test(safe(task?.type) + ' ' + safe(task?.id))).length;
  const files = Math.max(attachments.length, overlay.length,
    count(run?.intelligence?.context?.fileCount));
  let cards = [];
  if (mode === 'code') {
    cards = [
      { label: 'Files in scope', value: String(files) },
      { label: 'Checks recorded', value: String(codeChecks) },
      { label: 'Passed verifications', value: String(verified) }
    ];
  } else if (mode === 'research') {
    cards = [
      { label: 'Sources recorded', value: String(sourceCount) },
      { label: 'Evidence items', value: String(evidenceCount) },
      { label: 'Open questions', value: String(gaps) }
    ];
    if (conflicts) cards[2] = { label: 'Evidence conflicts', value: String(conflicts) };
  } else {
    if (files) cards.push({ label: 'Files in context', value: String(files) });
    if (reasoning) cards.push({ label: 'Reasoning effort', value: reasoning.replaceAll('-', ' ') });
    if (verified) cards.push({ label: 'Verified checks', value: String(verified) });
  }
  return Object.freeze({
    workspace: mode,
    cards: Object.freeze(cards),
    fileNames: Object.freeze(fileNames),
    stages: Object.freeze(stages),
    completed: tasks.filter(task => task?.status === 'complete').length,
    stageCount: tasks.length,
    hasWork: Boolean(tasks.length),
    focus: liveTask ? safe(liveTask.metadata?.title || LABELS[liveTask.id]
      || LABELS[liveTask.type] || liveTask.purpose || liveTask.id, 120) : ''
  });
}
