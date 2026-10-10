# KG Code staging: implementation note

**Date:** 2026-10-10. **Status:** draft PR, feature OFF in production by default.

This work implements a non-destructive first vertical slice of the coding-only product contract. It is not a full editor/agent-system replacement and it is not a release or claim of Cursor parity.

## What was implemented

- New optional `KG_CODING_ONLY=true` server-owned product mode (defaults `false`). It is separate from the older `CODING_RESEARCH_ONLY` toggle; when both are enabled, coding-only admission wins.
- New project creation restricted to Coding; existing normal-chat/research project records remain. New work requires the project's authorized coding surface and coding task intent before model, attachment or tool work. Research run advances are denied under the new mode.
- Same shared KG runtime, RunStore, database and task/approval system. No new separate agent supervisor or duplicate budget manager.
- Adaptive contract returns `product.codingOnly` and supported surfaces. Client uses that public presentation signal to expose a coding-focused left sidebar, Coding project dialog, new coding task, and existing working workspace, activity, terminal and chat-file links.
- Compact engineering-progress card in coding chat. It uses recorded run tasks and a real verification verdict, not guessed percentage complete. Shows current server-recorded task, recorded-step count, failures, an expandable latest-six-step trail, and explicit not-verified state.
- Existing `Chat | Files` top switch stays and still means uploads/artifacts in that *conversation*. Progress is hidden in the Files panel; direct device upload and the existing permission boundary are not affected.
- New model and product regression tests. The service worker static asset list and cache namespace are updated.

## Operations and user experience

A normal landing/product remains unchanged until the new mode is fully release-ready. The older Research/Normal Chat features are not deleted, and their historical conversations remain accessible under the existing authority rules. `KG_CODING_ONLY` is staged; do not turn it on without the gates below. The coding sidebar links use already implemented modules; the navigation intentionally does not show fictitious standalone IDE, inline review, preview, or deployment screens.

## Further reliability and security hardening (current branch)

- Progress verification now invalidates a prior pass when later code/test work is recorded. Failed, blocked, pending, running or stale test steps cannot be presented as verified completion. The progress renderer serializes the bounded visible snapshot, not potentially huge tool result bodies, avoiding expensive redraw comparisons.
- Expandable specialist activity shows only persisted agent states, bounded to five visible specialists. Proposed roles are explicitly not execution proof.
- Coding-only sidebar selection now follows the actual destination rather than permanently highlighting the first link. The menu still routes into existing working tools, not fake placeholder IDE panels.
- Under the `KG_CODING_ONLY` gate, visibility of a workspace-shared project grants **read access only**. A different editor cannot mutate its source/revision/visibility or archive it. The API gives explicit 403 owner-required responses, and the UI hides unauthorized archive actions. This ownership rule is gated to avoid silently changing legacy product permissions.
- Added real PostgreSQL/API integration scenarios for the feature flag (on by itself and alongside the old gate), revision invalidation, cross-user shared-project write rejection and unchanged persisted ownership, plus verification-staleness tests.

**Claims policy:** these changes are code and committed regression tests; full CI and live browser/provider acceptance are still separate. Preserve draft status until they pass.

## Professional developer-workspace refinement

- KG Code (only when `KG_CODING_ONLY` is active) now uses **one focused coding inspector tab at a time** — Overview, Activity, Files, Changes, Tests or Specialists — instead of rendering six always-expanded sections. Selection is scoped to workspace, project and conversation, and does not mutate agent execution state.
- Inspector tabs have native button interactions, a labelled tablist/tabpanel relationship, roving focus, Arrow Left/Right and Home/End keyboard navigation. The existing non-coding workspace remains in its original multi-card layout. A selected card fills the inspector width, including on small screens.
- Sidebar links for Code Changes, Checks & Tests and Specialists navigate to **existing evidence-backed workspace panels**, not fabricated editor routes. The top Chat | Files switch still controls conversation attachment history; entering the inspector returns to Chat without altering files.
- The top engineering progress card now explicitly labels disconnected data **last saved**, offers direct test/change/specialist inspection, and uses a step meter labelled as currently recorded steps rather than percent of unknown future work.
- **Coding verification claims are consistent across the progress card, adaptive run status and outcome summary.** A plain passing model/verifier verdict does not earn the `Verified` label. The code display requires a server-authenticated, all-passing test summary plus a passing final verification verdict, with no pending/failed/stale checks or subsequent code edits. Later code changes explicitly require retesting.
- Regression tests cover sidebar routes, focus semantics, test receipt authentication, stale revisions, inconsistent test counts and outcome-report consistency. In-memory source syntax checks of modified JavaScript succeeded; **this is not full browser or CI validation.**
- Updated offline app shell cache version to avoid mixing the old inspector script and refreshed CSS.

## Non-negotiable next release gates

1. Full CI, browser smoke and keyboard/mobile/a11y tests. A successful syntax check or isolated model test is not the same as full test evidence.
2. Verify strict first-message admission, queued and synchronous job paths, execution/approval routes, project mutation rules, stale revisions, cancellation, cross-workspace isolation and historical read-only states under `KG_CODING_ONLY`.
3. Check all routes, live workers, caches and RLS policies so no other new-run entrypoint bypasses coding-only authority. Confirm a rejected request does not consume model budget.
4. Integration test the newly added sidebar with a real Coding project and a live sandbox. Confirm run progress persists, renders after reconnect, honors test receipts, does not reset expanded details and remains usable with 200% zoom.
5. Migrate the public landing, optional settings, onboarding and historical-nav wording to a coherent KG Code product. Decommission research-only active flows only after compatible history/export handling.
6. Performance budget and measurements: accepted coding-task correctness, diff/test evidence, retry/cancellation idempotence, p50/p95 latency, real token and infrastructure cost, concurrency conflicts, and external benchmarks.
7. Canary with backup, migration repeatability, restore, flag rollback and audit trails. Keep the current draft branch unmerged before completion.

**Rollback:** switch `KG_CODING_ONLY=false` and redeploy. Preserve schema, legacy chat/files, and audit history. Do not delete prior migrations.
