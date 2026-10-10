/**
 * Pure, evidence-grounded UI view of an ongoing run. Never controls execution.
 * Counters and stages represent recorded server data, not estimated progress.
 */
import { nextWorkDecision } from './next-work-decision.js';
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

/** Compact, truthful timeline. Recorded count is NOT total work estimated. */
export function recordedCheckpointTrail(run, { maxMarkers = 8 } = {}) {
  const tasks = tasksOf(run);
  const limit = Number.isFinite(Number(maxMarkers))
    ? Math.max(1, Math.min(12, Math.floor(Number(maxMarkers)))) : 8;
  const terminal = ['complete', 'failed', 'blocked', 'exhausted', 'iterate'].includes(run?.state);
  const nextId = safe(run?.next, 120);
  const selected = terminal || !nextId ? null
    : tasks.find(task => safe(task?.id, 120) === nextId);
  const markers = tasks.slice(-limit).map(task => {
    const rawStatus = safe(task?.status, 24).toLowerCase();
    const status = ['complete','failed','skipped','running','pending','queued','waiting','blocked']
      .includes(rawStatus) ? rawStatus : 'pending';
    const next = Boolean(selected && selected === task);
    return Object.freeze({
      label: safe(task?.metadata?.title || LABELS[task?.id] || LABELS[task?.type]
        || task?.purpose || task?.id || 'Work step', 120),
      status,
      statusLabel: next && ['pending','queued'].includes(status)
        ? 'Up next' : STATUSES[status] || 'Recorded',
      next
    });
  });
  return Object.freeze({
    markers: Object.freeze(markers),
    recordedCount: tasks.length,
    hiddenCount: Math.max(0, tasks.length - markers.length),
    completedCount: tasks.filter(task => task?.status === 'complete').length,
    failedCount: tasks.filter(task => ['failed', 'blocked'].includes(task?.status)).length,
    explanation: 'These are saved workflow steps, not a fixed plan or a percentage estimate.'
  });
}

export function workspaceProgressPanel(run, workspace = 'normal-chat') {
  const mode = ['code', 'research'].includes(workspace) ? workspace : 'normal-chat';
  const tasks = tasksOf(run);
  const liveTask = tasks.find(item => item?.id === run?.next)
    ?? tasks.find(item => item?.status === 'running') ?? null;
  const stages = tasks.slice(-12).map(task => ({
    label: safe(task?.metadata?.title || LABELS[task?.id] || LABELS[task?.type] || task?.purpose || task?.id || 'Work step', 120),
    status: safe(task?.status || 'pending', 24),
    statusLabel: STATUSES[task?.status] || 'Recorded',
    evidenceAnchor: safe(task?.metadata?.evidenceAnchorTaskId, 80),
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
  // Only explain a stage when the server has an actual selected task.
  // These are concise public progress reasons, not private model deliberation.
  const hasObservedResults = tasks.some(task => task?.status === 'complete'
    && task?.evidence && typeof task.evidence === 'object'
    && Object.keys(task.evidence).length > 0);
  const phase = liveTask?.status === 'running' ? 'Working' : 'Up next';
  let stageContext = null;
  if (liveTask?.type === 'reassess') {
    stageContext = {
      title: phase + ' · reassess the next action',
      detail: hasObservedResults
        ? 'Review recorded results and remaining requirements before proposing more work.'
        : 'Check the existing plan and what evidence is still needed.'
    };
  } else if (liveTask?.type === 'verify') {
    stageContext = {
      title: phase + ' · verify the result',
      detail: 'Check the available result against the requested outcomes before delivery.'
    };
  } else if (files && liveTask && ['respond', 'step', 'code', 'tool', 'prototype'].includes(liveTask.type)) {
    stageContext = {
      title: phase + ' · file-based work',
      detail: files + ' file' + (files === 1 ? '' : 's')
        + ' in context. Preview, edits and checks are reported only when recorded.'
    };
  }
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
    nextAction: nextWorkDecision(run),
    cards: Object.freeze(cards),
    fileNames: Object.freeze(fileNames),
    stageContext: stageContext ? Object.freeze(stageContext) : null,
    stages: Object.freeze(stages),
    completed: tasks.filter(task => task?.status === 'complete').length,
    stageCount: tasks.length,
    hasWork: Boolean(tasks.length),
    focus: liveTask ? safe(liveTask.metadata?.title || LABELS[liveTask.id]
      || LABELS[liveTask.type] || liveTask.purpose || liveTask.id, 120) : ''
  });
}
