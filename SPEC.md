# BizAgent Specification

> Build a BizAgent — an AI agent platform for cross-functional business teams (data, product, engineering, operations).
> Two core capabilities: **long-term Memory** + **Anomaly Monitoring (Pulse)**.

**Status**: Draft v0.1 · **License**: CC-BY-4.0

Conventions: SQL = SQLite dialect (translate freely). TypeScript = normative shapes (equivalent in any language is fine). Time units = milliseconds (ms) unless noted. When a design decision is ambiguous, consult Appendix A.

---

## §1 Project Layout

Generate this directory:

```
bizagent/
├── apps/
│   ├── web/                       Web UI surface (any framework; out of scope, see §7.6)
│   └── server/                    Backend service (any runtime / database; SQL examples below are SQLite)
├── packages/
│   ├── memory/                    §2 Memory subsystem
│   ├── pulse/                     §3 Monitoring subsystem
│   ├── runtime/                   §4 Wakeup / Monitor primitives
│   └── adapters/                  §5 AgentRunner / AsyncQuery / Storage
├── workspaces/
│   └── {workspace-slug}/          Materialized filesystem per workspace
│       ├── CLAUDE.md
│       ├── knowledge/
│       │   ├── common/
│       │   ├── domain/
│       │   └── business/
│       └── deliverables/
│           └── {sessionId}/
│               ├── worklog.md
│               └── ...
├── data/
│   └── bizagent.db                SQLite SOT
└── tests/
    └── conformance/               §6 tests
```

`workspaces/` is the **materialized view** of the DB — derived, not authoritative. The DB at `data/bizagent.db` is the only source of truth.

---

## §2 Memory Subsystem

### §2.1 Data Model

```sql
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  claude_md     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE knowledge_docs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  layer         TEXT NOT NULL CHECK (layer IN ('common','domain','business')),
  path          TEXT NOT NULL,
  content       TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  last_editor   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(workspace_id, layer, path)
);

CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  title         TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','processing','completed','cancelled','failed')),
  worklog       TEXT,                              -- denormalized cache of session_deliverables(path='worklog.md'); for fast list views. Canonical content lives in session_deliverables.
  last_input_at INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE session_deliverables (
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  path          TEXT NOT NULL,
  content       TEXT NOT NULL,
  encoding      TEXT NOT NULL DEFAULT 'utf-8' CHECK (encoding IN ('utf-8','base64')),
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE recaps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  text          TEXT NOT NULL,
  generated_by  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

All writes go to the DB first; the filesystem under `workspaces/{slug}/` is regenerated from these tables. Out-of-band filesystem edits are not synced back.

### §2.2 Four Memory Layers

| Layer | Materialized path | Writable by | Conflict strategy |
|---|---|---|---|
| `common` | `knowledge/common/` | Curator only | Pull overwrites local |
| `domain` | `knowledge/domain/` | Curator only | Pull overwrites local |
| `business` | `knowledge/business/` | Agent + Human | Git-like `lastPullVersion` (§2.3) |
| `session` | `deliverables/{sessionId}/` | Agent (append) | Upsert by `(sessionId, path)` |

Each non-empty layer should contain an `INDEX.md` listing the documents in that layer (for agent discovery without full scan).

### §2.3 Manifest Sync API

URL prefixes are implementation-defined; the operation names are canonical.

```
GET    /workspaces/{id}/manifest
       → 200 { files: [{ path, layer, version, size, writable, encoding }], generatedAt }

GET    /workspaces/{id}/files?path={relpath}
       → 200 { path, content, encoding, version }
       → 404 if not found

POST   /workspaces/{id}/files
       body: { path, content, encoding?, lastPullVersion? }
       → 200 { version }
       → 409 { remoteVersion, remoteContent }     (writable layer, version mismatch)
       → 403                                       (read-only layer)

DELETE /workspaces/{id}/files?path={relpath}
       → 204 | 404 | 403

GET    /workspaces/{id}/deliverables/manifest
       → 200 { files: [{ sessionId, path, version, size }], generatedAt }

GET    /workspaces/{id}/deliverables/files?sessionId={n}&path={relpath}
       → 200 { content, encoding } | 404

POST   /sessions/{id}/worklog
       body: { content }
       → 200 { version }
       → 422 { error: "missing required frontmatter field: <name>" }

