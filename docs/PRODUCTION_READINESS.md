## Privacy-first release gate

Privacy is the first release criterion for every request path and data path.

A release is not privacy-ready unless the deployment proves:

- authenticated user and workspace scope is established before protected data access
- cross-workspace and cross-principal reads/writes are denied
- private data is classified and only the minimum necessary classes are transferred
- external model, runner and connector egress is explicitly authorized for the relevant data classes
- private provider connectors require an active connection and adequate scopes
- logs, metrics, audit records, URLs and provider errors do not contain raw secrets or unnecessary user content
- asynchronous jobs carry and re-establish the same verified authorization context
- encrypted storage, backup, restore and deletion preserve the same privacy boundaries
- idempotency response records are principal-scoped under PostgreSQL RLS
- isolation is tested using the same runtime database role, pooling model and request path as production

Privacy failures are release-blocking. This follows least-privilege, secure-by-default and multi-tenant isolation principles; tenant isolation should be enforced and tested at the data, authorization and asynchronous-work boundaries.

# Production readiness

This branch is the production-readiness track for Kindgleam's situation-adaptive,
open-world workflow. "Production ready" means the application refuses unsafe or
unverifiable states and the release pipeline proves the repository can build and
test; it does not mean that infrastructure, credentials, runners, backups, or
operational controls are magically supplied by the source tree.

## Release gates

A release candidate must pass all of these gates:

1. **Source integrity**
   - clean checkout and lockfile-resolved install with `npm ci`
   - syntax/source checks
   - dependency audit with no high/critical production dependency findings
   - tests against real PostgreSQL
   - migrations applied successfully twice
   - production container builds successfully

2. **Workflow integrity**
   - the server owns the task graph and authoritative state
   - dependencies are evaluated from stored rows under a transaction lock
   - execution tasks cannot be completed through the manual advance endpoint
   - generated code is a model-produced artifact and must be handed to a separate authorized execution stage
   - local execution challenges are server-issued, attempt-bound and single-use
   - observe/reassess/verify tasks require evidence
   - verification cannot run before its dependencies
   - failed work enters a bounded adaptation/replan path
   - no execution claim is accepted without an authenticated execution receipt

3. **Open-world integrity**
   - native capabilities are a bootstrap, not a ceiling
   - unknown requirements enter discovery
   - discovered capabilities remain candidates until authorized
   - missing runners/connectors leave work pending rather than inventing completion
   - external products are never represented as connected unless an actual
     authorized connector exists

4. **Security and tenancy**
   - authentication and workspace membership are enforced at the server boundary
   - ownership comes from the authenticated principal, not request JSON
   - governance is server-owned and layered
   - sensitive object content is encrypted at rest when configured
   - audit records are append-only
   - session writes require CSRF protection
   - production requires TLS database verification, secure cookies, a reasoning
     provider, separate migration credentials, and a durable PostgreSQL rate-limit store

5. **Execution trust**
   - local execution requires exact agent preflight, a paired secret, and a declared
     container/VM isolation boundary in production
   - managed runner endpoints require HTTPS and a strong shared token
   - cloud fallback is a new approval decision; it is never silent
   - execution receipts are cryptographically authenticated and bound to the run,
     task, task type, run attempt, execution ID, challenge nonce, target and output hashes
   - an executed-but-failed runner outcome is recorded as failure and enters the
     bounded recovery/replan path rather than being normalized to success
   - managed runner POSTs are not automatically retried after ambiguous transport
     failures, preventing the application from duplicating a side effect behind a timeout
   - the web process does not execute untrusted source directly

## Required production infrastructure

The repository deliberately leaves these deployment responsibilities explicit:

- PostgreSQL with a runtime role that cannot perform schema DDL and cannot bypass RLS
- PostgreSQL RLS enabled and forced on every tenant-owned table, with production startup coverage checks
- transaction-local, server-derived tenant/principal context re-established on every request transaction
- a separate migration identity
- a separate backup identity with only the minimum privileges required to dump the approved data
- a separate restore identity reserved for restore operations
- verified TLS/CA configuration
- a secret manager for API keys, encryption keys and runner credentials
- encrypted backups stored outside the primary database host
- tested restore and point-in-time recovery procedures
- centralized logs and metrics with secret/content redaction
- alerting for readiness failures, database exhaustion, runner failures and
  verification failures: ready-made Prometheus rules (instance down, readiness,
  5xx rate, p95 latency, connection-pool waiting, runner and verification
  failures, rate-limit store errors) with unit tests are in `docs/ops/`
