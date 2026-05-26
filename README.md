# BizAgent

**The open specification for BizAgent — the AI agent platform category for cross-functional business teams.**
**Stand up your own BizAgent on this spec; specialize it for your industry, business line, and workflows.**

> *Code Agent for developers. BizAgent for business teams.*

[![Spec Status](https://img.shields.io/badge/spec-Draft%20v0.1-orange)](./SPEC.md)
[![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](./LICENSE)

**Languages**: [**English**](./README.md) · [中文](./README.zh-CN.md)

---

## What this is

AI agents are specializing. Developers got **Code Agent** (Claude Code, Cursor, Devin). Browser automation got **Web Agent** (Operator, Computer Use). But **cross-functional business teams** — the data analysts, PMs, engineers, and operations folks who share ownership of a business line — still have nothing built for *them*.

A **BizAgent** is the answer: an AI agent platform purpose-built for that team. Not a chatbot, not a framework, but a persistent working environment where the team and a fleet of autonomous agents share one workspace around one business line.

This repo is the **open specification** for the BizAgent category. With it, any team can:

- ✅ **Stand up a BizAgent quickly** — the spec defines the platform's data model, memory layers, monitoring engine, and adapter contracts. No re-inventing the foundation.
- ✅ **Specialize for your business** — your industry vertical (e-commerce / ads / SaaS / fintech / gaming / …), your metrics, your skills layer additively on top. Specialization is **not** a fork.
- ✅ **Stay interoperable** — a workspace built on one conforming BizAgent can be exported and run on another, like OpenAPI definitions across toolchains.

A conforming BizAgent ships two core capabilities:

1. **Long-term Memory** — Agents accumulate, retrieve, and revise business knowledge across sessions, so the team doesn't re-explain context every time a new task starts.
2. **Anomaly Monitoring + Async Root-Cause Investigation** — Agents proactively detect business metric anomalies and chase them to root cause across multiple async query rounds, not just emit a Slack alert.

## The harness

Building a BizAgent isn't just wiring an LLM to a prompt. The hard part is the **harness** — the long-lived plumbing around the agent that makes it actually useful in a business setting: persistent memory across sessions, proactive monitoring, async resume of long-running work, scope-aware sync between platform and local mode. Most teams reinvent this from scratch every time.

This spec is what we landed on after running one such platform in production for six months. Two parts:

### 1. Memory harness

Two design choices anchor the memory harness: **4-layer partitioning** and **worklog-as-first-class-memory**.

**4-layer memory**: knowledge is partitioned into four scopes, each with its own lifecycle and writability:

| Layer | What lives here | Writable by |
|---|---|---|
| **Common** | Cross-workspace methodology and playbooks (KPI glossary, incident-review template) | Curator |
| **Domain** | Per-domain shared concepts (e-commerce GMV definition, ad attribution model) | Curator |
| **Business** | Per-workspace business knowledge (this team's domain models, gotchas, distilled findings) | Agent + human |
| **Session** | Per-session worklog + deliverables — the trace of one task | Agent (append) |

Agents see the union of all four. Splitting them this way means specialization (your domain, your business) layers on top of the spec — no fork required.

**Worklog as first-class memory**: every session writes a `worklog.md` — frontmatter (title / description / timestamps) plus a Markdown body recording plan, decisions, findings, and confusions. Worklogs push to the DB through a CLI (agent calls it after each meaningful update) with a filesystem watcher as fallback. They become **long-term episodic memory** that future sessions can `grep`, and the substrate for **Consolidation** — a scheduled pass that distills recurring patterns from worklogs into the Business knowledge layer.

(Full data model, sync API, engine algorithms: [SPEC §2](./SPEC.md#2-memory-subsystem).)

### 2. Monitoring harness (Pulse)

> **Alert is diagnosis, not notification. A monitoring loop should emit root cause, not noise.**

Three abstractions:

| Abstraction | One-liner |
|---|---|
| **Definition** | A metric = `SQL + threshold + cron`, fully config-driven |
| **Analysis** | Anomaly triggers async, multi-turn agent investigation (not a single LLM summary) |
| **Quality** | Hard prompt constraints forbid hand-waving phrases ("recommend checking X") |

**vs existing monitoring tools:**

| System | Alert Output | Multi-Turn | Root-Cause Constraint |
|---|---|---|---|
| Datadog / Grafana | Metric reading + threshold | ✗ | ✗ |
| Datadog AI Monitoring | + LLM summary | single-turn | weak |
| PagerDuty Ops Cloud | + LLM incident summary | weak | weak |
| **BizAgent Pulse** | **+ agent-derived root cause** | **✓ async multi-turn** | **✓ hard constraints** |

## Status

| | |
|---|---|
| Spec | **Draft v0.1** (2026-05-25) |
| Reference implementation | In progress (separate release) |
| Adopters | PRs welcome |

The draft phase will see breaking changes as feedback comes in. A `v1.0` cut is targeted once at least two independent implementations exist.

## How to use the spec

[**SPEC.md**](./SPEC.md) is written **for Code Agents** (Claude Code, Cursor, Devin…). The intended workflow:

```bash
# 1. Clone this repo (or hand the SPEC.md URL to the agent)
git clone https://github.com/phonism/bizagent
cd bizagent

# 2. In Claude Code / Cursor / your agent of choice:
> Read SPEC.md. Scaffold the BizAgent platform it describes into ./my-bizagent.
> Then run the conformance tests in §6.

# 3. Specialize for your business (§7)
> Wire in our internal platforms, data tables, ops tools, and business knowledge.
```

Each section gives **schemas, APIs, algorithms, and TypeScript interfaces** — enough for an agent to generate working code without further explanation. Section map:

| Section | What it specifies |
|---|---|
| [§1 Project Layout](./SPEC.md#1-project-layout) | Directory tree the agent should generate |
| [§2 Memory Subsystem](./SPEC.md#2-memory-subsystem) | SQL DDL · Manifest Sync API · Worklog · Knowledge · Recap · Consolidation |
| [§3 Monitoring (Pulse)](./SPEC.md#3-monitoring-subsystem-pulse) | Metric schema · 5 rule types · Scheduler · Atomic claim · Investigation flow |
| [§4 Runtime Primitives](./SPEC.md#4-runtime-primitives) | Wakeup engine · Monitor engine |
| [§5 Adapters](./SPEC.md#5-adapters) | TypeScript interfaces for AgentRunner / AsyncQuery / Storage |
| [§6 Conformance Tests](./SPEC.md#6-conformance-tests) | Test IDs to validate the build |
| [§7 Specialization Guide](./SPEC.md#7-specialization-guide) | How to layer your industry/business on top of the baseline |
| [Appendix A: Design Notes](./SPEC.md#appendix-a-design-notes-optional-reading) | Rationale for key decisions (optional reading) |

Both [SPEC.md](./SPEC.md) (English) and [SPEC.zh-CN.md](./SPEC.zh-CN.md) (中文) are maintained in parallel with 1:1 correspondence. In case of discrepancy, English takes precedence.

## Why a spec, not just a library

Libraries make one implementation easy. Specs make *every* implementation interoperable. BizAgent focuses on:

- **Substrate-portable** — your memory and monitoring choices outlive any single agent SDK or model vendor.
- **Cross-implementation testable** — Part V's test matrix means a conformant implementation can be validated, not just claimed.

## Contributing

Issues, PRs, and discussion welcome.

- **Editorial fixes** (typos, clarifications, missing examples) — PR directly. **Update both `SPEC.md` (English) and `SPEC.zh-CN.md` (中文) in the same PR.**
- **Semantic changes** (entity shape, protocol contract, conformance rule) — open an RFC issue first, then PR.
- **New adapters** — propose under [§5 Adapters](./SPEC.md#5-adapters).

See [CHANGELOG.md](./CHANGELOG.md) for the history of accepted changes.

## License

The specification is licensed under [CC BY 4.0](./LICENSE) — share and adapt freely, commercial use included, with attribution.
