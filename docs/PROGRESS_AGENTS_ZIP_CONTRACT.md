# Workspace progress, specialist lanes, and ZIP intake contract

This document records the implementation contract; the presentation and archive upload integration are not complete merely because this document or the ZIP preflight module exists.

## Shared durable progress surface

Read real run, task and job records from the existing server-owned RunStore, JobStore and persisted task projection. Present stage state as queued, working, blocked, verifying, completed, failed, or cancelled using persisted transitions. Show real counters rather than fabricated percentage completion. On refresh or connection loss, rehydrate from the persisted server state and resume event updates with monotonic revision IDs. Cancellation must invoke existing server authorization and settle started agent lanes before reporting cancelled.

NormalChat defaults to a compact stages view; Code can expand per-file change summaries, isolated agent lanes, revisions, tests and integration results; Research can expand evidence gaps, source provenance, conflict resolution and citation checks. Always distinguish proposed changes from applied changes, and execution requests from verified execution. Never expose model private reasoning, tokens, or unauthorized file contents as progress logs.

## Specialized agent policy

Code: planner, disjoint implementation lanes, reviewer and verifier are capabilities recruited as the task warrants. Only parallelize independently scoped writes with a scheduler-approved conflict graph, revision pinning and resource limits. Apply changes transactionally, recheck repository head, then run tests and report evidence. One source revision remains authoritative.

Research: independent discovery and source-verification lanes may execute concurrently under bounded budgets. Deduplicate sources, record freshness and provenance, reconcile contradictory evidence, and synthesize with verifiable citations. No source-finding claim without actual retrieval evidence.

NormalChat: one model by default, optional bounded independent reviewers for complex file or visual tasks. Education and deep reasoning remain native to Chat and must never be routed to Code or Research solely because they are difficult.

All lanes need traceable owner scopes, budget enforcement, safe cancellation, stable task IDs and explicit acceptance checks. Scheduling is separate from the suggestion system.

## ZIP archive intake

The pure `src/zip-intake-policy.js` preflight accepts a trusted parser's list of entries and returns a safety decision and advisory kind: code, research, mixed, documents, or general. It does not extract ZIP data or grant permissions. Use it only after a trusted archive parser has validated the directory and normalized entry metadata. Untrusted archive entry types must include symbolic-link and special-file detection from external attributes. Additional integration must:
1. Limit compressed upload size, archive count, total expanded bytes, per-entry size, compression ratio, nested archive depth and parser CPU/time.
2. Reject traversal, absolute paths, duplicate paths (including canonical platform collisions), links, unsafe permissions and encrypted or unsupported compression modes.
3. Extract in isolated temporary storage without network, with per-principal quotas and malware/security scanning as configured; never execute archive contents during inspection.
4. Offer user-confirmed routing to Code for software bundles or Research for scholarly collections; mixed bundles require an explicit choice. Documents and general bundles remain supported in NormalChat.
5. Preserve per-file provenance and manifest hashes. Preview the tree and selected files before executing any edits. Keep archive content scoped to the run or project; remove temporary extraction on expiry.
6. Require the existing GitHub project authority before repository mutations. ZIP imports cannot bypass Code workspace project-source authorization.

## Release acceptance criteria

- UI stage values must match persisted task/job transitions after reconnect, pause, cancellation and recovery.
- Code concurrent lanes must never produce overlapping writes without serialization.
- Research citations must bind to retrieved evidence, including disagreements and missing sources.
- ZIP tests must include zip-slip, symlinks, decompression bombs, nested archives, duplicate Unicode/case paths, malformed central directories and archive corruption.
- Run `npm run verify` and UI/integration tests in an environment with Node, dependencies and PostgreSQL. Provider and runner smoke tests require live credentials and separate isolation validation.
