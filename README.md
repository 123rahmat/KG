# KG Code — AI software engineering workspace

**Product direction:** KG is becoming **KG Code**, a professional, coding-focused AI engineering environment. It uses one server-owned runtime for repository context, focused patches, controlled execution, test evidence, review, and optional specialists only when they justify their cost. The core goal is reliable, reviewable software development, not a collection of unrelated assistant modes.

> **Release status:** The `main` source now defaults to the KG Code admission gate (`KG_CODING_ONLY=true`), with server-owned project scoping and coding-focused UI. Complete CI, migrations, browser, live runner and provider acceptance **are still required**; a source commit is not proof of production readiness. Set `KG_CODING_ONLY=false` only for an emergency rollback. Legacy data and research-related compatibility modules remain readable, but new work is code-only when the gate is enabled.

## Product boundaries

- **One application and runtime:** project-scoped coding tasks and a server-authorized CodingControlEngine; do not deploy a second agent runtime or clone the budget, policy, database or tool systems.
- **Adaptive, cost-aware execution:** understand, inspect the smallest relevant project context, decide whether to plan, patch in scope, run actual checks, inspect failures, apply bounded repairs, review the diff, then deliver with evidence. Optional specialists are advisory and parallel only when independent.
- **Developer workspace:** project and repository selection, chat, progress, changes, tests, terminal, activity, and top-of-conversation **Chat | Files**. Conversation Files are user uploads and generated artifacts; they are **not** limited to GitHub repository files.
- **Trustworthy status:** recorded steps are not a guaranteed percent of a growing task. A model saying "tests passed" never replaces an authenticated test receipt. Unavailable sandbox/provider actions must be reported as unavailable.
- **Migration:** preserve legacy projects, conversation attachments, saved artifacts, historical data, and existing database migrations; disable old entry points only after verified data access and export.

Coding-focused UI, admission, project controls, and conversation-scoped Files are integrated into `main`. The original [development PR #15](https://github.com/123rahmat/KG/pull/15) is retained as a design and implementation history reference. Keep a verified data backup and pass the release gates before production deployment.

## Architecture

```text
Project + repository + conversation
       |
Server authentication / workspace, project & revision authority
       |
CodingControlEngine (same shared RunStore / model and tool gateway)
       |
Adaptive task graph -> scoped context -> approved patch
       |
Isolated runner / real checks -> bounded repair -> recorded verification
       |
Developer review + approved write-back / deliverable
```

No generated task may elevate tool or repository permissions. Concurrent code writers must have compatible revisions and nonoverlapping resources. The server owns credentials, budgets, resource locks, evidence, and durable run state.

## Coding-only configuration and test gates

`KG_CODING_ONLY=true` is the default when running the current source. Authenticated new work must use an active Code project and the CodingControlEngine; ordinary chat and research requests cannot start new coding-only work. The separate historical `CODING_RESEARCH_ONLY` switch is not needed for this product.

The top-of-chat **Chat | Files** switch is scoped to each conversation. Files can be uploaded from the device and generated or saved as chat artifacts; it is not just the GitHub source tree. Older chats, research records, and existing storage/migrations are retained for reading/export.

For verification, use `npm run test:code:hardening`, `npm run test:code:integration` (PostgreSQL), `npm run test:ui` (browser), `npm run verify`, and configured runner/provider smoke tests. Never claim a task is verified from a proposed test or model narrative. See `docs/architecture/KG_CODE_MATURITY_AND_ADVERSARIAL_GATES_2026-10-10.md`.

## Local development

Use Node.js 22 or newer, npm, PostgreSQL and a C++ build toolchain if your platform needs to build `node-pty`. Docker Compose can provide the development database. Configuration is validated from process environment; the application does not automatically load `.env`.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env`, choose a development database password and set `DATABASE_URL`. For the supplied Compose database, use user/database `kindgleam`, the selected password, host `127.0.0.1` and port `5432`. In development, leave `DATABASE_MIGRATION_URL` empty to use that same database identity.
3. Start the database with `docker compose up -d db`, or provide your own PostgreSQL server.
4. Configure `GOOGLE_CLOUD_PROJECT` and an explicit temporary `VERTEX_ACCESS_TOKEN` for local development. The runtime uses that token or the Google metadata server in a supported hosted environment; it does not load local ADC credential files. Keep model selection within the server's approved Gemini catalog.
5. Migrate, create the first workspace/account and start the application:

```bash
node --env-file=.env bin/admin.js migrate
node --env-file=.env bin/admin.js bootstrap --workspace personal --name "Administrator"
node --env-file=.env server.js
```

Open `http://localhost:3000`. Bootstrap displays the initial API key once; store it privately. See [.env.example](.env.example) for available settings and [production readiness](docs/PRODUCTION_READINESS.md) for the production deployment sequence. The supplied Compose app configuration is a development baseline; it does not forward every optional model/runner setting.

Tool routing, sandbox execution and interactive terminal support have separate configuration and isolation requirements. Without configured execution infrastructure, the application reports unavailable execution rather than claiming work ran. See [sandbox and tools](docs/SANDBOX_AND_TOOL_FORGE.md).

## Verification

```bash
npm run check
npm run lint
npm run doctor
npm run eval:skills
npm run eval:adaptive-matrix
npm test
```

`npm run verify` runs source checks, doctor, skill evaluation, lint and the complete test suite. Database-backed tests need `TEST_DATABASE_URL` pointing at a PostgreSQL identity that can create/drop isolated test databases. GitHub Actions provides this environment; keep it separate from production data.

| Check | Evidence it provides |
| --- | --- |
| Unit tests and adaptive matrix | Control decisions, scope, budgets, graph consistency, concurrency and recovery behavior |
| PostgreSQL integration tests | Persisted transitions, leases, tenant boundaries, migrations and real application integration |
| `npm run test:ui` | Browser interactions in a configured application |
| `npm run smoke:providers` and `npm run eval:live` | Credentialed provider behavior and evaluated live outputs |
| Container and operational checks | Deployment configuration, boot, shutdown and backup/restore behavior |

## Documentation

- [Architecture and application services](docs/ARCHITECTURE.md)
- [Simple adaptive workflow and one privacy/policy gate](docs/SIMPLE_ADAPTIVE_POLICY.md)
- [User-isolated agent resources and governed specialist tools](docs/AGENT_RESOURCE_ISOLATION.md)
- [Three-workspace adaptive policy](docs/WORKSPACE_ADAPTIVE_POLICY.md)
- [Specialist dispatch and boundaries](docs/UNIFIED_ADAPTIVE_AGENTIC_ARCHITECTURE.md)
- [Runtime state, cancellation and recovery](docs/UNIFIED_ADAPTIVE_RUNTIME.md)
- [Open-world graph implementation and limits](docs/OPEN_WORLD_ADAPTIVE_ARCHITECTURE.md)
- [Hierarchical specialist scope](docs/HIERARCHICAL_ADAPTIVE_SPECIALISTS.md)
- [Coding production validation](docs/CODING_PRODUCTION_VALIDATION.md)
- [Live evaluation](docs/LIVE_EVALUATION.md)
- [Production readiness](docs/PRODUCTION_READINESS.md)

The current architecture removes the unused phase-advancement controller, duplicate generic agent executor and unused recovery/harness facades. Existing task data, migrations and active API contracts remain supported. Live quality/cost calibration and distributed endurance testing remain deployment work; the repository does not claim a universally best or 10/10 system.
