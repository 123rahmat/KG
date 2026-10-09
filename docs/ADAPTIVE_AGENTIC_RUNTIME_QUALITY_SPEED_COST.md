# Adaptive Agentic Runtime — Quality, Speed, Economy & Reliability

Implementation: existing **`KG/main`** runtime. This is a single orchestration path, NOT an independent second agent platform.

## Product boundary: three interfaces, two agentic workspaces

**Normal Chat** is a simple, general-purpose Gemini conversation for everyday life, education, business planning, file analysis, writing, visuals, and even challenging reasoning. It uses the primary model, adaptive reasoning effort, permitted just-in-time tools, and parent-owned verification **without recruiting specialist main agents, subagents, an arbiter or an independent reviewer**. No 'agents always' config overrides this boundary.

**Coding Workspace** and **Research Workspace** are the only agentic workspaces. Both use the same shared task-intelligence kernel, optional specialist main agents, situation-derived subagent lenses, supervisor-based ongoing recruitment and retirement, A2A handoffs, sandbox and resource brokers, and quality/cost accounting. Small tasks can still use one primary execution path; expert teams appear only where they improve outcomes.

This is a product/surface separation, not three independent AI engines. Workspace project states remain isolated, while general conversation can suggest opening a specialized workspace without secretly spawning a coding team.

## Actual execution contract

1. **Understand user outcome first.** Context, actual constraints, acceptance criteria, workspace, risk, permissions and existing evidence determine whether one model reply is enough. Nothing mandates running an agent team.
2. **Recruit justifiable expertise.** The registered specialist main-agent families are seed vocabularies, not a complete ontology or minimum active roster. `src/task-specialist-factory.js` adds temporary *main agents* for explicit complex requirements that no registered family covers. `src/situational-subagent-needs.js` adds task-specific *child lenses*. The configured task/model budget caps actual calls; it does not prescribe a constant team size.
3. **One supervisor, one scheduler.** `src/situational-recruitment-supervisor.js` reconciles task-specific parent/child roles and resource requests at safe wave boundaries in `src/multi-agent.js`. `src/agent-lane-executor.js` runs independent advisory jobs concurrently only where the provider reservation and work-lane conflict rules permit. Cross-agent information is bounded, typed, scoped and untrusted.
4. **Bring only needed resources.** Any selected specialist or child can propose research, file access, package dependencies, sandbox tests and one-shot terminal jobs. The common `src/agent-resource-broker.js` validates run ownership, workspace/task scope, actual ready tools, privacy and policy. The model's `resourceRequests` are intent-only, not commands, grants or execution receipts. The `sandbox.execute` tool is a separate **user-approved** action to the sealed sandbox runner. A user's interactive PTY is never shared with agents.
5. **Execute, observe, adapt.** After the current wave finishes, the supervisor can recruit specialists to close *new* evidence gaps, retire no-longer-useful advisor lenses, and preserve unresolved resource proposals for parent review. There is no recursive agent-spawning privilege.
6. **Quality before completion.** `src/agent-quality-economy.js` measures marginal novelty, repetitive findings, model calls, token use and elapsed time with **zero additional model calls**. Repeated redundant, low-risk advisory waves may stop; contradictory, high-stakes, unverified or unknown outcomes cannot be marked correct by model consensus. The actual parent workflow, real execution receipts and acceptance checks own completion.

## Specialized Coding and scholarly Research coverage (October 2026)

The registered catalog now includes **63 Coding main-agent families (504 possible family-owned subagent lenses)** and **57 Research main-agent families (456 possible family-owned subagent lenses)**. These are capability definitions, not 120 running workers. Each main agent has a distinct assignment and a bounded, task-selected set of child lenses. In the same request, other unmet acceptance criteria may generate temporary specialties through `src/task-specialist-factory.js` and task-specific child lenses through `src/situational-subagent-needs.js`.

For **Coding**, the catalog covers UI and UX, design systems, React/frontend/client state, forms, backend/services, REST/GraphQL/APIs, SDKs, SQL/PostgreSQL/ORM/databases and migrations, data governance and pipelines, security, authentication, tenant isolation, privacy/consent, payment/billing, queues, caching, full-text search, WebSocket/realtime, desktop/mobile/offline apps, browser extensions, graphics/media, PDF and Office preview/rendering, document generation, RAG/AI tools, agent runtimes, model serving, connectors, uploads/storage, localization, fuzz/contract/e2e tests, build tooling, observability, distributed systems, deployments, backups, cryptography and repository changes.

