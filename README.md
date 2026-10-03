# Kindgleam

**One adaptive workflow for governed, evidence-backed work.**

Kindgleam is not a bundle of domain products. Education, engineering, business,
research, design, science, operations and future domains are context, not separate
engines. The core adapts to the situation and is not limited to a predefined
capability universe.

```
goal
  → understand
  → safety/ethics gate
  → [investigate when justified]
  → [discover or compose missing capabilities]
  → adapt
  → plan
  → [human approval]
  → execute through authorized boundaries
  → observe evidence
  → verify
  → deliver
  → iterate
```

The native capability registry is only a bootstrap set. Unknown or unprecedented
requirements become governed capability specifications. A discovered capability
remains non-executable until an authorized implementation exists, passes its
required gates, and can return authenticated evidence.

The full architecture — workflow, capability lifecycle, execution trust,
governance, privacy and invariants — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Adaptive product architecture

The web client is a single adaptive workbench rather than a collection of fixed
domain applications. A user starts with one outcome. The server preview determines
the intent, required capabilities, workflow depth, execution constraints and
adaptive surfaces. The interface then exposes the surfaces selected for that run:

```
one goal
  → server plan
  → adaptive surfaces
     chat / research / code / creation / workspace
  → server-owned task graph
  → governed execution
  → evidence
  → verification
  → delivery
```

Surfaces are contextual UI, not separate engines. A compound request may expose
several at once; an unfamiliar request can enter discovery and generic capability
routing without changing the core workflow. Users can inspect the selected
workflow, current task, execution boundary, evidence and governance state from
the same run. The browser consumes server-selected surface descriptors; it does not
maintain the authoritative list of possible work surfaces.



The core is shared by individual and enterprise deployments. The audience and
workspace context change the policy and resource boundary, not the workflow:

```
individual → personal workspace → user/task policy
enterprise → organization → workspace → user/task policy
```

A goal may stay chat-only or compose multiple surfaces in one run. For example,
a research + coding goal can produce one graph whose execution order is
`research → code → observe → verify`. The server persists the adaptive
context with the run so a reload does not change what was planned.

Runtime placement is deployment-aware:

- `local`: local-first deployment context
- `hosted`: hosted deployment context
- `hybrid`: mixed local/hosted deployment context

For executable code, the run also selects an execution target:

- **Local machine** — an optional execution target for deployments that explicitly pair a local agent; it is not a Code Workspace source.
- **Kindgleam sandbox** — Kindgleam's sealed runner for code (`SANDBOX_RUNNER_URL`).

The selection order is: detect requirements → preflight local resources when local is eligible → select a compatible target → require human approval → execute through the target boundary → record the receipt → observe → verify. The system never silently moves an execution to the cloud.

### User-controlled adaptive scope

Every run separates available resources from the resources actually selected
for the current situation. The adaptive controller uses a minimum-necessary
working set and explicit ceilings for capability count, external sources,
artifacts, context, execution stages, tool rounds, attachment text and evidence.

Users control three important decisions from Personalization:

- Depth — brief, standard or thorough.
- Adaptive expansion — whether the system may expand one level automatically
  when the current scope proves insufficient.
- Missing capability investment — ask first, prepare a design, or prepare a
  candidate build.

The selected working set is persisted with the run. Omitted resources are not
silently pulled in later. A later observation can show that more is necessary;
the workflow then re-evaluates the situation and asks for expansion when the
current authorization does not cover it.

A missing capability is not treated as executable merely because its name was
discovered. When candidate investment is authorized, the existing tool forge can
write and sandbox-test a workspace tool; approval and verification still precede
promotion. The system therefore adapts what it uses without turning discovery
into hidden automatic investment.

### Built-in tool runner

Discovered capabilities and investigation tasks execute through the generic
tool boundary (`TOOL_RUNNER_URL`). The repository ships a runner for it:

```
RUNNER_TOKEN=<32+ chars> npm run tool-runner     # listens on 127.0.0.1:8766
TOOL_RUNNER_URL=http://127.0.0.1:8766 RUNNER_TOKEN=<same> npm start
```

It implements three tools and nothing else:

