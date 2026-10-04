# Kindgleam

**One shared adaptive and agentic intelligence for normal work, code, and research.**

Kindgleam is designed around one idea: the system should adapt to the situation instead of forcing every request through the same fixed process or maintaining separate “brains” for separate products.

## Core architecture

There is **one intelligence, one adaptive decision loop, and three workspaces**:

```
ONE SHARED ADAPTIVE + AGENTIC INTELLIGENCE
                 |
        +--------+--------+
        |        |        |
   Normal Chat  Code    Research
                Workspace Workspace
```

The workspaces are **context and persistence boundaries, not separate intelligence systems**.

- **Normal Chat** is the general adaptive workspace. It handles everyday conversation, writing, planning, analysis, files, images, design, visual/canvas work, presentations, and bounded micro/single-file coding.
- **Code Workspace** is for durable repository and multi-file engineering work, with project continuity, exact revisions, execution, tests, verification, and controlled write-back.
- **Research Workspace** is for durable evidence-heavy work, with source continuity, provenance, conflicting-evidence handling, and citation-backed synthesis.

The same agent runtime serves all three.

## The adaptive loop

The server does not require every possible stage in advance. It keeps the authoritative run state and activates only the work that the current situation justifies.

```
observe
  → assess
  → choose the minimum sufficient work
  → act
  → verify when justified
  → reassess
  → continue / expand / reduce / stop
```

This applies to reasoning, agents, tools, context, evidence, execution, and verification.

A simple request can stay lightweight. A complex request can deepen automatically. When new evidence changes the situation, the system can expand or re-plan instead of blindly following an old fixed graph.

## One agent behavior across all workspaces

The multi-agent layer is shared rather than duplicated.

By default, the system uses the smallest useful agent set. Additional specialists are added only when their independent value is worth the coordination cost. An arbiter is used only when disagreement becomes decision-relevant.

Typical roles include:

- strategist
- researcher
- analyst
- architect
- implementer
- critic
- communicator
- diagnostician
- debugger
- test engineer
- security reviewer
- performance reviewer

These are **adaptive roles**, not permanent background agents. The runtime chooses whether to use one role, several roles, or no specialist panel at all.

For Code Workspace, parallel work is bounded by the repository revision and write-set rules. For Research Workspace, independent source work is used only when it materially improves coverage or resolves disagreement.

There is no separate legacy Normal Chat control plane.

## Adaptive economy

Kindgleam separates **available resources** from **resources actually selected for the current situation**.

The controller aims for a minimum-necessary working set across:

- context
- agents
- tools
- external sources
- artifacts
- execution stages
- evidence
- verification

Work expands only when the current result, uncertainty, risk, or evidence gap shows that more work is justified.

This is the main complexity reduction: the product has **one shared intelligence and one adaptive workflow**, rather than multiple independent workflow engines.

The implementation is still modular internally for testing, security, and maintainability; modular code should not be confused with multiple independent “brains.”

## Workspace boundary

### Normal Chat

Normal Chat is the default general workspace.

It can handle:

- conversation, explanations, planning and analysis
- writing, rewriting and translation
- images and visual understanding
- design, canvas concepts and presentations
- documents, spreadsheets and other attachments
- one or a few files when the work is bounded
- micro/single-file coding and tests
- general adaptive tool use
- lightweight evidence gathering when justified

Normal Chat can escalate to Code or Research when the work becomes durable project engineering or durable evidence-heavy research.

### Code Workspace

Code Workspace is the durable engineering environment.

It provides:

- GitHub repository continuity
- exact revision awareness
- affected-file and dependency inspection
- adaptive specialist roles
- bounded parallel work
- terminal/sandbox execution where authorized
- tests and regression verification
- stale-revision detection
- controlled GitHub write-back with explicit confirmation

The selected repository revision is authoritative. Local folders are not silently imported into Code Workspace. An optional paired local agent is an execution target, not a project source.

