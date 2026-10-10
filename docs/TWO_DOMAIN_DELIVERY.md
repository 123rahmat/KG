# One runtime, two specialist domains: Code and Research

Kindgleam has a **single** server-owned RunStore, approval gate, Gemini/Vertex
inference boundary, usage accounting and task verification contract. Code and
Research are the two agentic domains built on top of that runtime. Normal Chat
remains a direct non-agent conversational entry point for compatibility and
ordinary requests; it is not a third specialist-agent engine.

## Adaptive dispatch, not an agent army

Code recruits engineering specialists (architecture, implementation, test,
debugging, security, performance) only for independent tasks with material
value. Its context is revision-first; workspace changes and terminal work must
go through existing owner/permission controls. Research recruits investigators,
analysts and critics only where conflicting sources, uncertainty or workload
justify them. Its context and delivery are anchored to evidence provenance,
open questions and citations. Independent specialist lanes may execute in
parallel under the existing conflict, budget and task ownership rules.
Neither specialists nor the browser own completion decisions.

Two **optional visual-review specialties** are part of the existing bounded
agent scheduler, not a second execution system: Code reviews actual authorized
UI screenshots and responsive regressions; Research checks figures, tables,
units, data provenance and uncertainty. These agents never manufacture
screenshots, measurements or execution receipts.

One Gemini/Vertex boundary routes efficient and stronger calls by actual task
requirements. Reducing optional model calls, reusing scoped context, and
stopping at acceptance are preferred to fixed multi-agent chains. Lightweight
low-effort coordination may use Flash-Lite; complex or uncertain engineering,
source critique, verification and recovery remain on the stronger model.
Explicitly resolved research questions or conflicts are removed from the
bounded evidence ledger without discarding unresolved historical gaps. The
configured Gemini model IDs must be authorized in the deployment's Vertex
project; model catalog entries alone do not prove API access.

## Presenting what actually happened

Both agentic workspaces show an overview report and a compact receipt beside
the final chat answer **after a run reaches a terminal state**. It distinguishes saved completed/failed steps, authenticated
execution receipts, passing verification records, applied changed-path metadata
and tracked research sources, evidence, open questions and conflicts. A proposed
test is never labeled as successfully executed. The persisted task timeline and
specialist activity remain available during the run. Images, tables and files
are presented through the existing scoped artifact preview path; no new
parallel artifact storage system is introduced.

### User-approved UI screenshots

In Code or Research, click **Screenshot UI**. Over HTTPS/localhost on a
compatible browser, choose the browser tab to capture in the operating
system's screen-sharing prompt. Kindgleam takes **one frame**, stops all
tracks immediately and attaches the PNG to the current message draft.
It is not uploaded or shared until the person sends the message. This can
capture a running UI **when that UI is actually visible in the selected tab**.

This is not a headless build-and-browse service. A backend preview of arbitrary
code still requires configured sandbox execution and an isolated browser;
screenshot success must never be claimed without a real browser capture.
The existing Playwright UI regression command produces on-disk screenshots
for CI/testing; those fixtures are not user code previews.

## Operational proof still required

Run `npm run check`, `npm run lint`, `npm test`, `npm run test:ui`,
credentialed `npm run smoke:providers`, and full sandbox/build deployment tests.
Passing mocked tests cannot establish live Vertex calls, correct code execution
for every language, production isolation, or arbitrary project screenshot
support. Update this document only as capabilities are verified.

## Adaptive choice: what, when, how and why

The server-owned role allocator now records bounded `selectionRationale`
for the actual selected Code/Research specialists: the expertise used
(**what**), the persisted task it belongs to (**when**), why the current
task matched that specialty (**why**) and its read-only review boundary
(**how**). Explanations are displayed only alongside recorded specialist
contributions; selection alone is not execution. Conditional parallel
capacity is not reported as completed parallel work. Existing wave-level
evaluation still expands, contracts and stops optional teams only on
observed evidence, policy and resource budgets.

