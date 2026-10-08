# Three adaptive workspaces: execution policy

KG uses **one shared adaptive intelligence, memory-scoping, governance,
checkpointing and verification kernel** with three distinct operating policies.
These are *profiles*, not independent brains or mandatory agent teams.

| Surface | Fast path | When to specialize | Safe parallel work | Verification |
| --- | --- | --- | --- | --- |
| Normal Chat | Direct Gemini, relevant chat/artifact context | Material uncertainty, complex file/visual task, or verified quality need | Optional independent read-only investigation (max 2 advisory lanes) | User intent, factual claims and relevant artifacts |
| Code | Single scoped editor for small changes | Repository architecture, debugging, testing, review, security, performance | Independently scoped analysis and disjoint file/revision lanes (up to policy/provider caps) | Exact revision, diff, targeted tests, execution receipts |
| Research | One scoped evidence investigation | Independent source comparison, disagreements, unanswered material questions | Independent evidence/source lanes with source deduplication and bounded search (up to policy/provider caps) | Claim-to-source provenance, contradictions, freshness, uncertainty |

## What gets better in this increment

The controller no longer infers that tasks are safely parallelizable just
because a Code or Research request is difficult. Difficulty, uncertainty and
verification need can justify **more expertise**; safe concurrent work is a
separate determination that requires a nonzero, task-supplied independence
signal. The work scheduler remains responsible for actual dependencies,
write-set conflicts, ownership, permissions and provider concurrency.

- Under 25% remaining optional budget, every workspace recommends just one
  model/agent at a time; the required server verification floor remains.
- A budget below 45% limits optional specialist breadth to two.
- High-impact and other designated high-risk work is serialized at the
  advisory compute-policy level as well as at authorization boundaries.
- Once the trusted acceptance contract is satisfied, the controller does not
  recommend hiring more specialists or expanding parallel work.
- An explicit `multiAgent=always` selection can still request a bounded panel;
  specialist allocation, provider limits, cancellation and server authorization
  stay authoritative, and the parallel scheduler still rejects conflicts.

## Examples

**Normal Chat:** summarize one document directly; read an attached image with
existing tools; only recruit a critic when a complex/high-stakes answer needs
additional checking. Do not force a move into Code/Research for simple work.

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
