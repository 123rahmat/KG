# KG Coding and Research Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refocus one existing KG system on Coding and academic Research, with two isolated domain controllers/project chats, verified outputs and bounded multiagent workflows.

**Architecture (user-corrected 10 October 2026):** **One KG AI/execution system** with **two independent domain control engines** (CodingControlEngine and ResearchControlEngine). Each controls its own orchestration, agent recruitment, graph instances, work policy and acceptance. Its project/run/agent/context/artifact scope is logically isolated; the underlying RunStore, task lifecycle, worker/leases, tools, model gateway, budget, auth, database and sandbox are **shared**, never duplicated. Do not interpret “separate engines” as “two full systems”. Domain queue reservations are partitions of one shared scheduler; separate deployments are optional, not core architecture. Cleanup follows caller replacement and preserves research provenance and historical user data. See the 2026-10-10 architecture correction.

**Tech Stack:** Existing Node.js ESM (Node >=22.0.0), Express 5, PostgreSQL, node:test, ESLint, Playwright, existing provider and sandbox interfaces. Research computation uses a separate locked Python runner environment with SymPy, SciPy and Matplotlib; preserve the configured deployment model catalog.

**Spec:** `docs/superpowers/specs/2026-10-09-coding-research-design.md`

**Base:** `123rahmat/KG` main `e7b5630f9132b5db2782c09e1b6288970195d06f`; Git tree `979319795f0126d76934571469a23e2d60595240`. Latest existing migration is 80. Refresh main and reconcile concurrent changes before implementation or integration.

## Architecture correction — binding requirement (2026-10-10)

**User decision:** Separate **control engines**, not complete AI systems. Apply this correction to every task and test below, including older `CodingEngine`/`ResearchEngine` names. New code should use `CodingControlEngine` and `ResearchControlEngine` for domain decision-makers. The existing shared kernel/runtime is the only system owner of RunStore, jobs, persistence, provider/tool gateway, authorization, usage and verification receipts. Each controller has **isolated per-run work DAGs, agent-team choices, memory/cache/artifact namespaces and acceptance**, enforced by the shared runtime; do not duplicate these infrastructure services. Use one deployable application unless measured workload warrants separate worker pools. Project chats remain separate views over that one platform.

**Implementation reinterpretation:** The “engine ownership and historical migration” task must introduce `control_engine_id` (or an unambiguous alias `engine_id`) as **immutable domain-control scope**, not a new independent runtime. The “separate engine execution and fair queue capacity” task implements two controller entry points **feeding the same RunStore and shared worker scheduler** with logical queue reservations, not two copies of the lifecycle. The “two separate workspace interfaces” task delivers domain-specific project chats, not two websites. Cross-controller transfer needs explicit versioned handoff; incidental analysis code/paper reads remain in the owning controller. Update tests to verify reuse of shared services as well as isolation of control decisions and private project work.

`docs/architecture/SHARED_KG_DOMAIN_CONTROLLERS.md` on the foundation PR is the authoritative ADR for this clarification. Do not remove old data or claim the migration complete before the shared runtime is connected and verified.

## Global Constraints

- “The product has two distinct workspaces, Coding and Research, each with its own workflow engine and project work chats.”
- “Each run has exactly one owning **control engine** for policy, graph and acceptance; there is **one authoritative shared task lifecycle**.”
- “Distinguish tenant workspace identity from engine type.”
- “Enforce scope on the server before substantive planning, agent recruitment, retrieval, tool admission or execution.”
- “Treat a scope decline separately from safety/abuse refusals so an ordinary unrelated request does not penalize the account.”
- “Do not insert brainstorming and planning as compulsory stages for every request.”
- “Once implementation is requested within a clear scope, continue without repeatedly asking for the same authorization.”
- “Keep a configurable initial ceiling of four concurrent jobs per run as a tuning starting point, not a promise of optimal performance.”
- “Do not introduce a competing worker store with its own task lifecycle.”
- “Do not drop historical database migrations or remove user data as a shortcut to code cleanup.”
- “If execution is unavailable, show ‘Not run’; a model assertion cannot count as a passing test.”
- No automatic cross-engine reads, writes, permission inheritance, or retargeting of running jobs.
- Retain existing authentication, RLS, encryption, consent, sandbox isolation, audit, backups, and usage ceilings. No provider credential is embedded in code or fixtures.
- Every implemented feature must be wired to a real server/UI execution path; exported helpers or role prompts alone do not satisfy this plan.

## Review Focus

1. A misspelled academic follow-up or humanities study must remain supported, while a misleading “Research” project label must not admit holiday planning: Tasks 1 and 3.
2. Switching the visible workspace, restarting a worker, or revoking access during work must not retarget or leak the run: Tasks 2, 5, 8 and 9.
3. The 41st source, a changed source version, or a resumed old claim must not destroy provenance or leave a verified dangling citation: Tasks 6 and 7.
4. Prefix-overlapping writes, a skipped mandatory prerequisite, duplicate messages, and late results after cancellation must not produce accepted output: Tasks 9–11.
5. An excluded mathematical root, stale chart data, misleading axis, or AI illustration presented as observations must not pass research acceptance: Tasks 14–16.

## Execution and integration

Use a feature branch `codex/coding-research-rebuild-20261009`; no force push and no wholesale main-tree replacement. The user has authorized the rebuild and removal of irrelevant product code. The current skill workflow requires review of this concrete implementation plan before product changes.

Recommended execution is Native in the current session: ownership and lifecycle changes depend closely on the same interfaces. Independent review comes after the implementation; a reviewer cannot waive missing execution or evidence. The user may instead choose subagent-driven execution with separate task reviews. Use the isolated-workspace skill when execution starts.

The work is divided into three independently checkable subprojects below. Each must leave the system runnable; dependencies between them are explicit. First complete a real coding request and a source-grounded research request end to end, then expand specialist delivery. Do not turn specialist expansion into a prerequisite for either initial working path.

