#!/usr/bin/env node
/**
 * npm run smoke:providers
 *
 * Calls the configured Google Vertex AI Gemini model and verifies the response
 * contract. Credentials are never printed.
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
if (!summary.ran) console.log('No Vertex AI project was configured; nothing was checked.');
process.exitCode = summary.ok ? 0 : 1;
