#!/usr/bin/env node
/**
 * npm run smoke:providers
 *
 * Calls Gemini when credentials are configured and checks the response contract.
 * Exit 0 when every configured provider passes (or none is configured),
 * 1 when any configured provider fails. Keys are never printed.
 */

import { runProviderSmoke } from '../src/provider-smoke.js';

const summary = await runProviderSmoke();
for (const result of summary.results) {
  if (result.skipped) {
    console.log(`- ${result.provider}: skipped (${result.reason})`);
    continue;
  }
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.provider} (${result.model}, ${result.elapsedMs} ms)`);
  for (const check of result.checks) {
    console.log(`    ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
}
if (!summary.ran) console.log('No Gemini credentials were set; nothing was checked.');
process.exitCode = summary.ok ? 0 : 1;
