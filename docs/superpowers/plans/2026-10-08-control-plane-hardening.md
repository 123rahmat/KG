# Control-plane hardening

Work directly on existing `main`, as requested. Keep the GitHub-only project boundary.

## Design

Workspace membership grants access to that workspace; it must never implicitly grant organization-wide policy authority. Explicit organization administrators are provisioned by the operator, through a registry the runtime can read but cannot modify. Personal policies are managed by their owner, including viewers. Workspace policy writes require workspace administration. PostgreSQL repeats these checks.

Policies accept only supported, typed constraints. Policy revisions support optimistic updates, so the settings editor cannot silently overwrite another administrator's change. Policy writes and audit entries share a transaction.

Every execution step, receipt, and approved action reloads current policy for the acting principal. Combine it with the original planning decision: denied rules accumulate, allowed sets intersect, token budgets only shrink, and mandatory approval remains mandatory. New approval requirements pause automatic execution and permit explicit human continuation. Declining an action always remains possible. Already-issued external requests cannot be revoked retroactively; this control acts at the next execution boundary.

The settings panel shows personal, workspace, organization and effective controls with scope-specific permissions. Async reads and saves retain the originating workspace. Viewer and unknown-role composer controls remain disabled through usage and activity updates; an authorized editor can still stop active work when the AI budget is exhausted. Usage limits are account-wide.

## Implementation and evidence

1. Add failing tests for layer authorization, malformed policy input, stricter policy combination, and composer role/usage/stop state. Add real PostgreSQL regressions for organization provisioning, row-level policy writes, revision conflicts, transactional audit, and ongoing execution denial.
2. Add migration 77, read-only organization authority registry, operator command, policy validation/revisions, API effective controls, and atomic audited writes.
3. Recheck current policy in foreground/background execution, receipts and approved actions; retain the original restrictions and enforce new approval requirements.
4. Add policy settings and consistent browser role/budget controls, including browser regressions.
5. Run source checks, lint, doctor, skill evaluations and the suite. Review the security boundaries, publish to `main` with a compare-and-swap update, and verify the real database/browser/security/deployment CI checks.

SSO/SCIM integration, formal compliance certification, and live-provider cost/quality benchmarks are separate capabilities; this pass does not claim they exist.