### Shared names and contracts

Use JavaScript objects with JSDoc typedefs, not a repository-wide TypeScript migration. Define shared typedefs in `src/engines/contracts.js` in Task 2.

- `EngineId`: `'coding' | 'research'`. UI/API surface `'code'` maps to `'coding'`; `'research'` maps to `'research'`. Legacy `'normal-chat'`, `'chat'`, `'visual'`, and `'design'` are history values, never a new engine.
- `EngineScope`: `{ principalId, workspaceId, engineId, projectId }`, all nonempty strings. `workspaceId` remains the tenant identifier. A direct question without a project gets a server-created project in its chosen engine; a repository is optional.
- `InputIdentity`: `{ engineId, projectId, projectRevision, policyRevision, sourceVersions, acceptanceDigest }`; content digests and versions participate in caching/resume checks.
- `ScopeDecision`: `{ status: 'in-scope' | 'out-of-scope' | 'mixed' | 'needs-clarification', domain: 'coding' | 'research' | null, supportedRequest, unsupportedSummary, reply, rationaleCode }`.
- `TaskUnderstanding`: `{ deliverable, intent: 'answer' | 'explore' | 'plan' | 'implement' | 'verify', constraints, successCriteria, materialUnknowns, sourceRefs, needsBrainstorming, needsPlan, actionAuthorized }`.
- `InvocationContract`: `{ version: 1, invocationId, runId, taskId, attempt, scope: EngineScope, inputIdentity: InputIdentity, understanding: TaskUnderstanding, goal, expectedOutput, acceptanceCriteria, readSet, writeSet, dependencies, toolRefs, deadlineAt, maxSteps, maxTokens, maxCost, cancellationId }`.
- `InvocationOutcome`: `{ invocationId, attempt, inputIdentity, status, proposals, observations, artifactRefs, receiptRefs, usage, stopReason }`. Accepted findings require engine acceptance; a worker cannot return permission grants.
- `ArtifactRef`: `{ id, version, sha256, engineId, projectId, mediaType }`; all dereferences recheck authorized scope and revocation.

Public identifiers are opaque references, never authorization. Every lookup also checks scope and visibility. Encrypted record namespaces retain principal/workspace identities and add engine/project identity. Fresh tables receive RLS and runtime grants in the same task as their stores. Allocate append-only migrations 81–85 as specified below; renumber only if main has advanced, without rewriting applied migrations.

---

## Subproject A: focused product and evidence foundation

Tasks 1–7 establish the two-domain product, replace callers before deletion, and repair provenance. Unit checks can run without credentials; database/browser checks require the existing test environment.

### Task 1: Domain policy and user understanding

**Files:** Create `src/work-domain.js`, `src/task-understanding.js`, `tests/work-domain.test.js`, `tests/task-understanding.test.js`, `tests/fixtures/domain-requests.json`.
Modify `src/classifier.js` to return domain/intent assessments through its existing governed, no-tool model call.

**Interfaces:** Produces `assessWorkDomain({ request, projectContext, conversation, modelAssessment }) -> ScopeDecision` and `understandTask({ request, projectContext, conversation, assessment }) -> TaskUnderstanding`. Model assessment is untrusted structured data; policy independently validates the result. No tools are passed to classification.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('domain follows purpose rather than project label', () => {
  assert.equal(assessWorkDomain({ request: 'Plan my holiday itinerary', projectContext: { engineId: 'research' } }).status, 'out-of-scope');
  assert.equal(assessWorkDomain({ request: 'Build a holiday itinerary API' }).domain, 'coding');
  assert.equal(assessWorkDomain({ request: 'Design a qualitative thesis study of migration interviews' }).domain, 'research');
});
```

Add separate fixtures for typos/paraphrases, greetings, manuscript translation, research mathematics, a coding request plus an unrelated reminder, and “plan this” after an authorized coding discussion. A simple inspected-paper summary sets needsPlan=false; an unknown purpose requests one material clarification. Do not assert acceptance based solely on matching a keyword.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Implement the two exports above. Clear rule cases take the direct path; ambiguous cases use governed semantic assessment without retrieval/tools, or ask a focused question when that model path is unavailable. A project label cannot authorize the request. Mixed requests carry only the supported portion downstream. Preserve explicit decisions and authorization instead of asking the same question again.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/work-domain.test.js tests/task-understanding.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: define coding and scholarly research domain policy`. Do not stage unrelated user work.

### Task 2: Engine ownership and historical migration

**Files:** Create `src/engines/contracts.js`, `src/engines/scope.js`, `tests/engine-ownership.test.js`.
Modify `src/migrations.js` (append 81), `src/db.js`, `src/projects.js`, `src/runs.js`, `src/http/context.js`, `src/run-view.js`, `src/routes/projects.js`.

**Interfaces:** Consumes ScopeDecision. Produces `engineForSurface(surface) -> EngineId` (throws on legacy/unknown for new work), `assertEngineScope(scope, resource) -> void`, and the shared typedefs above. ProjectStore create/update/list/get and RunStore create/get/history/state/list require or derive the immutable engine identity from an authorized stored project.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('unsupported engines cannot start new work', () => {
  assert.equal(engineForSurface('code'), 'coding');
  assert.throws(() => engineForSurface('normal-chat'));
  assert.throws(() => assertEngineScope({ principalId: 'p', workspaceId: 'w', engineId: 'coding', projectId: 'c' }, { principalId: 'p', workspaceId: 'w', engineId: 'research', projectId: 'r' }));
});
```

Database tests seed code, research and legacy projects/runs, migrate twice, and assert unchanged IDs, visibility, encrypted contents and historical rows. Legacy history remains readable but cannot execute. Cross-engine conversation IDs, linked projects, revision snapshots and attachment ownership fail closed before any model call.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Append migration 81: nullable checked engine_id on projects/runs and existing engine-bound jobs, memory, blackboard, cache and saved specialist records; backfill only from verified project/run associations or code/research surfaces. Legacy/unassignable records retain null and are excluded from active work. New projects default to code when no surface is supplied; new engine/workspace/project combinations are validated. New runs require non-null engine and project. Add scope indexes, owner consistency checks, app.engine_id DB scope, and protected immutable run ownership. Retain historical surface values and migration SQL. Disable unsupported queued legacy work while preserving its recorded state/outcome/history.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/engine-ownership.test.js tests/projects.test.js tests/runs.test.js tests/rls.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: persist immutable coding and research ownership`. Do not stage unrelated user work.

