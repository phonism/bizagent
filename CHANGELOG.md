# Changelog

All notable changes to the BizAgent specification will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This specification follows a `Draft v0.x` → `v1.0` lifecycle; breaking changes during the draft phase are expected.

**Languages**: [**English**](./CHANGELOG.md) · [中文](./CHANGELOG.zh-CN.md)

## [Draft v0.1] — 2026-05-26

Initial public draft. **BizAgent build spec for Code Agents** — schemas, APIs, algorithms, and interfaces sufficient for a Code Agent (Claude Code, Cursor, Devin, …) to scaffold a BizAgent platform end-to-end.

- §1 Project Layout — directory tree to generate
- §2 Memory Subsystem — SQL DDL, 4-layer model, Manifest Sync API, Worklog, Knowledge, Recap engine, Consolidation engine
- §3 Monitoring Subsystem (Pulse) — DDL, metric YAML schema, 5 rule types, scheduler tick, atomic claim CAS, investigation flow, insight output rules, failure & retry
- §4 Runtime Primitives — Wakeup engine, Monitor engine
- §5 Adapters — AgentRunnerAdapter, AsyncQueryAdapter, StorageAdapter (TypeScript interfaces)
- §6 Conformance Tests — M1–M7, P1–P7, W1–W5
- §7 Specialization Guide — common/domain knowledge, workspaces, metrics, skills, UI
- Appendix A — Design rationale (optional)
