# Kindgleam

**One shared adaptive intelligence for Normal Chat, Code, and Research.**

Kindgleam adapts the amount of reasoning, context, tools, evidence, agents and execution to the user's actual situation instead of forcing every request through a fixed pipeline.

## Architecture

```
ONE SHARED ADAPTIVE INTELLIGENCE
              |
      +-------+--------+
      |       |        |
 Normal    Code     Research
  Chat   Workspace  Workspace
```

The three surfaces are **context and persistence boundaries, not separate AI brains**.

- **Normal Chat** — universal default for conversation, writing, planning, analysis, files, images, lightweight design and bounded code.
- **Code Workspace** — durable repository engineering with exact revisions, controlled edits, execution and verification.
- **Research Workspace** — evidence-first investigation with sources, provenance, conflicts and adaptive depth.

Current reasoning provider: **Google Vertex AI Gemini family**, selected adaptively by workload.

## Canonical adaptive workflow

The server progressively chooses work one step at a time:

```
observe
  -> assess
  -> choose minimum sufficient work
  -> act
  -> verify when justified
  -> reassess
  -> continue / expand / contract / recover / stop
```

A simple request stays lightweight. Complex or uncertain work deepens only when evidence justifies it.

The server owns workflow state and completion. The model can propose work, but cannot grant itself permission, claim external execution or declare authoritative completion.

## Projects and chats

Projects are the human organization layer; conversations are the interaction layer.

```
Project A
  +-- Chat 1
  +-- Chat 2
  +-- Research thread
  +-- Code state

Project B
  +-- Chat 1
  +-- Research state
```

Multiple projects and conversations can remain active concurrently. Conversation continuity, project continuity, memory, workspace state and artifacts stay isolated by authorization and compatible identity.

Parallelism is bounded and adaptive so model, database and execution resources do not become the bottleneck.

## Agentic behavior

Specialists are recruited adaptively over the same runtime:

```
direct
  -> one specialist
  -> complementary specialists
  -> bounded panel
  -> arbitration only when disagreement matters
```

Roles may include strategist, researcher, analyst, architect, implementer, diagnostician, debugger, tester, critic, communicator, security reviewer, performance reviewer and visual specialists.

Agents are advisory. The server remains authoritative for state, permissions, execution, evidence and completion.

## Context and efficiency

The system compiles the smallest useful context:

```
authorized data
  -> sensitivity filter
  -> task relevance
  -> dependency / impact expansion
  -> budgeted context
  -> Gemini
```

The same adaptive economy governs model effort, agent count, tool calls, sources, artifacts, execution stages, verification and parallelism.

## Shared capabilities

The three workspaces share the same governed capability layer:

- skills and skill learning
- tool registry and tool forging
- files and project state
- memory and continuity
- multi-agent and parallel-agent orchestration
- permissions and approvals
- live progress, cancellation and resumable jobs
- verification, safety and governance

Files are contextual state, never a fourth workspace. Visual and design work stays inside Normal Chat. Simulation requests, when relevant, are ordinary Code/tool work rather than a separate product subsystem.

## Security

Kindgleam uses the **PA-ONE-X** defense-in-depth security boundary:

- zero-trust request handling and least privilege
- authenticated principal + workspace authorization
- PostgreSQL Row-Level Security
- strict CSP, CSRF and browser request protections
- encrypted object, personal-data and billing-private domains with separate keys
- immutable audit records
- idempotent state-changing operations
- isolated tool and execution boundaries
- authenticated execution receipts
- fail-closed governance and completion gates

Production deployments should add private networking, TLS, a secret manager, isolated execution services, encrypted backups and restore testing.

## Backend and operations

The backend is a server-owned control plane around:

- PostgreSQL and RLS
- adaptive run/task state
- durable jobs, scheduling and project/fleet dispatch
- multi-agent orchestration
- context compilation and memory
- artifacts and research evidence
- usage / billing
- structured logs, metrics and tracing
- sandbox / tool execution boundaries

The browser is a renderer and interaction surface. It does not own authoritative workflow state.

## Release standard

A production build should have required static, runtime and intelligence gates passing: source checks, lint, dependency/security scanning, CodeQL, migrations, production boot, integration/security tests, execution tests and live model evaluation.

A red required CI or verification gate means the release is **not** production-ready.

## Source of truth

The canonical product architecture is defined in:

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

Operational release requirements remain in **docs/PRODUCTION_READINESS.md**.

The file-storage, composer and API contract review is documented in **[docs/FULL_STACK_BOUNDARY_REVIEW.md](docs/FULL_STACK_BOUNDARY_REVIEW.md)**.

## Principle

**One intelligence. One adaptive control loop. Minimum sufficient work. Strong isolation. Real evidence. Controlled execution. Durable continuity.**
