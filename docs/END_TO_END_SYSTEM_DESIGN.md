# Kindgleam — End-to-End System Design

## 1. Product contract

Kindgleam is one adaptive intelligence product with three specialized operating surfaces. The core invariant is:

> Use the minimum reliable work needed to satisfy the user's actual goal; increase depth only when the current situation justifies it; verify material outcomes; stop when the acceptance contract is satisfied.

The surfaces are persistence and interaction boundaries, not separate AI brains.

- **Normal Chat** — universal default for conversation, writing, planning, analysis, files, images, lightweight design and bounded code.
- **Code Workspace** — durable repository engineering, exact revisions, controlled edits, execution and verification.
- **Research Workspace** — evidence-first work with durable sources, claims, conflicts and provenance.

Current reasoning provider: **Google Vertex AI Gemini family**, selected adaptively by workload.

---

## 2. System topology

```
Browser / App
    |
HTTPS + session authentication
    |
Ingress security boundary
    |
Application control plane
    +-- Identity / tenancy / workspace authorization
    +-- Governance / safety / policy
    +-- Adaptive intelligence
    +-- Run / task state
    +-- Project / conversation continuity
    +-- Memory / artifacts
    +-- Agent orchestration
    +-- Usage / billing
    +-- Audit / observability
    |
    +-- Reasoning plane ------> Vertex AI Gemini
    |
    +-- Tool plane
    |     +-- built-in safe tools
    |     +-- governed tool runner
    |     +-- research/web access
    |
    +-- Execution plane
    |     +-- sandbox
    |     +-- optional local agent
    |     +-- authorized external runners
    |
    +-- Async plane
          +-- durable jobs
          +-- scheduler
          +-- fleet/project dispatch
```

### Ownership

| Concern | Canonical owner |
|---|---|
| Situation / goal understanding | adaptive intelligence |
| Next-step choice | server workflow kernel |
| Permission | governance + server |
| Model response | reasoning runtime |
| Tool execution | tool boundary |
| Code execution | execution boundary |
| Completion | run store + verification gate |
| Conversation continuity | conversation state |
| Project continuity | project identity / project layer |
| Memory | memory store |
| Specialist recruitment | shared agent controller |
| Context selection | context compiler |
| Evidence | task-specific evidence stores |
| User presentation | frontend |
| Audit / telemetry | observability |
| Usage / billing | usage + billing |

No module may become a second independent authority for these decisions.

---

## 3. Canonical workflow

Every non-trivial request uses one progressive loop:

```
observe
 -> assess situation
 -> define success / constraints
 -> select minimum sufficient work
 -> execute one justified next step
 -> observe result
 -> reassess
 -> continue / expand / contract / recover / stop
 -> verify when required
 -> deliver
```

The server creates later work only when earlier evidence justifies it. There is intentionally no universal fixed chain such as:

```
understand -> research -> plan -> execute -> verify -> deliver
```

for every request.

### Adaptive decisions

The controller considers:

- goal and intent
- conversation state
- project identity
- current verified result
- uncertainty
- risk / consequence
- required evidence
- tools and execution targets actually available
- authorization / governance
- time pressure
- cost and remaining budget
- previous failures
- workspace specialization

It can stay direct, add evidence, recruit specialists, expand context, split independent work, recover, contract effort, or stop.

### Completion invariant

The model cannot create completion merely by claiming success. Server evidence, acceptance criteria and governance controls are checked before completion.

---

## 4. Situation model

The situation model is the common representation used by all surfaces:

```
Goal
Intent
Desired outcome
Inputs
Constraints
Success criteria
Uncertainty
Risk / consequence
Data sensitivity
Dependencies
Authorization
Environment
Available resources
Current verified state
Failure history
Time / capacity
Project identity
Surface
```

Evidence is explicitly typed:

- observed
- verified
- inferred
- assumed
- unknown
- stale

A model statement is never promoted automatically from inference to verified reality.

---

## 5. Projects, chats and parallel work

### Project Hub model

A **project** is the human organization layer. A **conversation** is the interaction layer.

```
Project A
  +-- Chat 1
  +-- Chat 2
  +-- Research thread
  +-- Design thread
  +-- Code state
  +-- Files / artifacts
  +-- Verified milestones

Project B
  +-- Chat 1
  +-- Code state
```