POST   /sessions/{id}/deliverables
       body: { path, content, encoding? }
       → 200 { version }

POST   /workspaces/{id}/export
       → 200 { zipUrl }    (zip of materialized workspace + workspace.json)
GET    /workspaces/{id}/export?download=1
       → 200 (streams zip)
```

**Conflict protocol** (writable layers):
```
if request.lastPullVersion is missing OR request.lastPullVersion < current_db_version:
    return 409 with { remoteVersion: current_db_version, remoteContent: current_content }
else:
    accept; version += 1; return { version }
```

**Manifest entry**:
```json
{
  "path": "knowledge/common/incident-playbook.md",
  "layer": "common",
  "version": "2026-05-01T03:14:15Z",
  "size": 1234,
  "writable": false,
  "encoding": "utf-8"
}
```

`version` is either ISO 8601 timestamp or monotonic integer — consistent within one manifest. Read-only layer entries always set `writable: false`.

### §2.4 Worklog

Path: `deliverables/{sessionId}/worklog.md`. Maximum one per session.

Required YAML frontmatter:
```yaml
---
title: <short title>
description: <one-line summary; updated to final conclusion at task end>
createdAt: <ISO 8601, never mutated>
updatedAt: <ISO 8601, refreshed on each edit>
---
```

Push API rejects missing fields with `422 { error: "missing required frontmatter field: X" }`.

Recommended body structure (not validated):

````markdown
```tasks
[done] Step 1
[run]  Step 2
[wait] Step 3
```

## Plan

## Acceptance Criteria
- [ ] criterion 1

## Notes

## Confusions
- (only if genuinely uncertain)
````

`tasks` block uses states `[done] [run] [wait] [fail] [skip]` and is rendered by UIs with status indicators. `Confusions` section is the agent's channel for expressing uncertainty; UIs should highlight it.

**Push channels** (both required; both idempotent):

A. **CLI** (primary) — the platform ships this binary; the agent invokes it after each meaningful update:
```
worklog-cli worklog --session-id=<sid>
worklog-cli push <relpath> --session-id=<sid>
worklog-cli push-all --session-id=<sid>
```

B. **Filesystem watcher** (fallback) — the runtime scans `deliverables/` every 5s for mtime changes and pushes detected updates. Guards against agents forgetting to invoke the CLI.

Both channels converge via upsert on `(session_id, path)`.

### §2.5 Knowledge

Business-layer writes go through Manifest Sync API (§2.3) with `lastPullVersion` conflict detection. Read-only layers (`common`, `domain`) are populated through curator channels not specified here (e.g., admin UI, git import, or direct DB).

Recommended frontmatter for agent-distilled documents:
```yaml
---
name: <short identifier>
sources: [deliverables/267, deliverables/412]   # session ids this was distilled from
distilledAt: <ISO 8601>
---
```

The `sources` field, when present, must reference real session deliverable paths. A reader can then trace any distilled fact to its origin worklogs.

### §2.6 Recap Engine

Tick: every 60 seconds.

```
for each session where state = 'processing':
    idle_ms = now - session.last_input_at
    if idle_ms < 600_000:                              # 10 minutes
        continue
    if recap already exists for this idle window:
        continue
    # spawn agent in isolated context (forked session — does not pollute original conversation history)
    prompt = "Summarize the past 10 minutes in one short sentence (≤ 40 graphemes; one CJK character counts as one)."
    text = run_isolated_agent(model = fast_model, session_fork = session.id, prompt)
    assert grapheme_count(text) <= 40                  # enforce on the platform side, not just in prompt
    insert into recaps (session_id, text, generated_by) values (session.id, text, fast_model)
    broadcast SSE event 'recap' to UI subscribers of session.id
```

The recap output is persisted in the `recaps` table — a distinct artifact from agent-authored messages. The recap-generation model should be cheaper/faster than the session's main agent (Haiku-class).

### §2.7 Consolidation Engine

Tick: implementation-defined (daily cron recommended).

```
for each workspace:
    candidates = worklogs where created_at >= now - 7 days AND session.state = 'completed'
    if len(candidates) < CONSOLIDATION_MIN_CANDIDATES:    # default: 5
        continue
    proposals = run_agent_with_prompt(
        "Read these worklogs. Distill recurring patterns / decisions / gotchas into business knowledge proposals.
         Output one Markdown file per proposal with frontmatter `sources: [...]` referencing the input worklogs.",
        inputs = candidates
    )
    for proposal in proposals:
        write to knowledge_docs (layer='business', path='_pending/<proposal.name>.md', ...)
        notify human reviewer
