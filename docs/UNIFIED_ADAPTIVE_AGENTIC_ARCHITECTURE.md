# Specialist planning and dispatch

The [canonical architecture](ARCHITECTURE.md) describes the whole application. This document defines the advisory specialist boundary within that system.

## Planning versus execution

`src/adaptive-agents.js` is a pure topology planner used to describe assignments and adapt saved planning metadata. It does not call agents or advance tasks. Actual specialist recruitment and dispatch use `src/multi-agent.js`, shared `src/agent-topology-policy.js` limits and `src/agent-lane-executor.js` scheduling. The removed generic executor is not a supported alternate runtime.

A specialist receives the current goal, task, success criteria, bounded files/context, capabilities, evidence requirements and a stop rule. Findings remain advisory. Specialists cannot widen permissions, mutate policy or certify final delivery. The parent integrates findings; RunStore owns accepted state and completion.

## Scheduling and budget contracts

- Direct work remains the default when sufficient. Independent work and quality pressure must justify coordination overhead.
- Shared policy bounds optional roles, tokens, breadth and parallelism. Missing budget telemetry is distinct from exhausted budget; user opt-out and caps remain effective through context revisions.
- The executor validates IDs and complete schedule coverage before dispatch. Waves execute in order; only ready independent work runs concurrently within the ceiling.
- Resource/file conflicts and consequential actions retain their existing serialization and approval boundaries.
- Started peers settle before failed/cancelled waves return. Cancellation and partial failures never become successful completion.
- Hierarchical assignments and subsystem communication remain bounded and revision-scoped; they are not independent recursive execution loops.

See [workspace policy](WORKSPACE_ADAPTIVE_POLICY.md) and [hierarchical scope](HIERARCHICAL_ADAPTIVE_SPECIALISTS.md).

## Evidence and UI

The encrypted run blackboard stores typed findings with optimistic revision checks. It is working state, not durable personal memory. UI activity comes from saved state and does not report old contributions as still running. Suggested follow-ups are optional drafts and do not overwrite user-authored text or start work automatically.

Tests cover planner conservation, shared compute limits, task scope, ordered lanes, failure/cancellation and UI behavior. Live recruitment calibration still requires comparisons with direct Gemini: accepted outcomes, correctness, latency, tokens and cost per accepted result.


## Canonical runtime map (one architecture, not another orchestration engine)

```text
User -> Normal Chat | Code | Research
     -> RunStore + evidence-based incremental task frontier
     -> One policy / privacy / resource-budget authority
     -> Direct model answer OR task-specific specialist selection
          -> 55 task-focus families (advisory expertise)
          -> Bounded parent specialist panel
          -> Optional read-only child checks when evidence justifies them
          -> One dependency/conflict-aware lane scheduler
     -> Authenticated parent task executor (models, files, sandbox, sources)
     -> Server-recorded test, approval and verification receipts
     -> Task-scoped progress UI -> accept, repair or next necessary step
```

There are exactly **three user workspaces**, not 55 separate applications.
`src/adaptive-specialist-focus.js` catalogs potential expertise.
`src/adaptive-family-subagents.js` chooses only needed lenses and bounded
exceptional child probes. `src/multi-agent.js` is the specialist dispatcher,
not another permission service. `src/agent-lane-executor.js` and
`src/parallel-orchestrator.js` serialize dependent/conflicting operations.
`src/agent-resource-broker.js` binds resource requests to the authenticated
run owner but **does not execute those requests**. One parent executor and
existing user-approval rules still govern actual file writes, GitHub changes,
terminal operations and network tools.

A project subsystem is a scoped unit of work derived from real ownership and
dependency data. It has access to research, design, implementation, review,
test and debug expertise, but only the relevant specialists run. An agent
cannot declare a model assertion to be a test receipt or verified completion.
New information can change the next work step; it cannot grant new access.
Normal Chat answers directly unless additional expertise materially helps.

## Adaptive UI truth contract

`public/agent-activity.js` and `public/work-progress-panels.js` consume
saved run tasks, agent waves, specialist contributions and evidence. A recorded
agent from a completed earlier task is **not** live in the next task, even if
its old snapshot still says `running`. Resource proposals and admissions
must explicitly say **not executed** until real parent tool receipts exist.
The UI can group observed specialists by Code subsystem or Research workstream,
show which optional capabilities were requested and disclose saved findings.
It must not render future planned roles as currently executing.

## Release gates and remaining deployment proof

`npm run verify` and CI run `eval:adaptive-matrix`, the deterministic
Normal Chat / Code / Research decision cases, alongside lint, doctor, Node
tests and real database integration. `bin/system-doctor.js` checks the
single-coordinator and resource authority boundaries. These checks validate
structural and deterministic behavior **without claiming** model answer
quality or live external provider success.

Do not call the platform publicly production-ready until the target deployment
also passes a real PostgreSQL migration and restore drill, container and
shutdown smoke, sandbox and source-tool access tests, live Vertex-provider
smoke, adversarial cross-tenant/owner isolation, hard task acceptance
evaluations in all three modes, and observed error/latency/cost budgets.
Deployment credentials and provider availability cannot be inferred from a
green deterministic CI run.