A project may have many conversations and a conversation may contain many governed runs.

### Isolation

Project continuity is reused only when the identity is compatible.

A follow-up may reuse relevant verified project state, but must not silently import:

- another project's private files
- another conversation's private memory
- another user's data
- stale repository state
- unrelated research evidence

Conversation continuity and project continuity are separate decisions.

### Parallelism

Many projects and chats may remain active concurrently.

Parallel execution is governed by:

```
user / workspace limits
    + project concurrency
    + task dependencies
    + model-provider concurrency
    + database capacity
    + runner capacity
    + cost / quota
    + risk / authorization
```

The target is useful throughput, not unlimited fan-out.

---

## 6. Workspace contracts

### Normal Chat

Default, direct-first, broad.

Supports:

- normal conversation
- explanations / analysis
- writing / translation
- planning
- files / documents / spreadsheets
- images and visual understanding
- lightweight visual creation
- presentations
- bounded micro/single-file code
- lightweight research when evidence needs are modest

It can hand off or route into a deep workspace when the request becomes durable engineering, evidence-heavy research or editable visual production.

### Code Workspace

Repository-first.

Order of operations:

1. authenticate source and exact revision
2. inspect hierarchy and task-relevant files
3. compute dependency / symbol impact
4. inspect tests and execution context
5. propose or select the smallest safe change
6. apply bounded edits
7. run targeted checks
8. reassess
9. broaden regression checks only when justified
10. write back only through an authorized path

Rules:

- immutable base revision
- stale revision rejection
- read-before-write
- explicit write-set ownership
- no silent overwrite
- contract-drift gate
- authenticated execution receipts
- verification after material change

For a brand-new build:

```
goal
 -> virtual scratch architecture
 -> minimum useful build slice
 -> agreement when required
 -> implement
 -> test
 -> observe
 -> expand only when evidence requires it
```

A scratch architecture is not a claim that files already exist.

### Research Workspace

Question-first, evidence-first.

State includes:

- root question
- subquestions
- source set
- evidence ledger
- citations / provenance
- unresolved questions
- conflicts
- coverage
- synthesis status

Depth adapts to freshness, uncertainty, conflict and stakes.

### Visual and design work in NormalChat

Visual creation, image understanding, diagrams, layout reasoning, and presentation work are capabilities of NormalChat. They may recruit visual specialists or governed image tools when justified, but they do not create a fourth workspace or persistence boundary. Durable software implementation moves to Code; source-heavy visual research moves to Research.

## 7. Agent architecture

Agents are adaptive specialists over the same runtime.

Typical roles:

- strategist
- researcher
- analyst
- architect
- implementer
- diagnostician
- debugger
- tester
- critic
- communicator
- security reviewer
- performance reviewer
- art director
- visual designer
- image editor
- layout designer
- visual reviewer

Escalation:

```
direct
 -> one specialist
 -> complementary specialists
 -> bounded independent panel
 -> arbitration only when disagreement is decision-relevant
```

Agent selection is driven by expected value relative to token, latency and coordination cost.

Agents are advisory and cannot directly grant permissions, mutate authoritative state, execute arbitrary tools or mark completion.

---

## 8. Model and context architecture

### Model boundary

The current product is Gemini-family-only:

```
Google Cloud / Vertex Gemini
```

The application-level model boundary stays provider-abstract, but current configuration exposes only the selected provider/model.

The primary request includes only the smallest useful package:

- current task
- situation
- mode controller
- relevant conversation
- authorized memory
- selected skills
- evidence
- project/workspace state
- prior attempts
- verification contract
- authorized tool definitions

Secrets and unrelated private context never enter the model payload.

### Context compiler

```
authorized data
 -> sensitivity filtering
 -> task relevance ranking
 -> dependency / impact expansion
 -> budget selection
 -> model
```

This prevents the default strategy of dumping an entire workspace into every prompt.

---

## 9. Memory

Two layers:

### Chat-local memory

Always available inside the current conversation. It preserves useful task facts and preferences without requiring the entire historical transcript every time.

### Cross-chat memory

Optional and user-controlled.

Rules:

