# Kindgleam — Architecture

Kindgleam is **one situation-adaptive workflow**, not a set of product modes.
A domain (education, engineering, business, research, design, a domain that
does not exist yet) is context discovered from the goal, not a separate engine.
This document is the single current architecture reference; it replaces the
V5–V9 and 10.1 documents.

## The workflow

```
user and world
  → situation model
  → safety and situation governance
  → capability requirements        (native, composed, or newly discovered)
  → implementation compiler         (what can actually run here)
  → server-owned dependency plan
  → approval gate                   (when execution, side effects or stakes require it)
  → governed execution
  → observation and evidence
  → reassessment                    (may add capabilities, re-evaluate governance, replan)
  → verification against success criteria
  → delivery, or a bounded iteration
```

1. **Situation model.** Built from the goal and everything around it: the
   person (skill, language, preferences), workspace and project state, prior
   and failed work, attached files, constraints, resources, success criteria,
   unknowns, physical or high-impact context and jurisdiction. A prompt is an
   input to the situation, not the whole situation.
2. **Capabilities.** The situation compiles into required capabilities. The
   native registry is a bootstrap set, not a ceiling; unknown needs become
   capability contracts.
3. **Investigation** happens when novelty, uncertainty, impact or missing
   knowledge justify it. Facts, sources, inference and unknowns stay separate.
4. **Plan.** A dependency graph owned by the server, with success criteria
   fixed before execution. The situation decides the stages (research, code,
   approvals, verification); inside that frame the plan step
   shapes the work to the person's exact need (`src/step-plan.js`): complex
   work is broken into up to six steps that build on each other, and research
   the need does not call for is skipped, with the reason shown. After each
   step the model may say the need is already met (the remaining steps are
   skipped) or re-plan the steps ahead. The model proposes; the server
   decides: only work steps are ever added; only research and tool stages
   that have not started can be skipped; approvals that still guard work,
   clarification, code, verification and delivery never are; and
   steps always come before the result is composed and verified. A need one
   answer can meet gets no extra steps.
5. **Approve.** Execution, material side effects, high-impact or physical
   work, and newly discovered risky capabilities require an explicit approval
   at the point they become known.
6. **Execute** only through an authorized boundary (see *Execution trust*).
7. **Observe and reassess.** Every meaningful stage is an evidence checkpoint:
   `act → observe → reassess → replan if necessary → continue`. New evidence
   can change the situation, add or reorder capabilities, require
   clarification, change the execution target or presentation, and re-evaluate
   governance. The system does not continue an obsolete plan.
8. **Verify** evidence against the server-owned criteria. Physical or
   high-impact work can require human certification. Verification checks
   accuracy, not just coverage (`src/verification.js`): the verifier gets
   the sources the work rests on and the links an answer shows that no step
   retrieved. When the work depends on outside facts and research is
   permitted (web access on, plan policy allows it, no open jurisdiction
   review), it searches the web itself to check the key claims. A claim it
   marks unsupported, or an invented link it cannot confirm, fails the check
   whatever verdict it wrote; the verdict records whether facts were checked
   on the web and against which sources.
9. **Deliver** artifacts, evidence, provenance, limitations and open
   uncertainty; **iterate** within the attempt budget, learning from failures.

## Unified adaptive intelligence fusion

Every request and every continuation uses the same server-owned adaptive loop. The
system does not switch between independent "chat", "coding", "research" or "agent"
brains. Those are surfaces and capability combinations selected from the current
situation.

The adaptive decision context is fused from:

1. **Situation and user context** — goal, current need, skill level, language,
   preferences, workspace/project state, prior work, constraints and success criteria.
2. **Memory** — conversation-local memory and optional user-controlled cross-chat memory,
   scoped to the authenticated workspace and principal.
3. **Experience and precedent** — prior verified workflow evidence and current blackboard
   state, treated as evidence to consider rather than automatic truth.
4. **Skills** — procedural SKILL.md instructions selected for the task. Learned user/workspace
   performance changes selection and effort, but never grants authority or permissions.
5. **Patterns** — repeated outcomes for the same task/context signature strengthen or weaken
   how a skill is selected in that situation; single observations are deliberately damped.
