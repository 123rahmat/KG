# Unified Adaptive Runtime

The platform uses one server-owned Run/Task lifecycle. Memory, RAG, Skills, orchestration, agents, tools, MCP/A2A adapters, code-workspace sessions, verification, billing, observability and evaluation are participants in the same workflow.

## Lifecycle
Request -> identity/tenant scope -> situation -> governance -> capability discovery -> Skills + Memory + RAG -> context compilation -> task DAG -> adaptive agent allocation -> bounded parallel waves -> governed Tool Gateway -> isolated execution/workspace -> evidence -> verification -> approval when required -> delivery -> state/memory update -> evaluation signal -> controlled evolution.

## Parallelism
The scheduler chooses auto, always, or off. Independent cognitive work runs in bounded waves. Dependencies, shared state, and overlapping code writes are serialized. A shared code project requires an exact revision and disjoint write set before concurrent writes are allowed.

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