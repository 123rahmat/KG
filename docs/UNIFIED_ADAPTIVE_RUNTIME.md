# Unified Adaptive Runtime

The platform uses one server-owned Run/Task lifecycle. Memory, RAG, Skills, orchestration, agents, tools, MCP/A2A adapters, code-workspace sessions, verification, billing, observability and evaluation are participants in the same workflow.

## Lifecycle
Request -> identity/tenant scope -> situation -> governance -> capability discovery -> Skills + Memory + RAG -> context compilation -> task DAG -> adaptive agent allocation -> bounded parallel waves -> governed Tool Gateway -> isolated execution/workspace -> evidence -> verification -> approval when required -> delivery -> state/memory update -> evaluation signal -> controlled evolution.

## Parallelism
The same scheduler governs specialist panels, normal-chat control agents and other independent cognitive work. It chooses `auto`, `always`, or `off` through `AGENTS_PARALLEL_MODE`. Independent work runs in bounded waves; dependencies, shared state, and overlapping code writes are serialized. Provider concurrency, task pressure, risk and remaining usage budget can narrow or expand the runtime ceiling, while hard provider and budget limits remain authoritative. A shared code project requires an exact revision and disjoint write set before concurrent work is allowed.

## Skills
Skills use SKILL.md with progressive disclosure. Metadata is cheap to discover; full instructions are loaded only after selection. A skill does not grant authority.

## Memory and RAG
State is authoritative current Run/Task state. Memory is durable user/project knowledge. RAG retrieves task-relevant evidence. Sensitive RAG content is encrypted at rest and retrieval metadata is keyed rather than plaintext.

## Agent Harness
Every model/agent invocation receives a bounded task context, selected Skills, retrieval requirements, evidence count, trace identifiers and an explicit non-authority contract. Models propose; the server authorizes and executes.

## MCP and A2A
MCP is an adapter boundary for tools/context. A2A is a delegation boundary for remote agents. Both are untrusted until authorized by the existing gateway/policy boundary.

## Evaluation
Versioned Evals can execute concurrently and return a deterministic promotion gate. Changes to prompts, Skills, routing and retrieval should be promoted only after the configured regression/adversarial gates pass.

## Multiple chats and code spaces
Each conversation is an independent concurrency lane. Multiple code workspace sessions can exist simultaneously over separate project, branch and revision contexts, while the underlying project source remains a server-owned shared truth.

## Adaptive control

The orchestrator is feedback-controlled. Each specialist wave measures latency and failures and can narrow or widen the next wave within hard concurrency and risk limits. High-risk work is kept conservative even when parallelism is available.

Provider scheduling also reacts to each HTTP attempt. Rate limits and unavailable-service responses reduce concurrency; healthy calls restore it gradually. Retry waits release the provider slot, honor numeric and date-form Retry-After headers within the bounded wait allowance, and preserve requested web grounding. Authentication errors are not retried. An exhausted retry allowance never triggers another ungrounded request.

During execution, workers check the persisted run state every second and before accepting a result. Stop, a changed task, or a changed attempt aborts supported provider and runner requests, removes queued provider work, closes guarded web requests, and terminates document readers. Cancelled specialist calls propagate cancellation rather than publishing failed waves or blackboard findings. Tool proposals check cancellation before being created. A disconnected browser does not stop a run; the user's saved Stop state does. Remote services can still charge for work already accepted, and aborting a runner connection does not establish whether an external side effect finished.

## Blackboard

The Run has one encrypted, versioned Blackboard for shared working state. Agents contribute findings; optimistic concurrency prevents silent overwrites. The Blackboard is not durable personal memory and never grants authority.

## Retrieval

RAG content is encrypted at rest, retrieved within tenant scope, and short-lived retrieval results may be reused through an encrypted cache. Indexing purges the relevant cache namespace.

## Learning loop

User feedback is stored as a Run outcome signal. Evaluation systems can use those signals to identify regressions and candidate improvements. No model output or feedback automatically rewrites Skills, prompts or policy.

## Production standards

The deployment path can map workload identity to SPIFFE/SPIRE and telemetry to OpenTelemetry semantic conventions. MCP is treated as a consented tool/context protocol, and A2A as a delegated-agent protocol; neither replaces server-side authorization. Current MCP guidance explicitly calls for user consent and authorization around data access and tools, while A2A 1.0 defines independent agent discovery and collaboration without sharing internal state.