### Task 3: Enforce scope at all active entry points

**Files:** Modify `src/routes/runs.js`, `src/routes/execution.js`, `src/core.js`, `src/runs.js`, `src/app.js`, `src/agent-resource-broker.js`, `src/http/context.js`.
Create `tests/work-domain-boundaries.test.js`; extend `tests/helpers.js` with spies for classification, retrieval, worker recruitment and tools.

**Interfaces:** Consumes assessWorkDomain, understandTask and stored engine identity. Produces a server-owned domain decision and understanding snapshot on each run/task; no browser field can override it. Domain declines return a normal domain-scoped response, not a safety strike.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('declined work has zero downstream execution', async () => {
  const response = await submitUnsupportedRequest(); // local HTTP fixture, configured in this test
  assert.equal(response.body.scopeDecision.status, 'out-of-scope');
  assert.deepEqual(response.body.startedWork, []);
  assert.equal(downstreamCalls.length, 0); // fixture spies, excludes the no-tool scope assessment
  assert.equal(safetyStrikeDelta, 0);
});
```

Define all fixture variables within the test using the existing test app builder. Cover /api/plan, run creation, execute, continuation, graph expansion, delegated-task admission and external result reception. Attachment metadata needed for classification may be inspected locally; substantive content retrieval waits for admission. Ensure a mixed request executes only its supported part; account/settings controls still work.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Call the scope/understanding boundary before planGoal, learned-skill retrieval, substantive attachment reads, recruitment and execution. Persist the supported request and reject attempt-level scope drift. Recheck new tasks/continuations and current access on execution. Use the exact decline: “Sorry, I’m designed to help with coding and research work, including papers and theses. I can help with a task in those areas.” Preserve existing safety and model/data consent checks separately.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/work-domain-boundaries.test.js tests/security-boundary.test.js tests/prompt-injection.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: enforce the two-domain scope before planning and tools`. Do not stage unrelated user work.

### Task 4: Remove general-chat and everyday feature paths

**Files:** Modify `server.js`, `src/app.js`, `src/core.js`, `src/mode-controllers.js`, `src/surface-policy.js`, `src/domain-specialists.js`, `src/expanded-family-catalog.js`, `src/toolbox.js`, `src/routes/execution.js`, `src/routes/platform.js`, `src/config.js`, `src/memory.js`, `.env.example`, `public/app.js`, `package.json`, `README.md`, `bin/adaptive-task-matrix.js`, `src/live-eval.js`.
Delete `src/scheduling.js`, `src/tools/finance.js`, `src/normal-chat-task-profile.js`, `public/normal-chat-capabilities.js` only after caller replacement. Replace everyday-only tests and examples; retain their applicable security/artifact assertions.

**Interfaces:** Consumes the enforced two-domain path and TaskUnderstanding. Produces a registered tool/role catalog containing only coding/research work and required product controls. Personal reminders and finance.project have no server registration or active route.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('retired everyday tools are unavailable', () => {
  assert.equal(Boolean(toolNamed('finance.project')), false);
  assert.equal(Boolean(toolNamed('schedule.create')), false);
  assert.equal(Boolean(toolNamed('schedule.list')), false);
});
```

Import/build tests prove bootstrap no longer imports Scheduler and no side-effect registration survives. Technical explanation, translation of manuscripts, datasets, document exports, arithmetic and account support still work. Search checks distinguish historical compatibility mentions from live product paths.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Replace normal-chat task profiles with task-understanding direct paths inside each supported engine. Remove Scheduler construction/start/stop, scheduler dependency injection, reminder prompts/routes/config, business forecast branches and duplicate finance registration. Keep jobs, operational maintenance, mail authentication and backups. Limit role eligibility to domain-scoped capabilities; do not remove statistical/reproducibility/qualitative or manuscript tools. Archive old product claims in documentation with explicit historical labels. Audit imports and registration references before each deletion; preserve legacy DB tables and migration files.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/integration-imports.test.js tests/tools.test.js tests/toolbox.test.js tests/surface-policy.test.js && npm run check
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `refactor: remove everyday chat reminders and business assistant paths`. Do not stage unrelated user work.

### Task 5: Two separate workspace interfaces

**Files:** Modify `public/index.html`, `public/app.js`, `public/app-projects.js`, `public/app-actions.js`, `public/app-attachments.js`, `public/app.css`, `public/work-progress-panels.js`, `public/workspace-intent.js`, `bin/ui-smoke.js`, `bin/ui-control-checks.js`.
Delete `bin/ui-workspace-suggestions.js` after replacing its useful coverage with `bin/ui-engine-isolation.js`; create `tests/two-workspace-ui.test.js`.

**Interfaces:** Consumes immutable stored engine/project IDs. Produces independent Coding and Research view state keyed by engine, with separate selected project/conversation, drafts, attachment selections and queue panels. UI requests include engine identity for consistency checks but server ownership remains authoritative.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('switching workspaces preserves each project draft', () => {
  assert.equal(codeView.projectId, codeProjectId);
  assert.equal(researchView.projectId, researchProjectId);
  assert.equal(codeView.draft, 'Fix parser');
  assert.equal(researchView.draft, 'Compare inspected studies');
});
```

