# KG vNext vs. Claude Code — Product and Engineering Gap Analysis

**As assessed:** 10 October 2026.
**Baseline:** Claude Code capabilities publicly documented by Anthropic, not a head-to-head experimental test. KG status is based on the current draft feature branch and must not be mistaken for deployed features.

## Correct comparison

Claude Code is a mature agentic **coding product** used in terminals, IDEs and remote/web development. KG's intended product is **Coding + scholarly Research**, with independent CodingControlEngine and ResearchControlEngine decisions, separate project work chats, and **one shared runtime**. Research is a proposed distinctive end-to-end academic workflow, **not proof KG currently outperforms Claude Code at research**.

| Criterion | Claude Code (documented) | KG vNext branch (observed/target) | Verdict today |
| --- | --- | --- | --- |
| Codebase understanding, file editing, terminal and test execution | Reads whole repositories, edits, executes tools/commands, creates commits/PRs; terminal/IDE/web interfaces | Existing shared RunStore, bounded sandbox and workspace mechanisms; new controller policy and project/route gates under flag | **Claude Code stronger on demonstrated production coding product** |
| Dynamic large-scale agentic work | Generally available adaptive workflows; tens-to-hundreds of parallel specialists with verification, persistence and resume | Advisor stages, bounded DAG and optional specialists; full enforcement, durable agent messaging, fairness and recovery not yet proven in new architecture | **Claude Code stronger; avoid copying agent count without evidence** |
| Multiple sessions and background supervision | Agent view offers background sessions and status/interaction; research-preview availability depends on plan | KG UI displays saved run activity and proposed domain controls; new strict execution-owner gates are incomplete | **Claude Code stronger currently** |
| Deterministic safeguards and local customizations | CLAUDE.md, skills, rules, hooks, subagents, permission controls and review integration | KG auth/RLS, policy checks and shared tools exist, but domain admission is staged and every tool/queue boundary must be audited | **Different models; KG still needs end-to-end controller enforcement** |
| Multiagent PR security review | Specialized PR review is a research preview for Team/Enterprise, with inline verified findings and usage-based cost | Coding review/test agent recommendations; real PR review evaluation and correctness metrics pending | **Claude Code offers stronger documented review product** |
| Mathematical research, paper/thesis provenance | General-purpose research/analysis is possible with coding/tools; no claim of dedicated complete manuscript-evidence contract | Dedicated ResearchControlEngine planned with source/claim/version ledger, methods, statistics, figures, thesis/manuscript acceptance and export | **Potential KG differentiation; not yet shipped** |
| Cost effectiveness | Dynamic workflows can consume substantially more tokens than conventional sessions | Explicit economy policy, zero optional agents for trivial tasks, shared budgets and inexpensive-first model routing; no actual cost benchmark | **Not comparable without real equal-task spend and quality data** |
| User experience | Terminal, VS Code, JetBrains, web and mobile-connected sessions | KG web/mobile browser project chats; full dedicated two-surface UI still in migration | **Claude Code broader developer integrations** |
| Verified production readiness | Publicly shipped product with documented capabilities and controls | Branch-only draft PR; strict scope gated by CODING_RESEARCH_ONLY; migration 81/82, new tests and limited isolated mock verification, full CI + live runner not yet confirmed | **KG not production ready** |

## Lessons worth implementing — without duplicating whole systems

1. **Worktree/revision isolation and real tool receipts before model claims.** Keep the tested KG worker+RunStore, but enforce exact input revision, disjoint writers, approval, and idempotent recovery at every transition.
2. **Programmable dynamic workflows over a fixed agent army.** Use evidence-driven graph admission, scoped specialist invocations, independent critics and finite repair loops, with deterministic server-owned controls. Default to a single pass for small tasks.
3. **Code review as separate evidence.** Let read-only reviewers inspect a real diff with tests, and prevent self-certification or reviewer overwrite of a failing test.
4. **Transparent live supervision.** Surface session/run progress, approvals, per-agent spend, source/citation freshness and cancellation in two domain project chats, without exposing unverified "completed" work.
5. **Research as the specific advantage.** Build first-class DOI/claim provenance, statistics, reproducible figures, manuscript section coverage and inspectable PDF/DOCX exports; avoid treating a very long AI response as a completed thesis.
6. **Production gates trump feature counts.** Deliver runnable coding and source-grounded research vertical slices, RLS/tenant isolation, honest failed-run diagnostics and repeatable benchmark receipts before calling the product ready.

## Objective head-to-head evaluation

Use the same public repository snapshots, instructions, allowable tools, environmental limits and published source datasets (respect each product's feature and account permissions). Treat any externally advertised model choice or unenabled workflow as a separate configuration. Never claim "cheaper/better/faster" from model self-assessments.

**Coding suite (12 cases):** small explanation; one-file fix; multi-file feature; failing integration test; codebase unfamiliarity; auth vulnerability; SQL migration; UI regression; versioned PR review; overlapping parallel edits; cancelled worker; missing sandbox/expired permission.

**Research suite (12 cases):** inspected paper summary; literature contrast; systematic search reproducibility; qualitative analysis; math excluded roots; statistical confidence intervals; reproducible chart; 40+ source continuity; DOI fabrication resistance; complete cross-referenced thesis; paper edits with stale sources; actual document export and rendered inspection.

**Scoring:** For each task record the input/output artifact hashes and versions; execution/citation receipts; correctness and independent reviewer rubric; unverified/fabricated claims; token and billable provider cost; human intervention; p50/p95 time; retries and recovery; privacy/security failures. **Cost per accepted task** = total task spend divided by independently accepted tasks (including failed attempts in total spend). Report confidence intervals on repeated comparable trials. Identify unavailable capabilities as *not tested*, never zero-cost successes.

**Release bar for KG:** New controller ownership immutability demonstrably holds in DB and every tool/job path; complete manuscript with inspectable citations, figures and export; verified coding patch/test receipt; cancellation and recovery safe; no tenant/project leaks; migration rollback validated; all required CI/security/end-to-end tests pass. No source-independent verified flag and no generated citation accepted as evidence. Document all known gaps.

## Official Claude references checked

- Anthropic, *Introducing dynamic workflows* (28 May 2026): https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Anthropic, *A harness for every task* (2 June 2026): https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
- Anthropic, *Agent view in Claude Code* (11 May 2026): https://claude.com/resources/articles/agent-view-in-claude-code
- Anthropic, *Claude Code common developer use cases* (15 April 2026): https://support.claude.com/en/articles/14553517-claude-code-common-developer-use-cases
- Anthropic, *Steering Claude Code: CLAUDE.md, skills, hooks, rules, subagents* (18 June 2026): https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more
- Anthropic, *Set up Code Review for Claude Code* (2 September 2026): https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code

**Disclaimer:** No live Claude Code or KG cross-product executions were conducted for this comparison. Product documentation reflects current advertised availability but can vary by plan and deployment configuration.
