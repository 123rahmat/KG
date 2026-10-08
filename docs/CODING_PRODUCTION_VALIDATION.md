# KG Coding Production Verification

This document distinguishes **verified coding behavior** from **live autonomous-model readiness**.

## Verified regression scenario

Task: Fix the defect where a 10% merchandise discount also reduces a $10 shipping charge on a $100 shopping cart. Shipping must not be discounted.

- Input defect: `((subtotal + shipping) * (1 - discount))` gives **$99**.
- Correct result: `subtotal * (1 - discount) + shipping` gives **$100**.
- KG builds a limited code context containing the affected implementation and related tests.
- An exact content-hash and pre-image-digest protected surgical patch changes only the pricing implementation.
- Unrelated project files and the test suite remain unchanged.
- Real Node tests are run on the fixture before and after the patch.
- The baseline intentionally fails **1 of 3** tests; repaired code passes **3 of 3**.
- Stale workspace revisions are rejected rather than overwritten.

Execute in a full checkout:

```sh
npm ci
npm run smoke:coding
npm run verify
```

The smoke test uses a **fixed deterministic patch proposal**, not a Gemini call. It validates project context selection, patch materialization and real test execution. It does not by itself validate Gemini's independent ability to propose the patch or the remote sandbox/container service.

## Stabilized adaptive specialist policy

The agent policy preserves an explicitly requested bounded advisory panel and uses parallel lanes only for work that the scheduler has deemed conflict-free. Advanced high-risk software plans may recruit a larger **serial** advisory panel when available budget permits. Ordinary conversational tasks retain small panel ceilings. Resource exhaustion suppresses optional specialists.

## Production release gate

A release needs all mandatory GitHub CI and Verify jobs green, a complete dependency installation, successful database migrations and browser tests, authorization and tenant-isolation checks, a sandbox/container test, and real Vertex/Gemini provider tests. Measure cost per accepted result, p50/p95 latency, quality regressions and failure recovery against direct Gemini.

**Do not label KG 10/10 or production-ready solely on the fixed fixture.** A deterministic smoke scenario verifies a meaningful contract, but production confidence requires the complete integration and operational suite.