Implement the view fixtures locally in this test; add Playwright flows that create both project types, run both, switch views while streaming, cancel one, reconnect, and check the other's messages and run owner. Both visible destinations support project creation and direct questions without requiring a repository. Legacy general chats are read-only history; three-workspace suggestion banners disappear.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Replace Normal Chat navigation/creation/landing with Coding and Research. Filter server listings by engine and keep per-engine state/draft keys. Make active workspace/project visible; show code files/changes/tests/terminal or research sources/claims/datasets/figures/manuscript panels as appropriate. UI switching never changes a queued run payload. Remove old workspace-switch handlers after reworking their shared consumers. Add engine metadata to stream events and ignore mismatched events in each view.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/two-workspace-ui.test.js tests/ui-layout.test.js && npm run test:ui && node bin/ui-engine-isolation.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: separate coding and research project workspaces`. Do not stage unrelated user work.

### Task 6: Repair citation key normalization and evidence status

**Files:** Modify `src/research-workspace.js`, `tests/research-workspace.test.js`.
Create `tests/fixtures/research-ledger-regressions.json`.

**Interfaces:** Preserves createResearchWorkspaceState/updateResearchWorkspaceState signatures. Produces stable source keys and per-claim support state; this module becomes a bounded projection after Task 7, not the authoritative store.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('stable sourceKeys survive normalization', () => {
  const state = createResearchWorkspaceState({ goal: 'Review paper', evidence: { sources: [{ url: 'https://example.org/paper' }], claims: [{ id: 'c1', summary: 'A claim', sourceKeys: ['url:https://example.org/paper'] }] } });
  assert.deepEqual(state.evidenceLedger[0].sourceKeys, ['url:https://example.org/paper']);
});
```

Add the reproduced old-source plus 40-new-sources case and assert every retained claim key resolves. A claim with no inspected passage remains unsupported even if unrelated sources exist. Preserve unknown keys as explicit evidence gaps rather than silently erasing them; support is not inferred from URL presence.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Accept stable sourceKeys directly; normalize source objects/URLs only once. Validate every retained claim relationship against the complete source set, retain linked metadata during transitional projection use, and compute support/status from relevant claim support, conflicts and open gaps. Retarget old tests that treated destructive truncation as correctness. Task 7 removes the remaining authority/context conflation.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/research-workspace.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `fix: preserve claim source keys and honest evidence status`. Do not stage unrelated user work.

### Task 7: Durable research source and claim ledger

**Files:** Create `src/research/ledger.js`, `src/routes/research.js`, `tests/research-ledger.test.js`.
Modify `src/migrations.js` (append 82), `src/db.js`, `src/runs.js`, `src/research-workspace.js`, `src/routes/execution.js`, `src/app.js`, `public/work-progress-panels.js`.

**Interfaces:** Produces `ResearchLedger.upsertSources(scope, records, { expectedRevision })`, `upsertClaims(scope, records, { expectedRevision })`, `recordSupport(scope, { claimId, sourceKey, sourceVersion, passageRef, relation })`, `setGap(scope, { id, state, reason })`, `invalidateSource(scope, key, version)`, and `projectView(scope, { sourceLimit=40, claimLimit=80, cursor })`. Returns durable IDs/revisions and bounded views with total counts.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('context paging does not delete authoritative provenance', async () => {
  assert.equal((await ledger.projectView(scope, { sourceLimit: 40 })).sources.length, 40);
  assert.equal(await countStoredSources(scope), 90);
  assert.equal(await countDanglingClaimLinks(scope), 0);
});
```

Use database fixture-local ledger/scope/query helpers. Cover old claim retention after repeated turns, source-version invalidation, metadata-only sources, conflicting inspected passages, reopened gaps, duplicate import, process restart and unauthorized Coding reads. An inspected-source link is necessary but support relation and claim review remain explicit; references do not alone prove a claim.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Append migration 82 for project-scoped research_sources, research_claims, research_claim_support and research_gaps with versioned encrypted payloads, referential integrity, RLS and grants. Import identifiable legacy Research ledgers idempotently without inventing lost sources. Retain missing provenance as gaps. Persist complete admitted records before projecting 40/80 bounded context; expose paginated authorized routes. Store passages/content digests and bibliographic/retrieval fields, search/inclusion decisions, explicit inference/uncertainty and source conflicts. Make run acceptance consume the ledger's reviewed support state.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/research-ledger.test.js tests/research-workspace.test.js tests/rls.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: persist complete research provenance outside model context`. Do not stage unrelated user work.

## Subproject B: isolated agent runtime

Tasks 8–13 consume Subproject A's ownership and scope boundaries. They make worker execution, graphs, messages, handoffs and external-agent results obey the same durable authority.

### Task 8: Isolate control-engine decisions and ensure fair shared scheduler capacity

**Files:** Create `src/engines/coding.js`, `src/engines/research.js`, `src/engines/registry.js`, `src/engines/execution-services.js`, `tests/engine-runtime-isolation.test.js`.
Modify `src/routes/runs.js`, `src/routes/execution.js`, `src/jobs.js`, `server.js`, `src/config.js`, `src/memory.js`, `src/blackboard.js`, `src/adaptive-cache.js`, `src/skills.js`, `src/unified-work-context.js`, `src/domain-specialists.js`, `src/mode-controllers.js`.

