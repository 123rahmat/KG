# Adaptive main-agent and subagent expansion

One task-scoped orchestrator serves **Normal Chat, Code and Research**. No new branch, workspace, or competing executor was introduced.

## Available expertise

| Workspace | Main-agent families | Available subagent lenses |
| --- | ---: | ---: |
| Normal Chat | 30 | 240 |
| Code | 30 | 240 |
| Research | 25 | 200 |
| **Total** | **85** | **680** |

The original 55 families remain; 30 additional families with eight specialist subagent lenses each were registered. Each family now also has a main-agent lead role. These numbers describe available expertise, not concurrent model instances or proof that every possible future task has a prewritten role.

New chat capabilities include meeting coordination, negotiation, personal automation, team collaboration, household planning, presentations, spreadsheet modeling, localization, customer support and visual communication.

New Code capabilities include distributed systems, cloud architectures, observability, cryptography, release engineering, AI evaluations, browser automation, data pipelines, protocol interoperability and performance profiling.

New Research capabilities include causal inference, reproducibility, questionnaire methods, systematic reviews, econometrics, technical standards, patents, geospatial research, risk/impact assessment and statistical auditing.

## Recruitment and execution

- A family main agent enters the existing role selector only when the goal matches its workspace specialty. A simple chat remains direct-first.
- Within a main-agent call, the family picks one to three relevant subagent lenses. Extra independent child model calls are exceptional, budget- and evidence-gated, and advisory only.
- The existing dependency/conflict-aware scheduler controls parallel waves. Scoped peer handoffs accept only completed work from the same task/run and never grant tools or constitute verified evidence.
- All resource requests go to the existing authenticated server-owned broker. Code agents may propose a one-shot terminal-command via the isolated code.run sandbox, but an interactive user PTY is never delegated. Research may propose explicit sandbox testing; full execution and installs remain restricted.
- Sandboxed execution, packages, file mutations and external connectors still require actual tool readiness, policy checks and any required user authorization. A resource admission is not an execution receipt.

## Production evidence required

Catalog coverage, pure selection logic and policy tests are not proof of deployed agent correctness. GitHub CI, actual Vertex model calls, database migration/restoration, sandbox isolation, cross-user access tests, load/failure tests and measured quality/cost/latency remain necessary release gates.
