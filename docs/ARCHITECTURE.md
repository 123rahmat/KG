# Kindgleam — Canonical Architecture

This file is the single product-architecture source of truth.

Kindgleam is **one adaptive intelligence system with exactly three user-facing workspaces**:

1. **Normal Chat**
2. **Code Workspace**
3. **Research Workspace**

There is no Design Workspace, Simulation Workspace, Files Workspace, Learning Workspace, Engineering Workspace, or provider-selection workspace. Files, visuals, skills, tools, memory, agents, verification, permissions, and progress are shared capabilities used inside the three workspaces.

## 1. System shape

```
User
  |
  v
Situation + intent understanding
  |
  +-------------------+-------------------+
  |                   |                   |
Normal Chat        Code Workspace      Research Workspace
  |                   |                   |
  +-------------------+-------------------+
                      |
              Shared adaptive core
                      |
   +------------------+------------------+
   |        |         |        |         |
 Gemini   Skills    Tools    Files     Memory
 Vertex   & learn   & forge  & state   & project
   |        |         |        |         |
   +------------------+------------------+
                      |
         Permissions / progress / jobs
                      |
          Multi-agent / parallel agent
                      |
             Evidence + verification
                      |
                 Final result
```

The workspaces are **specialized operating environments**, not separate AI brains.

## 2. Model boundary: Gemini family only

Production reasoning uses **Google Vertex AI and the approved Gemini family only**.

Current adaptive roles:

- **Gemini 3.5 Flash-Lite** — lightweight chat, routing, classification, summarization, and high-volume low-complexity work.
- **Gemini 3.8 Flash** — primary model for Code, Research, difficult reasoning, agents, verification, and complex multimodal work.

The adaptive controller may choose between approved Gemini models according to task complexity, risk, context, tools, latency, and cost. It does not expose other model providers or model-family switching to the user.

Model choice never grants permissions, changes server policy, or proves that an external action happened.

## 3. Normal Chat

Normal Chat is the default and should remain the simplest surface.

It handles:

- normal conversation and questions;
- writing, explanation, math, planning, analysis, and summaries;
- lightweight file and image understanding;
- single-file and small code tasks when a project workspace is unnecessary;
- visual/diagram/presentation requests as capabilities inside the conversation;
- small tool-assisted tasks;
- adaptive specialist help when it materially improves quality.

Normal Chat uses the **minimum sufficient machinery**. One model call is preferred when one call can solve the request reliably. Tools, verification, specialists, and extra reasoning are added only when justified.

Normal Chat may suggest switching to Code or Research when durable specialized state would materially improve the result.

## 4. Code Workspace

Code Workspace is a project-style engineering environment.

Its continuous workflow is:

```
repository/project
  -> relevant files and dependency context
  -> plan only the necessary change
  -> permission / approval when required
  -> edit
  -> diff
  -> run / terminal / build
  -> tests
  -> repair from real evidence
  -> verification
  -> explicit write-back
```

Files are not a separate workspace. In Code, files are part of the coding state.

Code Workspace keeps:

- exact project/repository identity and revision;
- relevant file tree and working set;
- edits and diffs;
- test/build/runtime evidence;
- terminal and sandbox state;
- project memory and history;
- permissions and approved write scope;
- failure/repair history;
- progress, cancellation, and resumable jobs.

Repository writes remain server-governed. Parallel agents may analyze independent scopes concurrently, but conflicting mutations are serialized or rejected.

## 5. Research Workspace

Research Workspace is a project-style evidence environment.

Its continuous workflow is:

```
research question
  -> source discovery
  -> source reading
  -> evidence ledger
  -> claims / conflicts / uncertainty
  -> synthesis
  -> citation and provenance checks
  -> verification
  -> research artifact
```

Files are not a separate workspace. In Research, files are sources and evidence.

Research Workspace keeps:

- root question and subquestions;
- source set and source quality;
- claim-to-source relationships;
- evidence and uncertainty;
- conflicting findings;
- citations and provenance;
- drafts and research artifacts;
- project memory and research history;
- progress, permissions, cancellation, and resumable jobs.

Parallel researchers are used only when independent source discovery or analysis is useful. Duplicate searches and repeated context are avoided.

## 6. Skills and learning

The skill system is a core part of the architecture and must remain.

Skills provide bounded procedural knowledge for tasks such as coding, testing, security review, research, deployment, analysis, and other reusable workflows.

The server may learn which skills work well for a task/context signature, but learning may only influence:

- skill selection;
- ordering;
- effort;
- review depth;
- verification depth.

Learning may **not**:

- grant permissions;
- bypass approvals;
- weaken safety or governance;
- silently rewrite policies;
- silently change model providers;
- claim an action succeeded.

Skill dependencies remain explicit and cyclic dependencies are rejected.

## 7. Tools, MCP, and tool forging

The tool system is also core and must remain.

Tools are discovered and invoked just in time from a governed registry. The system should choose the **smallest sufficient tool set**, not preload every tool.

**Model Context Protocol (MCP)** is shared tool infrastructure, not another workspace. Configured remote MCP servers can expose external tools to Normal Chat, Code, or Research when the active task justifies them. MCP discovery is cached, concurrency is bounded, calls have timeouts and circuit breaking, and actual remote tool calls are approval-gated. Read-only discovery may retry; tool calls are never automatically retried because an ambiguous network failure must not duplicate a side effect.

