# Tool convergence implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, followed by one independent code review.

**Goal:** Reduce wasteful tool iterations while preserving task constraints and live cancellation.

**Architecture:** Extend `answerWithTools` in place; retain existing server authority, provider governor, accounting and verification. No new dependencies, branch or worktree.

**Tech Stack:** Node.js ES modules, node:test, existing scripted Gemini fixtures.

**Spec:** `docs/AGENT_WORKFLOW_RESEARCH.md`

## Global constraints

- Work directly on `main`.
- Add no mandatory model calls or dependencies.
- Preserve existing authorization, scope, sources and token accounting.
- Cancellation throws before further provider/tool work.

## Review focus

- Distinct action inputs remain independently proposed.
- Changing errors and successful live reads remain eligible for more work.
- Object key order is immaterial; array order remains material.
- Oversized retained instructions fail as incomplete, without silent loss.
- Cancellation from either context or explicit options reaches final synthesis.

### Task 1: Convergence and trajectory controls

**Files:** Modify `src/toolbox.js`; test `tests/toolbox.test.js`.

**Interfaces:** `answerWithTools(messages, ctx, options)` returns the existing answer plus `toolLoop: { stopReason, modelCalls, toolCalls, avoidedToolCalls }`.

- [ ] Write tests for duplicate proposals with reordered keys, distinct inputs, repeated unchanged failures, changed failures, and successful live reads.
- [ ] Run `node --test tests/toolbox.test.js` and observe the new failures.
- [ ] Add invocation-local proposal identities and consecutive failure comparison; route convergence to existing final synthesis; count calls and termination reasons.
- [ ] Run the toolbox suite and inspect request counts and usage assertions.

### Task 2: Synthesis contract and cancellation

**Files:** Modify `src/toolbox.js`; test `tests/toolbox.test.js`.

**Interfaces:** Preserve a bounded task contract independently of tool evidence; use `options.signal ?? ctx.signal` for every call.

- [ ] Write tests for retained constraints/criteria/verification, oversized instructions, task output format, pre-cancelled context, and cancellation before synthesis.
- [ ] Run tests and observe the new failures.
- [ ] Preserve the selected task contract within 12,000 characters; return `synthesis-context-over-budget` if it cannot fit. Keep evidence within its existing independent limit.
- [ ] Run toolbox and relevant runtime/grounding/safety suites, then lint/source/doctor/skill evaluation and full tests.
- [ ] Request independent review; address material findings with regression tests.
- [ ] Publish verified content to `main` with compare-and-swap and check all CI workflows.
