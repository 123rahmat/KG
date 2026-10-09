# Kindgleam: unfamiliar/open-world situations on main

## Design goal

Serve the broadest practical range of legitimate user needs across Normal Chat, Coding and Research, including subject matter unknown when Kindgleam was shipped. This is **not** a claim to know or execute literally everything on the internet.

## Existing architecture preserved

- `src/core.js` / `src/adaptive.js`: open-world goal modeling and situation-dependent next work.
- `src/capabilities.js` / `src/capability-compiler.js`: requirements and execution feasibility.
- `src/capability-store.js`: discovered capabilities remain candidates; authorization and promotion are governed.
- `src/runs.js`: durable server-owned workflow, bounded state transitions.
- `src/multi-agent.js`: role selection, model allocation, bounded parallel waves and verification.
- `src/adaptive-specialist-focus.js`: existing 55 specialist families and 440 nested subskills as advisory descriptions, not 440 running agents.

## New open-world specialist bridge

`src/open-world-specialist-bridge.js` compiles a temporary specialist remit **only** when the server-owned situation marks unfamiliarity, investigation plus external evidence gaps, or when capability discovery yields candidates.

The existing model call receives a bounded `openWorldAssignment`. It includes the task and role, a small number of uncertain questions and candidate capability descriptions, what evidence records exist (but never assumes they are verified), and the appropriate next-action rule. The existing specialist is still advisory: it cannot spawn another worker, browse an unauthorized source, enable a proposed tool, change workspace, expand budget or bypass approval.

During investigative task types, `rolesFor` can prioritize a researcher for observed unknown situations, subject to the same model-call and budget caps. There is no separate orchestration layer, new database, model provider, or permanent role per niche subject.

`public/adaptive-workspace.js` shows discovered capability proposals as **not automatically enabled**. The UI does not claim the work was completed.

## Expected handling of a new domain

1. Understand the user's current goal and task context.
2. If known and sufficiently supported, solve directly without adding agent calls.
3. If unfamiliar, use the existing capability discovery workflow. A candidate is a proposal, not executable permission.
4. When an agent panel is justified, give a selected specialist the ephemeral brief and evidence gaps; request research and verification from the existing authorized workflow.
5. Do not assume web access, cite nonexistent sources, or claim a test, API call or external service happened without a real receipt.
6. If a needed integration is absent, provide the concrete missing prerequisite and route through the preexisting governance/implementation path.
7. Stop when the required outcomes are backed by evidence or when resources/permissions make the requested work infeasible.

## Validation and remaining work

New test files:
- `tests/open-world-specialist-bridge.test.js`: known vs unfamiliar, scoped prompts, candidate non-authorization, bounded data, targeted research priority.
- `tests/open-world-situation-matrix.test.js`: sample unfamiliar tasks across all workspaces.

Local smoke checks verified source syntax, temporary task focus, candidate non-authorization and research priority. **These checks are not substitutes for full repository CI, real Vertex model runs, tool integration tests, browser QA or adversarial multi-tenant testing**.

Required production evaluations:
- Precision/recall of routing on diverse unseen tasks and languages.
- Quality, time-to-result and cost vs the previous `main` model path; abort if specialists add cost without gains.
- Live source retrieval, freshness/citation verification and unavailable-tool fallback.
- User-to-tool, agent-to-tool and cross-tenant authorization isolation.
- Prompt injection in discovered capability names, source pages and agent findings.
- Timeout, retry, cancellation, budget depletion and human approval workflows.
- File and artifact interoperability across new formats through safe adapters.

**Invariant:** open-world *task space*, bounded and governed *execution space*.
