# Kindgleam — adaptive specialist-family subagents

## Architecture

Kindgleam retains its existing one server-owned workflow, the three independent
Normal Chat / Coding / Research workspaces, its existing specialists, Gemini
model boundary, authorization checks, tool registry, task evidence and resource
budgets. There is **no second agent engine**.

The registered specialist families are **starting vocabularies**, not fixed subagent rosters. Each catalog family supplies eight reusable seed lenses, and every parent can also derive as many distinct situation-specific advisory lenses as are supported by the task's requirements, acceptance criteria, requested outputs and observed evidence gaps. The active count is **not fixed** at one, three, eight, or any other preset roster size. Most lenses share their parent's already-authorized model call, so additional expertise does not automatically create extra model cost.

**Implementation**:
- `src/adaptive-specialist-focus.js` — authoritative family/subskill catalog.
- `src/adaptive-family-subagents.js` — family objectives, domain
  checks, related-family consultation options, child selection and exceptional
  bounded read-only independent model checks.
- `src/multi-agent.js` — parent agent gets its currently selected family
  subskills; independent child calls are admitted based on task evidence, the trusted task compute allowance, provider concurrency, and the same usage reservations and audit callbacks as parent agents. No unbounded recursive recruitment occurs.
- `src/subsystem-orchestrator.js` and the existing code-specialist iteration
  continue to manage parallel Coding work: ownership, dependencies and patch
  integration remain with the parent. New family lenses do not mutate files.
- `public/agent-activity.js` and `public/adaptive-workspace.js` display
  actual recorded child findings indented below their parent, explicitly as
  advisory, without faking future or current activity.

## Example: UI and UX on real work

For a responsive application feature:
1. UI specialist identifies the exact relevant lenses (component contract,
   layout, responsiveness, state, design-system consistency, visual checks).
2. UX specialist may separately inspect journeys, accessibility, information
   architecture, onboarding and usability if the task warrants a second parent
   role. The UI subagent cannot silently replace the UX specialist.
3. Security, frontend integration, API, and accessibility may be consulted
   by the existing parent role selector **only if relevant**, within overall
   worker and model budgets.
4. Independent, read-only subagents can review evidence/checks concurrently
   when genuinely useful; they send *bounded, untrusted findings to the
   requesting parent*, not shared raw tool permissions.
5. Real application screenshots, builds, E2E tests and code edits still require
   actual approved executors and recorded receipts. A model's UI critique is
   not a visual-test pass. The parent owns verification and final integration.

The same pattern applies to every other specialist family:
- Security: threat-model/authentication/authorization/vulnerability review,
  with backend/API/DB peers when necessary, never broadening permissions.
- Databases: schema/migration/transaction/tenant isolation/query-performance,
  with real migration and data-integrity checks under the parent.
- Testing/debugging: select reproduction, contract test, regression and
  root-cause work after observed changes or failures, not in a fixed loop.
- Education/Normal Chat: focus level, examples and comprehension, and skip
  unneeded multi-agent work.
- Research: source discovery, study quality, methods, evidence cross-checking,
  synthesis and citations with provenance/uncertainty; never fabricate sources.
- New unfamiliar domains: an ephemeral role assignment may use these lenses
  while any genuinely new executable capability remains a governed candidate.

## Dynamic admission and communication

- **Simple task**: one lens inside the primary model call. No child calls.
- **Compound, unfamiliar, high-stakes or observed-failure task**: recruit the skills justified by current acceptance criteria, required capabilities and verified gaps. Skills may come from a seed family or a task-specific lens. Do not recruit a standard-size team to fill arbitrary slots.
- **Separate child model work**: only for independent read-only investigation or verification inside a justified specialist panel, with active `usageGate`, `dataAllowed`, `canSpend` and sufficient remaining budget. A trusted per-task child-call allowance, provider concurrency, and wave scheduling constrain actual invocations, not a preset subagent count.
- **Messages**: task scoped and untrusted. Child findings reach only their
  parent specialist before the parent model call. They do not create tools,
  permissions, real test passes, new workspaces or approved changes.
- **Iteration**: only when task observations warrant further work; do not
  precreate a fixed chain of research/plan/test/debug agents.
- **Saved specialists**: reusing a previous specialization is separately
  governed by `src/saved-specialist-recipes.js`; recipes are advisory,
  user/workspace scoped, opt-in and must still be verified on a new task.

## Production quality bar

- Run full unit/integration tests, PostgreSQL RLS verification, source checks
  and browser UI smoke tests on a real checkout.
- Compare against baseline for task success, extra calls, latency and cost.
- Simulate provider timeouts, partial child failures, cancellation, budget
  depletion and authorization denials.
- Verify no prompt injection from child messages, retrieved sources or saved
  expertise can turn advice into system instructions, evidence or permissions.
- Real E2E tests and authorized tools are required before labeling code/UI,
  research or live external work *verified*.
- A long catalog does not imply all internet situations are solved. General
  capability discovery, source retrieval and missing executors must report
  actual limitations.

This is a working source-level adaptive family architecture, not a 10/10
production-readiness certificate.