```

**Promotion** (manual, human-gated): move a file from `_pending/` to the root of the `business/` layer via the Manifest Sync API (with `lastPullVersion`).

**Provenance rule**: any document under the business layer carrying a `sources:` frontmatter is treated as consolidated (agent-distilled). Documents without `sources:` are treated as human-authored.

---

## §3 Monitoring Subsystem (Pulse)

### §3.1 Data Model

```sql
CREATE TABLE pulse_metrics (
  id            TEXT PRIMARY KEY,                  -- platform-generated; recommend UUID v4 OR `{workspace_slug}.{key}`
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  key           TEXT NOT NULL,                     -- user-facing stable identifier, unique within workspace; matches [a-z0-9_-]+
  query         TEXT NOT NULL,                     -- SQL or DSL string
  schedule      TEXT NOT NULL,                     -- cron expression
  thresholds    TEXT NOT NULL,                     -- JSON array of rules
  state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','error','paused')),
  next_run_at   INTEGER NOT NULL,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(workspace_id, key)
);

CREATE TABLE pulse_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id     TEXT NOT NULL REFERENCES pulse_metrics(id),
  state         TEXT NOT NULL CHECK (state IN ('pending','running','completed','failed')),
  claimed_by    TEXT,
  claimed_at    INTEGER,
  scheduled_at  INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  values_json   TEXT,                              -- numeric result(s)
  rule_trips    TEXT,                              -- JSON: which rules triggered
  error_reason  TEXT
);

CREATE TABLE pulse_insights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES pulse_runs(id),
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  root_cause    TEXT NOT NULL,
  evidence      TEXT NOT NULL,                     -- JSON: timestamps, values, configs
  scope         TEXT NOT NULL,                     -- hypotheses tested / ruled out
  created_at    INTEGER NOT NULL
);
```

### §3.2 Metric Schema

A metric is fully defined by config (no per-metric code).

```yaml
metric:
  key: dau_main_app                         # stable identifier, unique within workspace
  query: |                                  # passed to AsyncQueryAdapter (§5.2)
    SELECT COUNT(DISTINCT user_id) AS dau
    FROM events
    WHERE event_date = '{{ds}}'
  schedule: "0 2 * * *"                     # cron: 02:00 daily
  thresholds:
    - type: drop_pct
      params: { value: 0.05, baseline: "7d_avg" }
    - type: consecutive_drop
      params: { count: 3 }
```

Placeholders such as `{{ds}}` are rendered before submission (implementation-defined renderer; provide at least `{{ds}}` = current date).

### §3.3 Rule Types

Must support all five. May add more (preserve determinism: same input series → same result).

| `type` | `params` | Triggers when |
|---|---|---|
| `drop_pct` | `{ value: float, baseline: "7d_avg"\|"1d_prev"\|"30d_avg"\|... }` | `current ≤ baseline × (1 − value)` |
| `spike_pct` | `{ value: float, baseline: ... }` | `current ≥ baseline × (1 + value)` |
| `absolute_below` | `{ value: float }` | `current < value` |
| `absolute_above` | `{ value: float }` | `current > value` |
| `consecutive_drop` | `{ count: int }` | Last `count` runs each dropped vs the immediately preceding run |

Baselines are computed from the metric's own historical `pulse_runs.values_json` over the matching window.

### §3.4 Scheduler Tick

Every 60 seconds:

```
now = current_time()
for each metric in pulse_metrics where state='active' AND next_run_at <= now:
    insert into pulse_runs (metric_id, state='pending', scheduled_at=now)
    update pulse_metrics set next_run_at = cron.next_after(metric.schedule, now)
    notify worker pool (SSE event 'pulse-run:pending' with the new run id; polling fallback OK)