- user and workspace scoped
- secret-safe
- sensitive personal details excluded
- explicit delete / clear
- never used to bypass project boundaries
- chat-local memory is not evicted by another chat

Memory is context, not hidden reasoning.

---

## 10. Security — PA-ONE-X

Security is defense-in-depth and fail-closed.

### Trust model

- zero trust
- least privilege
- authenticated identity
- explicit resource authorization
- server-owned state
- fail closed
- immutable audit

### HTTP / browser

- HttpOnly session cookies
- Secure + SameSite in production
- CSRF protection
- strict Content Security Policy
- frame denial
- referrer policy
- safe URL validation
- no API caching
- request-size and content-type limits
- rejected compressed request bodies where inflation would bypass limits

### Identity and tenancy

Every protected request resolves:

1. principal
2. workspace
3. role
4. applicable governance
5. resource ownership / visibility

Client JSON cannot choose a principal or bypass membership.

### PostgreSQL

- Row-Level Security
- forced RLS for protected tables
- separate runtime / migration / backup / restore roles
- parameterized SQL
- transactional state mutation
- row locking where decisions depend on current state
- append-only audit log
- idempotency records
- bounded worker leases

### Encryption

Separate production keys for:

- object content
- personal data
- billing-private information

Keys are never reused across those domains.

### Execution

```
model proposal
 -> server policy / authorization
 -> execution boundary
 -> authenticated receipt
 -> verification
```

No model component receives unrestricted shell or external execution authority.

---

## 11. Governance and safety

Governance layers:

```
platform
 -> jurisdiction
 -> organization
 -> workspace
 -> user
 -> task
```

Higher-level mandatory restrictions cannot be weakened by lower-level configuration.

Adaptation may tighten:

- human approval
- verification depth
- rollback requirements
- provenance
- data/tool restrictions
- human control

High-consequence work requires stronger verification and may require human control.

---

## 12. Real-world adaptation

The system may schedule, coordinate and react to external signals, but it does not claim magical real-world awareness.

Valid signals include:

- user input
- API responses
- webhooks
- scheduled polling
- connected services
- execution receipts

External state is modeled as known, observed, stale or unknown.

---

## 13. Async durability and recovery

Long work is durable and lease-based.

Jobs carry:

- owner / workspace
- run / task identity
- state
- attempts
- lease
- idempotency
- error classification
- bounded retry policy

Recovery mapping:

| Failure | Response |
|---|---|
| authorization | stop / request authority |
| stale revision | reassess / rebase |
| transient network/provider | bounded retry |
| verification failure | reopen reasoning / replan |
| implementation failure | diagnose and repair |
| missing capability | governed expansion |
| wrong assumption | reassess |
| security failure | stop and preserve evidence |
| attempt exhaustion | stop cleanly |

A restart must never manufacture success.

---

## 14. App / frontend architecture

The browser is a thin interaction and rendering layer.

```
Left rail
  New chat
  Operating surfaces
  Project Hub
  Chat list
  Workspace selector
  Account / settings / usage

Main column
  Active conversation / workspace
  Adaptive workspace bar
  Current status
  One next useful action
  Thread / canvas / research evidence
  Composer
```

### Project management UX

The app should make parallel work obvious:

```
Projects
  All
  Project A
    3 active chats
    Code working
    Research gap open
  Project B
    Design ready
    Chat waiting for approval
```

Selecting a project filters navigation; it does not merge private state.

### UI authority

The browser can request work, switch visible surfaces, provide input and show state.

The browser cannot:

- declare task completion
- bypass governance
- mutate authoritative state
- reuse another project's private data
- claim external execution

### Offline

Safe offline behavior is limited to:

- drafts
- unsent messages
- connection state

Idempotent server writes prevent duplicates after reconnect.

---

## 15. Files and artifacts

All files remain part of the shared adaptive workflow.

Routing is content-aware:

- code archives are profiled from contents
- research bundles preserve evidence lineage
- ordinary documents remain general
- mixed inputs stay general unless the actual goal demands a specialized surface

There is no internal simulation engine. MATLAB / Simulink, CAD, engineering datasets and similar material are handled as files, code and artifacts through the same adaptive system.

Artifacts should carry provenance:

