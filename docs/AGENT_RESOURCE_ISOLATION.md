# Kindgleam: simple adaptive specialists with isolated agent resources

## What is now authoritative

**One active run controller, one scoped resource broker, one shared policy
interface, and the existing specialized agent catalog.** This is not a
second agent runner, a new generic tool execution system or a duplicate
database. Normal Chat, Coding and Research retain independent adaptive
workspaces and UI behavior.

`src/agent-resource-broker.js` is the single resource admission and identity
contract for AI agents and subagents:

1. The run is loaded by authenticated scope, not from model-supplied IDs.
2. The broker requires `workspaceId` and `principalId` to match the persisted
   run owner, and a task ID already present in that run.
3. The scope is shared by parent and child agents; no child can switch tenant,
   switch user, assume workspace-admin powers, mint an execution token, or
   reveal another user's private files.
4. Resource requests are checked against task, surface, path safety, actual
   tool availability, effective policy, destination consent and approval.
5. Authorized read-only tools such as attached-file inspection can be used via
   the already existing `toolbox.js` tool loop and scope checks.
6. Sandbox runs, package installation, code edits and external effects
   remain requests until the owning parent uses the existing explicit
   proposal/approval/executor/receipt workflow. Admission itself is
   **never** an execution receipt.
7. The interactive terminal is opened by the authenticated human through
   `terminal.js`: a disposable, restricted container with its own session
   ownership, quotas and revocation checks. Subagents cannot type into a PTY,
   receive the Docker socket, read host secrets or run arbitrary host commands.
8. MCP tools are reached through the configured and policy-gated toolbox,
   not by importing provider credentials into agent prompts.

## User isolation

Users can deliberately share conversation visibility inside a workspace.
That does **not** authorize another workspace member to execute the owner's
agents, private file tools, model/RAG, sandbox or terminal. The execution
route checks this before doing work. The underlying tool loop and the
model/retrieval path separately enforce the same owner boundary.

Database migration **80** changes RLS for `run_agents` and `run_waves`:
workspace-shared runs can still be *read* where permitted, but agent/wave
**inserts, updates and deletes are owner-only**. Existing user-scoped
memories, files, saved specialist recipes and private chats retain their
database and application-level isolation. All database queries still use
transaction-local RLS settings, never pooled session-level tenant state.

**Not a blanket non-sharing promise:** information a user intentionally
shares in a workspace is visible under that workspace's authorization
rules. The broker prevents those read permissions from silently escalating
into control of the original owner's private runtime.

## Specialized backend work

The current catalog defines 55 families with 440 available task-specific
subskill descriptions. They are not 440 always-on agents. Each parent usually
activates 1–3 relevant skills, and only high-uncertainty/independent advisory
checks justify extra model calls within the existing two-child-call budget.

Backend examples:

- Backend engineering: service design, business logic, queues, caching,
  background jobs, errors, integration and scalability.
- API engineering: contracts, API authentication, versioning, webhooks,
  rate limits and testing.
- Database engineering: PostgreSQL, schema design, migrations, transactions,
  data integrity, query performance and backups.
- Security engineering: trust boundaries, authentication, authorization,
  secrets, privacy and vulnerability review.
- Testing and debugging: real test receipts, reproducible errors and
  targeted repairs, not unverifiable model claims.

Parent agents coordinate dependencies and actual project-file ownership.
Only the existing authorized executors can make side effects. User-approved
scope cannot be expanded because a specialist proposed a tool.

## Adaptive resource workflow

```text
Request -> choose primary specialist -> needed subskills
        -> propose necessary resources -> bind authenticated run-owner scope
        -> evaluate effective policy, capability and consent
        -> read-only tool if available OR explicit human approval
        -> existing isolated execution path -> recorded receipt
        -> parent verifies/reassesses -> deliver
```

This is intentionally *not* a fixed sequence of mandatory model steps.
Short requests remain direct. Long tasks continue to adapt at meaningful
checkpoints and record observed parallel work; proposals are shown with
real admission states (not executed, approval required, ready, or unavailable).

## Remaining production validation

- Apply migration 80 and test PostgreSQL RLS under two real user principals,
  two workspaces, a deliberate shared run and a background worker scope.
- Run `node --test tests/agent-resource-broker.test.js
  tests/agent-resource-integration.test.js` plus the full repository suite,
  lint and production checks on a real checkout.
- Test terminal/runner isolation with real containers, concurrent users,
  stale approvals, revoked membership, quota exhaustion and secret-bearing
  project inputs.
- Verify real Gemini, MCP, GitHub, local file and code runner calls;
  resource proposals alone are never proof those workflows executed.
- Benchmark completion quality, tool accuracy, latency and cost before
  claiming production-level maturity.

**Current state:** source changes and focused smoke checks committed to
`main`; full PostgreSQL migration execution, full GitHub CI, production
sandbox and live-provider validation are not yet confirmed.
