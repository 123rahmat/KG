# KG open-world adaptive intelligence — implementation specification

## What changes in this increment

KG retains one server-owned workflow and one decision authority. The new `src/open-world-task-graph.js` supplies a **pure incremental work graph**, not a second execution engine or an instruction to generate a long fixed plan.

- `composeOpenWorldDecision` distinguishes direct replies, uncertainty reduction, an authorized candidate, missing capabilities, exhausted optional budget and missing approval. It never executes anything.
- `validateOpenWorldGraph` rejects duplicate IDs, missing dependencies, dependency cycles, invalid state and unbounded (>48) graphs.
- `appendOpenWorldWork` adds one authorized, dependency-validated work unit at a specific revision.
- `recordOpenWorldOutcome` updates exactly one unit and invalidates downstream results only when an upstream revision materially changed.
- `openWorldFrontier` uses the existing parallel scheduler to process ready work with file/resource conflicts, dependencies and high-risk serial execution.
- `buildUnifiedAdaptiveWorkflow` and `reassessUnifiedWorkflow` expose and preserve the validated graph and its **proposal-only** next-action decision alongside the existing server-owned authority.
- `adaptiveDecisionAuthority` no longer falls back to a candidate excluded by its allow-list.
- `agent-harness` composes bounded skill prerequisites, accepts learned profile context and includes only explicitly authorized, limited memory excerpts. Memory entries are evidence/data and cannot grant authority.
- `multi-agent` now passes learned skill profiles/preferences and explicitly scope-verified memory to the harness when those have been supplied by the trusted runtime.
- The adaptive UI can display the latest **proposed** action and blockers, never presenting a proposal as completed execution.
- The evaluation harness measures cost per accepted result when the underlying run supplies measured `costUsd` and can reject cost regressions.

## Architectural invariants

1. **Direct Gemini is the default** when the requested outcome can be fulfilled in one model call with adequate quality.
2. Skills are procedures, not tool access or permissions. Skill metadata is discoverable without loading every instruction.
3. Memory recall must be workspace/principal scoped by the MemoryStore and is not automatically cross-chat. Recalled text is untrusted data.
4. Specialized agents are optional and bounded. The server remains the only execution and policy authority.
5. Parallel work is scheduled only on ready dependencies without conflicting resources. Consequential activity retains its original approval and verification gates.
6. A new user requirement or corrected source can invalidate dependent output without discarding unrelated verified work.
7. The UI is a safe view of persisted run state, not a second source of truth.
8. Permanent strategy or skill updates must be evaluated against versioned baselines before promotion.

## Test and rollout status

`node --test tests/open-world-task-graph.test.js tests/unified-adaptive-workflow.test.js tests/adaptive-decision-authority.test.js tests/evals.test.js` is the focused dependency-free test command. The repository-wide application, DB integration, full browser interaction and live Vertex/Gemini evaluation suites still require complete environment configuration and CI.

**Important:** This change ships graph validation and next-action projections, not a complete autonomously tool-authoring agent. Callers still must use authorized capabilities and existing run-store mutation boundaries. The execution planner must deliberately populate the graph with permitted work items before an unfamiliar multi-step task can execute from it.

## Next maturity checkpoints

- Connect graph write transitions transactionally to the run store after a proposed work unit has been validated and approved.
- Carry evidence provenance, task revision and idempotency keys across every tool result and specialist handoff.
- Calibrate agent/skill recruitment on a balanced benchmark: direct Gemini vs. adaptive, known vs. unseen tasks, task success, total tokens, p50/p95 latency, cost per accepted result and recovery.
- Add richer composable UI primitives for unfamiliar tasks, with accessibility and browser-level validation.
- Run security adversarial tests and verify tenant memory separation and irreversible-action approval.

Architecture target: maximize **verified user outcomes per unit of time and money**, subject to safety, privacy and user control. A universal 10/10 outcome cannot be asserted without those measurements.


## Persisted execution synchronization — October 8, 2026

The read-only `src/persisted-task-projection.js` now derives a bounded
open-world task graph from real server-owned `run_tasks` rows. RunStore
writes its initial projection in the task-creation transaction and updates
it after dynamic work/recovery transitions in the task-advance transaction.
The projection never queues tasks, bypasses the run controller, or accepts
client/model status as evidence of completion. It holds at most 48 visible
nodes and includes only task IDs, types, statuses, dependencies, declared
requirements and bounded purposes. Raw evidence, summaries, secrets and
untrusted metadata are excluded.

Missing prerequisites outside the window are only considered settled if
the underlying persisted task is completed or skipped. Other missing
dependencies keep work blocked in the read-only view. Nodes do not claim
parallel eligibility without an explicit, verified lane declaration. Graph
revisions increment only when visible task state changes. The complete
server task table remains the authoritative scheduler.

Run `node --test tests/persisted-task-projection.test.js
tests/open-world-task-graph.test.js tests/unified-adaptive-workflow.test.js
tests/adaptive-task-matrix.test.js` for focused tests. Database-backed
three-workspace synchronization is covered in
`tests/adaptive-conversation.test.js` and requires CI infrastructure.

**Still needed:** comprehensive live Gemini/Vertex outcome evaluation,
observed cost/latency baselines, independent multimodal service checks,
and multi-hour distributed fault-injection trials. Passing simulated
model/unit tests does not certify the full product as 10/10.

## Legacy architecture cleanup and scenario validation — October 8, 2026

The former `LEGACY_MODES` table and `legacyEvidenceBounds` mode-dependent stage
generator have been removed from `src/unified-adaptive-workflow.js`.
The public `selectAdaptiveWorkflow` function remains as a small compatibility
projection for existing callers; it returns a **single incremental-open-world
strategy**, current proposed action, context budget and reassessment triggers.
It no longer generates a fixed list of future phases for coding, research,
invention, image work or other domains.

The reasoning prompt no longer instructs the model to follow old
`workflowBlueprint.phases`. The server execution-status text now describes
the adaptive strategy and current proposed action. Stale dependent work is
eligible for re-execution when prerequisite tasks are complete, and completed
independent work is preserved. Existing ready/running work takes precedence
over unnecessary new specialist or tool proposals. A fulfilled acceptance
projection is only `ready-to-deliver`: the server still owns the final
completion and verification gate.

Run `npm run eval:adaptive-matrix` for the deterministic scenario check or
`node --test tests/adaptive-task-matrix.test.js tests/adaptive-workflow.test.js
tests/open-world-task-graph.test.js tests/adaptive-contract.test.js
tests/unified-adaptive-workflow.test.js tests/evals.test.js` for focused tests.

The scenario matrix covers conversation, writing, brainstorming, coding,
research, image capability availability, unfamiliar engineering work,
approval, scarce budget, in-progress work, failed tools and changed
requirements. **It evaluates control decisions, not Gemini-generated task
answers.** Do not interpret a simulated 'direct' or 'propose-work' action as
proof of answer correctness, successful image rendering or end-to-end
execution. A real Vertex/Gemini test requires provider credentials and
usable tool execution; the full database and browser suites require a
complete dependency/runtime configuration.

Live rollout remains conditional on the production suite, privacy and
approval checks, user-task success benchmarks, and measured cost per
accepted result. Existing task persistence and security enforcement are
preserved rather than replaced by the proposal-only graph.
