# Controlled rollout checklist

The Coding/Research-only product boundary is staged, not live. CODING_RESEARCH_ONLY defaults to false for legacy compatibility. The flag can be enabled only after dedicated project-chat UI is migrated and tests pass.

Enabled behavior: new requests must use accessible Coding/Research projects, the stored project must match the inferred domain, ordinary out-of-scope requests do not trigger abuse strikes, previously authorized same-project chat may continue, and controlled runs retain their owning controller through executions.

Migrations 81–83 add a nullable historical-compatible run controller field, immutable run/project ownership, and an insert-time PostgreSQL trigger that locks and checks the active project and pinned revision. The shared RunStore, model gateway, agent worker pool, tools, budget and RLS are not duplicated.

Before production release:
1. Pass full CI, PostgreSQL/RLS/trigger tests, security scans and mobile UI tests.
2. Migrate new project/chat routing and preserve readable old user histories.
3. Confirm all agents, tools, queues and cancellations enforce the same stored run/project identity.
4. Demonstrate genuine coding tool/test receipts and complete sourced research paper/figure/export workflows.
5. Benchmark against Claude Code on matched source tasks for correctness, latency and cost per accepted task.
6. Validate backups, restore and staged canary rollback.

Rollback: set CODING_RESEARCH_ONLY=false and redeploy; retain all migrations, data and audit logs. Rollback must not use destructive schema drops. New schema may continue to protect any previously created controlled run.

Current verification: isolated logic checks only; latest full CI and live provider/sandbox tests remain unverified. This draft must not be marketed as production ready.

Additional controller-focused regression gates:
- `tests/control-engine-admission.test.js` validates early domain checks, trusted prior controller runs, stale revision and ownership mismatches without a provider call.
- `tests/control-engine-strict-integration.test.js` exercises authenticated project creation, domain scope denial, persistence, immutable run owner, changed repository revision, old chat history mixing, project archival and receipt/execute refusal under a real PostgreSQL server.
- Verify a shared project cannot cross tenant or principal authority and old unchecked runs remain read-only while strict mode is on. Database migrations 81–83 must apply and reapply without error.
- Flag rollback does not delete records, revoke history, or remove the migration triggers. Switching the flag off re-enables the historical product, so activate only on a carefully staged release after users are warned.
