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
