# Kindgleam — reliable adaptive specialists, skills and learning

## Decision: situational behavior memory AND a verified library

Do not choose one instead of the other. They solve different problems:

- **Task/session behavioral context** decides how to work *right now*: current goal, constraints, available evidence, user preferences, task phase, uncertainty, cost, agent handoffs. This is not a durable agent definition and is limited to authorized context.
- **Agent Skills** (`src/skills.js`) hold reusable vetted operating procedures; selection is task-aware and skill outcome profiles already adjust ranking. A skill grants no permission.
- **Open-world specialist briefs** (`src/open-world-specialist-bridge.js`) supply temporary narrowly scoped expertise for unforeseen topics without creating permanent models or executing new tools.
- **Reusable specialist recipes** (`src/saved-specialist-recipes.js`) persist a small, generalized, non-executable summary of successful capability discovery. These are *hints* for subsequent tasks, not trusted instructions, proof, or code.
- **Capability registry** (`src/capability-store.js`) separately governs actual new executors/integrations. Candidate capabilities are NOT active tools.

These must stay separate. In particular, never "learn" by blindly appending model-generated instructions to a system prompt, and never treat an old verified answer as a verified answer to a new question.

## Existing authority retained

One parent `RunStore` controls workflow state and evidence. Only existing model/tool adapters execute. Existing `multi-agent.js` decides if, when and which specialist roles should run; existing lane planner bounds parallelism and file ownership. Subskills and saved recipes narrow advisory context only. No nested worker may independently grant itself a model, capability, connection, database right, or extra tokens.

Normal Chat remains the broad everyday-assistance entry point (including novel topics); Coding and Research retain their own deeper role hierarchies and mode-specific UI.

## Implemented learning lifecycle

1. **Discover** a genuinely missing capability while working on a user's task. The parent may compile a temporary task-specialist assignment. Unfamiliarity by itself is NOT authority to call external tools.
2. **Attempt the task** through already authorized models and tools, collaborating on dependency-safe waves where worthwhile.
3. **Verify** against existing acceptance criteria. An agent's recommendation or confident claim does not count.
4. **Save observed**: only after a server-recorded passing verification, in a per-person/per-workspace table, and only when the user has enabled cross-chat memory. Do not persist raw prompt text, sources, files, secrets, or previous outputs.
5. **Promote to reusable** after two *distinct* passing verification runs for the same normalized capability identity, subject to negative-outcome balance.
6. **Retrieve a few** relevant, still-fresh, reusable recipes for a similar future request, both in direct chat and justified specialist panels. Matching never increases the number of workers.
7. **Reverify every task**: old evidence is a routing hint, not current-task proof. Verified future work renews the recipe; stale recipes expire from retrieval after 120 days without qualifying success.
8. **Downgrade** after two distinct server-recorded failing verifications where prior model-work records actually show that recipe was supplied. Failure is an association, not proof the recipe caused failure; demotion is conservative. A user may explicitly forget any record.
9. **Keep privacy controls**: opt-in to cross-chat reuse via `crossChatMemory`; rows are RLS-separated by workspace AND principal. Turning off memory prevents retrieval/storage of these cross-chat recipes; it does not erase existing rows. The personalization panel offers individual deletion.

The persisted data contains IDs, generic vocabulary terms, counts/IDs of outcomes and expiration metadata, not independently executable agent instructions. Version 1 recipes are informational only. Promotion does NOT approve untrusted integrations.

## Key implementation components

- DB migrations 78/79 with forced RLS, explicit runtime table grants and bounds.
- `src/saved-specialist-recipes.js` opt-in, normalization, matching, observation, negative outcome and forgetting.
- `src/routes/execution.js` one cheap library lookup per eligible model task; same bounded context reaches direct model and optional panel. Records which recipes were *provided* in the server-owned task result, and updates quality only at verification.
- `src/multi-agent.js` receives up to three recipes marked untrusted and advisory. Existing subagent selection, budgets, messages, and permission policies remain unchanged.
- `public/index.html` and `public/app-settings-window.js` expose the person's scoped saved specialist list and deletion in Personalization.
- Existing skill-learning and capability stores remain the authoritative separate systems for procedures and executable capabilities.

## Context packing / protocol boundary

Specialist contexts should contain only the current assignment, compact relevant memory, a small number of vetted skills/recipe hints, authorized tool availability, and actual evidence. Peer findings are untrusted task-scoped messages, never tool permissions. This avoids blindly replaying entire old conversations and reduces tokens. A2A/MCP-style integrations, if later supported, must use explicit schema, issuer, tenant, identity, capability scopes, provenance and validation at the parent gate; having a protocol message is not evidence it should be executed.

## What must be measured before release

- Pass full `npm run check`, `npm run lint`, `npm test`, `npm run verify` on a real checkout with PostgreSQL migration/forced-RLS tests.
- Verify opt-in off, opt-in on, principal isolation, workspace isolation, switching workspaces, deletion, and retention.
- Exercise unknown tasks in languages and domains absent from the bootstrap taxonomy.
- Benchmark direct-chat quality and latency with zero, one and several learned recipes; compare against baseline. Discard recipes that raise hallucinations, model cost, bias or latency.
- Test model-supplied malicious capability names, prompt-injection payloads, impersonated run IDs, duplicate success/failure receipts, stale evidence, expired records, cancellation and provider outages.
- Require safe human approval for actual new tools. Never "learn" a runnable tool from a document without an explicit build/review/approval process.
- Validate with a browser UI smoke test and accessibility checks (the added settings panel must not rely on CSS-only status).
- Add operator dashboards for specialist selection hit rate, outcome lift, bad reuse, cache age, cost per solved task, forced review ratio and withdrawal rate.

**Current delivery is a source-level integration, not a proof of general intelligence or production readiness.** The next step is full CI/DB/browser and live Vertex evaluation, then a gradual feature-flag rollout with rollback.
