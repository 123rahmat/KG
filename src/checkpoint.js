/**
 * Whether a reassess checkpoint needs the model.
 *
 * A reassessment reads the evidence of the stage before it and can add a
 * capability or re-plan. When that evidence is plainly clean and a later
 * stage checks it anyway (code with its tests, about to be run; tests that
 * all passed), the model can
 * only say "carry on", so the server records that without a model call.
 * Anything else (a failure, research findings, a draft, tool output, a
 * retry after a failed check) still goes to the model.
 */

import { codeRunOutput, missingTests, hasCode } from './code-workflow.js';

const text = value => (typeof value === 'string' ? value.trim() : '');
const STAGES = new Set(['code', 'tool', 'investigate', 'prototype']);

/** Why one completed stage's evidence is clean, or null when it is not. */
function cleanStage(task, tasks) {
  if (!task || task.status !== 'complete' || !task.evidence) return null;
  if (task.id === 'build-code') {
    const built = task.evidence.structured;
    const testedNext = tasks.some(item => item.id === 'test-code' && item.status === 'pending');
    return hasCode(built) && !missingTests(built) && testedNext
      ? 'the code and its tests are written; the next step runs them' : null;
  }
  if (task.type === 'code') {
    const output = codeRunOutput(task.evidence.result);
    const summary = output.testSummary;
    return output.status === 'completed' && Number(output.exitCode ?? 0) === 0
      && summary && summary.total > 0 && summary.failed === 0
      ? `tests: ${summary.passed} of ${summary.total} passed` : null;
  }
  return null;
}

/**
 * The server's reassessment when the evidence is clean, as
 * { text, structured }; null when the model should reassess.
 */
export function cleanCheckpoint(run, task) {
  if (task?.type !== 'reassess' || Number(run?.attempt ?? 1) > 1) return null;
  const tasks = run.tasks ?? [];
  if (tasks.some(item => item.status === 'failed')) return null;
  const source = text(task.metadata?.sourceTask);
  const stages = source
    ? [tasks.find(item => item.id === source)]
    // At the final checkpoint the test run speaks for the code it tested.
    : tasks.filter(item => STAGES.has(item.type) && item.status !== 'skipped'
      && !(item.id === 'build-code' && tasks.some(other => other.id === 'test-code')));
  if (!stages.length) return null;
  const reasons = stages.map(stage => cleanStage(stage, tasks));
  if (reasons.some(reason => !reason)) return null;
  return {
    text: `Evidence is clean (${reasons.join('; ')}); the plan continues unchanged.`,
    structured: { capabilities: [], decidedBy: 'server', reason: 'clean-evidence' }
  };
}
