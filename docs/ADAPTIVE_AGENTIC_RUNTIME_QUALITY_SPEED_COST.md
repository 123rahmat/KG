# Adaptive Agentic Runtime — Quality, Speed, Economy & Reliability

Implementation: existing **`KG/main`** runtime. This is a single orchestration path, NOT an independent second agent platform.

## Actual execution contract

1. **Understand user outcome first.** Context, actual constraints, acceptance criteria, workspace, risk, permissions and existing evidence determine whether one model reply is enough. Nothing mandates running an agent team.
2. **Recruit justifiable expertise.** The registered specialist main-agent families are seed vocabularies, not a complete ontology or minimum active roster. `src/task-specialist-factory.js` adds temporary *main agents* for explicit complex requirements that no registered family covers. `src/situational-subagent-needs.js` adds task-specific *child lenses*. The configured task/model budget caps actual calls; it does not prescribe a constant team size.
3. **One supervisor, one scheduler.** `src/situational-recruitment-supervisor.js` reconciles task-specific parent/child roles and resource requests at safe wave boundaries in `src/multi-agent.js`. `src/agent-lane-executor.js` runs independent advisory jobs concurrently only where the provider reservation and work-lane conflict rules permit. Cross-agent information is bounded, typed, scoped and untrusted.
4. **Bring only needed resources.** Any selected specialist or child can propose research, file access, package dependencies, sandbox tests and one-shot terminal jobs. The common `src/agent-resource-broker.js` validates run ownership, workspace/task scope, actual ready tools, privacy and policy. The model's `resourceRequests` are intent-only, not commands, grants or execution receipts. The `sandbox.execute` tool is a separate **user-approved** action to the sealed sandbox runner. A user's interactive PTY is never shared with agents.
5. **Execute, observe, adapt.** After the current wave finishes, the supervisor can recruit specialists to close *new* evidence gaps, retire no-longer-useful advisor lenses, and preserve unresolved resource proposals for parent review. There is no recursive agent-spawning privilege.
6. **Quality before completion.** `src/agent-quality-economy.js` measures marginal novelty, repetitive findings, model calls, token use and elapsed time with **zero additional model calls**. Repeated redundant, low-risk advisory waves may stop; contradictory, high-stakes, unverified or unknown outcomes cannot be marked correct by model consensus. The actual parent workflow, real execution receipts and acceptance checks own completion.

## Workload-adaptive modes

| Request | Efficient default behavior | Quality protection |
| --- | --- | --- |
| Simple chat or familiar explanation | One primary reasoning response, no team fan-out | Explain uncertainty rather than fabricate evidence |
| Multi-domain planning, education, business | Select the relevant specialist families and task-derived requirements; share the parent call unless independent review justifies more | Preserve actual criteria, contrast alternatives where needed |
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

Measure on representative Normal Chat, Coding and Research tasks, comparing the same model with a single-agent baseline and with adaptive recruitment:

- Correctness and acceptance-criterion coverage **with external or human-labeled ground truth**; never use model confidence as the sole quality label
- Actual task completion and false-completion rate; sandbox test outcomes; unsupported citation rate; cross-user permission failures
- Median and p95 user-visible latency, total wall time, tokens and dollars per successfully completed request
- Number of model calls, child calls, parallel peaks, repeated findings, early stops and failed/aborted waves
- Recovery after provider/tool/runner failures and mid-task changes, including absence of stale work or duplicate side effects
- Budget compliance, privacy/data egress permissions, tool approval, resource cleanup and auditable receipts

The additional task role factory and efficiency metrics improve architecture and observability; they do **not** establish superiority over another agent system without comparative evaluations and production load tests. Server-configured compute/concurrency limits remain intentional safety boundaries.
