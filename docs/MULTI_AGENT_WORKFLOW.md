# Adaptive multi-agent workflow

Kindgleam already has a server-owned adaptive workflow, targeted context, model routing, verification, retry/replan logic, and an independent verification reviewer. The multi-agent layer adds specialist collaboration without handing workflow authority to the models.

## When it activates

`MULTI_AGENT_MODE=auto` is the production default. The panel activates when the situation has material complexity or uncertainty, high-impact/physical risk, external-data uncertainty, code/prototype work, or a retry. Crisis and safety-adaptive responses do not wait for the panel, and verification keeps its dedicated reviewer path rather than paying for two overlapping review systems.

The panel uses at most `MULTI_AGENT_MAX_AGENTS` specialists (1-11), but the configured value is only a ceiling. Specialist breadth grows with justified task pressure; simultaneous execution is separately bounded by the shared parallel scheduler and provider/resource capacity. For each task, the server scores implementation complexity, uncertainty/evidence gaps, task decomposition, dependencies, stakes, retries/failures, and concurrency opportunity, then chooses the smallest useful set of role perspectives. A medium coding task can use one architect; a complex code change can add critique; a decomposed or uncertain coding task can add strategy or research; recovery can add diagnosis. The allocator is re-evaluated after each specialist completes or fails.

## Iteration and disagreement

Specialists are advisory and have no tools. Their output is normalized to a small schema and passed to the primary model as **advisory data**. The server still decides which task is next, which tools are available, whether external execution is allowed, and whether a result can be recorded.

Specialists run independently. When their recommendations disagree, an arbiter gets the original situation plus the competing findings and resolves the disagreement into another advisory finding. A failed panel call never blocks the primary model, and a model outage does not change workflow authority.

The same provider/model policy and data-transfer governance used by the primary model applies to every specialist call. Specialist usage is recorded separately with `source=multi-agent`, so the run budget and operational metrics still account for the work.

## Configuration

```env
MULTI_AGENT_MODE=auto
MULTI_AGENT_MAX_AGENTS=11
AGENTS_PARALLEL_MODE=auto
```

`auto` enables the panel only when its coordination value clears the adaptive threshold. `always` enables the panel but still uses the task-specific allocator rather than blindly spawning the maximum. `off` disables it. Auto mode may choose 0 specialists for routine work, then 1-5 when extra perspectives have enough marginal value, subject to the configured ceiling and the same spend/data governance as the primary model.

## Why this fits the existing architecture

The design is intentionally additive. It does not replace the server-owned workflow, adaptive safety gates, capability compiler, tool approval path, local execution receipts, or verification. It gives difficult runs a structured second layer for planning, architecture, critique, and recovery while preserving the system's existing stop/iterate semantics.


## Adaptive consensus contract

Specialists are independent by default: each receives the same server-curated situation, constraints, success criteria, work plan and observed evidence, but no peer findings. This reduces anchoring and herding. Peer findings are passed only to the arbiter.

Every accepted finding carries a bounded confidence value plus optional evidence and assumptions. The coordinator treats materially different recommendations, large confidence spreads, or divergent action sets as substantive disagreement. When arbitration is unavailable because of policy, data access, or budget limits, the result is explicitly marked `unresolved-disagreement`; no individual agent finding is promoted to consensus.

The multi-agent layer is advisory. It never becomes a tool authority, approval authority, execution receipt, or substitute for verification. The primary workflow remains responsible for authorization, tool execution, evidence collection, verification and final delivery.


## Task-specific agent-count contract

Agent count is not a fixed domain preset. The coordinator first estimates explainable coordination pressure from current workflow state, maps that pressure to a provisional capacity, then selects roles by marginal utility. Role redundancy is penalized so a larger panel is only used when additional perspectives still add value.

Coding tasks are treated specifically: implementation complexity and decomposition increase pressure, while requirement count, dependencies, work-plan size, unknowns, external-data needs, high-impact/physical stakes, and retry/failure state can recruit additional independent perspectives. The selected pressure, dimensions, utilities, roles, completion/failure state, and allocation rounds are included in the advisory brief for observability.

After every specialist attempt, the server recomputes the remaining role set using completion/failure state. Specialist prompts never receive peer findings; only the arbiter receives the independent findings. This preserves independent reasoning while still allowing the panel size to adapt during a run.


## Domain-agnostic role management

The manager does not classify a request into a hard-coded "coding" or "non-coding" branch. It estimates the current coordination need from workflow structure and observable signals, then recruits reusable cognitive roles:

| Role | Primary contribution |
| --- | --- |
| strategist | decomposition, sequencing, dependencies, fallback |
| researcher | unknowns, evidence gaps, discriminating evidence |
| analyst | comparisons, trade-offs, quantitative/structured reasoning |
| architect | solution boundaries, interfaces, implementation/design integrity |
| critic | adversarial quality, safety and failure-mode review |
| communicator | audience fit, clarity, structure, translation and wording quality |
| diagnostician | root-cause analysis and recovery after failure/retry |

A task can therefore receive different panels without being labeled as a particular industry or domain. For example, a difficult research question may recruit researcher + analyst + critic; a complex writing task may recruit strategist + communicator + critic; a design decision may recruit strategist + analyst + researcher + critic; a failed implementation may add diagnostician. The same mechanism applies to future task types that the capability system discovers.

The panel is still optional. Routine work remains single-agent. The maximum is a configurable ceiling, while marginal utility and budget determine how many specialists are actually called.

## Adaptive subsystem orchestration for coding projects

For medium, large and very-large codebases, the panel can also receive an adaptive-subsystem-plan. This plan is derived from the repository's deterministic project index rather than from model guesses. It estimates an appropriate subsystem count from project scale, file/byte volume, dependency density and cross-boundary coupling, then uses hierarchical directories to produce non-overlapping file ownership. A large single-root tree can be split by promoting the largest child directories while keeping the parent as a residual bucket.

Each subsystem receives a bounded contract containing its owned paths, tests, dependency and consumer ids, read dependencies, write ownership, contract fingerprint and the exact base revision. The server builds a dependency DAG and exposes ready subsystems to workers only after their prerequisite subsystems have completed. Independent ready subsystems can still run concurrently, while failed subsystem work releases ownership so another role can retry it without allowing two workers to own the same subsystem at once.

Peer communication uses a typed, bounded project bus with these message classes: contract-update, dependency-request, dependency-response, blocker, handoff, test-result, and integration-request. Messages are revision-bound and stale messages are withheld from newer subsystem contexts. Payloads are bounded before persistence, duplicate messages are deduplicated, and peer data remains untrusted data rather than instructions or authority.

The subsystem plan is persisted in the run blackboard in compact form and is included in the primary/model context. This lets the primary coding workflow see the same ownership, dependency and communication state without creating a second authority system.

The current subsystem stage remains advisory/read-only: the server owns all mutations and the final coding result. This is intentional. It provides the safe coordination contract for future subsystem patch workers and integration workers without introducing unrestricted multi-writer repository access.


## GitHub-only Code Workspace source boundary

The Code Workspace has one project-source type: GitHub. Browser directory pickers, local-folder
snapshot ingestion, local-folder synchronization, and browser local write-back are not
available. Existing legacy local-folder source rows are revoked by the migration and the
database now accepts only GitHub source rows. Terminal sessions may still use a disposable
local filesystem inside their sandbox, but that filesystem is created from the selected
GitHub snapshot and is never a host/local-folder connection.