- content scanning/quarantine if untrusted files are accepted
- isolated execution runners with CPU, memory, filesystem, network and time limits
- a deployment proxy/load balancer with a correctly configured trust boundary
- horizontal-scaling validation at the intended workload, e.g. with
  `LOAD_API_KEY=… LOAD_WORKSPACE=… npm run load-test -- https://staging-host`
  (drives the main workflow from many users and reports p50/p95/p99 per step;
  it creates runs, so use staging). Reference point: one instance on 4 cores
  with PostgreSQL on the same host completed about 38 workflows/s for 20
  concurrent users, every step under 170 ms at p95; that limit is one Node
  process's CPU, so add instances rather than database connections to scale
- operational ownership for incident response and key rotation


## Outside services

Kindgleam connects to three outside services only: the AI model provider,
Stripe, and the mail server that sends sign-in emails. The first two need their
keys, and Stripe its signed webhook (see `docs/USAGE_AND_BILLING.md`); the mail
account is set by a platform administrator in Settings → Email sending. It does not connect to private accounts (Google Drive,
Microsoft, Dropbox…); that data arrives as attached files. Public web data is
read through the AI provider's search and Kindgleam's own guarded fetcher,
which `TOOLS_WEB_ACCESS=false` turns off.

## Situation-adaptive quality gate

Every meaningful workflow follows this invariant:

```
understand
  -> investigate when justified
  -> discover/compose capabilities
  -> adapt
  -> plan
  -> approve when required
  -> execute
  -> observe
  -> reassess
  -> verify against fixed success criteria
  -> present verified result
  -> iterate or finish
```

Presentation is downstream of verification for results that can be tested. The UI
may show a plan, pending state, uncertainty, or partial result before verification,
but it must not label unverified work as completed or verified.

## Code quality gate

For executable code, the workflow should perform the checks supported by the
selected runner: syntax/static analysis, unit tests, integration tests, edge cases,
failure cases, execution, evidence capture and regression tests. If a runner is
not
available, the system reports that limitation instead of claiming execution.

## Physical-world gate

Physical or high-impact work requires an actual authorized execution boundary and
observed evidence. A design, a program's output, or a plan is not represented as physical
execution. Where the verification contract requires it, an authorized human must
certify the result.

## Deployment sequence

1. Provision PostgreSQL and a secret manager.
2. Create the four database identities with `docs/sql/roles.sql` (migration,
   runtime, backup, restore). The application reconciles their grants on
   every boot; the script only does what needs administrator rights.
3. Configure verified database TLS.
4. Configure encryption and session secrets.
5. Run migrations using the migration identity.
6. Start the application with the runtime identity.
7. Confirm `/api/health` and `/api/ready`.
8. Run the non-destructive smoke check against the deployment:
   `SMOKE_API_KEY=… npm run smoke:deploy -- https://your-host` (health,
   readiness, reasoning provider, security headers, auth boundary, sign-in and
   a plan preview that creates nothing; exits non-zero on any failure).
9. Verify audit, metrics, backups and restore procedures.
10. Connect only the execution runners that have been independently sandboxed.
11. Perform load, failure, rollback and recovery drills.
12. Promote the exact tested container digest.

## Live provider check