```

### §3.5 Atomic Claim

Multiple workers may operate against the same scheduler. Claim via SQL CAS:

```sql
UPDATE pulse_runs
SET state = 'running', claimed_by = :worker_id, claimed_at = :now
WHERE id = :run_id AND state = 'pending';
```

Successful claim → 1 row affected. Loser → 0 rows. The loser does not retry; it waits for the next `pulse-run:pending` event.

### §3.6 Investigation Flow

When any rule trips on a `pulse_runs` row:

```
1. Create investigation session:
     insert into sessions (workspace_id, title=f"Investigate: {metric.key}", state='processing', ...)

2. Seed system message in the new session with the anomaly context:
     {
       metric_key, current_value, baseline, threshold_type, threshold_params,
       recent_runs: [{ scheduled_at, value }, ...]   // last 14 runs
     }

3. Launch agent with allowed_tools including (see §5.4 for signatures):
     - async_query_submit / async_query_fetch     (issue further SQL)
     - knowledge_grep / knowledge_read            (search business/common knowledge)
     - worklog_push                               (write findings as they accumulate)
     - pulse_insight_complete                     (signal investigation done; writes pulse_insights row)

4. Multi-turn loop:
     - Agent submits a query → async; agent's current turn ends.
     - Wakeup (§4.1) is armed for "query completed" condition.
     - When result lands, session is resumed (next turn) with the result injected.
     - Repeat until agent emits a `pulse_insight_complete` tool call OR exhausts hypotheses.

5. Persist final insight:
     insert into pulse_insights (run_id, session_id, root_cause, evidence, scope)
```

Must support `≥ 30 min wall-clock` and `≥ 5 async query rounds` in a single investigation session.

### §3.7 Insight Output Rules

Filter or reject any insight whose text matches these patterns (the investigation skill's system prompt enforces; the persistence layer double-checks):

- "recommend further investigation of …" / "建议进一步排查"
- "continue to observe" / "持续观察"
- "consider checking …" / "建议查"
- "more data is needed" without specifying what data / "需要更多数据"（未指明）

Required output fields (`pulse_insights` columns):

- `root_cause`: either a definitive statement OR an explicit closure like *"No root cause identified after N hypotheses: A, B, C."*
- `evidence`: concrete — specific timestamps, metric values, config changes, etc. (no "around X time" hand-waving).
- `scope`: which hypotheses were tested, which were ruled out, why.

### §3.8 Failure & Retry

Transient failures (query timeout, downstream 5xx):

```python
delay_seconds = min(base * (2 ** min(attempt - 1, 10)), max_backoff)
# defaults: base = 600,  max_backoff = 3600,  max_attempts = 6
```

After `max_attempts` consecutive failures:
```sql
UPDATE pulse_metrics SET state = 'error' WHERE id = :metric_id;
```
The metric leaves the scheduler until manually reset (`state='active'`, `fail_count=0`). This prevents indefinite alert storms.

---

## §4 Runtime Primitives

### §4.1 Wakeup Engine

```sql
CREATE TABLE wakeups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  fire_at       INTEGER NOT NULL,
  prompt        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','fired','cancelled')),
  chain_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
```

Tools exposed to agents (transport-implementation-defined — MCP tool, in-process function, etc.):

```
schedule_wakeup(sessionId, delaySeconds, prompt) → wakeupId
cancel_wakeup(wakeupId) → void
```

Tick (60 seconds):
```
for each wakeup where state='pending' AND fire_at <= now:
    set wakeups.state = 'fired'
    inject `prompt` as a new user message in sessions.id (resume prior conversation thread, not a fresh start)
    enqueue session for next agent turn (sessions.state = 'pending')