```
source
 -> transformation
 -> revision
 -> generating run
 -> verification evidence
 -> current lifecycle state
```

---

## 16. Usage and economics

Adaptive intelligence must also be economically adaptive.

The controller governs:

- model effort
- context size
- model calls
- agent count
- tool calls
- source count
- execution stages
- verification depth
- parallelism

The default economics are:

```
minimum useful work
 -> measure uncertainty / outcome value
 -> add only justified resources
 -> stop at diminishing returns
```

Provider concurrency should adapt independently from user quotas. The usage ledger records real model calls and their cost dimensions.

---

## 17. Observability and operations

Every important operation should be traceable without exposing secrets.

Telemetry includes:

- request latency / failures
- database pool pressure
- model active and queued requests
- model latency
- run / task throughput
- agent waves
- verification failure rate
- recovery counts
- job leases / retries
- project queue depth
- usage / token cost
- execution failures

Logs are structured and redacted.

Audit records are immutable and capture actor, workspace, action, target, outcome and bounded details.

---

## 18. Deployment

Recommended production topology:

```
HTTPS Load Balancer
       |
Kindgleam API / web instances
       |
       +--> private PostgreSQL
       +--> isolated sandbox / tool runners
       +--> optional local-agent channel
       +--> Vertex AI
       +--> GitHub / Stripe / approved integrations
```

Production requirements:

- private database networking
- TLS across trust boundaries
- secret manager
- non-root application runtime
- isolated execution services
- encrypted backups
- restore testing
- readiness / liveness probes
- graceful draining
- bounded database connections
- adaptive provider concurrency
- monitoring and alerting

---

## 19. Release gates

A production release is not complete until required checks pass.

### Static

- source/invariant checks
- lint
- dependency audit
- secret scanning
- CodeQL

### Runtime

- migrations
- production boot
- auth / RLS
- idempotency
- concurrency / lease recovery
- memory isolation
- project / conversation isolation
- execution receipt integrity
- security regression tests

### Intelligence

- adaptive routing
- direct vs deep calibration
- context selection
- specialist escalation
- evidence sufficiency
- recovery quality
- stopping quality
- cost / latency limits
- live Grok evaluation

Never weaken a security or correctness invariant just to make a test green.

---

## 20. Anti-patterns

Do not evolve the product into:

- one workflow engine per workspace
- permanently active agents
- a universal precomputed task graph
- client-owned workflow truth
- unlimited parallelism
- silent cross-project state reuse
- model-controlled authorization
- fabricated execution
- full-repository prompt dumping
- forced research for simple questions
- forced Code Workspace for every code word
- hidden cross-chat memory
- external-world awareness without a signal
- multiple model providers competing by default without measurable value

---

## 21. Target end-to-end user journey

```
1. User sends a goal
2. Authenticate and establish workspace
3. Load compatible conversation / project state
4. Assess the current situation
5. Select or preserve the correct surface
6. Compile minimum sufficient context
7. Create one justified server-owned step
8. Vertex Gemini reasons inside the granted envelope
9. Recruit specialists only when useful
10. Use tools / execution only through authorized boundaries
11. Convert results into typed evidence
12. Reassess
13. Continue, deepen, reduce, recover or stop
14. Verify against acceptance criteria
15. Deliver
16. Persist verified project / chat / memory / artifact state
17. Continue from that state on the next turn
```

This is the canonical Kindgleam workflow.

## 22. Implementation direction

The current repository already has most of the hard foundations: progressive server-owned runs, unified adaptive decision logic, four workspace controllers, durable conversation state, project-aware continuation guards, code revision discipline, research evidence state, design state, bounded multi-agent orchestration, provider concurrency governance, durable jobs/scheduling/fleet control, PostgreSQL RLS, encrypted objects/personal data, immutable audit and execution boundaries.

The next improvements should **align and harden those primitives under this contract**, rather than introduce another competing architecture. The human-facing Project Hub is now the organizational layer for many conversations and active workstreams; further work should improve filtering, milestones and operational views without moving workflow authority out of the Run/Task system.

## Principle

**One intelligence. One adaptive control loop. Minimum sufficient work. Strong isolation. Real evidence. Controlled execution. Durable continuity.**
