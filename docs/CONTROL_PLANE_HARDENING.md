# User, workspace and organization controls

This pass closes control-plane boundaries across PostgreSQL, the API, ongoing execution and the browser. It builds on [the full-stack boundary review](FULL_STACK_BOUNDARY_REVIEW.md).

## Authority

| Scope | Who can change policy | Boundary |
| --- | --- | --- |
| Personal | The authenticated person, including viewers | The API derives the principal ID; other users' policy rows are inaccessible |
| Workspace | A workspace administrator | Actual workspace membership is checked again by PostgreSQL |
| Organization | An explicitly provisioned enterprise organization administrator | Workspace administration and platform administration do not imply this authority |
| Platform and jurisdiction | The database operator | The workspace API cannot write these layers |

Migration 77 introduces `organization_admins`, protected by forced row-level security. The runtime can read its own authority records and cannot insert, update or delete this registry. Existing workspace administrators are deliberately not promoted. Existing organization policies remain effective. Provision the intended enterprise administrators explicitly after migration:

```bash
node bin/admin.js organization-admin --organization org-acme --principal <principal-id>
node bin/admin.js organization-admin --organization org-acme --principal <principal-id> --revoke
```

Provisioning requires membership in an active enterprise workspace and records an operator audit entry atomically. Organization authority does not grant access to additional workspaces or other people's private content.

## Policy writes

Supported fields are `id`, `version`, `requireHumanApproval`, `maxTokens`, and allowed/denied lists for capabilities, tools, models, data classes and risk classes. Unknown fields, coerced booleans, invalid token limits and malformed rule lists are rejected. Rules support exact names, `*`, `prefix*`, or `*suffix`.

`GET /api/governance?layer=user|workspace|organization` returns the policy, its revision and scope-specific edit permission. `GET /api/governance/effective` returns the effective layered decision. Clients should send `expectedRevision` on `POST /api/governance`; a conflict returns `409 policy-revision-conflict`. The settings editor always does this. Legacy API callers that omit the revision retain unconditional write behavior. The policy write and its audit entry commit together or roll back together.

Allow-lists are conjunctive: each declared group must match. This preserves wildcard semantics across layers and original/current policy snapshots. An explicitly empty group permits nothing. Denials always win.

## Ongoing execution

Foreground steps and queued jobs share the same executor. It reloads current policy for the acting person while retaining original planning constraints. Receipts and approved actions also recheck policy. Restrictions accumulate and token caps only decrease for an existing run.

Model authorization is checked at admission and immediately before outbound attempts, including after queue waits or retries. Reservations are revalidated atomically at dispatch, excluding their own reservation and accounting for other active work; output limits shrink with the admitted budget. Nested web search inherits the model/data guard and usage gate. Actual named tools, sandbox targets and approved actions check current constraints before execution. Lowered token caps are persisted atomically, so the usage reservation system admits work against the tightened cap and fresh spending. Optional reviewers propagate policy interruptions instead of treating them as advisory provider failures.

If policy newly requires human approval, automatic continuation pauses. The browser offers approval for that step with a token bound to the current policy revision, run, task and acting person. An old generic `approved: true` cannot approve a changed policy. Background job summaries retain the approval token but not model output. Local continuation preserves its chosen target and preflight, carries approval through receipt submission, and retains a completed receipt in memory for resubmission rather than repeating local execution if policy changes again. Continuation is bound to the account, workspace, task, attempt, repair round and current execution challenge; stale context is discarded. Declining a proposed action remains available even when current policy blocks execution.

Requests already sent to an external provider cannot be revoked retroactively. Reservation settlement records each provider call once. Fallback accounting includes only unsettled usage, including mixed tool-loop calls and code retries. Token admission uses estimates; providers can report higher actual usage, which is charged and prevents later admission when exhausted. Existing runs retain restrictions even after policy is relaxed; create a new run when intentionally using broader permissions.

## Browser controls

Settings → Policy controls shows effective restrictions and distinguishes personal, workspace and organization edit permissions. Saves preserve other supported constraints, use revisions, and retain their originating workspace. Stale reads cannot replace controls after a workspace switch.

Viewer and unknown-role write controls remain disabled after usage or activity refreshes. Usage locks identify the account-wide quota. An authorized editor can stop active work after quota exhaustion; new AI work remains disabled.

## Verification

Regression coverage includes layer authorization, forced RLS and read-only organization provisioning, typed policy validation, concurrent revisions, audit rollback, foreground/background revocation, new approval requirements, durable narrowed token admission, named tools, semantic wildcard intersections, provider retries and browser permission/scope races. Run `npm run verify` against PostgreSQL and `npm run test:ui` with Playwright Chromium; CI additionally checks supported Node versions, migration/backup restoration, security analysis and production startup/drain.

Primary guidance: [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [OWASP multi-tenant security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html), and [PostgreSQL row-level security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

SSO/SCIM, independent compliance certification, and live-provider speed/cost/quality benchmarking are separate work; this change does not claim those capabilities or a universal “best system” ranking.