Subagent lenses are chosen from an extensible skill vocabulary and
requirement-specific unknowns. The prompt's context-character allowance
increases with complexity, uncertainty, risk and available budget.
This controls wasted tokens without imposing a fixed team size or
silencing required parent-owned verification. Independent subagent calls
still require separate model-call admission and execution gates.

Both domains show the **actual next server-recorded task** with concise
why/how guidance. Evidence anchoring is shown only when the referenced
prior task holds real saved results. No future task is invented for a
completed or blocked run. These explanations are deterministic and do not
spend additional Gemini tokens.

## Elastic family expertise, not eight subagents per lead

The established main-agent families in Coding and Research now have expanding,
domain-specific skill vocabularies instead of a fixed eight-skill contract.
Shared foundational checks are excluded from family *discovery* scores so
generic correctness, provenance or revision words never recruit every lead.
Domain capability packs provide deeper coding roles (UI, API, databases,
security, AI-agent runtime, systems, testing, DevOps and more) and research
roles (source review, quantitative/qualitative methods, academic manuscripts,
data provenance, figures, ethics and more). New, uncovered task requirements
and later observed unknowns can still create temporary read-only expert roles.

At each settled specialist wave, the parent supervisor recomputes *both*
active main roles and selected child lenses. New justified work is admitted,
satisfied user/task criteria retire their corresponding lenses, and budget,
completed work or policy can retire the whole task team. No model output is
trusted to certify completion: original criteria require server/task-recorded
resolution; model findings can propose only further read-only investigation.
Newly emerging temporary main roles receive their observed specific mission,
not a generic fallback. The UI labels saved admission/retirement events as
advisory selection, separate from actual model-call receipts. No in-flight
agent is silently canceled, no child executes tools and no selected role
gains permissions or an unlimited Gemini budget.

## Main answer/output surface, separately from workflow steps

Coding and Research now show an adaptive **Work Output** area in the conversation
and at the top of the dedicated project overview, while recorded progress
steps remain visible as a compact status timeline or optional detailed list.
The displayed content is chosen from what the server actually saved:

- Recorded isolated runner `stdout`/`stderr` and test counts appear in an
  accessible, scrollable terminal-style view. The UI clearly distinguishes
  authenticated execution receipts from result data without confirmed receipt.
  It is a *snapshot of saved execution*, not a fabricated live shell stream.
- Real structured table samples are shown as bounded, read-only data tables.
  A table is not generated from speculative agent prose.
- Stored image artifacts with authorized object IDs can appear as inline,
  same-origin image previews, with the existing preview action alongside.
  Other saved artifacts stay accessible through their preview chips.
- Research uses saved evidence-ledger entries, source links and unresolved
  questions. Several recorded evidence rows become a comparison-friendly
  table; a single item becomes prose. No chart or figure is invented.
- Recorded findings are rendered through the existing safe Markdown component
  with paragraphs, headings, bullets, code and tables. The final assistant
  answer still appears in full and is not redundantly copied into the work
  area. Missing outputs produce an explicit empty/waiting state.

The surface does not add another model call, tool, permission or workflow
engine. It consumes bounded snapshots of the persisted run during the existing
UI refresh path and preserves accessible table/terminal scrolling on mobile.

## Point-based public explanations, low-waste Research output, and step/main progress

Research final-answer policy is **result first**, followed by only the
evidence-backed public decision points necessary to answer the user. Citations
stay adjacent to claims; limits are stated once when material. A full paper,
thesis, detailed report or expressly lengthy request is not shortened simply
for cost. This is an explanation of findings, **not internal chain-of-thought**.

The server applies a generous *ceiling*, not a target, on output tokens to
ordinary Research `respond` / `deliver` model calls. The cap adapts to task
risk, uncertainty and complexity. Evidence collection, verification, code,
tool results and requested long forms keep their existing budgets/controls.
Advisory Research specialists are also asked to send only short, distinct,
relevant findings, grounded sources and falsifiable next checks, not repetitive
mini-essays. Security/governance/acceptance work is never dropped to save tokens.

The main project output area now shows at most three short public progress
points, derived only from saved completed/failed steps and the exact server
selected next task's why/how policy. The step timeline remains a distinct
horizontal progress rail. For research, the main evidence reader prioritizes
source-ledger facts, tables and linked sources while suppressing the duplicate
prose already represented by the evidence ledger. It does not invent text,
figures, citations, terminal output or work that did not execute.

