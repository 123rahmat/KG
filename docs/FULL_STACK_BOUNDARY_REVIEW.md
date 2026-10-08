# Full-stack boundary review

Reviewed 8 October 2026 against `main`. Goal: reliable file operations and predictable API behavior across Normal Chat, Code and Research, with the existing server-owned workflow and GitHub workspace boundary.

## Primary research

| Source | Application |
| --- | --- |
| [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) | Keep authorization, storage quotas, isolated parsing and safe serving at server boundaries; user-selected files must be the files actually uploaded. |
| [RFC 9110, HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3) | Honor both numeric and date-form Retry-After; stop automatic retries when the requested wait exceeds the client budget; do not replay ambiguous non-idempotent writes. |
| [RFC 9457, API problem details](https://www.rfc-editor.org/rfc/rfc9457.html) | Report stable machine-readable errors rather than treating malformed responses as success. Preserve KG's existing error/code/requestId response contract. |
| [W3C ARIA22, status messages](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22.html) | Keep async status announcements and notices understandable and accessible. The existing live work announcer already follows this pattern. |
| [PostgreSQL, secure SECURITY DEFINER functions](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY) | Expose workspace-wide quota totals through a narrow aggregate function with a fixed search path, matching scope and membership, and explicitly restricted execution privileges. |

## Findings and selected design

1. `ObjectStore.create` serializes quota admission, but `replace` does not check the workspace byte limit. Share the same workspace advisory lock and quota-reading routine. Charge the size delta; permit same-size or smaller replacements when a quota was lowered. Principal-filtered object RLS also hid peers' private files from admission totals: migration 76 introduces `kg_workspace_storage_usage`, which exposes only totals for a matching workspace and member. It retains private-object RLS and revokes public function access. The runtime gets EXECUTE only. Update the object's digest before deleting the old blob, preserving its immediate foreign key. Preserve encryption, tenant scope, object identity, audit and blob reference counts. Serialize replacements with creation before locking target objects.
2. Browser attachment scope currently uses filenames and send uploads every attachment regardless of the checked selection. Use File-object identity in the composer; take an immutable selection snapshot when sending or queuing; upload only selected files. Duplicate filenames remain distinct selections. Do not let later checkbox changes alter a submitted request. Keep existing queued filename-based scope metadata for compatibility, since the queued files themselves are already selected.
3. Filename-only toolbox resolution can silently select the first duplicate. Accept exact object IDs, report ambiguous name matches, and expose per-file IDs in attachment context so the model has an actionable way to resolve the ambiguity. Keep existing unique-name and unique partial-name behavior.
4. The browser API client parses arbitrary JSON and can return an empty object for a successful HTML error page, crash on a null error body, ignore HTTP-date Retry-After, and retry unsafe writes when explicit retries are supplied. Validate successful JSON responses, normalize error bodies, bound retry counts and respect the safe-write gate even with explicit retries. Expose the server wait on the thrown error instead of retrying earlier than allowed. This is a transport check, not endpoint schema validation.
5. Capture the chat, workspace, project, surface, consent and context before asynchronous send work. Retain unchecked/new attachments and new drafts. Queue this snapshot offline, preserve an explicit null project, and prevent queued execution or delayed GitHub source responses from updating a different workspace. An interrupted response body must retain its status and Retry-After header.

## One system, clear ownership

| Layer | Owner and contract |
| --- | --- |
| Composer and file selection | `public/app-attachments.js` owns rendering and send snapshots; `public/attachment-selection.js` provides the shared pure selection rule. |
| Browser API | `public/ui-core.js` owns transport, typed failures, idempotency and bounded retries; callers can supply a captured workspace ID. |
| Authoritative API and execution | `src/routes/` validates authenticated requests and delegates to the existing server-owned run workflow; `src/toolbox.js` resolves attachment IDs without guessing between duplicate names. |
| Model file context | `src/attachments.js` bounds parsing/context and retains per-file identity outside the shared parser cache. |
| Persistent file store | `src/objects.js` owns encrypted content, scoped metadata, quota admission and blob references in PostgreSQL. Migration 76 supplies authorized workspace totals. |
| Verification harness | `tests/` covers contracts, storage and tools; `bin/ui-attachment-checks.js` is called by the existing real-browser smoke harness. |

This retains one frontend/backend/API pipeline. Project work continues through the GitHub source boundary. Repository files remain in their established modules; user content remains in scoped object storage rather than an unrestricted local-project filesystem.

A new frontend framework or filesystem redesign would add migration cost without fixing these failures. The selected approach consolidates quota admission and adds one small pure composer-selection module; other fixes extend established modules. No product dependencies, new branches, or local-folder project access are introduced. No destructive cleanup or bulk file movement is required.

## Verification

Regression tests must assert stored bytes, quota outcomes, blob counts under concurrency, selected upload contents, distinct duplicate-name selection, clear API failure codes, and retry counts/timing. Run the existing full suite, browser smoke checks and production CI. The local environment lacks PostgreSQL and Chromium; real database and browser checks run in CI, with dependency-free boundary regressions also exercised locally.

Independent review identified the foreign-key ordering, private-object quota totals, queued null-project/workspace changes, interrupted Retry-After body and stale source-sync response; all were addressed before publication. Local lint, source checks, 94 doctor checks and skill evaluation passed. The local full suite passed 699 tests, skipped 15 and could not run 210 database-dependent tests because PostgreSQL was unavailable. CI is the database/browser release gate; live-provider quality, latency and cost still require live evaluation under production workloads.
