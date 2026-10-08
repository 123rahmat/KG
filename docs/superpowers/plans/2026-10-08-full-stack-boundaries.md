# Full-stack boundaries implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, then one independent code review.

**Goal:** Make file selection, storage admission and API transport behavior consistent.

**Architecture:** Keep the current modules and server authority. Share quota admission between creates/replacements, isolate pure composer selection, and validate API transport at the existing browser boundary.

**Tech Stack:** Node.js, PostgreSQL, browser ES modules, node:test and Playwright.

**Execution note:** Implementation and independent review are complete. Database and browser checks are enforced by the existing CI workflows on the published main commit; the checklists below describe the required procedure.

**Spec:** `docs/FULL_STACK_BOUNDARY_REVIEW.md`

## Global constraints

- Work directly on `main`; no new branch or worktree.
- Add no product dependencies.
- Preserve encryption, tenant authorization, existing error response fields and safe serving.
- Never upload unchecked files or automatically retry ambiguous writes.

## Review focus

- Concurrent replacements and creates obey the same storage budget and preserve blob counts.
- Same-size and smaller replacements still work after a quota is lowered.
- Equal filenames have independent composer selections and unambiguous tool resolution.
- Checkbox changes during upload do not change the submitted selection.
- Malformed API responses cannot become success, and long Retry-After cannot cause an early retry.

### Task 1: Workspace quota admission

**Files:** `src/objects.js`, new `tests/object-replacement.test.js`; migration 76 in `src/migrations.js`, the explicit runtime grant in `src/db.js`, and the migration gate in `bin/system-doctor.js`.
**Interfaces:** Existing ObjectStore.create/replace signatures unchanged; shared private quota routine returns workspace limits and usage under a transaction-owned lock.

- [ ] Add failing replacement-over-quota boundary test and real PostgreSQL cases for grow/shrink, concurrent creates/replacements and identical-content blob counts.
- [ ] Observe the local boundary failure; add shared admission logic and preserve existing reference counting.
- [ ] Run boundary tests; run database cases through full CI.

### Task 2: File selection and resolution

**Files:** New `public/attachment-selection.js` and `tests/attachment-selection.test.js`; modify `public/app-attachments.js`, `public/sw.js`, `src/toolbox.js`, `src/attachments.js`, `tests/toolbox.test.js`, `tests/attachments.test.js`, `bin/ui-smoke.js` and its new `bin/ui-attachment-checks.js` helper; `src/routes/execution.js` retains IDs in compact context; `public/workspace-sources.js` guards stale sync responses.
**Interfaces:** `selectedAttachments(files, selection)` returns a snapshot array, with a Set of File references as selection; `file.read`/`data.analyze` accept exact attachment IDs as well as unique names.

- [ ] Add failing duplicate-name selection, empty selection and immutable snapshot cases; add ambiguous toolbox name and exact ID cases.
- [ ] Implement the selection helper, honor it before upload/queue, retain selection scope captured before async work, and expose file IDs to model context.
- [ ] Add real browser assertions for checkbox independence and only-selected upload bytes; include the new module in the offline shell and advance the cache version.
- [ ] Run local selection/toolbox tests and browser CI.

### Task 3: API response and retry contract

**Files:** `public/ui-core.js`, `tests/connection.test.js`.
**Interfaces:** Existing api callers remain compatible; optional captured workspaceId is supported; errors expose status/code/transient/retryAfterMs. At most five automatic retries; unsafe writes receive zero retries regardless of options.

- [ ] Add failing malformed-success, null-error, unsafe explicit-retry, excessive-retry and HTTP-date wait cases.
- [ ] Implement bounded safe retry behavior and response validation, retaining successful JSON arrays/scalars/null for compatible endpoints.
- [ ] Run connection and relevant UI regressions, then full verification.

### Completion

- [ ] Independent review and regression-backed material fixes.
- [ ] Lint, source check, doctor, skill evaluation, full tests and browser smoke.
- [ ] Publish to `main` with compare-and-swap; verify all CI workflows and a clean workspace.