## Business / Idea-to-product agent path

Business and creative venture requests stay within the existing **Research**
and **Coding** agentic domains (Normal Chat remains direct). The server detects
explicit idea discovery/validation requests rather than recruiting a permanent
business team on every ordinary code or business question.

For a venture-led Coding build, the same server-owned incremental graph
creates a single **Explore and test the idea** step after understanding (and
essential clarifications) and before the existing code-plan agreement gate.
That task compares at least three distinct solution directions, maps customer
needs, tests feasibility and identifies the smallest falsifiable experiment.
Its saved evidence is available to the downstream coding plan. Once the
exploration is complete, the server moves to the original build-plan approval,
then only after explicit user agreement can code generation take place. For
Research-only venture work, an evidence investigation and answer follow where
needed, **without inventing a code build**. Explicit "just build it" requests,
ordinary bug fixes and non-venture chats skip the extra idea stage.

Available task-scoped advisory main specialists include venture ideation,
customer discovery, business model, market validation, feasibility and
product MVP leads. Each has a larger vocabulary of child expertise but the
actual team size and selected child skills remain bounded by current need,
provider budget and the parent orchestration policy. These specialists do not
invoke tools or approve financial, external or software mutations.

The existing UI displays the named idea checkpoint and later build stages;
read-only main-area summaries derive from recorded work. The step-progress
"Why now" panel explicitly distinguishes hypothesis exploration from executed
validation or approved implementation. Unknown demand, revenue or market
figures are labeled assumptions until established by authorized sources.

## Conditional idea-first project development and opt-in milestone suggestions

The Coding controller protects the explicit idea-development phase against
model-suggested shortcuts: if a qualifying new venture still needs its
**Explore and test the idea** checkpoint, a proposed coding, planning,
prototyping, or finalization step cannot bypass it. Genuine clarification,
authorization and necessary evidence acquisition may still precede ideation.
Once exploration is recorded, the usual scoped build plan, explicit
user agreement, coding, testing and verification follow. Ordinary maintenance,
bug fixes and the user's explicit "just build it" intent do not trigger the
extra brainstorming phase; the existing code-plan/approval controls remain.

The Coding main output can present **one optional recommendation** at a
materially different checkpoint, with a concise evidence-based "why":
idea exploration, MVP planning, build-plan approval, generated code awaiting
tests, recorded test failure, reassessment, or completed passing verification.
The suggestions are static policy templates selected from **persisted server
task state**, not generated model claims or a new recurring model call.
User action is required to put one in the composer, and submitting the
resulting draft is a separate user decision. Dismissed recommendations do not
reappear in the same browser session until a *different milestone* is recorded.
No suggestion authorizes build steps, approves tools, invents successful tests,
or claims a product was deployed.

### Multi-phase idea requests stay in the Code project

The shared browser/server workspace intent also recognizes the explicit
sequence "brainstorm concepts, then build an MVP" even when a user has not
written the words "code" or "app". This routes the request to the
Code workspace and compiles the matching native code-generation capability
under the ordinary resource/governance policy. It does **not** route
idea-only conversations to Code, claim that project source files exist,
or authorize running code without the required approval and runner checks.

## Need-driven agent economics and improved creative/research continuity

Coding, Research and business/idea work share the existing parent workflow;
there is no extra fixed-size agent tier. The optional child-model admission
policy observes complexity, uncertainty, unmet success criteria, research
conflicts, failures and remaining compute allowance. For easy work and most
ordinary ideation it reserves **zero** extra child calls. When independent
checks could change an important decision, it allows a small, bounded number,
still subject to the existing per-child need, consent, provider-budget and
token gates. Operator-configured child allowances remain upper bounds. The
final parent verification, research evidence fetching and human approvals
are **not** bypassed.