6. **Capabilities and resources** — the situation decides what is justified and available,
   then the existing capability compiler/resource controller selects the smallest viable set.
7. **Planning and agents** — the dependency-aware server plan chooses the next work item;
   advisory specialists receive the same adaptive context without becoming a second authority.
8. **Execution and coding workspace** — sandbox/agent execution, repository-aware edits,
   tests, repair history, blackboard and workspace state all report evidence back into the loop.
9. **Verification and governance** — evidence is checked against server-owned criteria;
   approvals, privacy, policy and safety remain hard boundaries and cannot be learned around.
10. **Learning and controlled evolution** — successful/failed outcomes update scoped skill
    performance; explicit feedback also creates the existing governed evolution candidate.
    Nothing silently rewrites policies, prompts or model weights.

The resulting control loop is:

`observe situation → recall memory/experience → select skills/patterns →
compile capabilities/resources → plan → approve when required → execute →
observe evidence → verify → update learning → reassess/replan → deliver/iterate`

For coding work this specializes through context, not a separate engine: repository
intelligence, code-workflow repair, testing, performance, security-review and GitHub
skills are selected inside the same loop.


Ordinary requests take a short path (answer, then check); crisis and
emergency situations get an immediate, caring answer before any workflow.

## Interactive terminal

The Code Workspace includes an interactive terminal surface backed by a real PTY, but the PTY is attached only to a disposable sandbox container, never to the application host shell. The browser uses xterm for terminal emulation and a WebSocket for bidirectional input/output. Sessions require an authenticated browser session and editor access to the selected workspace.

A terminal session starts from the current workspace-source snapshot in /work. The container has no network, no Linux capabilities, no privilege escalation, a read-only system filesystem, an unprivileged UID, CPU/memory/process/file limits, and a bounded idle/lifetime window. Host environment variables and the Docker socket are not passed into the container. Terminal output and input are bounded to prevent an interactive session from becoming an unbounded resource sink.

Terminal changes are not automatically pushed. The session can capture a text-file delta against its original snapshot. Local-folder changes require a browser read/write permission grant and per-file pre-image checks. GitHub changes require an explicitly write-enabled source and an exact branch commit SHA; the server then creates an atomic Git tree/commit update without force-pushing. A stale workspace or branch is rejected rather than overwritten.

The terminal is therefore another governed workspace surface: interactive enough for shells and terminal applications, but still subordinate to authentication, workspace tenancy, execution policy, resource limits, verification, and explicit write-back.
## Adaptive multi-agent review

The server stays the only orchestrator; agents propose and it decides. One
extra agent joins the verification stage (`src/agents.js`): an independent
reviewer with its own instructions and no tools, on a different model from the
verifier when the plan allows one. It is adaptive: `AGENTS_REVIEW=auto` uses it
only for complex work, high-impact or physical stakes, code, or a retry, and
never for crisis or declined requests. It runs only after the verifier passed
the work, can only turn that pass into a fail, and cannot rescue a fail. Its
tokens are recorded under its own model, it runs under the same governance and
data-transfer rules as the verifier, and if it cannot answer the verdict stands
with a visible warning. Cost: one extra model call per reviewed run.

The adaptive subsystem planner (src/subsystem-orchestrator.js) extends coding work for medium, large and very-large repositories. It uses project size, dependency density, hierarchical directory structure and coupling to choose a bounded subsystem count, creates non-overlapping path ownership contracts, builds a dependency DAG, and feeds only dependency-ready subsystem contexts to workers. Typed handoffs, blockers and contract messages are revision-bound and bounded, and stale messages are rejected from newer revisions. The subsystem layer is coordination infrastructure; repository mutation and integration remain server-owned.

The specialist panel (`src/multi-agent.js`) adds a domain-agnostic advisory
layer without changing that authority model. In `MULTI_AGENT_MODE=auto`, the
server estimates the value of additional independent perspectives from the
current task and situation, then recruits the smallest useful set up to the
configured eleven-agent ceiling. Reusable roles include strategist, researcher,
analyst, architect, critic, communicator and diagnostician. Allocation reacts
to complexity, decomposition, uncertainty, evidence gaps, comparison needs,
communication needs, stakes, retries and observed specialist confidence or
disagreement. Agents have no tools. Their findings are treated as data, usage
is recorded, and an arbiter is used only when disagreement becomes decision
relevant. A panel outage or budget/data-policy block falls back to the primary
workflow. The existing verification reviewer remains separate so verification
is not accidentally duplicated.