For **Research**, it covers research framing and proposals, thesis/dissertation chapter architecture, literature discovery and reviews, identifying legitimate research gaps, theoretical and conceptual frameworks, methodology and protocol registration, experiments, mixed/qualitative/quantitative work, causal analysis and meta-analysis, source and statistical verification, scholarly argumentation, abstract/introduction/methods/results/discussion/conclusion, academic editing, figures/tables, bibliographic references and citation styles, research integrity and ethics, data stewardship and reproducible computation, journal submissions, point-by-point peer review responses, grants, conference papers/posters and thesis defenses.

**Selection:** A specialized role is admitted only for matching user objectives, task phase, observed evidence gaps or subsystem files. The Code subsystem selector can prioritize a directly relevant new engineering lead while preserving implementer ownership. Available child lenses are narrowed by actual need, remaining budget and parent approval. Reconciliation recruits and retires roles/subagent *proposals* at safe wave boundaries; no worker earns broader tool authority.

**Normal Chat remains non-agentic.** It can still inspect documents, use selected files, create visual artifacts and invoke authorized tools. Existing preview supports images, PDF frames, read-only text/table samples for Office files and isolated non-executing static HTML. DOCX/XLSX/PPTX extraction is **not** a pixel-perfect Office renderer; precise layout may require a dedicated conversion or native application. The distinction is shown in the preview UI.

## Workload-adaptive modes

| Request | Efficient default behavior | Quality protection |
| --- | --- | --- |
| Simple chat or familiar explanation | One primary reasoning response, no team fan-out | Explain uncertainty rather than fabricate evidence |
| Multi-domain planning, education, business in Normal Chat | One primary Gemini model with deeper internal reasoning and authorized tools as needed, **no role recruitment** | Preserve actual criteria, contrast alternatives and verify material claims without auxiliary agents |
| Substantial coding | Scoped architecture/implementation/testing experts; independent subsystem panels on disjoint files; sandbox checks and package installs only through approved runners | Owners, source revisions, tests, code-change scope and receipts govern the result |
| Complex research | Source/method/analysis specialist families or temporary task-specific leads; parallel only for genuinely independent evidence | Cite retrieved evidence; distinguish candidate claims from sourced, verified facts |
| Ambiguous, failing or regulated work | Targeted investigation, debugging, independent criticism, or human control as consequences require | No high-confidence shortcut around verification or explicit approval |

## Mature production invariants

- **No fixed active team count:** work complexity and distinct acceptance criteria determine useful roles; server-configured quotas, costs and provider concurrency limit how much computation can be spent.
- **No runaway delegation:** subagent invocations are read-only unless their parent uses the authorized user-controlled tool workflow. No agent can mint itself permissions or credentials.
- **No unverified success:** model-reported tests, citations, tool execution and final correctness remain *unverified* until a real provider/runner receipt or accepted source is checked.
- **No unreviewed host commands:** model agents never get a privileged terminal. Disposable containers run supported structured programs and tests, with separate restricted dependency installation.
- **No permanent parallelism:** disjoint work may run concurrently, dependency-order work serializes; low budget, sensitive risk or poor provider health contracts concurrency.
- **No redundant catalog bloat:** unusual user requirements generate temporary main-agent specialties rather than duplicating hundreds of nearly identical permanent roles.
- **No duplicate orchestration engines:** policy and monitoring modules are pure helpers used by the existing multi-agent and workspace subsystem engines.

## Evaluation requirements before calling it production-ready

Measure Normal Chat as **direct reasoning with zero auxiliary model agents**, and compare agentic recruitment against a single-agent baseline **inside Code and Research only**. Track:

- Correctness and acceptance-criterion coverage **with external or human-labeled ground truth**; never use model confidence as the sole quality label
- Actual task completion and false-completion rate; sandbox test outcomes; unsupported citation rate; cross-user permission failures
- Median and p95 user-visible latency, total wall time, tokens and dollars per successfully completed request
- Number of model calls, child calls, parallel peaks, repeated findings, early stops and failed/aborted waves
- Recovery after provider/tool/runner failures and mid-task changes, including absence of stale work or duplicate side effects
- Budget compliance, privacy/data egress permissions, tool approval, resource cleanup and auditable receipts

The additional task role factory and efficiency metrics improve architecture and observability; they do **not** establish superiority over another agent system without comparative evaluations and production load tests. Server-configured compute/concurrency limits remain intentional safety boundaries.