**Interfaces:** CodingEngine and ResearchEngine each implement `plan({ scope, understanding, inputIdentity, request })`, `execute({ scope, runId, taskId, signal })`, `accept({ run, task, outcome })`, `resume({ scope, runId })`, and `cancel({ scope, runId })`; async operations return existing RunStore views. Registry `engineForRun(run)` selects only persisted ownership. JobStore.claim gains required engineId, and createJobWorker gains engineId/slot budget.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('research backlog cannot consume coding reservation', async () => {
  assert.equal((await jobs.claim({ workerId: 'coding-worker', engineId: 'coding' })).engine_id, 'coding');
  await assert.rejects(() => codingEngine.execute({ scope: codingScope, runId: researchRun.id }), { code: 'engine-mismatch' });
});
```

Exercise concurrent runs with identical query text and conversation labels, memory/cache collisions, account concurrency limit=1, revoked project access, view switching, cancellation, and worker restart. No unauthorized cross-engine recall is allowed even when cross-chat memory is enabled. Combined budgets still cap both engines.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Give each engine separate policy/registry/graph construction and acceptance functions around shared primitives. Extract shared low-level execution dependencies from the large HTTP executor into `src/engines/execution-services.js` without creating another orchestrator. Partition queue claims and reserve configurable capacity per engine (default one slot each when aggregate limits permit; round-robin fairness under a single aggregate slot). Use transactional active reservations to respect user/workspace/provider limits across processes. Include engine/project/revision/policy/model/tool/acceptance identity in context, memory, cache and skill-learning keys; legacy unscoped memories require explicit import, never automatic recall.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/engine-runtime-isolation.test.js tests/jobs.test.js tests/jobs-worker.test.js tests/memory.test.js tests/blackboard.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: isolate coding and research execution ownership and capacity`. Do not stage unrelated user work.

### Task 9: Enforced invocation harness and fenced recovery

**Files:** Create `src/engines/invocations.js`, `tests/invocation-harness.test.js`, `tests/agent-lane-executor.test.js`.
Modify `src/agent-harness.js`, `src/run-actions.js`, `src/jobs.js`, `src/routes/execution.js`, `src/multi-agent.js`, `src/agent-lane-executor.js`, `src/usage.js`, `src/migrations.js` (append 83), `src/db.js`.

**Interfaces:** Consumes InvocationContract, EngineScope and engine acceptance. Produces `invokeWorker(contract, { services, signal }) -> Promise<InvocationOutcome>` and `reconcileInvocation(contract, { services })`. The invocation store appends attempts/outcomes linked to existing run/task/action lease authority; it cannot independently complete a task.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('late result cannot settle cancelled or newer attempt', async () => {
  assert.equal(await settleLateOutcome(cancelledAttempt), false);
  assert.equal(await settleLateOutcome(supersededAttempt), false);
  assert.equal(await usageRecordedForStartedCalls(), expectedConsumedUsage);
});
```

Define these integration helpers in the test around real lease/store methods and a delayed fake provider. Cover duplicate idempotency keys, lease theft/expiry, timeout after an external side effect, restart with unchanged vs changed inputs, invalid structured output, missing receipts and cancellation draining all started calls. Check that mandatory verification never becomes success when budget is exhausted.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Append migration 83 for append-only invocation_attempts and invocation_outcomes referencing existing run/task IDs with uniqueness on invocation/attempt/outcome, encrypted content, input identity and external operation IDs. Apply admission/domain/access/tool policy, bounded harness context, model/runner allocation, timeout, structured output validation, receipts, accounting and lease-fenced outcome storage to every real worker. Reuse accepted work only with unchanged identity; reconcile uncertain operations before replay. Reuse existing repair ceilings (RunStore maxAttempts=5 and MAX_CODE_REPAIRS from code); record finite deadlines/step caps and explicit budget/stall/cancel stop reasons.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/invocation-harness.test.js tests/run-actions.test.js tests/jobs.test.js tests/agent-lane-executor.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: enforce worker contracts and recover outcomes with lease fencing`. Do not stage unrelated user work.

### Task 10: Authoritative task readiness and conflict-safe parallelism

**Files:** Modify `src/parallel-orchestrator.js`, `src/open-world-task-graph.js`, `src/runs.js`, `src/subsystem-orchestrator.js`, `src/agent-lane-executor.js`, `src/agent-resource-broker.js`, `src/workspace-patch.js`.
Create `tests/engine-task-graph.test.js`; modify `tests/parallel-agent-runtime.test.js` and `tests/workspace-patch.test.js`.

**Interfaces:** Consumes InvocationContract and recorded acceptance. Produces `resourceScopesOverlap(left, right) -> boolean`, strengthened tasksConflict and readyTasks, and engine-owned graph proposals admitted into existing persisted tasks. A resource is `{ engineId, projectId, revision, kind, path, access }`; unknown mutation scope is exclusive.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('mandatory skipped dependencies do not unlock delivery', () => {
  const tasks = [{ id: 'test', status: 'skipped', metadata: { required: true } }, { id: 'deliver', status: 'pending', dependsOn: ['test'] }];
  assert.deepEqual(readyTasks(tasks), []);
});
```

Cover path-prefix overlap (src/ and src/api.js), generated-file/interface locks, missing dependencies, cycles, completed-but-unaccepted outcomes, disjoint writer overlays, research readers of immutable snapshots and serial/parallel integrated-result equivalence. Assertions use actual persisted task states, not only the UI projection.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Keep dependencies acyclic; only accepted prerequisite outcomes unlock mandatory dependents. An explicitly optional waived/skipped dependency needs a recorded waiver, never an unconditional skipped check. Namespace resource sets and detect parent/child paths and coupled locks. Initial run ceiling remains 4, narrowed by budgets and pressure. Writers get independent overlays against the same pinned base; engine parent integrates with pre-image/revision checks and runs combined acceptance. Research analysis code stays a Research-owned invocation. Models may propose assignments but cannot spawn or grant tools unchecked.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/engine-task-graph.test.js tests/parallel-agent-runtime.test.js tests/open-world-task-graph.test.js tests/workspace-patch.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: enforce accepted dependencies and conflict-safe agent waves`. Do not stage unrelated user work.

### Task 11: Durable internal messages and bounded repair loops

**Files:** Create `src/engines/messages.js`, `src/engines/control-loop.js`, `tests/engine-messages.test.js`, `tests/engine-control-loop.test.js`.
Modify `src/subsystem-orchestrator.js`, `src/agent-peer-handoffs.js`, `src/unified-adaptive-workflow.js`, `src/runs.js`, `src/migrations.js` (append 84), `src/db.js`.

