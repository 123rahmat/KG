# Adaptive multi-agent workflow

Kindgleam already has a server-owned adaptive workflow, targeted context, model routing, verification, retry/replan logic, and an independent verification reviewer. The multi-agent layer adds specialist collaboration without handing workflow authority to the models.

## When it activates

`MULTI_AGENT_MODE=auto` is the production default. The panel activates when the situation has material complexity or uncertainty, high-impact/physical risk, external-data uncertainty, code/prototype work, or a retry. Crisis and safety-adaptive responses do not wait for the panel, and verification keeps its dedicated reviewer path rather than paying for two overlapping review systems.

The panel uses at most `MULTI_AGENT_MAX_AGENTS` specialists (1-3). Typical roles are strategist, researcher, architect, critic, and diagnostician. Role selection follows the task and the current attempt instead of a fixed domain list.

## Iteration and disagreement

Specialists are advisory and have no tools. Their output is normalized to a small schema and passed to the primary model as **advisory data**. The server still decides which task is next, which tools are available, whether external execution is allowed, and whether a result can be recorded.

Specialists run independently. When their recommendations disagree, an arbiter gets the original situation plus the competing findings and resolves the disagreement into another advisory finding. A failed panel call never blocks the primary model, and a model outage does not change workflow authority.

The same provider/model policy and data-transfer governance used by the primary model applies to every specialist call. Specialist usage is recorded separately with `source=multi-agent`, so the run budget and operational metrics still account for the work.

## Configuration

```env
MULTI_AGENT_MODE=auto
MULTI_AGENT_MAX_AGENTS=3
```

`auto` expands only when the situation warrants it, `always` allows the specialist layer whenever governance permits, and `off` disables it. Keeping `auto` avoids paying multi-agent latency/tokens for routine questions.

## Why this fits the existing architecture

The design is intentionally additive. It does not replace the server-owned workflow, adaptive safety gates, capability compiler, tool approval path, local execution receipts, or verification. It gives difficult runs a structured second layer for planning, architecture, critique, and recovery while preserving the system's existing stop/iterate semantics.