```

**Drift**: wakeups may fire late (after `fire_at`), never early. Log drift exceeding 30,000 ms for operator visibility.

**Chain limit**: each session has a cumulative wakeup counter. Every successful `schedule_wakeup(sessionId, ...)` increments `chain_count` on the **target** session (the one passed as `sessionId`). When `chain_count >= 50`, further `schedule_wakeup` calls targeting that session return an error. The counter does **not** reset on session state change; only an explicit operator reset clears it. This prevents an agent from looping itself indefinitely.

**Durability**: wakeups persist in the SOT DB and survive process restarts. The engine tick re-reads from the table on each tick.

### §4.2 Monitor Engine

```sql
CREATE TABLE monitors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES sessions(id),
  condition_json  TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  single_fire     INTEGER NOT NULL DEFAULT 1,
  state           TEXT NOT NULL CHECK (state IN ('armed','fired','cancelled')),
  created_at      INTEGER NOT NULL
);
```

Tools:
```
arm_monitor(sessionId, condition, prompt, singleFire=true) → monitorId
list_monitors(sessionId) → monitorId[]
stop_monitor(monitorId) → void
```

`condition` is a predicate descriptor. At least support:

```json
{ "type": "deliverable_exists", "sessionId": 42, "path_glob": "reports/*.md" }
{ "type": "agent_idle", "sessionId": 42, "ms": 30000 }
{ "type": "async_query_ready", "externalId": "snowflake-job-abc" }
```

Implementations may add custom predicate types.

Tick (5 seconds):
```
for each monitor where state='armed':
    if evaluate_predicate(monitor.condition_json) is True:
        set monitors.state = 'fired'
        inject monitor.prompt as a new user message in monitor.session_id
        enqueue session for next agent turn
        if monitor.single_fire: # auto-cancelled by state transition
            continue
```

**Auto-stop on session close**: when `sessions.state` enters `('completed','cancelled','failed')`, set `monitors.state = 'cancelled'` for every monitor owned by that session.

**Durability**: same as Wakeup — DB-backed, survives restarts.

---

## §5 Adapters

### §5.1 AgentRunnerAdapter

```typescript
interface AgentRunnerAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentRunEvent>;
}

interface AgentRunInput {
  cwd: string;                        // absolute path to materialized workspace
  systemPrompt: string;
  allowedTools: string[];
  model: string;
  messages: Message[];                // empty for first turn; prior history for resume
  abortSignal: AbortSignal;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

type ContentBlock =
  | { type: 'text';        text: string }
  | { type: 'tool_use';    id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string };

type AgentRunEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'tool_call'; toolName: string; input: unknown }
  | { type: 'tool_result'; toolName: string; output: unknown }
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; error: string };

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUsd: number;
  durationMs: number;
}
```

Reference implementations: Claude Agent SDK, OpenAI Codex app-server, direct Anthropic SDK.

### §5.2 AsyncQueryAdapter

```typescript
interface AsyncQueryAdapter {
  submit(query: string, params?: Record<string, unknown>): Promise<{ externalId: string }>;
  status(externalId: string): Promise<'pending' | 'running' | 'completed' | 'failed'>;
  fetchResult(externalId: string): Promise<QueryResult>;
  cancel?(externalId: string): Promise<void>;
}

interface QueryResult {
  rows: unknown[][];
  columns: string[];
}
```

Reference implementations: Snowflake REST, BigQuery jobs.query, DuckDB-via-HTTP, PostgreSQL with `LISTEN`, in-memory mock.

### §5.3 StorageAdapter

```typescript
interface StorageAdapter {
  readFile(path: string): Promise<Buffer | null>;
  writeFile(
    path: string,
    content: Buffer,
    expectedVersion?: string,           // for optimistic concurrency
  ): Promise<{ version: string }>;
  deleteFile(path: string): Promise<void>;
  listFiles(prefix: string): Promise<FileEntry[]>;
}

interface FileEntry {
  path: string;
  size: number;
  version: string;
  updatedAt: number;
}
```

Reference implementations: SQLite-backed blob store (single host), PostgreSQL (multi-host), S3 + metadata DB, local filesystem (development only).

### §5.4 Agent-Facing Tools

These are the tools the **platform exposes to agents** (distinct from §5.1–§5.3, which are interfaces the platform consumes). The agent calls these through whatever transport the platform chooses (in-process function, MCP server, JSON-RPC, etc.). Signatures below are normative; transport is implementation-defined.

```typescript
// Knowledge & deliverables (used by every agent)
worklog_push(sessionId: number, content: string): Promise<{ version: string }>;
deliverable_push(sessionId: number, path: string, content: string, encoding?: 'utf-8' | 'base64'): Promise<{ version: string }>;
knowledge_grep(workspaceId: string, layer: 'common' | 'domain' | 'business', query: string): Promise<Array<{ path: string; snippet: string }>>;
knowledge_read(workspaceId: string, layer: 'common' | 'domain' | 'business', path: string): Promise<{ content: string; version: string }>;
knowledge_write(workspaceId: string, path: string, content: string, lastPullVersion?: string): Promise<{ version: string }>;   // business layer only