The test suite mocks Gemini responses, so it cannot notice the Gemini API
changing its contract. `npm run smoke:providers` calls Gemini when
`SMOKE_GOOGLE_API_KEY` (or the app's own `AI_PROVIDER`/`AI_API_KEY`) is present, and checks the contract: a complete
answer, reported token usage and a valid classification. Missing credentials
are reported as skipped, never as passing. Run it before each release;`.github/workflows/provider-smoke.yml` runs it weekly and on demand
from repository secrets.

## Backup and restore

Run both from an operations host with the PostgreSQL 16 client tools
(`pg_dump`, `pg_restore`); the application image deliberately ships without
them. Both commands use the same `PGSSLMODE`/`PGSSLROOTCERT` as the server.

```
BACKUP_DIR=/secure/backups npm run backup
RESTORE_CONFIRM=I_UNDERSTAND npm run restore -- /secure/backups/<file>.dump.enc
```

- Backups are AES-256-GCM encrypted as they stream out of `pg_dump`, with a
  SHA-256 manifest. A failed backup leaves no file behind.
- Restore checks the manifest, then restores in a single transaction as the
  schema owner (through the restore role's membership). A tampered or
  corrupted file fails authentication and leaves the database unchanged.
- Restart the application after a restore so it reconciles role grants.

This procedure was exercised end to end: provision, back up, delete data,
restore, and serve the restored rows through the runtime role.

## Security review

An attacker-minded review of the whole system (September 2026) looked at it
as several attackers at once: anonymous visitors, signed-in users of other
workspaces, a user with read-only access, malicious web pages the AI reads,
code running in the sandbox, and someone with access to backups or logs.
Everything below is covered by tests.

Fixed in that review:

- **Sandbox escape to host files**: code could replace its output folder with
  a link to the host; outputs are now read only from real paths inside the
  job folder, never through links (`O_NOFOLLOW`).
- **Prompt-injection data theft**: the AI may only open addresses the person
  gave, that a search returned, or that appeared on a page it read, so an
  address it builds with private data attached is refused.
- **Local execution**: the signed challenge covers a digest of the exact code.
- **Restore of altered backups**: the whole AES-GCM tag is verified, from a
  private copy, before `pg_restore` reads anything.
- **Sign-in**: links and 8-digit codes are single use, 15 minutes, stored only
  as hashes; 5 wrong codes end them; 3 emails per address and 20 per network
  per hour; IPv6 is counted per /64; links are built only from `PUBLIC_URL`
  (never a request's Host header); sign-in emails are never written to logs on
  a deployed server; with sign-up off, response timing does not reveal accounts.
- **Browser**: `__Host-` session cookie over HTTPS; every link refuses
  `javascript:`/`data:` addresses; `X-Frame-Options: DENY` alongside the strict
  Content-Security-Policy; request bodies cannot carry prototype keys.
- **Transport**: production refuses an unencrypted connection to a database on
  another machine.

Checked and found sound: row-level security on every tenant table (a viewer
cannot change others' data), SSRF guard with DNS pinning, parameterized SQL
throughout, zip-bomb limits, downloads served as attachments with `nosniff`,
constant-time secret comparisons, Stripe signature and replay checks, runner
tokens over HTTPS, log redaction, and no known vulnerable dependencies.

Operator checklist for sign-in:

- set `NODE_ENV=production` and `PUBLIC_URL=https://…` (email sign-in stays
  off without `PUBLIC_URL`);
- keep `OBJECT_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` in a secret manager;
  after rotating the object key, re-enter the mail password;
- use a dedicated mailbox or app password for the sending account;
- decide `ALLOW_SIGNUP`: open sign-up gives every new account the free AI
  allowance, so watch `sign_in_links_throttled_total` and usage;
- grant `platform-admin` only to the people who run the service.

Known limits: someone who can burn an address's 5 code guesses can make its
current email useless until a new one is requested (a nuisance, not access);
a platform administrator can point the mail server at any host.

## What this document does not claim

Passing CI is not proof that a deployed system is safe for every workload.
Production readiness still depends on the concrete deployment, runner isolation,
credentials, policies, jurisdictional requirements, monitoring, backup/restore
drills and operational controls. The system is designed to fail closed when those
dependencies are missing rather than pretending they exist.


## Current implementation synchronization

Account preferences are created by migration 17 and protected by PostgreSQL RLS. Voice and offline queue preferences are accepted and stored by the preferences API. The browser offline queue stores attachment metadata in session storage and attachment bytes in IndexedDB when available; private API responses remain uncached. Migration 29 removed the old simulation tables and schedules.
## Gemini on Vertex AI

Kindgleam's production model transport is Gemini through Google Cloud Vertex AI / Gemini Enterprise Agent Platform. Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION=global`, then attach a least-privilege service account to the production workload so Application Default Credentials can obtain short-lived access tokens. A short-lived `GOOGLE_VERTEX_ACCESS_TOKEN` is supported for local/test runs. Vertex Express Mode with `AI_API_KEY` remains available for development only. The runtime does not call `generativelanguage.googleapis.com`.

## Release-gate verification (September 30, 2026)

Run against PostgreSQL 16 with `npm ci`, `npm run check`, `npm run lint`, `npm audit --omit=dev --audit-level=high` and `node --test`:
source check clean, lint clean, 0 vulnerabilities, migrations 1-34 apply and re-apply cleanly, and the suite passes
(the Docker sandbox tests are skipped where no container runtime exists; CI runs them where Docker is available).

Fixed in that pass:

- **Vertex on Google Cloud crashed at model selection.** With a project and a service account but no API key
  (the documented production setup), `resolveConfiguredModel` read `.apiKey` of a missing connection and threw.
- **Customers saw the wrong limits.** The backend, environment variables and docs use a 4-hour window
  (`fourHourTokens`, `USAGE_LIMIT_4H_TOKENS`), but the billing API and account screen used `fiveHourTokens` and
  "5-hour", so paid plans showed "No 5-hour limit". All layers now say 4 hours.
- Lint failures from dead code left after model discovery was disabled; a test harness and tests that still
  targeted the retired Gemini Developer API instead of Vertex request shapes.
