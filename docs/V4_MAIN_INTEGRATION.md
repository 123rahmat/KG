# Kindgleam V4 architecture integration — main

The standalone V4 ZIP was a coordination **prototype**. `KG/main` already contains a stronger production-boundary architecture: durable, server-owned RunStore, Google Vertex AI model routing, safety/approval contracts, persisted evidence, model budget policy, adaptive parallel waves, project-revision ownership, a test suite, and three existing workspaces. It would be a regression to copy the standalone V4 browser runtime or in-memory scheduler into the production application.

## What was integrated

1. **`src/adaptive-specialist-focus.js`** is a 55-family/440-subskill *advisory catalog*, preserving V4's broad everyday Normal Chat and separate UI/UX/Security/Backend/Research domains. Each existing agent call gets at most a few task-relevant subskills, not hundreds of new calls. Role specialization and task intent guide selection.
2. **`src/multi-agent.js`** passes that bounded specialty focus through the existing model prompt contract. The provider, authorization, budgets, run state, and scheduler are unchanged. Code specialists remain limited by their already-established subsystem remits. Research uses its existing evidence-driven hierarchy.
3. **`src/agent-peer-handoffs.js`** creates small typed handoffs from observed, completed findings for later waves within the same parent run/task. It excludes subsystem-restricted findings from general collaboration, discards failed or empty findings, and marks every message untrusted and unverified. Handoffs cannot authorize tools or claim completion.
4. **New regression tests** exercise taxonomy counts, relevant Normal Chat/Code/Research focus, generic model-prompt compatibility, handoff limits, isolation, and non-authority.

## Comparison and deliberate non-merges

| V4 prototype | Existing `main` | Decision |
| --- | --- | --- |
| In-memory task lifecycle | Durable RunStore and authoritative transitions | Preserve `main`, do not introduce a second scheduler |
| Mock model execution adapter | Real authorized Gemini/Vertex runtime | Preserve `main`; inject only specialty metadata |
| 55 broad specialist families | Live domain roles and per-subsystem specialists | Catalog as **task-scoped nested expertise** only |
| Direct prototype messages | Typed subsystem communication and persisted blackboard | Add limited generic cross-wave findings; no raw agent-to-agent authority |
| Browser demo dashboard | Existing authenticated, adaptive three-workspace UI | Keep the existing UI instead of replacing it with a disconnected page |
| Prototype resource locks | Immutable project revisions and disjoint write/read sets | Preserve `main` safeguards |
| Simulated test/research checkpoints | Parent-controlled verification and real execution receipts | Preserve evidence-based gates; do not invent results |

## Production and validation requirements

The source integration is **not** proof of a 10/10 or production release. Before rollout, require:
- `npm run check`, `npm run lint`, `npm test`, `npm run verify` and browser smoke tests on actual `main` checkout.
- Existing CI on Node 22/24/26 and PostgreSQL to pass, with no regression in RunStore, tenant boundaries, tool authorization, billing, or code write ownership.
- Real Vertex AI trials for simple chat, math, multilingual tutoring, documents, source-heavy research, code patch/test, failed provider calls, cancellation and reruns.
- Quality/cost/latency A/B evaluations against the pre-integration baseline; default direct-response path should not add unnecessary model calls.
- Adversarial tests for prompt injection in peer summaries, cross-tenant data exposure, misleading evidence, and malformed task inputs.
- Rollback and deployment gates documented in `docs/PRODUCTION_READINESS.md`.

**Architecture invariant:** one server-owned adaptive intelligence. Workspaces and specialists select scopes, not new permission authorities. Parallel work proceeds only when the existing scheduler proves it safe.
