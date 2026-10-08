# Unified architecture cleanup

Goal: keep one incremental, server-owned execution path; remove unused architecture engines and explain the actual application.

Spec: docs/OPEN_WORLD_ADAPTIVE_ARCHITECTURE.md and the user request to clean the current architecture. Existing acceptance: three surfaces, Vertex Gemini, RunStore authority, advisory specialists, scoped memory, measured quality.

Architecture: RunStore persists and advances real tasks. Pure planning modules provide proposals and context. Runtime executes scoped model/tool calls. No second executor or prescribed phase scheduler.

Tech stack: Node ES modules, Express, PostgreSQL, browser JavaScript, Vertex Gemini.

Global constraints: preserve existing run data and migrations, permissions, API and UI behavior, model boundaries, budget and cancellation guarantees. Remove only symbols whose callers are obsolete tests or other removed symbols. Keep actual verification checks and active workflow projections.

Review Focus: overlooked imports or indirect callers; documentation claims exceeding implementation; confused advisory plan versus runtime dispatch; preservation of existing data compatibility and real lane lifecycle tests.

## Task 1: Consolidate current architecture

Files: src/core.js, src/unified-adaptive-workflow.js, src/adaptive-agents.js, src/adaptive-runtime-state.js, src/agent-harness.js, src/unified-adaptive-intelligence.js and their focused tests.

Interfaces: buildTasks/decideAdvance remain RunStore inputs; workflow/recovery contracts stay pure; decideAgentTopology/adaptAgentTopology stay advisory; multi-agent.js/agent-lane-executor.js remain actual specialist execution.

Steps: add a failing active intelligence contract test proving incremental strategy and RunStore scheduling authority; observe assertion failure. Remove unused fixed stage advancement and its private helpers, unused generic executor and dead recovery/harness facades. Remove tests for deleted engines; retain planner and real executor lifecycle tests. Update controlLoop to describe incremental strategy and authority. Run focused tests, source checks, lint and doctor.

Expected: new contract fails before change, focused tests and checks pass after change. Commit the consolidated implementation.

## Task 2: Explain the application

Files: README.md, docs/ARCHITECTURE.md, docs/UNIFIED_ADAPTIVE_AGENTIC_ARCHITECTURE.md, docs/UNIFIED_ADAPTIVE_RUNTIME.md, docs/OPEN_WORLD_ADAPTIVE_ARCHITECTURE.md.

Interfaces: documentation describes Task 1 exports and actual server object graph.

Steps: make README the application entry point; ARCHITECTURE the canonical module/authority reference; reduce overlapping architecture documents to focused implementation notes. Validate internal links and run the full project verification through CI with PostgreSQL. Obtain one fresh read-only branch review. Commit docs and integrate the tested branch.

Expected: working relative documentation links, no references to removed engines in current architecture docs, all GitHub checks green before integration.