| Tool | Does |
| --- | --- |
| `web.fetch` | Readable text of a public page, with final URL and SHA-256 provenance |
| `http.check` | Whether a public URL responds, with status and timing |
| `math.evaluate` | Exact arithmetic through a parser, never `eval` |

Guarantees: the runner is a separate process and requires the shared token;
URL tools refuse private, loopback, link-local and metadata addresses at every
redirect hop and pin each connection to the vetted address; a discovered
capability runs only after an administrator approves it, and only the tools
its approved spec names. A request selects the tool with
`payload: { tool, input }`. Anything the runner cannot do is reported as not
executed; it never returns a fabricated result.

### Outside services

Kindgleam's core AI/payment stack uses the **Google Gemini API** (Gemini 3.8 Flash) and **Stripe** for payments. **GitHub** is an additional optional authenticated source for Code Workspace projects and write-back. Everything else is
its own code: document reading, web search (through Gemini's Google Search grounding)
and page and file downloads (through its own guarded fetcher), the sandbox
and scheduling. It does not connect to accounts such as Google
Drive, Gmail, Dropbox or OneDrive; data kept there arrives as attached files,
and the system says so when a request mentions one.

### Memory across chats

Kindgleam remembers what a person tells it that stays true (their work,
place, equipment, projects, how they like answers) and uses it in later chats. Each person's memories are private to them in that
workspace, never include secrets, and can be seen, deleted or turned off in
Settings → Personalization. See `docs/SANDBOX_AND_TOOL_FORGE.md`.

### Situation-aware governance

Governance is part of the situation model, not a separate static rules page. For each workflow,
the server combines safety, domain/risk signals, data sensitivity, jurisdiction, human-decision
requirements, side effects, server policy and verification requirements into a persisted governance
contract. The contract can put a situation into ready, care or review state, or hard-block it.

The governance contract carries privacy controls (minimum necessary data, workspace/principal
boundaries and explicit model/connector consent), ethical controls (human autonomy, transparency,
non-discrimination and no-model-authority), execution controls (approval and side-effect gates),
and verification controls (evidence, provenance and independent/human verification where needed).

Jurisdiction awareness is deliberately conservative: a regulated or high-impact situation
requires the applicable country/region before external execution (code, tools,
runner receipts and approved actions). The model may still understand and answer, but is told
to give general information, ask which jurisdiction applies and never claim that something is
legal, compliant or certified. The system does not claim to know every law or to certify
compliance; jurisdiction-specific policy sources and qualified professional review remain
authoritative.

Governance follows the work rather than being fixed at planning time:

- **Re-evaluated on discovery.** When understanding, capability discovery or reassessment finds
  a capability the plan did not contain, governance is re-evaluated with everything seen so far.
  Capabilities, tools, side effects, data classes and risk only accumulate, so a discovery can
  tighten governance (for example, ready → review for a high-impact capability) but never
  loosen it. An escalation is written to the audit trail as `run.governance.escalate`.
- **Applied by the model.** Gemini receives the governance record with every task and is
  instructed to follow its restrictions: keep consequential decisions about people with a
  person, never use or infer protected characteristics, avoid manipulation, be transparent
  about uncertainty and what was actually done, and recommend a qualified professional when
  the stakes call for it.
- **Refusals are audited.** A safety or governance refusal at the execution boundary is
  recorded as `run.execute.denied` with its reason code, never the task content.
- **Visible to the person.** The workbench shows the governance state on a step whenever it
  asks something of the person (care, review or blocked).

### Ethics and safeguards

Safety is an adaptive-system invariant, not only prompt guidance. The server evaluates the
same governed safety decision while understanding the goal, before capability discovery,
while composing the adaptive workflow, and again at execution and external-receipt boundaries.
Model safety hints are untrusted and can only make a decision stricter. A deterministic refusal
cannot be reopened by later adaptation, a newly introduced plainly harmful task is re-checked
without a model, and legitimate goals remain open-world and free to adapt across domains.

Kindgleam helps with anything good and declines what would hurt people: each request is allowed,
helped with care (health, law, money, decisions about people) or kindly refused with a safe
alternative. The same rules cover images, new tools and scheduled messages. Religion is not
discussed, for any religion (`BLOCKED_TOPICS`). People confirm their age (16+) and accept the
terms before starting, can report any answer, and admins review reports. See
`docs/USAGE_POLICY.md` and `/policy.html`.

### Checking it with Gemini 3.8 Flash

`npm run eval:live` sends 35 real requests (greetings, writing, emergencies,
research, files, code, reminders, memory, the usage policy) to a running
deployment and checks the flow, tools and answer of each, with the real AI
model. See `docs/LIVE_EVALUATION.md`. What the service keeps and shares, for
a privacy policy, is in `docs/PRIVACY_NOTES.md`.

---

## Files, folders and simulations

There is no separate simulation feature. Every file, folder or zip archive
the person attaches is handled in the normal chat: read, explained, changed
and handed back there. When the work is software (a zip of a project, a
script, a netlist, a MATLAB/Simulink script, a FreeCAD macro), it becomes a
**code project**: the code is written with its tests, run in the sealed
sandbox where its language can run, and delivered with what it printed. A
request to simulate something is the same: code that computes it. A question
about a simulation is simply answered.

## Universal adaptive architecture

The core is a **situation-adaptive capability workflow**, not a fixed catalog of applications:

```
Goal
  → Normalize into a goal model
  → Understand outcome, constraints, unknowns and evidence needs
  → Investigate when justified
  → Discover/compose capability contracts
  → Adapt runtime + tools + data + UI
  → Plan with fixed success criteria
  → Human approval when execution, impact, or policy requires it
  → Execute through an authorized boundary
  → Observe real evidence
  → Reassess the situation against the new evidence
  → Discover additional capabilities when required
  → Re-plan through the server-owned graph when required
  → Verify against the current success criteria
  → Human certification when the verification contract requires it
  → Deliver evidence + artifacts + limitations
  → Iterate or finish
```

A capability is described by its inputs, outputs, prerequisites, execution modes, tools,
data classes, risk, side effects and verification method. Dynamic capabilities are
**candidates** until an authorized implementation exists and returns evidence. This lets
the platform meet unfamiliar requirements without adding a new domain-specific engine.

### Execution trust model

Local code runs use an optional paired local agent. The browser may provide
coarse hints, but the server does not consider a machine locally compatible without an
agent preflight containing exact host information. A local result must carry an
HMAC-SHA256 receipt bound to the run id, task id, task type, execution target and output
hashes. An unsigned or altered receipt cannot complete the server-owned task.

Code Workspace supports GitHub repositories and browser-selected local-folder snapshots. The terminal always starts from a server-side snapshot of the selected source; local folders are imported as private snapshots, never as host filesystem connections.
An optional paired local agent is a separate execution target and never becomes a Code Workspace source.
GitHub write-back requires explicit source permission, an exact revision, pre-image checks,
and an explicit apply confirmation.

A managed runner (the sandbox or the tool runner) must return the execution evidence for
the server to mark a task complete. The same rule applies to any external execution boundary: a claim without
authenticated execution evidence is not completion.

### Verification trust model

Verification is distinct from execution. The system records what actually happened first,
then checks that evidence against success criteria fixed during planning. Physical or
high-impact workflows can require a human-certified verification level. The platform
does not turn a model output into a legal, regulatory, safety, medical, or professional
certification merely because a model expressed confidence.

### Open-world boundary

Open-world means the native registry is a bootstrap set, not a complete list of all
possible capabilities. Goal interpretation is not limited to those domain names: the
adaptive compiler first builds a domain-neutral goal model, and an unresolved or novel
goal enters a governed discovery path instead of being forced into an existing domain. Kindgleam can discover a missing capability, describe the
required contract, find an authorized integration, or request that a connector/runner be
installed. It cannot honestly claim access to an external product that has not actually
been connected, authorized and made executable in the deployment.


## The rule the system is built on

**Nothing is claimed unless it actually happened.** That is enforced in code:

| Situation | What the system does |
|---|---|
| No reasoning model configured | Task stays `pending`, `executed: false`, `status: "not-configured"` |
| No runner configured | Same — and it does **not** burn an attempt |
| Runner errors or is unreachable | `executed: false`, `status: "failed"` / `"unreachable"` |
| `verify` requested before `observe` completed | **409** — a task cannot complete before its dependencies |
| `observe` or `verify` with no evidence | **422** — tasks that record reality must record something |
| Policy denies a capability | Run is `blocked`, naming the capability |
| Policy requires approval | `409 awaiting-approval`; the gate cannot execute itself |
| `iterate` loops forever | Bounded by `MAX_RUN_ATTEMPTS`; then `exhausted` |

### Why the server owns the workflow

An earlier version kept the plan in the client and accepted it back on every
advance. A caller could post a graph with every dependency already marked
complete and have the server record *"verified"* against no evidence:

```
verify.status   = complete
verify.evidence = "none whatsoever"
```

A dependency check on client-supplied state protects nothing. Now a run is rows
in Postgres; each advance re-reads them under `SELECT … FOR UPDATE` and decides
from stored state. The client names a task and supplies evidence — it never
supplies status. `tests/security.test.js` replays that exact attack.

---

## Repository

```
server.js              bootstrap, lifecycle, graceful drain
bin/admin.js           operator CLI — bootstrap, keys, members, migrations
src/config.js          environment → validated frozen config (fails fast)
src/db.js              pool, migrations under an advisory lock, transactions
src/core.js            the workflow: intent, capabilities, policy, task graph (pure)
src/identity.js        principals, API keys, sessions, workspaces, roles
src/runs.js            server-owned runs — the integrity boundary
src/objects.js         object store: dedupe, refcounts, quotas, keyset paging
src/runtime.js         outbound: model providers and execution runners
src/adaptive.js           capability registry + local/hosted adaptive context
src/governance.js         server-owned layered governance policy store
src/audit.js           append-only audit log
src/app.js             HTTP: auth, CSRF, idempotency, rate limits, routes
public/                the interface (no inline script or style — strict CSP)
tests/                 core, security, API — against real PostgreSQL
```

`src/core.js` performs no I/O and reads no environment, so planning and
governance are tested without a server, a database or a key.

---

## Quick start

```bash
docker compose up -d db          # or point DATABASE_URL at your own Postgres
cp .env.example .env
npm install
npm run bootstrap -- --workspace acme --name "Your Name"
```

`bootstrap` prints an API key **once** — only its SHA-256 is stored.

```bash
npm start                        # http://localhost:3000
npm test                         # current test suite against a real PostgreSQL database
npm run lint                     # static checks (undefined names, unused code)
npm run verify                   # check + lint + tests: run before every push
git config core.hooksPath .githooks   # optional: run verify automatically on git push
```

It runs with no model and no runners configured: the workflow still plans, and
every response states plainly that nothing was reasoned or executed.

---

## Application-level private data protection

PostgreSQL RLS protects tenant boundaries, and PostgreSQL should also use encrypted
storage/transport in production. Kindgleam additionally encrypts high-sensitivity
application fields before they enter PostgreSQL:

- **Workspace billing:** invoice email, company name, tax ID, country, address,
  Stripe customer ID and Stripe subscription ID are encrypted with a dedicated
  `BILLING_ENCRYPTION_KEY`.
- **Individual memory:** saved memory text is encrypted with a separate
  `PERSONAL_DATA_ENCRYPTION_KEY`; lookups use a keyed digest instead of plaintext
  normalized text.
- **Payment cards:** card numbers, CVC/CVV and payment-method details are not
  stored by Kindgleam. Checkout and payment-method management stay on Stripe.
- **Key separation:** production requires the billing and personal-data keys to
  be distinct from each other and from the object-storage encryption key.

Keys belong in a secret manager, with a documented rotation procedure and no
plaintext keys in source control.

## Production database hardening

Production uses three separate database trust planes:

```
runtime role
  → normal application requests
  → must be non-superuser and cannot bypass RLS

migration role
  → schema migrations and controlled maintenance

backup role
  → backup-only database access

restore role
  → restore-only privileged database access
```

Tenant-owned tables use PostgreSQL Row-Level Security as defense in depth. Request
identity and workspace context are established by the authenticated server and
applied transaction-locally, so a pooled connection cannot carry one user's
tenant context into another request. Production startup verifies RLS coverage and
rejects an application database role that can bypass it.

Backups use the dedicated backup database identity and stream through AES-256-GCM
encryption. Restore verifies the backup manifest and SHA-256 before passing
decrypted bytes directly to `pg_restore`.

## Privacy and sharing model

Privacy is enforced at both the tenant and individual-user level:
- every authenticated request is bound to its server-verified workspace and principal;
- runs and objects are private by default, with explicit workspace sharing;
- request JSON cannot self-declare a private Google, Gmail, Drive, Calendar, Photos or other provider connection;
- only a server-verified external connection can authorize private provider access;
- external model/runner processing of private data requires both policy authorization and explicit processing consent;
  a data-class allow-list fails closed as soon as any policy layer declares
  `allowedDataClasses` (even if the intersection is empty); when no layer
  declares one, the user's consent and any `deniedDataClasses` decide. Consent
  is only needed for external egress; same-scope internal access never asks;
- public information remains distinct from private provider data.

The system treats a connector catalogue entry as a capability description, never as proof that an account is connected. Live OAuth/token infrastructure remains deployment-specific and must establish the verified connection state before private retrieval is enabled.

## Security model

- **Authentication.** API key (`Authorization: Bearer kg.<id>.<secret>`) or an
  httpOnly session cookie obtained by exchanging a key at `POST /api/session`.
  Only key hashes are stored, so a database dump is not a set of credentials.
- **Tenancy.** Scope comes from `X-Workspace-Id` and is checked against
  membership. It is never read from the request body, and ownership is stamped
  from the authenticated principal. Naming a workspace you do not belong to
  returns **404**, not 403 — existence is itself information.
- **Roles.** `viewer` reads, `editor` writes and runs, `admin` also reads audit.
- **CSRF.** `SameSite=Strict` plus a client header that a cross-site form post
  cannot set. Bearer callers are unaffected.
- **CSP.** `default-src 'self'` with no `unsafe-inline`, which is why the page
  carries no inline script or style.
- **Uploads** are always served `application/octet-stream` + `attachment` +
  `nosniff`, so stored bytes can never execute on our own origin.
- **Logs** pass through a redactor; keys, tokens, cookies and object content
  never reach them.
- **Audit.** Append-only, and denials are written *outside* the rejected
  transaction — otherwise the rollback would erase the very record that matters.

---

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | — | Liveness. Touches nothing else. |
| `GET` | `/api/ready` | — | Readiness. Checks the database. |
| `POST` | `/api/session` | — | Exchange an API key for a cookie |
| `GET` | `/api/me` | any | Principal and workspace memberships |
| `POST` | `/api/plan` | viewer | Preview a goal. Persists and executes nothing. |
| `POST` | `/api/runs` | editor | Create a run |
| `GET` | `/api/runs` | viewer | List runs (keyset paging) |
| `GET` | `/api/runs/:id` | viewer | One run with its task graph |
| `POST` | `/api/runs/:id/execute` | editor | Execute the next task for real |
| `POST` | `/api/runs/:id/advance` | editor | Record an outcome for one task |
| `POST` | `/api/runs/:id/fail` | editor | Abandon a run |
| `POST` | `/api/objects` | editor | Store an object |
| `GET` | `/api/objects` | viewer | List (scoped, keyset paging) |
| `GET` | `/api/objects/:id/content` | viewer | Bytes, always as a download |
| `DELETE` | `/api/objects/:id` | editor | Delete, releasing unreferenced bytes |
| `GET` | `/api/audit` | admin | The trail for this workspace |
| `GET` | `/api/metrics` | any | Prometheus text format |
| `GET` | `/api/capabilities` | any | Capability and connector catalogue |
| `GET` | `/api/execution/config` | any | Available local/sandbox/tool-boundary targets |
| `POST` | `/api/runs/:id/execution-plan` | editor | Preflight and select an execution target; no execution |
| `POST` | `/api/runs/:id/execution-result` | editor | Record a local/external execution receipt |

`POST` accepts `Idempotency-Key`: a retry after a timeout replays the first
response instead of doing the work twice, and reusing a key with a different
body is a **409**. Governance is loaded from server-owned policy records;
clients may supply only an optional `taskPolicy` restriction.

```bash
curl -s localhost:3000/api/runs \
  -H "authorization: Bearer $KEY" -H 'x-workspace-id: acme' \
  -H 'content-type: application/json' \
  -d '{"goal":"Write a Python function that reverses a string, with tests."}'
```

---

## Governance

Policy is evaluated **while planning**, not audited afterwards. Five persisted
server-owned layers, most authoritative first, plus an optional task-level
restriction supplied by the authenticated caller:

```
platform → jurisdiction → organization → workspace → user → task
```

- **Denials union.** A platform prohibition cannot be re-enabled underneath it.
- **Allow-lists intersect.** Every non-empty allow-list must permit the capability;
  lower layers cannot widen a higher layer's restriction.
- **The tightest `maxTokens` wins.** The budget is in *tokens*, because token
  counts are the only spend figure providers actually return. Dollar pricing is
  deployment-specific and is not invented here.
- **Opt-in, but fails closed once partial.** No policy → `unconfigured`,
  everything granted, and the plan says so. Policy without its `platform` layer
  → `incomplete`, nothing granted. A half-configured control plane is a
  misconfiguration, not a permission.
- **Approval gates precede execution**, and `/api/runs/:id/execute` refuses to
  pass one. A system that auto-approves its own gate has no gate.

```jsonc
{
  "goal": "Write and run a migration script.",
  "policies": {
    "platform":     { "id": "platform-v1", "deniedCapabilities": ["code-execution"] },
    "organization": { "id": "acme", "requireHumanApproval": true, "maxTokens": 50000 }
  }
}
```

Policy evaluation is a control decision, not a legal-compliance guarantee.
Policy storage is server-owned: a request body cannot replace platform,
jurisdiction, organization, workspace or user policy.

---

## Data

PostgreSQL is the only datastore — object bytes included — so there is no
filesystem state to mount, back up or keep in sync.

Content identity is separate from object identity, and the content digest is
workspace-scoped when encryption is enabled:

```
        bytes
          │
   workspace-keyed digest
      ╱           ╲
 workspace A    workspace B
     blob A        blob B
```

Identical bytes in different workspaces are intentionally stored under different
digests. This prevents cross-tenant content-identity leakage. Objects remain
independently owned, scoped, authorized and deleted. Deleting one releases the blob **only** when the last
reference goes — a soft delete that never frees storage is a leak, and an
unconditional delete would destroy another tenant's content.

Quotas are enforced per workspace inside the same transaction as the write,
with the workspace row locked, so concurrent uploads cannot both see room that
only one of them can have.

---

## Operations

- **Migrations** run at boot under a Postgres advisory lock, so concurrent
  instances in a rolling deploy cannot both apply them. CI runs them twice to
  prove they are idempotent.
- **Shutdown** stops accepting, drains in-flight requests, closes the pool, and
  hard-exits after 15s rather than hanging a container.
- **Probes:** `/api/health` for liveness (deliberately does not touch the
  database — a blip should not make an orchestrator kill healthy processes),
  `/api/ready` for readiness.
- **Pool sizing:** keep `PG_POOL_MAX × instances` under the server's
  `max_connections`.
- **Behind a proxy:** set `TRUST_PROXY` only for proxies you control. `true`
  trusts exactly one hop (your load balancer), a number trusts that many
  layers, and a list names proxy addresses or subnets. Every hop is never
  trusted, so a forged `X-Forwarded-For` cannot dodge per-IP rate limits.
- **After each deploy:** `SMOKE_API_KEY=… npm run smoke:deploy -- https://your-host`
  checks health, readiness, security headers, the auth boundary, sign-in and a
  plan preview (nothing is created) and exits non-zero on failure, so a
  pipeline can roll back.
- **Zero-downtime deploys:** set `SHUTDOWN_DRAIN_MS` a little above your load
  balancer's readiness-check interval. On SIGTERM, `/api/ready` returns 503
  while the process keeps serving, then it stops taking requests, jobs and
  schedules, finishes the work in hand and exits.

---

## What is still deployment work

The repository contains the production application, PostgreSQL tenancy/RLS
hardening, authenticated runner boundaries, the sealed sandbox implementation,
encrypted backup/restore commands, structured observability, and automated
checks. A public launch still depends on configuring and proving the surrounding
operations:

- **Execution isolation.** Deploy the sandbox and tool runner as separate
  services/hosts with the documented isolation, HTTPS, runner token, resource
  limits, and preferably a stronger OCI runtime such as gVisor. Keep runner
  images pinned to reviewed immutable digests rather than floating tags.
- **Key management** for Gemini and other production credentials: use a secret
  manager, rotation procedures, least privilege, and no secrets in source
  control. The production deployment must also provide separate
  `BILLING_ENCRYPTION_KEY` and `PERSONAL_DATA_ENCRYPTION_KEY` values.
- **Backups and recovery.** Schedule encrypted backups, retain them separately
  from the primary database, and perform a documented restore drill plus
  point-in-time recovery test.
- **Observability.** Ship structured logs and metrics to a monitored system,
  define alerts for readiness failures, database pressure, rate-limit-store
  errors, failed runs and authentication anomalies, and set retention/redaction
  policies.
- **Untrusted uploads.** Add malware/content scanning and operational quarantine
  if the service accepts arbitrary user files. Document the file types and
  retention policy.
- **Capacity and rollout.** Run `npm run load-test` against staging at the
  intended concurrency, size PostgreSQL connections across all instances, and
  verify graceful drain, readiness, rollback and database migration procedures.
- **Release gate.** Do not expose the service publicly until the current main
  commit has a successful `verify`, CI, CodeQL and secret-scan run, and the
  deployed URL passes `npm run smoke:deploy`.


## Open-world capability model

Kindgleam treats capabilities as runtime requirements rather than a permanent
finite list:

```
known need       → existing capability
compound need    → compose capabilities
unknown need     → investigate + discover requirements
missing tool     → create a capability specification
new capability   → execute through an authorized generic tool boundary
insufficient     → observe → verify → iterate
```

Each dynamic capability carries purpose, inputs, outputs, execution mode, risk,
constraints and a verification method. Governance can restrict capability names,
tools and risk classes. Missing infrastructure is never converted into a fake
successful result; the task remains pending until an authorized executor produces
evidence.

## Architecture boundary

Kindgleam deliberately keeps intelligence, orchestration, governance and execution separate. Models can change without rewriting the workflow; execution runners can move between local and hosted deployments; GitHub access is a connector rather than an implicit credential. Enterprise controls belong to server-owned organization/workspace policy rather than user-editable request JSON.


## Local execution bridge

The optional `bin/local-agent.js` runs on the user's own machine. It reports exact host CPU, memory, storage and NVIDIA GPU information when available, then exposes an explicit execution endpoint. Browser access is origin-allowlisted, process execution is disabled by default, and shell strings are never accepted.

Start it separately:

```bash
npm run local-agent
```

Configure the Kindgleam web origin in `LOCAL_AGENT_ALLOWED_ORIGIN`, then set `LOCAL_AGENT_ALLOW_PROCESS_EXECUTION=true` only for a reviewed local execution deployment. For stronger isolation, run the bridge under a restricted OS account or container. The bridge is a controlled execution interface, not a kernel-level sandbox.

The bridge currently supports Node.js and Python source execution.

## Execution policy

Execution targets are treated as governed tools. A policy can deny or allow `local`, `general-ai-sandbox` or `generic-tool-router`, and high-risk execution still requires human approval. Local preflight data is advisory until the selected target actually returns a receipt; an unknown local environment is never considered sufficient.


### Offline state

The browser workbench keeps unsent message metadata in the current session and stores queued attachment blobs in IndexedDB when the browser provides it. The service worker caches only the application shell; private API responses are never cached for offline replay. User preferences are persisted in PostgreSQL with tenant/principal RLS.