Tool forging may define or register a missing capability only through the existing governed lifecycle:

```
need
  -> capability contract
  -> implementation check
  -> permission / governance
  -> bounded execution
  -> evidence
  -> verification
  -> promotion or rejection
```

Discovery is never execution. A model cannot invent a working tool, connector, runner, or external result.

## 8. Files and project state

Files are shared infrastructure, never a fourth workspace.

- **Normal Chat:** lightweight attachments and generated artifacts.
- **Code:** repository files, working set, diffs, tests, build outputs.
- **Research:** papers, documents, sources, evidence, drafts.

File access is scoped to the active authenticated project/workspace. Sensitive files follow centralized path and data policies. Writes require the appropriate permission and revision checks.

## 9. Memory and continuity

Memory remains shared infrastructure.

Memory is scoped by authenticated principal, workspace, conversation, and project as appropriate. Current-chat context has priority; broader recall is bounded and permission-controlled.

The system must never use memory as authority. Memory can help recover context, preferences, prior decisions, and project state, but current evidence and explicit user instructions win.

## 10. Multi-agent and parallel-agent system

Multi-agent behavior remains a major capability, but it is **adaptive rather than mandatory**.

Default rule:

```
Can one Gemini call solve this reliably?
  -> yes: use one call
  -> no: add the minimum necessary specialist/tool
```

Normal Chat uses specialists sparingly.

Code may recruit roles such as architecture, implementation, testing, debugging, security review, performance review, and critique when justified.

Research may recruit independent research, analysis, source review, and critique roles when source diversity or disagreement matters.

Parallel execution is allowed only for independent work. Shared mutations, overlapping repository paths, and dependent tasks are serialized through server-owned scheduling.

Agents are advisory. The server owns permissions, tool access, workflow state, writes, job leases, approval gates, and verification.

## 11. Progress, cancellation, resume, and jobs

Live progress is application state, not model narration.

The UI should show structured server events such as:

- understanding request;
- reading project/source context;
- waiting for approval;
- editing;
- running tests;
- searching sources;
- verifying;
- complete;
- stopped;
- failed with recoverable state.

Do not fabricate percentages.

Long-running Code and Research work uses server-owned jobs with bounded leases, cancellation, safe stopping points, and recoverable state. A disconnected client does not own the job lifecycle.

Progress metadata should not be repeatedly inserted into LLM prompts. Only model-relevant state enters model context.

## 12. Permission model

Permissions remain explicit and server-enforced.

User-facing controls cover the meaningful risk boundaries:

- file writes;
- command/code execution;
- network/web access;
- external actions;
- destructive actions;
- project/repository write-back.

The UI may display permission state, but the backend is the authority. A model cannot grant itself permission.

## 13. Verification

Verification is evidence-driven and proportional to the work.

Normal Chat verifies when factual uncertainty, tools, transformations, or stakes justify it.

Code verifies with the most relevant combination of diff review, tests, builds, runtime output, static checks, and repository state.

Research verifies important claims against sources, provenance, conflicts, and citation coverage.

No subsystem may claim external execution or successful mutation without evidence.

## 14. Safety, privacy, and governance

Safety, privacy, tenant isolation, and data boundaries remain shared platform invariants.

Governance is evaluated before risky work and again when the situation changes. Lower-level agents or tools cannot weaken higher-level policy.

Credentials, secrets, payment data, and protected sensitive data do not enter prompts or user-visible logs unless a narrowly authorized workflow explicitly requires safe handling.

## 15. UI contract

The primary product navigation exposes only:

- **Normal Chat**
- **Code**
- **Research**

Project/file/history/settings controls may exist around those workspaces, but they are supporting product controls, not additional AI workspaces.

The UI should progressively disclose complexity:

- Normal Chat stays calm and conversation-first.
- Code exposes project tree, working set, diff, terminal/tests, progress, and write controls.
- Research exposes sources, evidence, citations, conflicts, progress, and research artifacts.

## 16. What is retired

The following are not product workspaces or architecture modes:

- Design Workspace
- Simulation Workspace
- Files Workspace
- Learning Workspace
- Engineering Workspace
- Presentation Workspace
- provider/model-family selection UI

Visual work remains a Normal Chat capability. Simulation requests, when relevant, are handled as ordinary Code/tool work. Learning exists inside the skill/memory/evaluation systems, not as a workspace.

## 17. Non-negotiable invariants

1. Exactly three user-facing AI workspaces: Normal Chat, Code, Research.
2. One shared adaptive intelligence core.
3. Gemini family only in the production model layer.
4. Skills, tools, MCP, files, memory, multi-agent, parallel execution, progress, permissions, and verification are shared infrastructure.
5. Files are contextual state, not a workspace.
6. Simple tasks stay simple.
7. Extra agents/tools/model effort are added only when they can materially improve the result.
8. The server owns workflow state and permissions.
9. Parallel work must be independent or safely fenced.
10. No action or mutation is claimed without evidence.
11. Code and Research maintain durable project state.
12. UI progress is server-reported rather than token-heavy model narration.
13. Retired architecture paths must not remain as active product contracts.

This architecture should be changed only by intentionally updating this file together with the corresponding production contracts and tests.