**Interfaces:** Produces `MessageStore.send(scope, envelope)`, `receive(scope, { recipientInvocationId, cursor })`, `ack(scope, { messageId, recipientInvocationId })`; and `runControlLoop({ engine, run, limits, services, signal }) -> recorded stop/acceptance`. Envelope fields: version, messageId, correlationId, causationId, EngineScope, runId/taskId, sender/recipient invocation IDs, inputIdentity, contractVersion, type, payload/artifact refs.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('duplicate or stale message does not repeat an action', async () => {
  assert.equal(await consumedActionCount(duplicateDeliveries), 1);
  assert.equal(await acceptsEnvelope(staleRevisionEnvelope), false);
  assert.equal(await acceptsEnvelope(crossEngineEnvelope), false);
});
```

Cover ack retry and crash between delivery/ack, participant authorization, encrypted payload references, advisory peer instructions attempting tool grants, repeated identical failure, budget/deadline exhaustion and a source change reopening only dependent claims/sections. A repair is a new versioned attempt, never a dependency cycle.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Append migration 84 for engine-scoped run_agent_messages and deliveries, unique recipient delivery IDs, acknowledgment/retry state, RLS and grants. Connect the existing typed project bus and handoffs to durable envelopes. Deduplicate action idempotency keys separately from transport delivery. Treat peer output as untrusted observations. The owning engine loop selects admitted actions and checks real code failures/evidence gaps; retain unaffected accepted work and stop on finite bounds or no evidence gain. UI graphs/statuses are projections of recorded outcomes.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/engine-messages.test.js tests/engine-control-loop.test.js tests/subsystem-orchestrator.test.js tests/unified-adaptive-workflow.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: persist scoped agent messages and bounded evidence-driven repair`. Do not stage unrelated user work.

### Task 12: Explicit versioned artifact handoffs

**Files:** Create `src/engines/artifact-transfers.js`, `src/routes/artifact-transfers.js`, `tests/artifact-transfers.test.js`.
Modify `src/objects.js`, `src/routes/workspace-sources.js`, `src/app.js`, `src/migrations.js` (append 85), `src/db.js`, `public/app-attachments.js`.

**Interfaces:** Produces `createArtifactTransfer({ fromScope, toScope, artifactRef, requestId, consent })`, `importArtifactTransfer(scope, transferId)`, `revokeArtifactTransfer(scope, transferId)`. Transfer records own no task lifecycle; an imported ArtifactRef is a destination snapshot or authorized read-only reference.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('handoff grants a snapshot without source write authority', async () => {
  assert.equal(importedArtifact.sha256, originalArtifact.sha256);
  assert.equal(await canWriteOrigin(receivingScope), false);
  assert.equal(await canReadTransferAfterRevocation(receivingScope), false);
});
```

Test missing explicit consent, source access revocation, changed versions between request/import, destination mismatch, duplicate request, private notes not requested in the transfer, and malicious permission metadata. Cross-engine attachments cannot bypass this route merely by submitting an object ID.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Append migration 85 for versioned project_artifacts and artifact_transfers with origin/destination identity, immutable digests, revocation, consent audit, RLS and grants. Reuse encrypted ObjectStore bytes and authorized artifact metadata; no raw private transcript transfer. Expose the checked handoff UI as a deliberate user action. Recipient writes only its imported copy; server rechecks access and source version at dereference/import.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/artifact-transfers.test.js tests/workspace-sources.test.js tests/security-boundary.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: add explicit scoped artifact transfers between engines`. Do not stage unrelated user work.

### Task 13: Pinned external A2A adapter

**Files:** Create `src/engines/a2a/adapter.js`, `src/engines/a2a/contracts.js`, `tests/a2a-adapter.test.js`, `tests/fixtures/a2a-1.0/` conformance messages and a vendored schema/provenance manifest.
Modify `src/config.js`, `src/agent-resource-broker.js`, `src/engines/messages.js`, `.env.example`, `docs/ARCHITECTURE.md`.

**Interfaces:** Produces `A2AAdapter.discover(endpoint, { identity, signal })`, `submit(scope, contract, { signal })`, `updates(scope, remoteTaskRef, { signal })`, `cancel(scope, remoteTaskRef)`; remote refs retain separate server/externalTaskId/internalTaskId and identity. Consumes internal invocations/messages; local workers do not use external networking.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('remote completion is only result received', async () => {
  assert.equal(mappedRemoteCompleted.status, 'result-received');
  assert.equal(internalTask.status, 'pending-acceptance');
  assert.equal(await canRemoteAgentGrantToolAccess(), false);
});
```

Pin the official stable 1.0 specification and schema content hashes; verify availability/version before implementation. Add golden Agent Card/task/message/artifact tests, declared streaming and cancellation, authentication errors, capability/version mismatch, SSRF destinations, stale or duplicate updates and cross-engine artifacts. Use a local mock remote agent; live interoperability is a separate release receipt.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Implement an authenticated adapter matching the pinned specification rather than renaming the internal A2A constant. Discovery/endpoints are administrator-configured allowlisted capabilities and disabled until configured. Never forward bearer secrets, full transcripts or implicit filesystem authority. Resume/update/cancel flow through the existing harness, budgets and scoped bus; all remote results require owning-engine acceptance before completion. No second coordinator or local-agent network requirement.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/a2a-adapter.test.js tests/safe-url.test.js tests/agent-resource-broker.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: adapt authenticated external A2A tasks to engine contracts`. Do not stage unrelated user work.

## Subproject C: mathematics, visual research and academic delivery

Tasks 14–17 consume the durable ledger, invocation receipts and versioned artifact contracts. Mathematical and figure tools run in the research sandbox; manuscript acceptance checks their actual outcomes.

### Task 14: Research mathematics, statistics and reproducibility

**Files:** Create `src/research/computation.js`, `src/research/math-contract.js`, `runners/research/Dockerfile`, `runners/research/requirements.lock`, `runners/research/compute.py`, `tests/research-math.test.js`, `tests/fixtures/research-math.json`, `bin/research-runner-checks.js`.
Modify `src/domain-specialists.js`, `src/tools/registry.js`, `src/toolbox.js`, `src/sandbox.js`, `src/config.js`, `bin/sandbox-runner.js`, `src/engines/research.js`, `src/engines/coding.js`.

