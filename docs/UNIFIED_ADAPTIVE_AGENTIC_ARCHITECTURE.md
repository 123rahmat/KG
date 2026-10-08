# KG unified adaptive agentic architecture

## Principle

KG is one server-owned, situation-adaptive system. It solves the user's current goal using the least expensive *reliable* strategy. It does not create a fixed sequence of tasks or activate a permanent team of specialists based only on a category name.

## Runtime flow

1. The existing unified intelligence and workflow modules determine the user's requested outcome, accepted scope, known evidence, constraints, risk and currently useful next step.
2. The existing multi-agent decision determines whether additional **advisory** capacity materially improves the task. Simple chat stays one agent.
3. A task-specific assignment binds each specialist to the user's current goal, available success criteria and bounded file/task scope. No agent can expand permissions, mutate policy or self-certify delivery.
4. The single optional specialist-topology policy enforces remaining budgets and maximum parallel capacity. Unknown budget values are not interpreted as exhausted budgets. Scarce budgets suppress speculative panels, not mandatory safety and verification work.
5. The lane scheduler processes dependency/conflict waves **in sequence**, only running independent work within a wave concurrently and applying the configured parallel ceiling.
6. Recorded findings are integrated through the existing server-owned workflow and verification gates. Disagreement can request targeted arbitration. Errors, blocked work and cancellations are not presented as success.
7. The existing adaptive workspace UI presents the task's current focus. A safe task lens can enhance normal chat for brainstorming, planning, decisions, writing, learning and design without creating a separate application. Code and research retain their deep workspaces. Follow-up suggestions are optional drafts, never automatic actions.

## Core contracts

- Task: goal, current step, constraints, acceptance criteria, evidence, risk and permission scope.
- Specialist: role, dynamic task, expected evidence, bounded context, scope, stop rule and advisory-only authority.
- Allocation: selected roles, compute budget, parallel ceiling, reason, integration and verification requirements.
- UI: authoritative run state, context-appropriate label, current activity, saved specialist findings, optional user actions. UI never grants execution authority.

## Operational invariants

- Source-of-truth for workflow, approvals and completion stays with the server.
- High-risk side effects are serialized and require their original approval/verification gates.
- Only justified optional specialists are recruited. There is no requirement for a specialist on every task.
- Model context remains minimized; code intelligence is not serialized twice into the same prompt.
- Agent work follows ordered waves and bounded concurrency.
- User-authored composer text is never overwritten by a suggested next task.
- Recorded agent contributions are not falsely reported as currently running.

## Verification and remaining work

Included unit checks cover budget conservation, task-bound scope, sequential waves, concurrency, UI task lens and stale activity. Existing code/research workflow behavior must still pass repository CI with installed dependencies.

This commit improves the architecture incrementally; it is **not** proof of a 10/10 product. Before production rollout, measure representative user tasks against single-agent and prior-build baselines: acceptance rate, correctness, p50/p95 latency, total cost per accepted result, regressions, recoverability, privacy, accessibility and operator safety. Remaining work includes richer composable UI types for unfamiliar tasks, calibrated recruitment thresholds and a full end-to-end CI/browser suite.
