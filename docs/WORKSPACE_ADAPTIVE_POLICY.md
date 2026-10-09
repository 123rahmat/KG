# Three adaptive workspaces: execution policy

KG uses **one shared adaptive intelligence, memory-scoping, governance,
checkpointing and verification kernel** with three distinct operating policies.

Normal Chat owns daily assistance **including complex reasoning when warranted**: educational explanations, math and science tutoring, business planning, scenario comparison, writing, file previews and small authorized sandbox work. Its task profile classifies the current purpose, reasoning depth and verification emphasis without dispatching agents or forcing a Code/Research transition. Current events and basic factual lookups remain everyday chat work. Code and Research use independently controlled specialist policies and scoped project/evidence state; they never silently inherit another workspace's edit permissions, state or execution authority.
These are *profiles*, not independent brains or mandatory agent teams.

| Surface | Fast path | When to specialize | Safe parallel work | Verification |
| --- | --- | --- | --- | --- |
| Normal Chat | Direct Gemini, selected files and conversation context | Never recruit main agents or subagents; increase primary reasoning effort and use permitted tools when useful | No advisory agent lanes | User intent, factual claims, file extraction and artifact integrity |
| Code | Single scoped editor for small changes | Repository architecture, debugging, testing, review, security, performance | Independently scoped analysis and disjoint file/revision lanes (up to policy/provider caps) | Exact revision, diff, targeted tests, execution receipts |
| Research | One scoped evidence investigation | Independent source comparison, disagreements, unanswered material questions | Independent evidence/source lanes with source deduplication and bounded search (up to policy/provider caps) | Claim-to-source provenance, contradictions, freshness, uncertainty |

## What gets better in this increment

The controller no longer infers that tasks are safely parallelizable just
because a Code or Research request is difficult. Difficulty, uncertainty and
verification need can justify **more expertise**; safe concurrent work is a
separate determination that requires a nonzero, task-supplied independence
signal. The work scheduler remains responsible for actual dependencies,
write-set conflicts, ownership, permissions and provider concurrency.

- Normal Chat has zero recruited agents at every optional budget level, including when
  settings request an always-on panel. It retains one primary reasoning model,
  on-demand file previews and policy-controlled tool calls.
- Below 25% remaining optional budget, Coding and Research recommend just one
  specialist model call at a time; required server verification still applies.
- A budget below 45% limits optional specialist breadth to two.
- High-impact and other designated high-risk work is serialized at the
  advisory compute-policy level as well as at authorization boundaries.
- Once the trusted acceptance contract is satisfied, the controller does not
  recommend hiring more specialists or expanding parallel work.
- An explicit `multiAgent=always` selection can request a bounded panel only
  in Coding and Research; it cannot override direct-chat isolation. Specialist
  allocation, provider limits, cancellation, approvals and lane conflict checks
  remain authoritative.

## Examples

**Normal Chat:** summarize or edit an authorized document; inspect an attached
image; preview PDF/image/HTML and text/table extracts where supported. Complex
reasoning raises primary-model effort or uses an authorized tool but never
recruits a critic or subagent. Office previews are extracted text and table
samples, not guaranteed pixel-perfect Word/PowerPoint/Excel rendering.
Static HTML previews do not execute scripts or fetch styles/assets.
Interactive applications require a separately isolated build/runtime preview.

**Code:** inspect backend and test ownership independently; use engineering
specialists for authentication, implementation and regression review; serialize
shared mutations, and run verification after relevant changes are applied.

**Research:** decompose a question into material evidence gaps; assign
independent source-discovery lanes when justified; reconcile overlapping
sources and contradictions before publishing a cited synthesis. Never invent
search success or pretend an advisory role has fetched a source.

**Mixed task:** Research can provide a source-backed dependency assessment to
a Code project, but project revisions, user approvals and source provenance
stay bound to their original workspace/project scopes.

## Tests and limits

Run `node --test tests/workspace-adaptive-compute.test.js
tests/mode-controllers.test.js tests/surface-policy.test.js
tests/agent-topology-policy.test.js` to validate workspace-specific policy.
The GitHub CI and Verify suites exercise the full application, including
different workspace conversations and the coding and research state stores.

This update improves policy correctness, not evidence that the deployed
Gemini service has generated excellent outputs. Full live comparisons,
multi-hour recovery, cost per accepted result, and real multimodal tools
are still separate release requirements.


## Task-aware workspace suggestions

A shared presentation policy in `public/normal-chat-capabilities.js` evaluates
the current request and selected attachments in every workspace. It offers a
clear banner and switch button for complex coding, research, or clearly
lightweight new work. File uploads are not required: a request such as building
a complete website can suggest Code, while researching a topic can suggest
Research. General follow-ups remain in the selected workspace.

Suggestions update during typing and file selection. Unchecked attachments
are excluded, and a new draft is not classified from an older run's files.
Clicking the button retains the draft, conversation and attachment selection;
it does not submit a request or import attachments into a Code project. Code
project tools still require the existing GitHub source boundary. These are
lightweight presentation hints, not guaranteed semantic classification or
permission grants; users can always choose another workspace manually.

The presentation policy and server `surface-policy.js` consume the same pure
request hints in `public/workspace-intent.js`. Teaching or explaining a subject
does not turn its software/research vocabulary into engineering or an
investigation. Explicit workspace intent takes precedence; a research request
about GitHub stays an investigation, while researching a dependency and then
updating its repository uses Code with supporting research capabilities.
The server still supports small file bundles in Chat even when the browser
offers an optional Code recommendation.

## Ongoing work and state ownership

Normal Chat's controller reads selected artifact names from the situation;
its purpose and verification policy adapt to files as well as task wording.
File contents remain in scoped artifact storage. Difficult reasoning can
increase depth without forcing a specialist workspace or adding permissions.

RunStore preserves conversation history across switches and independently
checks whether the prior controller/project state is compatible. Only that
compatible state may enter a follow-up plan, project identity, file overlay
or research ledger. An intent-driven transition rebuilds the plan without
implicitly inherited state before saving it. A new project likewise starts
with its own context. Explicit user context is retained and remains subject
to authorization; shared conversation history does not authorize a mutation.