**Interfaces:** Produces `validateMathContract(input) -> { valid, issues }` and `executeResearchComputation(scope, contract, { runner, signal }) -> { results, diagnostics, receiptRef, artifactRefs }`. Math contract records variables, assumptions, units, restrictions, precision, dataset/equation/source versions and requested checks. ResearchEngine math capability uses the harness; CodingEngine may use authorized algorithm/math computation in its own scope.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('excluded roots and unsupported computation cannot be verified', async () => {
  assert.deepEqual(excludedRootResult.acceptedSolutions, []);
  assert.equal(unexecutedResult.verified, false);
  assert.equal(unexecutedResult.status, 'not-run');
});
```

Reference fixtures cover substitution of candidates into original equations, excluded roots, dimensional consistency, limiting cases, symbolic/numerical agreement, ill conditioning, reproducible seeds, missing data, Welch-test assumptions/effect size/CI, multiplicity, and causal overclaiming. Use independent expected values, not specialist agreement or keyword checks. Malicious expressions must not execute filesystem/network code.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Build and test a locked isolated Python environment; record exact Python/package versions and image digest in receipts. Translate validated expression AST nodes into approved SymPy operations without eval/exec or unrestricted sympify/parse_expr on user text. Implement admitted solve/differentiate/integrate/matrix/numerical-root and supported statistical operations, returning explicit unsupported-method diagnostics otherwise. SciPy results include method assumptions and limits. General analysis scripts use the existing Research-owned sandbox, not server Python execution. Record datasets, scripts, environment, outputs, exclusions and uncertainty; numerical samples cannot establish a general proof.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/research-math.test.js tests/sandbox-languages.test.js && node bin/research-runner-checks.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: add tool-grounded research mathematics and statistical receipts`. Do not stage unrelated user work.

### Task 15: Research figure and image production

**Files:** Create `src/research/figures.js`, `src/research/figure-contract.js`, `runners/research/figures.py`, `tests/research-figures.test.js`, `tests/fixtures/research-figures/`, `bin/research-runner-checks.js`.
Modify `src/domain-specialists.js`, `src/engines/research.js`, `src/routes/research.js`, `src/documents.js`, `src/document-runner.js`, `public/artifact-preview.js`, `public/work-progress-panels.js`.

**Interfaces:** Produces `validateFigureContract(input)`, `renderResearchFigure(scope, contract, { runner, signal })`, `inspectResearchFigure(scope, artifactRef, { renderer, signal })`, `FigureRegister.upsert(scope, record)` and `invalidateAnalysis(scope, analysisVersion)`. Figure contract records kind (data/math/concept/source-image/illustration), dataset/source/analysis versions, units, transforms, uncertainty, labels, caption, placement and actual export dimensions/formats.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('figure cannot verify against changed analysis', async () => {
  assert.equal(staleFigure.status, 'needs-rerender');
  assert.equal(illustrationRecord.empiricalEvidence, false);
  assert.equal(await captionNumbersMatchRecordedAnalysis(), true);
});
```

Render known datasets/equations to SVG/PDF/PNG in the actual isolated runner. Test misleading scales, omitted units/uncertainty, overlapping labels, unreadable page-size exports, grayscale/color accessibility, caption data mismatch, SVG active content, missing fonts and cancellation. Preserve originals and attribution through crop/contrast/annotation history. PDF/image ingestion records inspected page/panel refs; image measurements require method/accuracy receipts.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Use deterministic Matplotlib/export tooling and exact diagrams for data/math. Store stable figure IDs, versioned contracts, scripts/data/digests, visual inspection results and manuscript refs in project_artifacts from migration 85; invalidated versions remain historical. Add bounded PDF/image rendering through isolated worker/sandbox limits, not merely text extraction. Serve sanitized/rasterized SVG previews with existing isolation policy; preserve vector downloads. Illustrative image generation runs only for admitted conceptual needs, records origin and cannot satisfy evidence gates. Parallel figures integrate through one manuscript numbering step. Journal-specific sizing overrides defaults; no universal 300-DPI rule.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/research-figures.test.js tests/documents.test.js && node bin/research-runner-checks.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: produce traceable research figures and inspect publication exports`. Do not stage unrelated user work.

### Task 16: Paper and thesis delivery acceptance

**Files:** Create `src/research/manuscripts.js`, `tests/research-manuscripts.test.js`.
Modify `src/engines/research.js`, `src/routes/research.js`, `src/unified-adaptive-workflow.js`, `src/requirements.js`, `public/work-progress-panels.js`, `public/artifact-preview.js`, research skill descriptors and `docs/ARCHITECTURE.md`.

