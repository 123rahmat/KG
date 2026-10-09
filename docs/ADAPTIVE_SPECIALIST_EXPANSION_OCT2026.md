# Adaptive main-agent and subagent expansion

One task-scoped orchestrator serves **Normal Chat, Code and Research**. No new branch, workspace, or competing executor was introduced.

## Available expertise

| Workspace | Main-agent families | Seed subagent lenses |
| --- | ---: | ---: |
| Normal Chat | 30 | 240 |
| Code | 30 | 240 |
| Research | 25 | 200 |
| **Total** | **85** | **680** |

The original 55 families remain; 30 additional families with eight specialist subagent lenses each were registered. Each family now also has a main-agent lead role. These numbers describe the seed catalog, not an execution ceiling, concurrently running instances, or every possible future task specialty. Task-specific advisory lenses are generated from real requirements and observed gaps when needed.

New chat capabilities include meeting coordination, negotiation, personal automation, team collaboration, household planning, presentations, spreadsheet modeling, localization, customer support and visual communication.

New Code capabilities include distributed systems, cloud architectures, observability, cryptography, release engineering, AI evaluations, browser automation, data pipelines, protocol interoperability and performance profiling.

New Research capabilities include causal inference, reproducibility, questionnaire methods, systematic reviews, econometrics, technical standards, patents, geospatial research, risk/impact assessment and statistical auditing.

## Recruitment and execution

- Multiple relevant family leads can join the same task when evidence supports distinct specialties. A simple chat remains direct-first; a complex task does not have a predetermined main-agent team size.
- Each main agent begins with a seed vocabulary and recruits additional task-specific advisory subagents for actual acceptance criteria, outputs, unresolved questions and risks. There is **no fixed one-to-three or eight-subagent active roster**. Most share the parent model call; separately invoked read-only probes require trusted budgets and model admission.
- The existing dependency/conflict-aware scheduler controls parallel waves. Scoped peer handoffs accept only completed work from the same task/run and never grant tools or constitute verified evidence.
- **Every selected main agent and subagent**, in Normal Chat, Code or Research, can propose read-only file/source access, isolated sandbox testing, sandbox execution, temporary dependency installation and a one-shot terminal-command through the same resource broker. No special hardcoded agent role gets an exclusive sandbox privilege.
- The server binds requests to the authenticated user, workspace, run and task; validates active capabilities and ready tools; and requires a parent-approved execution action for sandbox work. Even an approved request is **not** an executed command, a test result, or a file mutation.
- An agent does not get the human's interactive terminal (PTY), unrestricted shell, host filesystem, secrets or credential store. A terminal-session request remains a manual user action. Terminal-command means **an isolated one-shot sandbox operation**, never a persistent session. Models supply intent and scope, not raw commands or package installer arguments.
- Distinct same-kind needs from a parent or child are retained through task-scoped resource handoffs; bad scopes, unsafe paths and executable payloads are rejected. Existing provider and task budgets gate concurrent activity.
- Sandboxed execution, packages, file mutations and external connectors still require actual tool readiness, policy checks and any required user authorization. A resource admission is not an execution receipt.

## Production evidence required

Catalog coverage, pure selection logic and policy tests are not proof of deployed agent correctness. GitHub CI, actual Vertex model calls, database migration/restoration, sandbox isolation, cross-user access tests, load/failure tests and measured quality/cost/latency remain necessary release gates.


## Situation-specific recruitment supervisor and resource lifecycle

The shared `src/situational-recruitment-supervisor.js` controller reconciles **both the agent team and the resource plan** at safe wave boundaries in Normal Chat, Research, and the Code subsystem engine. It is a task-scoped supervisor role within the existing orchestrator, not another privileged LLM service or a separate workflow.

- **Recruit** only policy-selected main agents and situation-specific subagent lenses justified by this wave's goal, acceptance criteria, and evidence gaps.
- **Bring required resources** from parent/child recommendations: source research, file inspection, isolated sandbox tests, execution, temporary package dependencies and one-shot sandbox commands. Requests remain scoped to the authenticated run, task and proposing parent/child. Different same-kind needs can coexist.
- **De-recruit** main agents and child lenses after their work settles and the next wave no longer needs them; never cancel in-flight work based on an advisory finding.
- **De-recruit resource requests** when parent-owned task acceptance is satisfied, the optional budget is exhausted or an independently recorded, server-authored resolution explicitly identifies the request. Merely saying a test passed is *not* resolution evidence.
- **Resource truth**: recruiting a resource means recording a bounded *proposal*, not actually allocating a container, installing dependencies, granting shell access, or marking work verified. Executable operations require a user-approved `sandbox.execute` action, permission/policy rechecks, a configured hardened sandbox runner, and real execution receipts. The legacy `code.run` tool remains unchanged; `sandbox.execute` is a dedicated approval-only action so the normal code execution path is not shadowed.
- **Automatic cleanup**: disposable sandbox runtime execution cleans up its own containers after completion. No agent receives the interactive human terminal/PTY, host shell, credentials, or unrestricted network.

The runtime reports `recruitmentSupervisor`, wave-scoped recruitment/retirement activity, and pending `resourceRequests` in the existing panel brief, never pretending that proposals are actual tool use. An explicit recorded resource-resolution ID is an input to the pure reconciliation contract; the system must obtain such IDs from its trusted parent execution/receipt path, not model output, before removing a still-needed approval request mid-task.

This is an architectural and integration change, not evidence of production-ready live Gemini execution.