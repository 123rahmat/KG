# Skill intelligence system

Kindgleam skills are reusable procedures inside the single adaptive workflow. A skill is not
a permission, model, tool, or independent agent.

## Contract
Skills expose prerequisites, procedure phases, evidence requirements and bounded cost. The
compiler resolves prerequisites and orders the resulting bundle before the planner executes it.

## Learning
Learning combines contextual and general history conservatively, with recency decay and a
separate usefulness signal. Low-evidence observations are deliberately damped.

## Patterns
Verified outcomes create compact contextual patterns and deterministic failure classes. Failure
classes are bounded categories and do not require retaining raw private failure text.

## Evaluation
The deterministic registry gate is `npm run eval:skills`; `npm run verify` runs it before lint
and tests so malformed skill definitions fail early.

## Authority
Skill learning can change procedure selection, ordering, effort and evidence collection only.
It cannot grant permissions, bypass governance, weaken safety, or mark execution complete.