**Interfaces:** Produces `auditManuscript(scope, { sectionArtifactRefs, ledgerRevision, figureRefs, methodArtifactRefs }) -> { accepted, issues, receiptRefs }` and `invalidateManuscriptDependents(scope, changedRef)`. Stores sections and review state as versioned project artifacts, not another run/task store.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('missing studies and stale figure references block academic acceptance', async () => {
  assert.equal(await auditAccepted(manuscriptWithInventedDoi), false);
  assert.equal(await auditAccepted(manuscriptWithStaleFigure), false);
  assert.equal(await auditAccepted(manuscriptWithoutRecordedMethod), false);
});
```

Define database-backed manuscript/ledger fixtures in the test. Cover proposals without results, qualitative methods, conflicting evidence, absent participants/data, section number/caption consistency, translated manuscript citation retention, reviewer revisions and DOCX/PDF exports. A proposal can be accepted with clearly identified planned methods; it cannot present planned work as executed findings.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Wire literature/method/statistics/math/qualitative/reproducibility/writing/reference/figure capabilities into ResearchEngine on demand. Support proposal through conclusion/references and targeted reviewer revision. Audit material claims against reviewed inspected support, results against computation receipts, figures against accepted current versions, and manuscript references against stable IDs. Keep direct findings, synthesis, inference and uncertainty distinct. Render and inspect final exports through sandbox tools before publication-readiness claims; unresolved evidence remains explicit.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
node --test tests/research-manuscripts.test.js tests/real-world-delivery-gate.test.js tests/research-ledger.test.js
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `feat: enforce evidence-aware paper and thesis delivery`. Do not stage unrelated user work.

### Task 17: Clean repository and verify the release candidate

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_READINESS.md`, `docs/LIVE_EVALUATION.md`, `src/live-eval.js`, `bin/live-eval.js`, `bin/system-doctor.js`, `bin/adaptive-task-matrix.js`, `.github/workflows/ci.yml`, `.github/workflows/live-eval.yml`, `package.json`, deployment/runner configuration.
Create `tests/coding-research-vertical-slices.test.js`, `docs/CODING_RESEARCH_RELEASE.md`, `bin/research-runner-checks.js` if not already created in Task 14, and export reviewed evaluation results. Remove additional obsolete facades only after the reference audit demonstrates replacement.

**Interfaces:** Consumes all implemented paths and execution/ledger/figure acceptance receipts. Produces a release report tied to the exact candidate commit, test environment, unresolved blockers, and comparable baseline/new/direct-model evaluation results. No numerical quality rating is invented.

- [ ] **Step 1: Write the failing acceptance tests in the named test files.**

```javascript
test('both vertical slices complete through their owning engines', async () => {
  assert.equal(codingSlice.run.engineId, 'coding');
  assert.equal(researchSlice.run.engineId, 'research');
  assert.equal(codingSlice.acceptance.executedChecksPresent, true);
  assert.equal(researchSlice.acceptance.inspectedSupportPresent, true);
});
```

Use real server/store/sandbox paths in the fixture, with deterministic provider fixtures for offline regression. Run credentialed coding/research evaluations separately. Compare accepted outcomes, regressions, citation support/fabrication, recovery, cost per accepted task and p50/p95 latency with current KG and the same model/tool/data baseline; compare single/serial/parallel runs under equivalent conditions.

- [ ] **Step 2: Run the targeted test files before implementation.**

Use the node:test portion of the verification command below. Expect FAIL on the missing/new behavior, not an unrelated environmental error. Database tests require the existing isolated `TEST_DATABASE_URL` fixture and must not touch production data.

- [ ] **Step 3: Implement the specified boundary and connect its production callers.**

Finish import/route/registration/config/dependency cleanup, replace daily-chat demos/evals, and document actual active architecture and historical compatibility. Run npm ci, npm run verify, PostgreSQL migration/RLS/integration/backup-restore checks, browser isolation flows, coding smoke, research runner/export checks, secret scan and runtime hardening on the final commit. Capture GitHub CI results and live provider/runner evidence before release readiness. Missing credentials or external runners are recorded blockers; do not claim unrun checks passed. Request independent whole-branch review, address confirmed findings, re-run affected checks, and present the concrete PR for integration. Merge only within the user's authorization and repository protection requirements.

- [ ] **Step 4: Run the task verification and inspect the recorded output.**

```bash
npm run verify && npm run smoke:coding && npm run test:ui && node bin/ui-engine-isolation.js && node bin/research-runner-checks.js && npm run eval:live
```

Expected: required tests/checks PASS, with no silent skips counted as acceptance. Keep actual commands, exit codes and environment/commit identity in the task record.

- [ ] **Step 5: Review the changed references and commit only this task's files.**

Use explicit paths from Files, inspect `git diff --check` and the staged diff, then commit with message `chore: validate and document the coding research release`. Do not stage unrelated user work.

## Release evidence and rollback

- [ ] Confirm every spec section maps to Tasks 1–17 and all Review Focus cases have tests.
- [ ] Confirm new UI actions reach owning-engine server paths rather than unconnected helper modules.
- [ ] Confirm historical project/run/source IDs, permissions and contents survive migration and restore.
- [ ] Confirm sources remain durable beyond the 40/80 context window, and every verified claim has current recorded support.
- [ ] Confirm tests, mathematical computations, figures and manuscript exports have genuine receipts where required; show “Not run” elsewhere.
- [ ] Confirm latest candidate CI, integration and browser checks have completed, not been cancelled or skipped.
- [ ] Confirm secret scan, sandbox integration and independent branch review have passed or expose specific blockers.
- [ ] Record live coding/research/A2A checks separately from deterministic fixtures; do not infer provider success from mocks.

Roll out behind an operational feature configuration until migrations and both vertical slices pass. Reversal restores the prior application deployment while retaining additive schema and read-only historical data; never remove migrations or drop user records to roll back. The prior general-chat product is not an active alternative in the released redesign. Separate worker processes can be deployed later with the same queue/ownership contracts when load warrants it.

## Plan self-review

Coverage: domain/user understanding (1–3), product cleanup/UI/history (2–5), coding checks (8–10,17), research provenance (6–7), engine isolation/caches/queues (2,8,12), harness/recovery (9), parallel graphs (10), communication/bounded loops (11), external A2A (13), math/statistics (14), figures/images (15), manuscript/thesis methods (16), speed/cost/live evaluation and release (17). Each new public interface is named at its producing task; later tasks consume the shared contracts above.

Required repository verification still needs a complete checkout and configured test services. Direct GitHub cloning was blocked by this environment's network boundary during planning; the GitHub connector successfully supplied the pinned tree and inspected source files. Execution may use an authorized repository mirror or hydrate every pinned blob through that connector, verifying Git blob IDs before tests. A partial source copy is not a testable checkout. Remote commits must use the verified main/feature parent and guarded ref updates; inspect branch changes before retrying a ref conflict.

This is a concrete implementation plan, not a completion report. Product code has not been rebuilt or deleted when this plan is created.
