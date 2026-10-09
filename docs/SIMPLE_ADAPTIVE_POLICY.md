# Kindgleam — simple adaptive workflow with unified privacy and policy

## Product design

The *user-visible* workflow is deliberately small:

**Understand -> Decide -> Work -> Verify -> Deliver**.

These are logical checkpoints, **not** a fixed pre-created list of tasks. A greeting or a simple explanation normally needs just a direct answer. Only an unfamiliar, complex or consequence-sensitive request justifies extra research, specialists, parallel execution, file tools, debugging or iterative verification. The existing server-owned RunStore and task scheduler remain the sole sources of truth.

There is **one adaptive controller**, three separately managed workspaces (Normal Chat, Coding, Research), a shared agent/skill/tool harness and one visible privacy/policy decision interface. Family-owned subagents choose task-specific expertise rather than opening dozens of permanent model workers. A specialist's resource proposal is not a permission grant.

## One central task and destination policy interface

The public code entry point is `src/policy-gate.js`:

- `checkTaskPolicy(run, task, options)`: one request-time decision, in the existing order of **safety -> execution budget -> situation and human authorization**.
- `checkConnectionPolicy(run, options)`: one decision for model, code runner, research or external data transfer, combining **current tool/model restrictions and destination-aware private-data consent**.
- `taskPolicySummary(decision)`: compact result for clients or progress display, never an authorization token.

These functions are **facades over the existing trusted server implementations**, not another competing rule system:

- `src/adaptive-safety.js`: deterministic safety checks and rejection boundary.
- `src/adaptive-control.js`: user-selected depth and bounded resources.
- `src/situation-governance.js`: constraints involving higher-consequence work.
- `src/core.js` + `src/governance.js`: persisted organization/workspace/user policy and current effective restrictions.
- `src/privacy.js` and `src/http/policy.js`: minimum necessary scoped private data, explicit egress consent and destination authorization.
- PostgreSQL/RLS: principal and workspace data isolation and encryption boundaries.
- Existing per-tool and execution approvals: MCP, GitHub/local writeback, external runner, shell, sandbox, package installation, schedules and other side effects.

The facade now replaces three sequential checks in `src/routes/execution.js` with one `checkTaskPolicy` call, preserving response codes and failure priority. It is also used at the main model pre-call and selected research/code-runner entry points. Other specialized execution, receipt, approval and policy-recheck paths continue to enforce their own safeguards; migrating them must be separately tested, not removed by deleting files.

## Simpler user settings

Settings now have **Privacy & policy** instead of separate Data controls and Policy controls screens. The main view explains chat sharing, model consent, optional memory and external data. Authorized advanced policy controls remain inside expandable **Advanced policy & resource limits** settings, with explicit Save behavior. Security, billing and account settings remain separate.

## Privacy and autonomy principles

1. The user owns whether cross-chat memory is enabled; each task may use only currently authorized context.
2. Other users and organizations cannot read a user's private files through an agent or subagent. DB RLS and scoped queries remain mandatory.
3. A model, retrieved web page, prompt injection, memory, specialist message, or tool proposal cannot approve itself or broaden capabilities.
4. Ordinary conversation and legitimate reasoning should not be forced into unnecessary expensive multi-agent or approval stages.
5. Actual model/connector data transfers and side-effecting tools are subject to explicit policy and consent checks at the execution boundary.
6. Human approvals protect file changes, external effects and high-impact decisions; a proposed test or a child-subagent note is not evidence that execution happened.
7. Real verification, source provenance and task evidence remain required when the task demands them.

This is Kindgleam's own implementation. It does **not** claim to copy the private/internal policy engines of ChatGPT or Claude.

## How to validate

- Run `node --test tests/policy-gate.test.js` and then the full repository `npm run check`, `npm run lint`, `npm test` and `npm run verify`.
- Verify safety denials, scenario/budget blocks, consent revocation, cross-user/RLS isolation and restrictions that are tightened while a run is ongoing.
- Verify the merged Privacy & policy settings tab still loads and saves scope-aware policy through the existing endpoints.
- Verify real Gemini calls, MCP/tool approval, sandbox/terminal execution, cancellation, long-task reassessment and test receipts across all three workspaces.
- Confirm UX and cost/latency versus the old separate controls. Do not assign a 10/10 production score before CI and real integration passes.

**Not changed intentionally:** mandatory authentication, row-level security, safety filters, encryption, tenant/workspace isolation, policy store, human authorization and tool/runner permissions. Removing those would make a "simpler" platform insecure.