### Research Workspace

Research Workspace is the durable evidence environment.

It provides:

- a persistent research question
- bounded source sets
- evidence and citation continuity
- provenance tracking
- unresolved-question tracking
- conflict tracking
- adaptive source expansion
- source-backed synthesis

Research depth is adaptive. A simple factual question does not require a large source set; an uncertain, current, or high-stakes question can trigger deeper evidence collection and cross-checking.

## Adaptive surface selection

The server classifies the situation before choosing a workspace boundary. Attachment routing uses an aggregate profile rather than treating file extensions as the answer: ZIPs are inspected from their contents, multiple files are evaluated together, and ambiguous/mixed sets stay in Normal Chat.

```
Normal Chat
  ↕
Code Workspace
  ↕
Research Workspace
```

The boundary is based on what the work actually needs, not merely on a file extension or a keyword.

Examples:

- a single Python edit → Normal Chat
- multiple source files forming a project → Code Workspace
- a current comparison requiring sources → Research Workspace
- a ZIP whose contents form a real code project → Code Workspace
- a ZIP with research-oriented documents/evidence → Research Workspace
- ordinary documents, spreadsheets, images or unrelated files → Normal Chat
- mixed code + research material → Normal Chat unless the task clearly requires one dedicated workspace
- ambiguous or weak signals → Normal Chat

The archive profiler looks at project markers, source-file structure, research/document signals and a small bounded content sample. It does not declare README/LICENSE files alone to be a software project, and it does not treat every PDF/DOCX as research. A ZIP archive is therefore profiled by its contents instead of automatically being treated as a code project.

## Files and archives

Files remain part of the shared adaptive workflow.

Supported archive classification includes:

- `code-project`
- `research-bundle`
- `document-bundle`
- `mixed-bundle`
- `unknown-bundle`

Code projects retain the stricter project/file limits. Non-code bundles are summarized and ranked for the current task instead of blindly dumping every item into model context.

There is **no separate built-in simulation engine or simulation workspace**. Simulation-related files (for example MATLAB/Simulink scripts, FreeCAD macros, engineering data or similar artifacts) are treated as ordinary files/code and handled in the workspace that the current situation requires.

## Server-owned workflow state

The browser does not own completion state.

A run is stored by the server, and each advance re-reads authoritative state under a transaction/row lock. The client can name the current task and provide evidence, but it cannot simply declare a task complete.

This protects the core invariant:

> **Nothing is claimed unless it actually happened.**

For example:

- an unconfigured model remains unexecuted
- an unavailable runner does not become a fake success
- verification cannot complete before its required evidence exists
- policy denial remains denial
- approval cannot approve itself
- repeated recovery is bounded

## Evidence and verification

Evidence uses the same adaptive loop as the rest of the system.

```
low uncertainty
  → little or no external evidence

meaningful uncertainty
  → targeted evidence

conflicting evidence
  → compare / expand

high-stakes or current claim
  → deeper verification

sufficient evidence
  → stop
```

The system distinguishes:

1. what was observed,
2. what was inferred,
3. what was executed,
4. what was verified.

A model statement is not treated as proof that an external action happened.

## Open-world capability model

Kindgleam is open-world: the built-in capability registry is a bootstrap set, not a complete list of everything the platform can ever do.

```
known need
  → existing capability

compound need
  → compose capabilities

unknown need
  → investigate / discover requirements

missing capability
  → create a governed capability specification

authorized implementation
  → execute through an approved boundary

new evidence
  → reassess / re-plan if required
```

A discovered capability is a candidate, not an executable fact. Missing infrastructure is never turned into fabricated success.

## Governance and safety

Governance is part of the situation model.

The server combines safety, risk, data sensitivity, jurisdiction, human-decision requirements, side effects, approval requirements, and verification requirements into a persisted governance contract.

The important rule is that adaptation can **tighten** governance when the situation becomes riskier, but it must not silently loosen an existing restriction.

