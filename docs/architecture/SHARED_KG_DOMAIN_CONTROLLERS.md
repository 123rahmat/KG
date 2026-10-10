# Architecture decision: one KG system, two independent control engines

**Decision date:** 2026-10-10
**Status:** User-directed architecture correction; implementation in progress.
**Supersedes:** Wording that implies two entire independent systems, databases, model stacks, or separately deployed workflow products.

## The requested boundary

KG is **one product and one shared intelligence/execution system** devoted to Coding and academic/technical Research. It has exactly two domain control engines:

- **CodingControlEngine:** coding task understanding, plans, agent recruitment, scoped repository edits, conflict-aware parallel work, tests, review, and code acceptance.
- **ResearchControlEngine:** scholarly question understanding, source discovery, evidence/claim ledger, methods, reproducible mathematics/statistics, figures, paper/thesis authoring, and research acceptance.

The control engines are independently governed *workflows*, **not copies of the whole AI system**. Both controllers invoke the **same** governed runtime: model/provider gateway, global run/task lifecycle (RunStore), worker and lease infrastructure, tools, auth/RLS, encryption, object storage, audit, budget/usage accounting, model routing, cache infrastructure, sandbox, observability, and backups. A shared system scheduler gives each control engine isolated **logical** queues, capacity reservations and concurrency caps; separate worker processes are an optional deployment optimization, never a required duplicated stack.

```text
                  ONE KG PRODUCT — two project chat areas
           Coding project chats       Research project chats
                   │                          │
           CodingControlEngine       ResearchControlEngine
           │ coding task graph │      │ research task graph │
           │ coding agents     │      │ research agents     │
           │ code acceptance   │      │ evidence acceptance │
                   └────────────┬─────────────┘
                                │
            SHARED, SERVER-GOVERNED EXECUTION RUNTIME
           model gateway · single RunStore · job worker pool
           tool registry · sandbox · scoped data stores
           auth/RLS · billing/usage · audit · observability
```

## What must be isolated

1. **Control decisions:** Domain policy, task understanding, dependency graph *instances*, agent/team configurations, approval/acceptance gates, retries and domain-specific evaluation belong to the owning controller.
2. **Agentic work:** Each agent invocation, task, message, read/write scope, tool admission, lease, context snapshot and artifact must carry an immutable `controlEngineId`, `projectId`, `runId`, tenant `workspaceId` and principal/authorization context.
3. **Data views:** Code revisions, working overlays, source ledgers, manuscript state, project memory and cached reasoning are controller+project scoped. The *infrastructure* storing them is shared; data cannot be fetched cross-controller just because it lives in one database.
4. **Queues/concurrency:** Partition logical work claims and reserve fair capacity per controller under a shared account/provider budget; a Research backlog cannot silently consume every Coding slot. Mutating agents must not race on overlapping paths; research source changes must invalidate dependent claims.
5. **Project chats:** Distinct Coding and Research chat interfaces display owner, saved checkpoints, current workflow, evidence and output; switching the visible chat never retargets a running job. Short technical questions can be answered directly inside their project's controller.
6. **Cross-domain work:** A research task may use code, and a coding task may read papers **inside its owning controller** if those are substeps. A move to a separately owned project requires explicit, authorized, versioned, read-only or copied artifact handoff; not a silent transfer of credentials or memories.

## Cost-effective high-quality decision rules

- Direct, low-overhead responses for simple technical questions and straightforward source summaries.
- Brainstorm only for meaningful alternatives; plan only for dependent or substantial work.
- Recruit specialists and parallelize only independent, useful work. Shared state mutations and mandatory verification remain serialized/gated.
- Reuse cached source inspections and repository indexes only at the same authorized source/revision/policy identity.
- Route model effort adaptively: economical for classification/routine steps, stronger for nontrivial implementation, uncertain synthesis and independent critique.
- Maintain one shared cost ceiling across both controllers. Record actual cost per **accepted** task, latency, unsupported claims and repair rate. Never call unrun tests “passed”.
- Research claims require inspected evidence, and real experiments/plots require reproducible receipts; generated illustrations are never observations.

## Explicit exclusions

- **Do not** build two complete AI platforms or two copies of RunStore, task lifecycle, provider integration, tool registry, authentication, billing, database, cache infrastructure or safety gate.
- **Do not** treat a React UI tab or a prompt-only persona as effective controller isolation: enforce ownership at server admission, task scheduling, tool admission and data queries.
- **Do not** delete legacy data or migrations merely to hide former Normal Chat; once active callers are migrated, retire irrelevant active product paths while retaining read-only history and safe rollback.
- **Do not** create additional ordinary-chat, visual, or generic file-assistant control engines; in-scope visualization and files remain capabilities of Coding or Research.

## Acceptance scenarios

- Coding and Research project conversations can both run through the **same** shared runtime, but a run's controller identity cannot change mid-flight.
- Cross-controller memory, source records, worker messages and writable overlays fail closed; an explicit versioned transfer is tested.
- Both control engines select different domain specialists and acceptance criteria without instantiating different full workflow stacks.
- Switching UI views, reconnecting, cancelling or retrying doesn't leak context or duplicate actions.
- Repository changes have executed tests with receipts. Research manuscripts have claim→inspected source→method/figure traceability, verified exports, and visible gaps.
- Compare shared-runtime baseline and proposed controller split using accepted-task quality, token/$ cost, p50/p95 latency, failure/recovery, and fairness. Use real observations, not invented quality scores.

This architecture decision governs the existing rebuild plan. Any contradictory “separate full engines” phrase in earlier documents must be interpreted as **separate domain control engines over one shared runtime**.
