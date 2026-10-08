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
