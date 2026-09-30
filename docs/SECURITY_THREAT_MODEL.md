# Kindgleam security threat model

This document records the security boundaries that must remain true for production.

## 1. Tenant and identity attacks

Attack paths:
- Guess or alter workspace, organization, owner or principal identifiers.
- Reuse an object, run, conversation or idempotency identifier from another workspace.
- Reuse a stolen, revoked or expired API key/session.
- Race two requests during login, object creation, billing or workflow execution.

Controls:
- Resource scope comes from authenticated identity plus server-side membership lookup.
- PostgreSQL RLS is forced on tenant tables and transaction-local scope is applied on every scoped connection.
- API-key secrets and browser-session secrets are stored only as hashes.
- Sign-in links/codes are one-time, time-bounded and guess-limited.
- Quota mutations and billing state changes are transactional/locked.
- Idempotency reservations are bound to the authenticated principal and selected workspace.

## 2. Cryptographic and data-at-rest attacks

Attack paths:
- Database snapshots or SQL reads expose private user content.
- Billing data is copied from a dump and reused.
- Encryption key changes cause silent data loss.
- Ciphertext is tampered with or decrypted under the wrong purpose.

Controls:
- Object blobs use AES-256-GCM with workspace-derived keys.
- Workspace billing metadata uses a separate AES-256-GCM key.
- Individual memory and private feedback use a separate AES-256-GCM key.
- Production requires the three encryption domains to use distinct keys.
- Sensitive ciphertext uses authenticated integrity and purpose-specific key derivation.
- Previous-key windows support controlled rotation.
- Rotation/backfill fails closed when authenticated ciphertext cannot be decrypted; it never replaces unknown data with blanks.
- Payment-card numbers, CVC/CVV and payment-method secrets are not stored by Kindgleam; payment-method management remains on Stripe.

## 3. Payment integrity attacks

Attack paths:
- Forged webhook activates a subscription.
- Replayed webhook runs a state transition twice.
- An old webhook arrives after a newer state and rolls the subscription backward.
- A second Stripe customer takes over an existing workspace.
- A browser return from Checkout is treated as proof of payment.

Controls:
- Webhooks require Stripe HMAC signatures and a five-minute timestamp window.
- Stripe events are deduplicated by event id.
- Workspace/customer mismatch is rejected.
- Subscription state comes from Stripe subscription data, not the browser.
- Checkout completion alone does not activate paid access.
- Older subscription events are rejected using the encrypted billing event timestamp.
- Billing writes are restricted at PostgreSQL RLS to workspace administrators or the dedicated signed-webhook context.

## 4. Execution and supply-chain attacks

Attack paths:
- Generated code escapes the host.
- A compromised tool runner authenticates to the sandbox runner.
- A mutable container tag changes underneath a production deployment.
- A package-install phase reaches an unexpected network.
- Runner traffic exposes a bearer token over plaintext HTTP.

Controls:
- Code executes outside the web process in sealed containers.
- Production sandbox startup requires an isolated OCI runtime such as runsc or kata-runtime.
- Production sandbox startup requires pinned SHA-256 image digests.
- Production disables on-demand image pulling.
- Production requires an HTTPS install proxy for package egress control.
- Production managed runners require TLS.
- Sandbox and tool runners use separate production bearer tokens.
- The run phase uses no network, a read-only base filesystem, dropped capabilities, no-new-privileges, PID/memory/CPU/file-size limits and an unprivileged uid.
- Execution receipts/challenges are bound to run, task, attempt, target, expiry, nonce and payload digest.

## 5. SSRF and untrusted-content attacks

Attack paths:
- Fetch loopback/private IPs or cloud metadata.
- DNS rebinding after a public hostname is checked.
- Redirect into a private address.
- Upload hostile PDF/Office/ZIP content to exhaust memory/CPU.
- Put active content on the application's origin.

Controls:
- Web fetch resolves all addresses and rejects non-public ranges.
- Checked addresses are pinned for the connection.
- Every redirect is re-validated.
- URL credentials and non-HTTP(S) schemes are rejected.
- API request compression is disabled to prevent inflate-before-limit abuse.
- Document parsing is isolated and bounded.
- PDF page count/image size, ZIP entries/expanded size and spreadsheet rows are capped.
- Downloaded stored objects are forced to attachment/octet-stream with nosniff.

## 6. Browser attacks

Attack paths:
- CSRF with cookie authentication.
- Clickjacking.
- Cross-origin script injection.
- Cache poisoning of private API responses.
- Prototype pollution through JSON bodies.

Controls:
- Session cookie is HttpOnly, Secure in production, SameSite=Strict and Host-prefixed over HTTPS.
- Cookie-authenticated writes require a same-origin client header.
- Strict CSP uses self-only scripts/styles and no framing.
- API responses are Cache-Control: no-store.
- JSON parsing drops __proto__, constructor and prototype.
- HSTS is enabled in production.

## 7. Abuse, race and time-based attacks

Attack paths:
- Brute-force sign-in codes.
- Flood email sign-in requests.
- Retry the same POST after a timeout and create duplicate work.
- Repeated workflow iterations exhaust compute.
- Competing writes race quotas or scheduling state.

Controls:
- Sign-in code attempts and per-IP/email request rates are bounded.
- Production rate limits use PostgreSQL, not per-instance memory.
- Workspace-bound idempotency leases recover abandoned requests without double execution.
- Workflow iteration count is bounded.
- Database transactions and advisory/row locks serialize quota-sensitive operations.

## 8. Recovery and audit

Production must also prove:
- encrypted backups succeed on a schedule;
- restores are tested against an isolated environment;
- runtime, migration, backup and restore PostgreSQL identities are separate;
- audit records remain append-only;
- monitoring alerts on database, rate-limit, model, runner and readiness failures;
- secret rotation is documented and reversible within the previous-key window.

## 9. Release invariant

A build is not considered production-ready solely because application tests pass. The deployed environment must also satisfy the production configuration checks for TLS, database identity separation, RLS, encryption keys, runner isolation, backups and external service credentials.

The controls above are defense in depth. No single control is treated as a complete security boundary.