Specialist system messages use a compact findings/risks/next-check JSON
contract for Research, brainstorming and read-only reviewers. Only the
scoped Coding implementer receives the large patch-proposal format. All
specialist messages still prohibit unauthorized tools, shell commands,
credential access, fabricated sources or claimed tests. This saves prompt
tokens before models are called and does not shorten an expressly detailed
final deliverable.

Venture discovery respects requested breadth. Open brainstorming compares
at least three distinct concepts. An already selected idea gets focused
assumption validation without replacing the user's preference. A known
direction gets a short comparison rather than an expensive broad brainstorm.
The selected mode travels in the server task metadata, survives UI/rerenders
and keeps the existing build plan and approval gate.

Research ledger updates now keep already-recorded source identifiers as
identifiers (not malformed, re-normalized URLs). Repeated claims merge
their legitimate source keys while keeping the newest claim. This preserves
traceable provenance across successive research turns without inventing
freshness or treating reused findings as newly verified.

### Smaller specialist context, without cutting Code edits or source evidence

For Research and idea-discovery advisory agents, repeat history is bounded
according to risk, uncertainty and complexity: fewer recent chat turns,
shorter remembered excerpts and fewer skill-instruction excerpts. Current
task, situation, criteria, evidence, source ledger and primary-model context
remain separate and available. Idea advisors working against a Coding project
receive project identity, focus and file paths rather than large source-code
contents; later authorized Code implementers retain their full scoped source
and normal coding history. This eliminates repeated large payloads in
optional specialist calls without claiming that sources have been verified
or work executed. The choices are deterministic, measured in regression
tests, and do not introduce another agent or provider call.

## Server-controlled progression integrity across changing situations

The system can brainstorm, validate an existing idea, discover a tool,
retrieve Research evidence, scope Code work, ask for approval, implement,
test, verify and deliver. These are **conditional milestones**, not a fixed
sequence of extra agents or a promise to run tools. Progression is based on
the capabilities selected for this run, actual saved task statuses, remaining
acceptance gaps and current governance.

A cheap deterministic `enforceRequiredProgression` check protects the
server-owned one-task-at-a-time graph after model proposals, early
`enough:true` decisions and evidence-expansion handling. If the actual plan
requires capability discovery or evidence retrieval, the check inserts that
stage before a premature answer/build. For a Code project that requires scope
agreement, it inserts the plan, then the **explicit user-agreement** gate,
then implementation. It will not permit skipping an unscheduled Code build or
its test stage and going directly to verification. Small Code requests without
a required plan, ordinary questions, clarification, optional investigation,
and authorized governance approval retain their existing conditional paths.
The check does not overwrite an in-progress plan or approval with a duplicate.
It never claims source retrieval, code changes or tests occurred; a
`codeNotRun` runner limitation remains a limitation.

Mandatory transitions carry bounded saved `progressionReason` metadata that
the read-only UI uses to explain **why this next step**, distinct from the
latest completed step or any model narrative. No extra model call or
speculative percentage is needed. When a saved run is waiting, blocked,
exhausted or entering recovery, the main area shows that exact status and an
available recorded blocker instead of pretending the previous operation is
still running.

Research projects have the same optional milestone-guidance surface as
Coding. Suggestions are selected from recorded conflict entries, missing
sources, unresolved questions, claim/source links, and saved findings. Only
one suggestion is shown at a time; it can be dismissed or copied into the
composer by the user. These are **not facts or automatic research actions**,
and do not authorize a new provider call. Source links alone are not treated
as independent proof.

## Multi-chat, multi-project Coding and Research organization

The left rail now filters the **loaded** conversation page by workspace
(Coding, Research, Normal Chat), project selection, search, and material work
status (needs action, working, complete, failed/blocked). The summary reports
the number loaded and highlights active or attention-requiring conversations.
These are navigation filters on authorized server data, not additional AI
agents, provider calls, or merged conversation memory. The current server
chat page remains capped at 100 conversations and visibly says so.

Project-scoped server conversation listings now apply the SQL limit
**after** selecting one latest visible row per conversation. Previously,
a 100-message chat could consume 100 run rows and hide every sibling chat
in that project. The corrected SQL preserves tenant/principal visibility,
project identity, earliest chat title, message count and latest progress.

