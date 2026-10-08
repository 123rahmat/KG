# Adaptive workflow research and design

Reviewed 8 October 2026 against the current `main` implementation. This is a focused review of primary engineering guidance, not an exhaustive survey of the web.

## What fits KG

| Source | Useful principle | Application in KG |
| --- | --- | --- |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Start with simple workflows; add parallel workers for independent tasks; bound agent iterations. | Keep the existing adaptive model and specialist selection. Improve convergence inside the existing tool loop. |
| [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Select relevant context; preserve decisions and unresolved work when compacting. | Carry the task's constraints, acceptance criteria, and evidence requirements into final synthesis. |
| [Anthropic: Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) | Separate durable session state from the replaceable harness and execution environment. | Retain the existing persisted run controls, isolated runners, and provider cancellation. Propagate the same cancellation signal into synthesis. |
| [Anthropic: Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Evaluate environmental outcomes as well as the transcript; track turns and usage. | Test actual proposal counts, provider calls, cancellation, retained criteria, and charged usage. |
| [Google Cloud: A methodical approach to agent evaluation](https://cloud.google.com/blog/topics/developers-practitioners/a-methodical-approach-to-agent-evaluation) | Define measurable success; evaluate both final output and tool trajectory. | Add scripted trajectory regressions to the existing CI tests rather than relying on model self-ratings. |

## Design decision

Three approaches were considered: add another planner/reviewer on every task; replace the current harness with a new framework; or strengthen the existing bounded loop. The third fits the current architecture and adds no mandatory model calls or dependencies. Extra planning is already available when the adaptive controller identifies a material gap.

The selected changes are:

- Within one invocation, an identical already-proposed action leads to synthesis with the original action ID. It does not create another approval proposal. Input object key order does not change identity; array order and distinct values do. This is invocation-local protection, not distributed idempotency for external actions.
- After two consecutive identical requests return the same error or unmet prerequisite, synthesize from the evidence rather than retrying unchanged until the round budget. A different input, a different result, or successful work breaks this sequence. Normal provider retries remain governed separately.
- Compact synthesis retains task identity and purpose, user deliverable and constraints, acceptance criteria, evidence requirements, governance, approved-plan choices and chat continuity. It uses the task's requested output format. Earlier workflow evidence and tool results remain bounded separately from these instructions; original and tool-produced images remain available. If the retained contract exceeds the synthesis budget, return an incomplete result rather than silently discard constraints.
- Use one effective abort signal at model and tool boundaries, including required-tool execution and final synthesis. Cancellation must throw and prevent another call.
- Return loop termination reason and call counts with the existing tool log and usage, so trajectory tests can distinguish budget exhaustion from convergence. Counts refer to harness model calls and toolbox execution attempts, not internal provider retries or nested tool model calls.

Live-source reads are not cached: repeat retrieval can be useful when the external state changes. Proposed actions still require their existing authorization flow. Insufficient evidence stays subject to the existing verifier and never becomes a server-owned success merely because the loop stopped.

Independent review reproduced three additional edge cases: changing prerequisite explanations, approved-plan and chat instructions omitted from synthesis, and whitespace in tool names bypassing proposal equivalence. Each is covered by the regression suite and corrected in the implementation.

## Validation and operational limits

Use scripted provider/tool fixtures to prove request counts and input retention, plus current runtime, safety, grounding, multi-agent and full CI suites. These are regression checks, not evidence that arbitrary real-world answers are universally correct. Live task success rate, time to useful output, token usage, and cost per successful task should be evaluated on representative Normal Chat, Code and Research workloads before tuning effort thresholds.
