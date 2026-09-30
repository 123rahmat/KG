#!/usr/bin/env node
/**
 * npm run smoke:deploy -- https://ai.example.com
 *
 * Non-destructive check of a running deployment: health, readiness, security
 * headers and the auth boundary; with SMOKE_API_KEY it also signs in and
 * previews a plan (nothing is created). Exit 0 when every check passes, 1
 * otherwise. SMOKE_WORKSPACE picks the workspace; the key is never printed.
 */

import { runDeploySmoke } from '../src/deploy-smoke.js';

const baseUrl = process.argv[2] || process.env.SMOKE_BASE_URL;
try {
  const summary = await runDeploySmoke({
    baseUrl,
    apiKey: process.env.SMOKE_API_KEY,
    workspace: process.env.SMOKE_WORKSPACE
  });
  console.log(`Smoke check of ${summary.baseUrl}`);
  for (const item of summary.checks) console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}`);
  if (!process.env.SMOKE_API_KEY) console.log('  (set SMOKE_API_KEY to also check sign-in and planning)');
  console.log(summary.ok ? 'PASS' : 'FAIL');
  process.exitCode = summary.ok ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