Each Coding or Research chat now has a private **per-principal, per-workspace,
per-conversation in-tab draft**; unsent text is saved before switching, and
restored only for the selected chat. A new chat's draft is separated by
project and selected surface. A small bounded session storage pool keeps
recent drafts; sign-out and storage limitations remain local-device concerns.
Opening a chat restores its latest saved workspace mode and source binding.
Switching to a chat while other runs execute will not cancel background work,
and background run updates may refresh navigation but **cannot** write into an
unrelated blank conversation or replace the wrong foreground stop control.
The explicit All-projects filter is not silently replaced just because a
chat belongs to a particular project.

All context and project state remain scoped by existing server ownership,
authorization and project revision controls. Changing a UI filter never
moves files, grants access, or mixes Research evidence with another project's
Coding files.

When switching chats, locally selected but unsent File objects are cleared
from the composer rather than being silently carried into another project's
request. The user can explicitly reattach them. Pending offline messages
retain their own saved files and conversation target.

### Finding older chats and starting a domain-focused conversation

Workspace and status filters and chat-title searches now query authorized
server history BEFORE the last-100-chat page is selected. This allows an older
Research or Coding conversation to appear when 100 newer chats from other
domains exist. The query uses parameterized SQL, per-workspace and
per-principal visibility checks, latest state per conversation, a literal
case-insensitive substring match, and a fixed maximum of 100 returned
conversations. Unfiltered navigation retains its optimized recent-run path.
Search requests are lightly debounced, and stale network responses cannot
overwrite another workspace/filter selection.

Two small actions create a fresh **Coding chat** or **Research chat** using the
current selected project without borrowing any other chat's unsent draft,
file attachment, evidence or execution run. Changing a workspace or opening
another chat does not pause already-authorized background jobs. The project
selector remains a navigation filter, not a permission grant or an implicit
copying instruction.

The current conversation header also displays its actual Coding/Research
surface, visible Project Hub project name, and latest recorded server status.
Only authorized project metadata is labeled; missing project names are not
guessed. Browser-local search semantics match the server's literal chat-title
search, avoiding a misleading flash of project-name-only search results.

## Parallel project chats: safe follow-ups, draft retention and cheaper background refresh

Following up in an existing Coding or Research conversation now uses the
project ID and workspace surface recorded on **that conversation**, not
the left-rail's current project selection. The latest saved run is the
source of truth for follow-up workspace; switching chat filters or visiting
a different project does not silently move the chat, mix evidence, or
overwrite another project's source context. Brand-new conversations still
use the person's chosen project and surface.

Sending a new message creates the authorized run and releases the shared
composer once persistence succeeds. Its normal background server execution
is started and monitored independently, with run-ID locks and existing
approval gates intact, so the person can switch to another chat and create
new work without waiting for the first Coding/Research task to complete.
Offline-queued conversations also initiate their own run progression
without serially waiting through another chat's long execution.

The in-tab unsent draft of a **new** conversation is consumed only when
its first turn is submitted. Sending a follow-up in another established
chat no longer clears the separate new-chat draft. Per-person, per-workspace,
per-chat draft storage remains bounded and is cleared on sign-out.

All active background runs share a short coalescing window for chat-list
refreshes, rather than each run polling the expensive conversation-search
query on every single progress update. Explicit user Refresh and workspace
filter changes remain immediate. No extra model calls or independent agent
workers are required to operate this navigation layer.

## Independent chat submissions and retry continuity

A per-workspace **and** per-conversation in-flight submission set now replaces
the page-global message-upload lock. Starting, reopening, or switching between
Coding and Research chats updates only the visible composer. A previous chat's
late network completion cannot unlock or block the current one. Request
idempotency, persisted task status and policy checks remain server-owned.

Retry/regenerate requests are now also tied to the saved original conversation,
project ID (including explicitly unassigned projects), Code/Research surface and
source ID rather than ambient left-sidebar navigation filters. The creation is
scoped to the original workspace, and the long automatic run is driven without
holding the foreground browser composer hostage. These boundaries are covered
by regression tests, including switching chats during overlapping uploads.