Independent execution steps are still not run in parallel. The dependency
planner locks and evaluates stored rows serially, and changing that is a larger,
riskier change than advisory parallelism; it should be measured against
load-test data before allowing concurrent execution.

## Capability contract and lifecycle

A capability has a stable id and declares purpose, inputs, outputs,
prerequisites, constraints, risk, data classes, execution modes, side effects
and verification requirements.

The implementation compiler resolves each requirement to one of: native
bootstrap capability, governed composition, concrete runtime, configured
execution target, connector, hardware runner, *implementation required*, or
*unavailable*. Capabilities form a dependency graph, ordered topologically
where possible, with missing dependencies kept explicit.

```
discover → specify → implementation-check → approval (when required)
         → execute → observe → verify → promote-or-rollback
```

With no implementation the lifecycle stops at
`register-or-build → await-implementation`. **Discovery is never execution**:
a candidate becomes executable only when a concrete implementation is
registered for this deployment, and never bypasses governance or approval.

## Open-world boundary

Open-world means no fixed domain ceiling, not a claim that every capability is
installed. For an unknown need the platform understands the situation,
describes the missing capability, reuses or composes what exists, connects or
registers a real implementation when appropriate, verifies it, and executes
only then. Otherwise it reports the limitation instead of pretending.

## Execution trust

All environment-dependent work passes the same implementation gate: code needs
a configured runner, a discovered tool the tool runner,
private data an authorized connector, hardware a concrete hardware runner.
A model cannot manufacture evidence that a runner, connector, device or solver
exists.

- **Local agent.** Eligibility comes from a paired agent's preflight (CPU,
  RAM, storage, GPU) compared with task requirements. Only allowlisted
  runtimes run; no arbitrary shell. Receipts are HMAC-SHA256 signed and bound
  to run, task, type, target, status, timestamps, agent version and output
  hashes; unsigned or altered receipts are rejected. Production deployments
  run the agent inside a VM, container or equivalent isolation boundary.
- **Sandbox** (`SANDBOX_RUNNER_URL`) is Kindgleam's sealed code runner.
- **Tool boundary** (`TOOL_RUNNER_URL`) runs discovered tools, isolated from
  the web process.
- Every managed runner must return an explicit `executed: true` receipt bound
  to the execution id; cloud fallback is a new explicit decision, never silent.

## Situation governance, safety and ethics

Safety is evaluated deterministically while understanding the goal, before
capability discovery, while composing the workflow, and again at the
execution and receipt boundaries. Model safety hints are untrusted and can
only make a decision stricter.

Situation governance combines safety, risk, domain, data sensitivity,
jurisdiction, decisions about people, side effects, server policy and
verification needs into a persisted record with a status of *ready*, *care*,
*review* or *blocked*:

- **Blocked** stops every step, and the refusal names its reasons.
- **Missing jurisdiction** on regulated or high-impact work stops acting steps
  (code, tools, research, runner receipts, approved actions); the
  model may still help with general information and never claims legal or
  regulatory compliance.
- **Decisions about people** (hiring, admission, grading, credit, housing,
  benefits) stay with a person; protected characteristics are never used or
  inferred.
- **Governance follows the work.** When a step discovers a capability the plan
  did not contain, governance is re-evaluated with everything seen so far.
  Inputs only accumulate, so it can tighten but never loosen; escalations are
  audited as `run.governance.escalate`.
- **Refusals are audited** at the execution boundary as `run.execute.denied`
  (reason code only, never content).
- Gemini receives the governance record with every task and is instructed to
  follow its restrictions, avoid manipulation, be transparent about what was
  and was not done, and recommend a qualified professional when stakes call
  for it.

Server policy layers apply in the order
`platform → jurisdiction → organization → workspace → user → task`: denials
accumulate, allow-lists intersect, the tightest budgets win, and lower layers
cannot replace platform or jurisdiction controls. Governance is a control
mechanism, not a certificate of legal compliance.

