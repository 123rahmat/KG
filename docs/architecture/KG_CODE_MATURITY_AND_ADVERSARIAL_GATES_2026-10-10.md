# KG Code — engineering maturity and adversarial test gates

**Date:** 2026-10-10. **Status:** coding-only source integrated into `main`; production acceptance, real runner/provider tests and full CI are still required. Historical PR #15 is closed as superseded.

## What we hardened

1. **Coding-only intent without false exclusions.** A Python script for thesis experiments, manuscript-formatting plugin or app that summarizes research articles belongs to the Coding controller. Requests to write an actual academic paper remain historical Research, not a new KG Code task. A verified project and authenticated conversation are still required; text alone is not permission.
2. **Parallel agents fail closed without declared resource scope.** Unknown read/write targets do not justify parallel work; proven disjoint read/write sets still can run concurrently. Relative paths, backslashes and dot segments are canonicalized for conflict detection. Ambiguous path traversal conflicts conservatively.
3. **Revision-safe patches.** Existing files require a base-workspace hash or matching preimage digest; mixed whole-file and range operations on one path are rejected; line ranges beyond source length and stale deletes reject explicitly. The central sensitive path rule blocks credentials, private keys, service-account material and secret config aliases. Explicit sanitized examples remain possible.
4. **Bounded evidence-led repairs.** Malformed failure counts (negative, greater than total, nonnumeric) cannot masquerade as progress. A failed execution reporting zero failing tests remains an unexplained execution failure. Consecutive stalled repairs and the ceiling stop unproductive loops.
5. **Verification after repair.** A historical failed test is allowed to be superseded only by a later **server-authenticated all-passing test receipt** and passing final verifier on the current code revision. New code changes or more recent failing/pending/unauthenticated checks invalidate the verified badge. Saved failures remain visible in history.

These protections reuse the single runtime, existing access controls, model gateway and sandbox. They do not deploy a second orchestration system or authorize more tools.

## User-needs understanding and outcome coverage

The CodingControlEngine now records **explicit, user-stated deliverables and constraints** before planning and persists them with the authorized run. Natural engineering requests such as "make my coding agent better" are treated as engineering changes, not generic chat. Requests for integration, smoke or regression tests are recognized as software tasks without requiring the word "code". Domain classification still does **not** authorize a run: the project/revision/owner and server-owned tool gates apply independently.

The coverage ledger is deliberately conservative:

- One simple fix remains a single requested outcome. Multiple *explicit* changes become independently tracked criteria. Negative constraints such as "do not delete data" have priority.
- A verifier must **name each explicit criterion** and report it met; a blanket pass can no longer mark every user-defined feature done. Overlapping subclauses are matched exactly so checking "integration tests" cannot incidentally check "no deletion".
- A later `build-code` revision reopens previously checked criteria and the parent outcome. The dashboard shows which user-defined items still need verification and labels the acknowledgement separately from authenticated execution tests.
- Long requests are bounded to a 12-item UI/requirements summary, preserve discovered no-delete conditions, and include a visible review requirement when some requested details exceed the cap. The full request remains in the persisted run goal.
- "Best", "perfect", "all scenarios" and similar goals **are not measurable acceptance criteria** by themselves. They are recorded as unspecified quality aspirations, not automatically declared satisfied.

New regressions: `tests/coding-user-needs.test.js`, `tests/coding-user-coverage.test.js`, existing intent-policy suites, and coding API/PostgreSQL coverage assertions. The first-party UI intentionally does not treat requirement acknowledgements as a sandbox test receipt.

Known limits: this is a conservative clause parser, not perfect natural-language understanding; unusual phrasings, nested conditionals and ambiguous constraints need model-assisted clarification and human review. The server verifier can evaluate named criteria only against its available evidence; benchmark tests, real sandbox execution and acceptance runs remain essential. Do not claim complete autonomy or universal task success.

## Reproducible test commands

- `npm run test:code:hardening` — **database-free** deterministic path-safety, intent, graph, parallel, patch, bounded repair, progress, outcomes and real local Node code fixture tests (requires dependencies and Node 22+).
- `npm run test:code:integration` — authenticated route and PostgreSQL/RLS tests for feature flag admission, shared-project ownership and stale run execution (requires `TEST_DATABASE_URL` with permission to create isolated databases).
- `npm run test:ui` — the existing Playwright/browser smoke test pipeline (requires configured browser dependencies and server).
- `npm run verify` — project source checking, doctor, skill/adaptive evaluation, lint and broad `npm test` coverage.
- `npm run smoke:providers`, `npm run eval:live` — **environment- and provider-dependent**, never infer live success from unit tests.

`tests/coding-agent-adversarial-scenarios.test.js` contains deterministic domain, budget/risk, 48 scheduler instances with 576 task proposals, task-DAG and evidence tests. Supporting focused tests cover stale line ranges, credential aliases and repair policy.

## Remaining release blockers

This suite cannot exhaust all OS, languages, libraries, user inputs or adversarial behavior. A mature release additionally needs an isolated live test project set and human review of evidence:

| Scenario | Required observable acceptance |
| --- | --- |
| Small bug repair | Before test fails; after patch test passes on real sandbox; diff matches revision. |
| Cross-file feature | Real build + integration tests; patch conflicts rejected. |
| Dependency outage / timeout | Bounded retries, cancellation, durable resume and expense limit respected. |
| Malicious repository prompt | Repository text cannot grant new permissions, disclose secrets or widen shell/network scope. |
| Shared project | Non-owner cannot change source or revision; historical research export remains intact. |
| Parallel writers | Observed isolation on separate paths/revisions; conflicting writes serialized. |
| Reconnect/mobile/browser | Saved/active labels truthful, focus and Chat/Files view preserved, no cross-chat data bleed. |
| Zero or skipped tests | Never shown as verified; blocked tests and manual-approval constraints stay explicit. |
| Background worker replays | Idempotent execution/side effects, no duplicate commits or lost audit entries. |
| Repo benchmark | Correctness, accepted patch cost, latency p50/p95 and recoverability compared on fixed tasks. |

**Release procedure:** wait for real CI, security checks, database migrations, browser, actual sandbox, real provider, concurrent task and backup-restore evidence. Then controlled canary and reversible flag rollout. Keep `KG_CODING_ONLY` OFF by default and PR #15 in draft until these conditions pass. Do not delete legacy research data or claim to outperform Cursor or Claude Code based on architecture alone.