// Async query (Pulse investigation, ad-hoc analysis)
async_query_submit(query: string, params?: Record<string, unknown>): Promise<{ externalId: string }>;
async_query_fetch(externalId: string): Promise<{ rows: unknown[][]; columns: string[] }>;

// Runtime primitives (§4)
schedule_wakeup(sessionId: number, delaySeconds: number, prompt: string): Promise<{ wakeupId: number }>;
cancel_wakeup(wakeupId: number): Promise<void>;
arm_monitor(sessionId: number, condition: object, prompt: string, singleFire?: boolean): Promise<{ monitorId: number }>;
list_monitors(sessionId: number): Promise<number[]>;
stop_monitor(monitorId: number): Promise<void>;

// Pulse investigation closure (§3.6, §3.7)
pulse_insight_complete(runId: number, rootCause: string, evidence: object, scope: string): Promise<void>;
```

The platform may expose additional tools via the AgentRunnerAdapter's `allowedTools` (see §7.5). The above set is the minimum any conforming BizAgent must expose to the investigation agent (§3.6) and to general-purpose session agents.

---

## §6 Conformance Tests

Provide automated tests covering each ID below. A platform claiming BizAgent conformance passes all tests in §6.1–§6.3.

**Layout**: tests live under `tests/conformance/` (per §1) and are runnable as a single command. Spec does not mandate the runner — use whatever fits the stack (`npm test:conformance`, `pytest tests/conformance/`, `cargo test --test conformance`, etc.). Each test ID corresponds to one test case; the implementation reports pass/fail per ID.

### §6.1 Memory Tests

| ID | Assert |
|---|---|
| M1 | All four layers are persistent and addressable via Manifest Sync (§2.3). |
| M2 | Out-of-band filesystem edits do NOT appear in the DB; filesystem rebuilt from DB is byte-identical (modulo timestamps). |
| M3 | Worklog and Recap artifacts are stored distinctly (different tables); a reader can tell which authorship path produced any artifact. |
| M4 | Read-only layer write → 403. Business layer concurrent write with stale `lastPullVersion` → 409. Session layer concurrent write from CLI and watcher converges. |
| M5 | Worklog push without required frontmatter → 422 with a clear `error` message. |
| M6 | Recap runs in an isolated context (forked session); output ≤ 40 chars; persisted in the `recaps` table. |
| M7 | Consolidation proposals land in `business/_pending/`; promotion requires explicit human action. |

### §6.2 Monitoring Tests

| ID | Assert |
|---|---|
| P1 | A metric is defined entirely by YAML/JSON config; no per-metric code is required. |
| P2 | Atomic claim: under concurrent workers, exactly one claims a given pending run. |
| P3 | Rule evaluation is deterministic for identical input series. |
| P4 | Rule trip launches an investigation session (a new row in `sessions`), not a one-shot output. |
| P5 | Investigation session can span ≥ 30 min and ≥ 5 async query rounds. |
| P6 | Insight rows reject forbidden phrasing (§3.7); root_cause/evidence/scope all populated. |
| P7 | After max_attempts consecutive failures, metric transitions to `state='error'` and exits the scheduler. |

### §6.3 Runtime Tests

| ID | Assert |
|---|---|
| W1 | Scheduled wakeup fires (within bounded drift) at or after `fire_at`; never before. |
| W2 | Wakeups survive a worker process restart. |
| W3 | `chain_count` enforced; the 51st `schedule_wakeup` in a session returns an error. |
| W4 | Monitor predicate evaluates true → session resumes with the configured prompt. |
| W5 | Session entering a terminal state auto-cancels all monitors it owned. |

---

## §7 Specialization Guide

A baseline BizAgent built from §1–§6 is industry-neutral. To make it useful for your business, layer the following on top.

### §7.1 Add Common Knowledge

Populate `knowledge/common/` with cross-workspace methodology, definitions, and playbooks (e.g., incident-review template, KPI glossary, escalation matrix). Include `INDEX.md`. Read-only to agents.

### §7.2 Add Domain Knowledge

For each business domain (e.g., `e-commerce`, `ads`, `b2b-saas`), create `knowledge/domain/{domain-key}/` and populate with domain-specific concepts (e.g., `gmv-definition.md`, `attribution-model.md`). Workspaces opt into a domain by reference; agents see the union of `common` + the workspace's domain + the workspace's business layer.

### §7.3 Add Business Workspaces

Create one workspace per business line. Each gets:
- a workspace-scoped `claude_md` (worldview),
- its own writable `business/` knowledge layer,
- its own metrics (§7.4) and skills (§7.5).

### §7.4 Add Metrics

Author YAML metric definitions per §3.2. Use the five baseline rule types; add custom types as needed (preserve determinism).

### §7.5 Add Agent Skills

Skills are reusable agent capabilities (e.g., `run-sql`, `generate-pptx`, `query-tracker`). Skill system specification is out of scope for v0.1; implement skills as a flat tool registry exposed via the AgentRunnerAdapter's `allowedTools`.

### §7.6 Add UI

The UI layer is out of scope. Build views over the SOT DB as your team needs (session inspector, metric dashboard, knowledge browser, etc.).

---

## Appendix A: Design Notes (Optional Reading)

This appendix records the rationale behind key design choices. Implementing §1–§7 does not require reading it; consult it when an ambiguity arises or when considering deviations.

### A.1 Why DB-as-SOT (and FS-as-Materialization)

The filesystem is convenient for agents to read with `glob` and `grep`, but it cannot be the source of truth across multiple processes, machines, or deployment modes. Two processes editing the same file drift; a managed-mode platform and a local-mode user cannot reconcile. Centralizing truth in a single DB and treating the filesystem as a derived view eliminates this class of divergence. Any client (server, worker, local agent) materializes the same workspace identically by replaying from the DB.

### A.2 Why Agent-Authored vs System-Compressed (separate paths)

Mixing the two confuses both audit and behavior. MemGPT lets the LLM decide what to keep (opaque eviction). Letta exposes memory as a tool (conflates authorship with tool semantics). mem0 extracts facts post-hoc from conversations (loses the agent's intent). Splitting authorship makes the agent the *writer* of its own memory (worklog, knowledge) while the system handles the mechanical residue (recap of idle sessions) as a separately tagged artifact. A reader can always tell who wrote what.

### A.3 Why Scope-Based Sync (three strategies, not one)

A single sync rule cannot satisfy three different semantics simultaneously. Read-only layers represent shared truth (no forks). The business layer is collaborative (concurrent edits demand explicit conflict signaling, hence `lastPullVersion`). The session layer is single-writer-per-`(session, path)` (upsert suffices; no ceremony). Forcing one rule on all three either loses safety or adds unnecessary friction.

### A.4 Why Alert-as-Diagnosis (not Notification)

Datadog/Grafana/PagerDuty stop at "metric X dropped Y%" — the receiver must investigate. The Pulse paradigm instead launches an agent investigation that returns a root-cause statement. The receiver acts on the diagnosis. The infrastructure to support multi-turn async investigation (§3.6) and to enforce output quality (§3.7) is the non-trivial part — but the *contract* (insight, not signal) is the differentiator.

### A.5 Why Not RAG

For agent memory in this spec, vector retrieval is the wrong tool:

1. **Paradigm mismatch.** RAG treats the model as a *passive consumer* of top-k retrieval. Agents *actively navigate* with `glob` / `grep` / multi-turn — they have context and goal. RAG is a regression.
2. **Signal quality.** Worklogs and knowledge docs are keyword-rich and structured. Full-text search (FTS5, ripgrep) outperforms embedding similarity on this kind of content — the same reason Sourcegraph/Cursor/GitHub default to ctags+regex for code.
3. **Scalability path.** When the corpus exceeds what an agent can consume, the right answer is *Consolidation* (§2.7) — distill into fewer, denser artifacts — not retrieve more cleverly.

RAG is correct for cross-language fuzzy search, open-ended exploration where the user does not know what to look for, and long-tail unstructured web content. The Memory artifacts in this spec satisfy none of those conditions.

---

## Document History

| Version | Date | Notes |
|---|---|---|
| Draft v0.1 | 2026-05-26 | Initial public draft. BizAgent build spec for Code Agents. |
