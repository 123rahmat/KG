# Hierarchical adaptive specialization

**One adaptive intelligence, three user-facing workspaces.** Normal Chat remains universal, direct-first, and able to handle several files with isolated sandbox execution when configured. Code and Research can recruit scoped two-level specialist teams when the current task needs genuine independent expertise. This is not a new orchestrator, tool runtime or permission authority.

## Code: project → subsystem → advisors

The existing `subsystem-orchestrator` partitions project work by actual repository paths and dependencies. The bounded `specialist-hierarchy` now recommends domain-matched reviewers inside each assigned subsystem: UI/UX, frontend, backend, authentication/security, database/storage, testing and infrastructure. The implementation and review roles are selected **within the existing specialist concurrency and token budget**. A one-agent task never creates additional calls solely to fill the hierarchy.

Subsystem-specific agent messages include an explicit, limited advisory remit (focus, owned paths and parent-run control). The run store still decides what executes; write-back still requires exact revisions and user authorization. No specialist can recursively spawn agents or claim edits or tests that the runtime has not recorded.

## Research: research question → evidence workstream → advisors

The Research panel can allocate literature review, methodology checks, quantitative analysis, citation audit and academic writing roles for relevant thesis/dissertation or source-heavy requests. Workstreams come from the requested topic, observed research gaps and actual source/evidence state, **not from fabricated studies or generic mandatory phases**.

Academic writing specialists are not proposed until source/evidence state actually exists. All agent outputs are advisory; citations are only verified when supported by retrieved and recorded provenance. Conflicting sources and missing methods remain explicit. A single simple research question still uses the direct or one-agent path.

## Normal Chat, multi-file work and sandbox

Normal Chat can handle up to ten selected attachments in one request under the current client limit. It retains conversation continuity, direct answers, file analysis, previews and bounded code execution through an **already-configured** sandbox. Sandbox status in the UI is informational; it does not grant tool authorization. Complex code/research can prompt an *optional* workspace switch without moving the chat or losing attached files.

## Situation-specific recruitment

Within each main agent, the family seed skills are augmented by task-specific requirements and observed gaps. No preset number of subagents is required. Independent model-powered children are still authorized and budgeted by the parent, while a simple request uses only the minimum justified expertise. More specialist families may advise the same task when their separate contributions are relevant.

## Operational invariants

- Hierarchy depth is capped at two advisory levels.
- The existing allocation, usage reservation and lane scheduler enforce concurrency and budgets. There is no recursive autonomous orchestration.
- Low remaining budget shrinks specialist breadth and preserves required verification.
- High-risk work has existing approval and serialization boundaries.
- Specialist findings from peers are untrusted data, not tool grants.
- The adaptive UI shows persisted specialist results, not planned agents disguised as live activity.

## Runtime continuity and failure handling

Material file edits retain the conversation ID, chat-local memory scope, user agent mode and cap, project name, and immutable source revision. Recreating a deleted file clears its overlay tombstone; later edits preserve that restored state. A material edit advances the work-context revision and still requires verification.

Missing, blank, invalid, or non-finite budget readings are unknown, rather than a measured zero. The shared budget interpretation applies through workflow, execution policy, workspace controller and specialist hierarchy boundaries. Known low budgets continue to narrow optional expertise, and user opt-out, provider limits and required verification remain authoritative.

The lane executor validates all job IDs and complete schedule coverage before invoking agents. On failure or cancellation it waits for already-started peers to settle so usage and evidence callbacks finish within the parent task lifecycle. It then fails the task and starts no later batch or wave. Provider timeouts and cooperative cancellation remain the caller's responsibility.

## Verification

`node --test tests/specialist-hierarchy.test.js tests/multi-agent.test.js tests/mode-controllers.test.js tests/normal-chat-capabilities.test.js`

These tests exercise the **decisions and contracts**, not actual live Gemini answers. Full production confidence still requires GitHub CI, live Vertex AI task trials, end-to-end sandbox checks, measured quality and cost per accepted result, and multi-hour failure/resume testing.
