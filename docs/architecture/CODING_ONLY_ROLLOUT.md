# KG coding-only product — staged rollout

**Status:** implementation branch, not production-ready. Updated 2026-10-10.

## Product boundary

KG has **one CodingControlEngine over one shared runtime**. There is no new parallel AI platform, no ResearchControlEngine for new tasks, and no independent sidebar task controller. Coding agents may still consult technical documentation, standards, algorithm papers, and engineering experiments as support for software delivery. Academic thesis/manuscript production is outside the new-work scope.

`CODING_ONLY=true` is the proposed release switch. It takes precedence over the older `CODING_RESEARCH_ONLY` feature flag. **It defaults false**: do not enable on production without the acceptance gates below.

Server-enforced new-work admission checks the authorized active Code project and rejects Research, Normal Chat and unrelated new tasks before model calls and attachment retrieval. Saved run controller, project and revision remain immutable. The background execution boundary and foreground mutation routes re-check owning controller/project/revision. Historical research chats and objects remain stored and readable under existing access policy; they cannot be continued as new execution under coding-only mode. Rollback must retain migrations and historical records.

## Professional workspace information architecture

The authenticated sidebar prioritizes **New coding task → Coding / Activity → Projects → Repository / Chat files / Terminal → searchable task history → account, notifications, usage, settings**.

- **New coding task** always chooses the Code surface; if no Code project is selected, opens project creation rather than secretly using a generic chat.
- **Projects** isolate repository sources, run history, owner, revision and permissions. No implicit project transfer.
- **Repository** uses the existing optional, explicit-authorization GitHub source dialog. Device uploads stay first-class without GitHub.
- **Chat files** opens the existing per-conversation Chat ⇄ Files view, with verified workspace and conversation ownership.
- **Terminal** opens the existing controlled sandbox interface. No silent deployment, merge or write-back.
- **History** defaults to Code conversations with status/search filters. Earlier chat data is preserved, not rewritten into Code.
- **Activity** and **Settings** remain accessible; extra control engines are not added.
- Existing theme tokens, mobile drawer, keyboard focus and reduced-motion affordances are reused without a framework migration.

## Before release

1. Complete full CI, static security analysis, real PostgreSQL migration/RLS checks and idempotent rollback tests.
2. Test code-only browser and mobile surfaces, project selector, optional GitHub, device file uploads, terminal, keyboard navigation, screen reader labels and historical chat read-only state.
3. Demonstrate code understanding → changed files → genuine sandbox tests → reviewed diff → explicit authorized write-back, with execution receipts and error/repair recovery.
4. Verify code-only isolation on all background worker, queue, tool, approval, cancellation, and artifact paths, including attempts to forge project/surface fields.
5. Run matched Cursor/Claude Code task benchmarks for accepted-task quality, p95 latency and actual cost per accepted result. Never claim superiority without evidence.
6. Back up, restore-test, canary release and monitor errors. Roll back with `CODING_ONLY=false` if needed; never delete old research tables or records.

**Unfinished:** This feature branch establishes the coding-only admission/UI foundation, not a verified production replacement for Cursor or a completed front-end and worker security audit. Legacy research implementations are retained dormant for safe migration/rollback.
