/**
 * Unified, dependency-free system doctor.
 *
 * This is intentionally deterministic and read-only. It gives the same fast
 * architectural health signal locally and in CI without requiring Postgres,
 * provider credentials, network access, or a second environment.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const checks = [];

async function exists(relative) {
  try { await access(path.join(root, relative)); return true; }
  catch { return false; }
}

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const requiredFiles = [
  'server.js', 'package.json', 'src/core.js', 'src/runs.js',
  'src/runtime.js', 'src/safety.js', 'src/verification.js',
  'src/code-workspace.js', 'src/project-index.js', 'src/context-compiler.js', 'src/parallel-orchestrator.js', 'src/subsystem-orchestrator.js', 'src/adaptive.js',
  'src/jobs.js', 'src/fleet-control.js', 'src/run-actions.js', 'src/security-boundary.js', 'src/sandbox.js',
  '.github/workflows/ci.yml', '.github/workflows/verify.yml', '.github/workflows/codeql.yml', '.github/workflows/secret-scan.yml',
  'tests/security.test.js', 'tests/code-workspace.test.js'
];

for (const file of requiredFiles) check(
  `required:${file}`,
  await exists(file),
  await exists(file) ? 'present' : 'missing'
);

const pkg = JSON.parse(await read('package.json'));
const app = await read('src/app.js');
const nodeEngineMajor = Number(/(\d+)/.exec(String(pkg.engines?.node ?? ''))?.[1] ?? 0);
check('node-engine', nodeEngineMajor >= 22, `requires ${pkg.engines?.node ?? 'unset'}`);
check('package-lock-sync', (await read('package-lock.json')).includes(`"version": "${pkg.version}"`), 'package.json and package-lock.json versions must match');
check('app-version-sync', app.includes(`VERSION = '${pkg.version}'`), 'application VERSION must match package.json');
for (const script of ['check', 'lint', 'test', 'verify']) {
  check(`script:${script}`, typeof pkg.scripts?.[script] === 'string', pkg.scripts?.[script] ?? 'missing');
}

const core = await read('src/core.js');
const runs = await read('src/runs.js');
const workspace = await read('src/code-workspace.js');
const safety = await read('src/safety.js');
const verification = await read('src/verification.js');
const runtime = await read('src/runtime.js');
const jobs = await read('src/jobs.js');
const fleet = await read('src/fleet-control.js');
const actions = await read('src/run-actions.js');
const securityBoundary = await read('src/security-boundary.js');
const sandbox = await read('src/sandbox.js');
const ci = await read('.github/workflows/ci.yml');
const verify = await read('.github/workflows/verify.yml');
const codeql = await read('.github/workflows/codeql.yml');
const secretScan = await read('.github/workflows/secret-scan.yml');
const dockerfile = await read('Dockerfile');
const adaptive = await read('src/adaptive.js');
const adaptiveControl = await read('src/adaptive-control.js');
const projectIndex = await read('src/project-index.js');
const contextCompiler = await read('src/context-compiler.js');
const parallel = await read('src/parallel-orchestrator.js');
const multiAgent = await read('src/multi-agent.js');
const migrationSource = await read('src/migrations.js');
const billingAccount = await read('src/routes/account.js');
const billingRoutes = await read('src/routes/stripe.js');
const billingProtection = await read('src/data-protection.js');
const billingDb = await read('src/db.js');

check('server-owned-workflow', /SELECT[\s\S]*FOR UPDATE/.test(runs), 'run state is expected to be re-read under a row lock');
check('execution-claim-integrity', /executed\s*[:=]/.test(core + runs), 'execution state is represented explicitly');
check('workspace-path-boundary', /workspacePath\(/.test(workspace), 'workspace paths use the centralized boundary');
check('workspace-content-hash', /createHash\(['"]sha256['"]\)/.test(workspace), 'workspace revisions have deterministic content hashes');
check('safety-boundary', /export|function/.test(safety) && /BLOCK|deny|refus/i.test(safety), 'safety module is present with decision/refusal logic');
check('verification-separation', /verify|verification/i.test(verification), 'verification remains a distinct subsystem');
check('provider-governor-enforced', /providerGovernor\.run\(modelKey/.test(runtime), 'model traffic passes through the adaptive concurrency boundary');
check('runner-side-effect-no-retry', /retries:\s*0/.test(runtime), 'side-effecting runner POSTs do not retry ambiguously');
check('adaptive-efficiency-integrated', /adaptiveEffortProfile\(/.test(adaptive), 'adaptive efficiency participates in situation analysis');
check('adaptive-scope-controller', /reconcileAdaptiveTransition|adaptiveBudgetStatus/.test(adaptiveControl), 'adaptive scope is re-evaluated at transitions');
check('hierarchical-project-index', /buildProjectHierarchy\(/.test(projectIndex) && /hierarchicalProjectScope\(/.test(projectIndex), 'large repositories have deterministic hierarchical scope and subtree digests');
check('incremental-project-index-cache', /FILE_SIGNAL_CACHE_LIMIT/.test(projectIndex) && /cachedFileSignals\(/.test(projectIndex), 'unchanged files reuse deterministic structural parsing across index rebuilds');
check('hierarchical-context-integration', /hierarchicalProjectScope\(/.test(contextCompiler) && /projectScale\(/.test(contextCompiler), 'coding context selection consumes hierarchical project intelligence');
check('workspace-lane-isolation', /workspaceLanesConflict\(/.test(parallel) && /rightReads/.test(parallel) && /leftReads/.test(parallel), 'workspace lanes serialize read/write and stale-revision conflicts');
check('workspace-parallel-scheduler', /buildWorkspaceParallelPlan\(/.test(parallel), 'coding lanes have a deterministic server-owned parallel scheduler');
check('multi-agent-lane-integration', /agentWorkspaceLane\(/.test(multiAgent) && /buildWorkspaceParallelPlan\(/.test(multiAgent), 'multi-agent waves execute through workspace lane contracts');
check('subsystem-orchestration-integration',
  /buildSubsystemPlan\(/.test(multiAgent)
  && /subsystemCommunicationContext\(/.test(multiAgent)
  && /createSubsystemMessage\(/.test(multiAgent),
  'coding agents receive adaptive subsystem ownership and typed downstream communication through the shared orchestration layer');
check('subsystem-revision-fencing',
  /projectRevision/.test(await read('src/subsystem-orchestrator.js'))
  && /staleRevisionRequiresRebase/.test(await read('src/subsystem-orchestrator.js'))
  && /item.projectRevision === currentRevision/.test(await read('src/subsystem-orchestrator.js')),
  'subsystem communication is fenced to the current workspace revision');
check('subsystem-communication-bounded',
  /MAX_SUBSYSTEM_MESSAGES = 64/.test(await read('src/subsystem-orchestrator.js'))
  && /subsystemMessages: mergeSubsystemMessages/.test(await read('src/blackboard.js')),
  'subsystem peer communication is persisted through the encrypted blackboard with a bounded history');
const codeWorkflow = await read('src/code-workflow.js');
check('stale-patch-rejection', /workspace-revision-stale/.test(codeWorkflow) && /expectedBaseHash/.test(codeWorkflow), 'code mutation rejects patches prepared from stale workspace state');
check('background-job-lease-fencing', /worker_id/.test(jobs) && /lease_until\s*>\s*now\(\)/.test(jobs) && /workerId:\s*effectiveWorkerId/.test(jobs), 'background job completion is fenced to the owning worker, attempt and live lease');
check('background-attempt-bound', /attempts\s*<\s*max_attempts/.test(jobs) && /reapExhausted\(/.test(jobs), 'background work cannot claim beyond its attempt budget and exhausted jobs are reaped');
check('terminal-access-recheck', /ACCESS_RECHECK_MS/.test(await read('src/terminal.js')) && /ensureAccess\(/.test(await read('src/terminal.js')), 'long-lived terminal sessions periodically re-authorize workspace access');
check('terminal-secret-input-filter', /isSensitiveWorkspacePath/.test(await read('src/terminal.js')), 'credential-bearing files are excluded from terminal sandboxes through the centralized path policy');
check('usage-reservation-admission', /usage_reservations/.test(await read('src/usage.js')) && /runReserved/.test(await read('src/usage.js')) && /pg_advisory_xact_lock/.test(await read('src/usage.js')), 'model spend is admitted atomically against rolling and per-run token limits');
check('universal-user-usage-windows', /FROM usage_events/.test(await read('src/usage.js')) && /WHERE principal_id = \$1/.test(await read('src/usage.js')) && /fourHour: 'principal'/.test(await read('src/usage.js')) && /weekly: 'principal'/.test(await read('src/usage.js')), '4-hour and weekly AI quotas are universal per user across chats and workspaces');
check('account-level-usage-entitlement', /principal_ai_entitlements/.test(await read('src/usage.js')) && /principal_ai_entitlements/.test(await read('src/migrations.js')) && /principal_ai_entitlements/.test(await read('src/db.js')) && /account-entitlements/.test(await read('src/identity.js')) && /syncWorkspaceAiEntitlements/.test(await read('src/routes/stripe.js')), 'paid AI quota is resolved from the user account entitlement rather than the active workspace');

check('skill-pattern-runtime-grant',
  /'skill_profiles', 'skill_observations', 'skill_patterns'/.test(await read('src/db.js'))
  && /GRANT ALL ON skill_patterns FROM PUBLIC|REVOKE ALL ON skill_patterns FROM PUBLIC/.test(await read('src/migrations.js')),
  'runtime can use scoped skill-pattern learning while the table remains revoked from PUBLIC');check('stripe-hosted-billing',
  billingAccount.includes("billingDetailsStoredLocally: false")
    && !billingAccount.includes("app.put('/api/billing'")
    && billingProtection.includes('stripeBillingPrivateState')
    && billingProtection.includes('billing_storage_version')
    && migrationSource.includes("version: 66")
    && billingRoutes.includes("/api/billing/portal"),
  'payment methods, invoices and billing-profile data stay in Stripe; Kindgleam keeps only opaque references and entitlements'
);
check('entitlement-rls-readiness',
  billingDb.includes("principal_ai_entitlements")
    && migrationSource.includes("ALTER TABLE principal_ai_entitlements ENABLE ROW LEVEL SECURITY"),
  'account-wide entitlement state is covered by the database RLS readiness model'
);
check('usage-source-attribution', /multi-agent/.test(await read('src/usage.js')) && /verification-review/.test(await read('src/usage.js')), 'model spend sources remain distinguishable in the usage ledger');
check('run-action-write-policy-split', migrationSource.includes('version: 60') && migrationSource.includes('CREATE POLICY run_actions_select_policy') && migrationSource.includes('CREATE POLICY run_actions_update_policy'), 'database policy separates read access from action mutation');
check('migration-order', (() => { const v = [...migrationSource.matchAll(/version:\s*(\d+)/g)].map(m => Number(m[1])); return v.every((n, i) => i === 0 || n > v[i - 1]) && v.at(-1) === 68; })(), 'migrations are strictly increasing and include every hardening migration');
check('github-only-code-workspace', /SOURCE_KINDS = Object\.freeze\(\['github'\]\)/.test(await read('src/workspace-sources.js')) && !/\/api\/workspace\/sources\/local/.test(await read('src/routes/workspace-sources.js')) && !/showDirectoryPicker|openLocalFolder|syncLocalFolder|applyLocalWorkspaceChanges/.test(await read('public/workspace-sources.js')) && /kind = 'github'/.test(await read('src/routes/workspace-sources.js')), 'Code Workspace accepts GitHub repositories only; browser local-folder access is removed');
check('github-only-session-and-terminal', /github-source-required/.test(await read('src/code-workspace-sessions.js')) && /requiredSourceId/.test(await read('src/terminal.js')) && /sourceId/.test(await read('src/routes/code-workspace-sessions.js')), 'Code Workspace sessions and terminal require an attached GitHub source');
check('background-worker-cycle-bound', /maxPerCycle/.test(jobs) && /cycleLimit/.test(jobs), 'background workers bound queue draining per cycle for fairness and resource control');
check('fleet-lease-fencing', /renewLease\(/.test(fleet) && /worker_id/.test(fleet) && /lease_until\s*>\s*now\(\)/.test(fleet), 'fleet completion and renewal are lease-owned');
check('fleet-batch-concurrency-fence', /ROW_NUMBER\(\) OVER \(PARTITION BY d\.project_id/.test(fleet) && /project_rank/.test(fleet) && /project_slots/.test(fleet), 'fleet acquisition limits one batch by each project’s actual concurrency slots');
check('action-outcome-fencing', /ACTION_LEASE_MS/.test(actions) && /recoverExpired\(/.test(actions) && /status = 'running'/.test(actions), 'approved side effects carry a lease and abandoned outcomes become explicit uncertainty');
check('action-run-privacy', /run_actions_policy/.test(await read('src/migrations.js')) && /r\.visibility = 'workspace'/.test(await read('src/migrations.js')), 'proposed action access follows the underlying run visibility');
check('browser-security-boundary', /sec-fetch-site/.test(securityBoundary) && /SameSite=Strict/.test(app), 'browser state changes have request-metadata and strict-cookie boundaries');
check('sandbox-production-pinning', /@sha256/.test(sandbox) && /assertProductionSandboxConfiguration/.test(sandbox), 'sandbox source enforces immutable production image references in production');
check('docker-non-root', /USER node/.test(dockerfile), 'production application image runs as the unprivileged node user');

check('dev-compose-loopback-password',
  /127\.0\.0\.1:5432:5432/.test(await read('docker-compose.yml'))
  && /KINDGLEAM_DEV_DB_PASSWORD/.test(await read('docker-compose.yml'))
  && !/POSTGRES_PASSWORD:\s*kindgleam\b/.test(await read('docker-compose.yml')),
  'development PostgreSQL is loopback-only and requires an explicit local password');
check('ci-release-gates', /npm ci/.test(ci) && /npm audit/.test(ci) && /npm test/.test(ci) && /docker build/.test(ci), 'CI covers install, audit, tests and production image build');
check('verify-release-gate', /npm run verify/.test(verify), 'Verify invokes the unified application verification contract');
check('codeql-enabled', /github\/codeql-action\/init/.test(codeql) && /security-extended/.test(codeql), 'CodeQL security-extended analysis is present');
check('codeql-upload-conditional', /upload:\s*\$\{\{/.test(codeql), 'CodeQL upload policy is environment-aware');
check('secret-scan-enabled', /gitleaks\/gitleaks-action/.test(secretScan) && /GITLEAKS_CONFIG/.test(secretScan), 'repository secret scanning is present');

const forbidden = [
  ['eval', /\beval\s*\(/],
  ['new-function', /new\s+Function\s*\(/],
  ['child-shell', /execSync\s*\([^\n]*shell\s*:/]
];
const sourceFiles = ['server.js', 'src/core.js', 'src/runs.js', 'src/runtime.js', 'src/safety.js', 'src/verification.js', 'src/code-workspace.js'];
for (const [name, pattern] of forbidden) {
  let hit = false;
  for (const file of sourceFiles) hit ||= pattern.test(await read(file));
  check(`unsafe-pattern:${name}`, !hit, hit ? 'pattern found in critical source' : 'not found in critical source');
}


check('codeql-private-upload-policy', /upload:\s*\$\{\{\s*github\.event\.repository\.visibility/.test(codeql), 'CodeQL upload is conditional so private repositories without Code Security keep artifact-only analysis');



check('central-sensitive-file-policy', /isSensitiveWorkspacePath/.test(await read('src/workspace-path.js')) && /sensitive-file-blocked/.test(await read('src/toolbox.js')) && /sensitive-file-blocked/.test(await read('src/tool-forge.js')), 'credential-bearing files use one centralized model and sandbox exclusion policy');

check('docker-base-image-pinned', /^FROM node:24-alpine@sha256:[0-9a-f]{64}$/m.test(await read('Dockerfile')), 'application build stages use an immutable Node base-image digest');

check('usage-summary-universal-scope', /quotaScope:[\s\S]*fourHour: 'principal',[\s\S]*weekly: 'principal'/.test(await read('src/usage.js')), 'usage summaries identify both rolling AI quotas as principal-wide');

check('usage-output-cap', /admittedMaxOutputTokens/.test(await read('src/runtime.js')) && /maxOutputTokens: admittedMaxOutputTokens/.test(await read('src/runtime.js')), 'provider output limits are constrained to the amount admitted by the shared usage reservation');

check('action-lease-live-finalize', /lease_until > now\(\)/.test(await read('src/run-actions.js')), 'approved side effects cannot finalize after their execution lease expires');

check('postgres-service-image-pinned', /postgres:16-alpine@sha256:[0-9a-f]{64}/.test(await read('.github/workflows/ci.yml')) && /postgres:16-alpine@sha256:[0-9a-f]{64}/.test(await read('.github/workflows/verify.yml')), 'CI database services use an immutable PostgreSQL image digest');


check('usage-aggregation-bounded', /FILTER \(WHERE created_at >/.test(await read('src/usage.js')) && !/const \{ rows: globalUsageRows \}/.test(await read('src/usage.js')), 'quota checks use indexed database aggregates instead of loading the full rolling ledger into memory');

const failed = checks.filter(item => !item.ok);
const passed = checks.length - failed.length;
console.log(`Kindgleam system doctor: ${passed}/${checks.length} checks passed.`);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} — ${item.detail}`);
if (failed.length) {
  console.error(`\nSystem doctor found ${failed.length} issue(s). Fix these before release.`);
  process.exit(1);
}
console.log('\nSystem doctor passed. No release-blocking architecture issue was detected by this deterministic audit.');

