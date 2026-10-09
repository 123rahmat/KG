/**
 * UI-only outcome report. Every number comes from persisted run evidence.
 * It neither infers model intent nor claims unperformed execution or tests.
 */
const array = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.floor(Number(value)) : 0;
const countLabel = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');
const terminal = new Set(['complete', 'failed', 'blocked', 'exhausted']);
const value = input => String(input ?? '').trim();

function successfulVerification(task) {
  return task?.type === 'verify' && task?.status === 'complete'
    && ['pass', 'passed'].includes(value(task?.evidence?.verdict?.verdict ?? task?.evidence?.verdict?.status).toLowerCase());
}

function recordedChanges(run) {
  const change = run?.adaptation?.unifiedWorkContext?.lastChange ?? {};
  return [...new Set([...array(change.files), ...array(change.deleted)]
    .map(item => value(typeof item === 'string' ? item : item?.path))
    .filter(Boolean))];
}

export function workspaceOutcomeSummary(run, domain) {
  if (!run || !['code', 'research'].includes(domain) || !terminal.has(run.state)) return null;
  const tasks = array(run.tasks);
  const completed = tasks.filter(task => task?.status === 'complete').length;
  const failed = tasks.filter(task => ['failed', 'blocked'].includes(task?.status)).length;
  const verified = tasks.filter(successfulVerification).length;
  const specialists = new Set(tasks.flatMap(task => array(task?.evidence?.multiAgent?.agentStates))
    .filter(agent => agent?.status === 'complete' && agent?.role && agent.role !== 'arbiter')
    .map(agent => value(agent.role)));
  const facts = [countLabel(completed, 'completed step')];
  if (failed) facts.push(countLabel(failed, 'failed or blocked step'));
  if (specialists.size) facts.push(countLabel(specialists.size, 'recorded specialist role'));
  const notes = [];
  if (domain === 'code') {
    const paths = recordedChanges(run);
    if (paths.length) facts.push(countLabel(paths.length, 'recorded changed path'));
    const tests = tasks.filter(task => task?.id === 'test-code');
    const receipts = tasks.filter(task => task?.executionReceipt?.serverAuthenticated === true
      || task?.evidence?.executionReceipt?.serverAuthenticated === true);
    if (tests.length) facts.push(countLabel(tests.length, 'test step') + ' recorded');
    if (receipts.length) facts.push(countLabel(receipts.length, 'authenticated execution receipt'));
    if (verified) facts.push(countLabel(verified, 'passing verification'));
    if (tests.length && !receipts.length) notes.push('Test steps were recorded; an authenticated runner receipt was not found in this view.');
    if (!paths.length) notes.push('No applied file-change path was recorded in the work summary.');
    if (!verified) notes.push('No passing final verification verdict was recorded.');
  } else {
    const evidence = run?.adaptation?.researchWorkspace ?? {};
    const sources = number(evidence.sourceCount ?? array(evidence.sourceSet).length);
    const findings = number(evidence.evidenceCount ?? array(evidence.evidenceLedger).length);
    const gaps = array(evidence.unresolvedQuestions);
    const conflicts = array(evidence.conflicts);
    facts.push(countLabel(sources, 'tracked source'), countLabel(findings, 'recorded evidence item'));
    if (verified) facts.push(countLabel(verified, 'passing verification'));
    if (gaps.length) notes.push(countLabel(gaps.length, 'open research question') + ' remain.');
    if (conflicts.length) notes.push(countLabel(conflicts.length, 'unresolved evidence conflict') + ' remain.');
    if (!sources) notes.push('No research sources were recorded in the evidence ledger.');
    if (!verified) notes.push('No passing final verification verdict was recorded.');
  }
  return Object.freeze({
    domain,
    state: value(run.state),
    title: run.state === 'complete' ? 'What was completed'
      : 'What was recorded before work stopped',
    facts: Object.freeze(facts),
    notes: Object.freeze(notes)
  });
}
