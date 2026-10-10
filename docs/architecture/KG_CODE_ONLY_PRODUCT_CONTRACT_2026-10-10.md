# KG Code — coding-only product direction and workspace contract

**Decision (2026-10-10):** KG will target a professional autonomous coding workspace, not a general-purpose or separate academic-research product. This document describes the *new target*, not a claim that it is shipped. Supersedes the two-domain product direction for future implementation; existing PR #15 code, migrations and historical records remain intact until safe migration.

## Product and navigation

One application, one `CodingControlEngine`, one existing shared KG runtime. The left sidebar is a stable navigation surface, not a second workflow:

- **New coding task** — project-bound chat with repository/branch selector and concise task input.
- **Projects** — searchable, pinned/recent repositories and workspaces; each project owns chats, run history, saved artifacts and permissions.
- **Tasks / Runs** — active, queued, awaiting approval and completed work with durable resume/cancel.
- **Code / Changes** — repository tree, editor/read-only preview, staged patch/diff, changed-file list and branch identity.
- **Tests / Terminal** — authenticated execution logs, command receipts and failures, no invented success.
- **Reviews** — test evidence, security review and approvals before committing or applying patches.
- **History** — completed run details, checkpoints, costs, exported artifacts and rollback references.
- **Settings** — models, reasoning effort, budgets, approvals, secrets, GitHub, workspace, accessibility and billing.

Avoid redundant destinations; tasks, changes, terminal and reviews may be docked panels within a single project workspace instead of separate globally empty pages. On mobile use a collapsible/drawer sidebar; make main navigation keyboard-operable and screen-reader labeled. Preserve current accessibility support and no-motion behavior. Use clear empty/loading/error states.

## Core coding workspace

The primary workspace has a resizable left navigation rail, central conversation/execution timeline and a right contextual panel on wide screens. On mobile and narrow widths, the right panel becomes an accessible drawer or tab. At the **top of every chat**, retain the two-position **Chat | Files** switch: Files lists *that conversation's user uploads and generated artifacts*, with authorized preview/download; it must never silently show GitHub repository contents or unrelated workspace files.

Below/alongside the chat, support context-aware tabs **Changes, Explorer, Terminal, Tests, Preview, Activity**. These are work panels, not substitutes for the Chat/Files switch. Show project, repository, selected branch/commit, agent status, estimated/actual spending and approval need plainly. A patch must show base revision, hunks and conflict status before applying. Results link to true execution/source receipts.

## Coding agent workflow

1. **Authorize and pin** tenant, principal, project, repository and revision before any read, model call, tool invocation or write.
2. **Understand** request and success criteria. Straightforward questions use a direct, low-cost explanation. Limited repairs use a small scoped edit. Larger tasks may use a dependency DAG.
3. **Explore** smallest relevant source set via repo map, indexed search, file reads and test configuration; inspect actual code, avoid speculative claims.
4. **Plan** bounded implementation with expected files, failure modes, tests and permission requirements. Only fan out specialists for independent valuable work.
5. **Implement** patches on isolated branches/worktrees or equivalent revision-pinned overlays; enforce path write leases and merge conflict checks. Optional architect, coder, debugger, tester, security and UI/accessibility roles.
6. **Verify** by running authentic lint/unit/integration/build checks as appropriate. Distinguish passed, failed, skipped, blocked and not run; no self-attested executions.
7. **Repair** based on real failure evidence with a finite attempt and cost budget; invalidate dependent results after code changes.
8. **Review / approve** diff, tests, policy and external side effects. Human approval is required for destructive actions, deployment and other sensitive changes.
9. **Deliver** final scoped changes, receipts, known limitations, cost and branch/PR pointer. Persist resumable state and meaningful checkpoints.

Tool outputs and repository files are untrusted instructions. Never allow a prompt embedded in source code to override authority or expand tool access. Cancellation and retries must be idempotent; background work may only be represented as running when the durable worker and ownership evidence say so.

## Options / controls (avoid overwhelming the default view)

**Task mode:** Auto (default), Ask, Plan, Build, Debug, Review, Test. A mode selects control policy, not bypass authority. **Reasoning:** Auto, Fast, Balanced, Deep. **Execution:** Suggest only, Ask before changes, Auto-apply safe changes (policy gated). **Agents:** Auto, Single, Parallel (only on conflict-safe tasks). **Budget:** visible per-run cap and spend breakdown. **Model:** Auto by task complexity and quality/economy signals; allow approved provider/model overrides where supported. **Context:** pinned repository/branch, selected files and linked chat attachments. **Review:** require diff + actual test results before PR/merge or deploy; allow explicit known-failure override only with separate permission.

Advanced configuration lives in Settings; the composer exposes only project/repo, mode and model/effort shortcuts with progressive disclosure.

## Remove Research safely

Do **not** drop tables, delete existing documents, revoke file access, or remove historical migrations. Preserve archived research conversations and artifacts as read-only history/export during transition. First migrate active navigation, API admission, project creation, task planner and workflow policy to code-only using a dedicated feature gate; then audit every internal path that currently accepts `research` or `normal-chat`. Historical records can retain old `surface` values, but new run creation must exclusively authorize `code` server-side. Code tasks still use documentation lookup and mathematical/statistical computation when necessary for software work; do not confuse this with a standalone scholarly manuscript product.

Keep original PR #15 in draft until a replacement coding-only product migration passes. Decide whether to reshape the current draft branch or open a smaller follow-up branch before landing. **Do not enable the old `CODING_RESEARCH_ONLY` flag as a shortcut**: that gate still permits two domains. Introduce a separately tested code-only admission path and rollback.

## Release gates

- Server rejects new research/general-chat run creation and blocks forged client surfaces, while historical viewing/export remains authorized and intact.
- Persistent run/project/controller/revision identity is immutable; DB/RLS, queue, worker, tools, cache and artifacts enforce it.
- New-chat, Chat/Files panel, sidebar and workspace work on mobile/desktop and keyboard/screen reader; test cross-chat file isolation.
- Real project-repo source scan, small scoped edit, multi-file implementation, test run, failed-test repair, review, patch delivery and PR creation work end-to-end.
- Concurrency conflict, stale revisions, retries, cancellation, side-effect approval, tool injection, race and cross-tenant security tests pass.
- Evidence-backed measures for code correctness, cost per accepted task, p50/p95 latency and recovery rate are compared with a fixed reproducible task set; do not claim Cursor/Claude superiority before measurement.
- CI/security checks, migrations, backup-restore and staged canary rollback pass before merging.

**Recommended priority:** server-side code-only authority → basic project/sidebar navigation → polished workspace + Chat/Files integration → execution/diff/test receipts → safe parallel agent flow → performance & accessibility hardening → canary. Do not replace the database or execution runtime merely to reskin the UI.