## Privacy

Privacy is an invariant, not a feature a workflow can switch off:

`authenticated principal → verified workspace scope → minimum necessary data → purpose → policy → authorized destination → provenance`

- **Tenant isolation** (PostgreSQL row-level security, forced on every
  tenant table) keeps workspaces apart.
- **Inside a workspace**, runs and objects are private by default and shared
  only when their creator chooses `visibility: workspace`.
- **Egress to Gemini or a runner** needs destination policy *and* explicit
  processing consent; a connection or a share never implies consent.
- Credentials, payment data, sessions and secrets never appear in prompts,
  URLs, logs, audit detail or provider responses.

Kindgleam connects to no private outside account. Public web research uses
the model's web search and a guarded fetcher (public addresses only, re-checked
on every redirect). Data a person keeps elsewhere arrives as an attached file.

## Presentation

The browser renders server-selected surfaces (chat, research, code,
creation, workspace, adaptive) for each run; it does not own the
list of possible surfaces. Presentation adapts to the person — guided,
dense, or artifact-first — and suggestions stay non-coercive.

## Code quality

**Code** (`src/code-workflow.js`, `src/sandbox.js`): understand → plan →
write a small increment *with its tests* (normal, edge and failure cases) →
syntax check → run the tests through an authorized runner → on failure, the
real error output, test counts and the failed code go back to `build-code`
for a targeted fix, and the fixed code runs again → verify → deliver code with
test evidence and limitations.

- A package without tests is sent back once for them. Code that still ran
  without tests cannot be certified by the automated check; a person does.
- A fix never deletes, skips or weakens a test to pass it.
- Up to three fixes per attempt, audited as `run.code.repair`; after that
  the run falls back to a new attempt with the lesson. Fixing keeps the
  attempt's approval; in the chat, a fixed version reruns on its own only in
  the sealed Kindgleam sandbox (never on the local agent).
- Generated code is not verified merely because a model produced it.

There is no separate simulation feature. A request to simulate something, a
netlist, a model script or a CAD macro is a code project and follows the code
workflow above; a language the sandbox cannot run is delivered untested with
the reason. Files, folders and zip archives are worked on in the chat, or as
a code project when they are software.

## Human editing

AI-generated artifacts are editable. A human edit becomes new input that
re-enters the same verification and execution workflow and is never silently
overwritten by an earlier model output.

## Reproducible decision state

Each adaptive decision is captured as a canonical situation snapshot
(situation, capabilities, implementation state, presentation, runtime,
privacy boundary, verification contract, provenance) with a SHA-256
fingerprint. The fingerprint identifies the decision state; it is not an
authorization mechanism. A changed situation produces a new snapshot instead
of silently changing the meaning of an earlier decision.

## Non-negotiable invariants

- The server owns workflow state; clients cannot set task status or forge
  dependencies.
- External execution cannot be marked complete by hand, and requires an
  approved target and an authenticated receipt.
- Observe and verify require evidence; human certification applies where the
  verification contract requires it.
- Dynamic capabilities cannot bypass governance or approval.
- No component claims work happened without evidence.
- Unknown requirements stay explicit instead of being mapped to a fixed domain.
- Live runtime changes require explicit promotion, never silent mutation.

Operational requirements, release gates and deployment steps are in
`docs/PRODUCTION_READINESS.md`.


## Skill intelligence compiler

Skills are compiled as contracts rather than instruction snippets. Each selected skill exposes prerequisites, phases, evidence requirements and bounded cost. The server composes required dependencies into an ordered skill plan before execution. Learning combines contextual and general evidence conservatively; observed outcomes also create bounded pattern records and deterministic failure classes. Skill intelligence can improve selection, ordering, effort and verification, but remains subordinate to server governance, capability availability, execution boundaries and verification.


## Continuous improvement control loop

The unified controller now treats quality and recovery as first-class runtime state. Skill registries reject cyclic prerequisites, skill composition preserves prerequisite closure under resource budgets, failures receive bounded recovery classes, and evaluation reports can compare reliability, latency and token usage against a baseline. These signals are control inputs only: they tune future planning and review depth but never grant permission, weaken governance or bypass human approval.
