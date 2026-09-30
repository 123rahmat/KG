#!/usr/bin/env node
/**
 * npm run eval:live
 *
 * Sends real requests to a running Kindgleam and checks how the real AI
 * model handled each situation. It spends real tokens.
 *
 *   EVAL_URL        the deployment, e.g. http://127.0.0.1:8080
 *   EVAL_TOKEN      an API key or session token for a test account
 *   EVAL_WORKSPACE  the workspace to use
 *   EVAL_ONLY       optional: scenario ids or areas, comma-separated
 *   EVAL_REPORT     optional: where to write the JSON report (default live-eval-report.json)
 *
 * Exit 0 when every scenario passed, 1 otherwise.
 */

import fs from 'node:fs';
import { runLiveEval } from '../src/live-eval.js';

const { EVAL_URL, EVAL_TOKEN, EVAL_WORKSPACE, EVAL_ONLY, EVAL_REPORT = 'live-eval-report.json' } = process.env;
if (!EVAL_URL || !EVAL_TOKEN || !EVAL_WORKSPACE) {
  console.error('Set EVAL_URL, EVAL_TOKEN and EVAL_WORKSPACE. See docs/LIVE_EVALUATION.md.');
  process.exit(2);
}

try {
  const report = await runLiveEval({
    baseUrl: EVAL_URL, token: EVAL_TOKEN, workspace: EVAL_WORKSPACE,
    only: EVAL_ONLY ? EVAL_ONLY.split(',').map(item => item.trim()).filter(Boolean) : null,
    onResult: result => {
      if (result.skipped) return console.log(`SKIP ${result.id.padEnd(14)} ${result.skipped}`);
      console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id.padEnd(14)} ${String(result.workflow ?? '-').padEnd(6)} ${String(result.tokens).padStart(7)} tokens ${String(result.seconds).padStart(6)} s  ${(result.tools ?? []).join(' ')}`);
      for (const problem of result.problems ?? []) console.log(`       - ${problem}`);
      if (result.awaitingPersonCheck) console.log('       (waits for a person to certify the check, as physical and high-stakes work should)');
    }
  });
  fs.writeFileSync(EVAL_REPORT, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped; ${report.tokens} tokens (${report.provider}). Report: ${EVAL_REPORT}`);
  process.exitCode = report.failed ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
