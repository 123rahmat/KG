/**
 * A two-level, evidence-first activity surface.
 * The compact line describes exactly the selected server task; details disclose
 * only records already present. This module never initiates terminal, sandbox,
 * model calls, commits, or background work.
 */
const clip = (value, limit = 120) => String(value ?? '').trim().slice(0, limit);
const array = value => Array.isArray(value) ? value : [];
const TERMINAL = new Set(['complete', 'failed', 'blocked', 'exhausted', 'iterate']);
const LABEL = Object.freeze({
  understand: 'Understanding the request',
  'discover-capabilities': 'Checking available tools',
  discover: 'Inspecting available context',
  plan: 'Choosing the next action',
  adapt: 'Adapting the approach',
  respond: 'Preparing the answer',
  investigate: 'Reviewing evidence',
  'build-code': 'Applying code changes',
  'test-code': 'Checking the code',
  code: 'Working on the code',
  tool: 'Using an authorized tool',
  reassess: 'Checking whether another action is needed',
  verify: 'Verifying the result',
  deliver: 'Preparing the result',
  approval: 'Waiting for approval',
  clarify: 'Waiting for an answer',
  prototype: 'Preparing the requested artifact'
});
const TARGET = Object.freeze({
  'general-ai-sandbox': 'Sandbox', 'builtin-research': 'Research tool',
  'builtin-tools': 'Built-in tool', 'generic-tool-router': 'Tool runner',
  local: 'Local runner'
});

function labelFor(task) {
  return clip(task?.metadata?.title || task?.purpose
    || LABEL[task?.id] || LABEL[task?.type] || task?.id || 'Selected task', 145);
}

function contextNames(run) {
  return [...new Set([
    ...array(run?.adaptation?.attachments),
    ...array(run?.adaptation?.projectOverlay)
  ].map(item => clip(item?.path || item?.name, 120)).filter(Boolean))].slice(0, 8);
}

function toolState(task) {
  const entries = array(task?.evidence?.tools);
  const running = entries.find(item => ['running', 'working'].includes(item?.status)
    || item?.outcome === 'running');
  return running && clip(running.tool, 70) ? clip(running.tool, 70) : '';
}

function execution(task) {
  const evidence = task?.evidence ?? {};
  const target = clip(evidence.executionTarget || evidence.result?.executionTarget
    || evidence.receipt?.executionTarget || evidence.executionReceipt?.executionTarget, 70);
  return target ? (TARGET[target] || target.replaceAll('-', ' ')) : '';
}

/** Detailed surfaces are shown only after the relevant work is recorded. */
export function liveWorkFocus(run, { workspace = 'normal-chat', connectedGitHub = false,
  offline = false, stopping = false } = {}) {
  const mode = ['code', 'research'].includes(workspace) ? workspace : 'normal-chat';
  const tasks = array(run?.tasks);
  const terminal = TERMINAL.has(run?.state);
  const current = terminal ? null
    : tasks.find(task => task?.id === run?.next)
      || tasks.find(task => task?.status === 'running')
      || tasks.find(task => ['pending', 'waiting', 'queued'].includes(task?.status)) || null;
  const files = contextNames(run);
  const status = stopping ? 'Stopping' : offline ? 'Connection lost'
    : terminal ? ({ complete: 'Finished', iterate: 'Result ready', failed: 'Failed',
      blocked: 'Blocked', exhausted: 'Limit reached' }[run?.state] || 'Finished')
      : current?.type === 'approval' || current?.type === 'clarify' || run?.state === 'waiting'
        ? 'Action needed'
        : current?.status === 'running' ? 'Working'
          : run?.state === 'queued' || current?.status === 'pending' || current?.status === 'queued'
            ? 'Up next' : 'Ready';
  const runningTool = status === 'Working' ? toolState(current) : '';
  const title = terminal ? status : current ? labelFor(current) : 'Preparing the next action';
  const line = clip(terminal && !stopping && !offline ? status
    : runningTool ? status + ' · ' + runningTool + ' · ' + title
      : status + ' · ' + title, 220);
  const currentExecution = execution(current);
  const lastExecutionTask = [...tasks].reverse().find(task =>
    ['complete', 'failed'].includes(task?.status) && execution(task));
  const lastExecution = lastExecutionTask ? execution(lastExecutionTask) : '';
  const completed = tasks.filter(task => task?.status === 'complete').length;
  const relevantToolWork = ['code', 'tool', 'test-code', 'build-code'].includes(current?.type)
    || ['test-code', 'build-code'].includes(current?.id);
  const terminalNeed = current?.metadata?.terminalRequired === true
    || /\b(?:terminal|shell|command|debug|reproduce|runtime|run tests|execute tests)\b/i
      .test(String(current?.purpose ?? '') + ' ' + String(current?.metadata?.title ?? ''));
  const isFileWork = files.length > 0 || mode === 'code';
  const activity = [
    ...(current ? [{ label: 'Current task', value: title },
      { label: 'Task state', value: clip(current.status || run?.state || 'pending', 30) }] : []),
    ...(runningTool ? [{ label: 'Recorded live tool', value: runningTool }] : []),
    ...(currentExecution ? [{ label: 'Selected execution target', value: currentExecution }] : []),
    ...(lastExecution ? [{ label: 'Last recorded execution target', value: lastExecution }] : []),
    ...(files.length ? [{ label: 'Selected files', value: files.join(', ').slice(0, 300) }] : []),
    { label: 'Saved stages', value: completed + ' completed of ' + tasks.length + ' recorded' }
  ];
  const surface = runningTool ? 'tool'
    : currentExecution === 'Sandbox' ? 'sandbox'
      : current?.type === 'investigate' || mode === 'research' ? 'research'
        : isFileWork ? 'files'
          : 'chat';
  return Object.freeze({
    workspace: mode, status, line, title, surface, completed, stageCount: tasks.length,
    activity: Object.freeze(activity.map(item => Object.freeze(item))),
    showDetails: tasks.length > 1 || isFileWork || Boolean(runningTool || currentExecution || lastExecution),
    hasRecordedExecution: Boolean(currentExecution || lastExecution),
    allowTerminal: mode === 'code' && connectedGitHub && relevantToolWork
      && terminalNeed && !terminal && !offline && !stopping,
    allowGitHub: mode === 'code' && connectedGitHub,
    isRunning: status === 'Working'
  });
}