Governance can require:

- human approval
- additional verification
- restricted data handling
- restricted capabilities/tools
- jurisdiction-specific caution
- human certification for high-impact outcomes

The model follows the server-provided governance state; it does not become the authority that grants itself permission.

## Execution trust

Execution is separated from reasoning.

Supported boundaries include:

- **Kindgleam sandbox** for authorized code execution
- **Generic tool runner** for bounded tools
- **Optional paired local agent** for local execution

Execution receipts are bound to the run/task and output evidence. An execution claim without an authenticated receipt is not treated as completed external execution.

The system never silently moves an execution to the cloud.

## Security model

The repository includes application-level controls for:

- API-key/session authentication
- workspace membership and tenant isolation
- PostgreSQL Row-Level Security
- CSRF protection
- strict Content Security Policy
- safe upload/download headers
- log redaction
- append-only audit records
- idempotent write operations
- encrypted high-sensitivity application fields
- separate billing, personal-data and object-storage keys
- dedicated database roles for runtime, migration, backup and restore

Production credentials belong in a secret manager. Production deployments should use TLS, isolated execution services, encrypted backups, monitoring, malware/content scanning for arbitrary uploads, and a documented recovery procedure.

## External services

The AI provider is **Google Gemini**, with Gemini 3.8 Flash as the current model family in the application.

The runtime supports Google/Vertex AI credentials and a direct API-key path. A deployment should use the credential path appropriate for its environment; production managed deployments can use Vertex AI.

Optional external integrations include:

- GitHub for Code Workspace repositories and controlled write-back
- Stripe for payments

The application does not treat a connector catalogue entry as proof that a user's private account is connected.

## Memory

Memory is scoped to the individual workspace and is separate from hidden model reasoning.

Users can view, delete, or disable saved memory from Personalization. Secrets are not stored as memory.

Conversation continuity is kept within the appropriate workspace context so follow-up turns do not need to restart the entire job.

## Repository structure

```
server.js
bin/                    operational CLIs and runners
src/core.js             core goal planning and workflow decisions
src/runs.js             server-owned run state and adaptive progression
src/multi-agent.js      shared adaptive agent orchestration
src/adaptive*.js        adaptive control, runtime state and efficiency
src/unified-*.js        shared adaptive workflow/context layers
src/code-workspace.js   durable Code Workspace behavior
src/research-workspace.js research continuity and evidence ledger
src/documents.js        document/archive inspection
src/attachments.js      attachment context and ranking
public/                 web interface
tests/                  unit, API, security and workflow tests
docs/                   architecture, policies and operational notes
```

The important architectural boundary is simple:

```
shared intelligence
    +
adaptive workflow
    +
workspace-specific context
    +
authorized tools / execution
```

Not:

```
three separate brains
three separate adaptive loops
three separate control planes
```

## Quick start

```bash
docker compose up -d db
cp .env.example .env
npm install
npm run bootstrap -- --workspace acme --name "Your Name"
npm start
```

Then open:

```
http://localhost:3000
```

Useful checks:

```bash
npm test
npm run lint
npm run doctor
npm run verify
```

The service can start without a configured model or runner; in that state it plans honestly and does not pretend that external reasoning or execution occurred.

## Verification before release

A production release should have successful:

- source/invariant checks
- system doctor
- skill evaluation
- lint
- test suite
- CodeQL
- secret scanning
- deployment smoke tests

For live AI validation:

```bash
npm run eval:live
```

See:

- `docs/ARCHITECTURE.md`
- `docs/USAGE_POLICY.md`
- `docs/PRIVACY_NOTES.md`
- `docs/LIVE_EVALUATION.md`

## Design principle

**One intelligence. Adaptive depth. Minimum sufficient work. Real evidence. Controlled execution.**

Kindgleam should become more capable when the situation requires more capability, not more complicated merely because more features exist.
