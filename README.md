# Kindgleam

**One shared adaptive and agentic intelligence for normal work, code, research and design.**

Kindgleam adapts the amount of reasoning, context, tools, evidence, agents and execution to the user's actual situation instead of forcing every request through a fixed pipeline.

## Architecture

```
ONE SHARED ADAPTIVE INTELLIGENCE
              |
      +-------+--------+---------+
      |       |        |         |
 Normal    Code     Research   Design
  Chat   Workspace  Workspace  Workspace
```

The four surfaces are **context and persistence boundaries, not separate AI brains**.

- **Normal Chat** — universal default for conversation, writing, planning, analysis, files, images, lightweight design and bounded code.
- **Code Workspace** — durable repository engineering with exact revisions, controlled edits, execution and verification.
- **Research Workspace** — evidence-first investigation with sources, provenance, conflicts and adaptive depth.
- **Design Workspace** — editable visual/canvas work with assets, layout, preview and export.

Current reasoning provider: **xAI Grok 4.7**.

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
  +-- Design state
```

Multiple projects and conversations can remain active concurrently. Conversation continuity, project continuity, memory, workspace state and artifacts stay isolated by authorization and compatible identity.

Parallelism is bounded and adaptive so model, database and execution resources do not become the bottleneck.

## Agentic behavior

Agents are adaptive specialists over the same runtime:

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
  -> Grok
```

The same adaptive economy governs model effort, agent count, tool calls, sources, artifacts, execution stages, verification and parallelism.

## Files and external work

Files are part of the shared adaptive workflow. Archives are profiled from their contents instead of trusted by extension alone.

There is no built-in simulation engine. MATLAB/Simulink, CAD, engineering data and similar material are handled as files/code/artifacts through the workspace the current situation requires.

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

The full end-to-end product architecture, workflow, security model, project/chat model, app design, operations and release gates are defined in:

**[docs/END_TO_END_SYSTEM_DESIGN.md](docs/END_TO_END_SYSTEM_DESIGN.md)**

## Principle

**One intelligence. One adaptive control loop. Minimum sufficient work. Strong isolation. Real evidence. Controlled execution. Durable continuity.**
