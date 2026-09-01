# ADR 0001: Keep DSH behind a RuntimeProvider boundary

Status: superseded

This was the original external application-server design. It was superseded on 2026-08-29 after
the product boundary was corrected: BizAgent is a DSH-native organizational learning Bundle, not
an external RuntimeProvider host. See [the current plan](../plan.md).

## Context

DeepSeek Harness already owns agent composition, model execution, tools, session history, and its
plugin ecosystem. It is also a rapidly changing developer-preview dependency.

BizAgent needs DSH execution without inheriting DSH types throughout its domain model or forking a
large upstream codebase. BizAgent must also be testable without a model, network, or runtime binary.

## Decision

BizAgent will consume DSH through its public SDK/JSON-RPC process boundary.

All DSH calls, notifications, profile configuration, and compatibility handling live in one
`DshRuntimeProvider`. The rest of BizAgent depends on a small provider contract expressed in
BizAgent-owned types.

The DSH version is pinned. Adapter startup checks the capabilities required by the current
BizAgent release and fails clearly when they are missing.

BizAgent will not:

- fork DSH for its primary distribution;
- implement its own agent loop;
- treat DSH's internal package graph as a stable application API;
- mirror the full DSH session log into BizAgent SQLite;
- claim provider-independent behavior that has not been contract-tested.

## Consequences

Benefits:

- DSH upgrades are localized to one adapter.
- Core tests use a deterministic fake provider.
- BizAgent can define durable application semantics independently from runtime transport details.
- A future provider can be added without changing stored run and message records.

Costs:

- Some DSH capabilities are unavailable until the SDK exposes them.
- Cross-process delivery has an unavoidable ambiguous crash window unless DSH accepts a caller
  idempotency key or correlation id.
- A DSH-native plugin may still be required later for mid-turn interaction and approval.
- The adapter needs an explicit compatibility matrix for every supported DSH release.

## Revisit when

Reconsider a DSH-native BizAgent plugin only after the public RuntimeProvider contract and durable
message semantics have survived a release, and only when an SDK boundary demonstrably prevents a
required capability such as non-blocking human interaction.
