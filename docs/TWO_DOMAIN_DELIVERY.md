# One runtime, two specialist domains: Code and Research

Kindgleam has a **single** server-owned RunStore, approval gate, Gemini/Vertex
inference boundary, usage accounting and task verification contract. Code and
Research are the two agentic domains built on top of that runtime. Normal Chat
remains a direct non-agent conversational entry point for compatibility and
ordinary requests; it is not a third specialist-agent engine.

## Adaptive dispatch, not an agent army

Code recruits engineering specialists (architecture, implementation, test,
debugging, security, performance) only for independent tasks with material
value. Its context is revision-first; workspace changes and terminal work must
go through existing owner/permission controls. Research recruits investigators,
analysts and critics only where conflicting sources, uncertainty or workload
justify them. Its context and delivery are anchored to evidence provenance,
open questions and citations. Independent specialist lanes may execute in
parallel under the existing conflict, budget and task ownership rules.
Neither specialists nor the browser own completion decisions.

One Gemini/Vertex boundary routes efficient and stronger calls by actual task
requirements. Reducing optional model calls, reusing scoped context, and
stopping at acceptance are preferred to fixed multi-agent chains. Lightweight
low-effort coordination may use Flash-Lite; complex or uncertain engineering,
source critique, verification and recovery remain on the stronger model.
Explicitly resolved research questions or conflicts are removed from the
bounded evidence ledger without discarding unresolved historical gaps. The
configured Gemini model IDs must be authorized in the deployment's Vertex
project; model catalog entries alone do not prove API access.

## Presenting what actually happened

Both agentic workspaces show an overview report and a compact receipt beside
the final chat answer **after a run reaches a terminal state**. It distinguishes saved completed/failed steps, authenticated
execution receipts, passing verification records, applied changed-path metadata
and tracked research sources, evidence, open questions and conflicts. A proposed
test is never labeled as successfully executed. The persisted task timeline and
specialist activity remain available during the run. Images, tables and files
are presented through the existing scoped artifact preview path; no new
parallel artifact storage system is introduced.

### User-approved UI screenshots

In Code or Research, click **Screenshot UI**. Over HTTPS/localhost on a
compatible browser, choose the browser tab to capture in the operating
system's screen-sharing prompt. Kindgleam takes **one frame**, stops all
tracks immediately and attaches the PNG to the current message draft.
It is not uploaded or shared until the person sends the message. This can
capture a running UI **when that UI is actually visible in the selected tab**.

This is not a headless build-and-browse service. A backend preview of arbitrary
code still requires configured sandbox execution and an isolated browser;
screenshot success must never be claimed without a real browser capture.
The existing Playwright UI regression command produces on-disk screenshots
for CI/testing; those fixtures are not user code previews.

## Operational proof still required

Run `npm run check`, `npm run lint`, `npm test`, `npm run test:ui`,
credentialed `npm run smoke:providers`, and full sandbox/build deployment tests.
Passing mocked tests cannot establish live Vertex calls, correct code execution
for every language, production isolation, or arbitrary project screenshot
support. Update this document only as capabilities are verified.
