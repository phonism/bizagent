# BizAgent 规范

> 搭一个 BizAgent——面向跨职能业务团队（数据、产品、开发、运营）的 AI Agent 平台。
> 两个核心能力：**长期记忆** + **异常监控（Pulse）**。

**状态**：Draft v0.1 · **许可**：CC-BY-4.0

约定：SQL = SQLite 方言（自由翻译）。TypeScript = 规范形状（任意语言的等价物均可）。时间单位 = 毫秒（ms），除非另行注明。设计决策有歧义时查阅附录 A。

---

## §1 项目布局

生成以下目录：

```
bizagent/
├── apps/
│   ├── web/                       Web UI 界面（任意框架；超出规范范围，见 §7.6）
│   └── server/                    后端服务（任意 runtime / 数据库；下方 SQL 示例使用 SQLite 方言）
├── packages/
│   ├── memory/                    §2 记忆子系统
│   ├── pulse/                     §3 监控子系统
│   ├── runtime/                   §4 Wakeup / Monitor 原语
│   └── adapters/                  §5 AgentRunner / AsyncQuery / Storage
├── workspaces/
│   └── {workspace-slug}/          每个 workspace 的物化文件系统
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
    └── conformance/               §6 测试
```

`workspaces/` 是 DB 的**物化视图**——派生的、非权威的。`data/bizagent.db` 处的 DB 是唯一的真理来源。

---

## §2 记忆子系统

### §2.1 数据模型

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
  worklog       TEXT,                              -- session_deliverables(path='worklog.md') 的反范式缓存；用于列表视图快速访问，权威内容在 session_deliverables。
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

所有写入先到 DB；`workspaces/{slug}/` 下的文件系统从这些表重新生成。带外的文件系统编辑不反向同步。

### §2.2 4 层记忆

| 层 | 物化路径 | 可写性 | 冲突策略 |
|---|---|---|---|
| `common` | `knowledge/common/` | 仅 curator | Pull 覆盖本地 |
| `domain` | `knowledge/domain/` | 仅 curator | Pull 覆盖本地 |
| `business` | `knowledge/business/` | Agent + 人 | Git-like `lastPullVersion`（§2.3） |
| `session` | `deliverables/{sessionId}/` | Agent（追加） | 按 `(sessionId, path)` 幂等写 |

每个非空层应包含一个 `INDEX.md`，列出该层下的文档（供 agent 发现，避免全量扫描）。

### §2.3 清单同步 API

URL 前缀实现定义；操作名为规范名。

```
GET    /workspaces/{id}/manifest
       → 200 { files: [{ path, layer, version, size, writable, encoding }], generatedAt }

GET    /workspaces/{id}/files?path={relpath}
       → 200 { path, content, encoding, version }
       → 404 未找到

POST   /workspaces/{id}/files
       body: { path, content, encoding?, lastPullVersion? }
       → 200 { version }
       → 409 { remoteVersion, remoteContent }     （可写层、版本不匹配）
       → 403                                       （只读层）

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
       → 200 { zipUrl }    （物化 workspace + workspace.json 的 zip）
GET    /workspaces/{id}/export?download=1
       → 200 （流式下载 zip）
```

**冲突协议**（可写层）：
```
if 请求的 lastPullVersion 缺失 OR lastPullVersion < 当前 DB 版本:
    返回 409，body 为 { remoteVersion: 当前 DB 版本, remoteContent: 当前内容 }
else:
    接受；version += 1；返回 { version }
```

**清单条目**：
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

`version` 为 ISO 8601 时间戳或单调整数——同一 manifest 内类型一致。只读层条目永远 `writable: false`。

### §2.4 Worklog

路径：`deliverables/{sessionId}/worklog.md`。每个 session 最多一份。

必需的 YAML frontmatter：
```yaml
---
title: <短标题>
description: <一句话总结，任务结束时更新为最终结论>
createdAt: <ISO 8601，永不修改>
updatedAt: <ISO 8601，每次编辑刷新>
---
```

Push API 在字段缺失时返回 `422 { error: "missing required frontmatter field: X" }`。

推荐正文结构（不校验）：

````markdown
```tasks
[done] 步骤 1
[run]  步骤 2
[wait] 步骤 3
```

## Plan

## Acceptance Criteria
- [ ] criterion 1

## Notes

## Confusions
- （只在真有不确定时写）
````

`tasks` 区块使用状态 `[done] [run] [wait] [fail] [skip]`，UI 应配状态指示器渲染。`Confusions` 区块是 agent 表达不确定性的通道；UI 应高亮。

**Push 通道**（两条都必需；两者都要幂等）：

A. **CLI**（主通道）——平台提供此二进制；agent 在每次有意义更新后调用：
```
worklog-cli worklog --session-id=<sid>
worklog-cli push <relpath> --session-id=<sid>
worklog-cli push-all --session-id=<sid>
```

B. **文件系统 watcher**（兜底通道）——运行时每 5 秒扫 `deliverables/` 的 mtime 变化并 push 检测到的更新。防 agent 忘记调用 CLI。

两条通道通过 `(session_id, path)` 上的 upsert 收敛。

### §2.5 知识

业务层写入通过清单同步 API（§2.3）进行，带 `lastPullVersion` 冲突检测。只读层（`common`、`domain`）通过 curator 通道写入，本规范不规定（如 admin UI、git 导入、或直接 DB）。

Agent 提炼文档推荐使用的 frontmatter：
```yaml
---
name: <短标识符>
sources: [deliverables/267, deliverables/412]   # 提炼自的 session id
distilledAt: <ISO 8601>
---
```

`sources` 字段（如存在）必须引用真实的 session deliverable 路径。读者据此可将任一被提炼的事实追溯到来源 worklog。

### §2.6 Recap 引擎

Tick：每 60 秒。

```
for each session where state = 'processing':
    idle_ms = now - session.last_input_at
    if idle_ms < 600_000:                              # 10 分钟
        continue
    if 此 idle 窗口已存在 recap:
        continue
    # 在隔离上下文中 spawn agent（fork session——不污染原对话历史）
    prompt = "用一句话总结过去 10 分钟（≤ 40 graphemes；一个中文字符算 1）。"
    text = run_isolated_agent(model = fast_model, session_fork = session.id, prompt)
    assert grapheme_count(text) <= 40                  # 平台侧强校验，不只靠 prompt
    insert into recaps (session_id, text, generated_by) values (session.id, text, fast_model)
    向 session.id 的 UI 订阅者广播 SSE 事件 'recap'
```

Recap 输出持久化在 `recaps` 表——与 agent 主笔消息分别存储。Recap 生成模型应比 session 主 agent 更便宜 / 更快（Haiku 级）。

### §2.7 Consolidation 引擎

Tick：实现定义（推荐每日 cron）。

```
for each workspace:
    candidates = worklog where created_at >= now - 7 天 AND session.state = 'completed'
    if len(candidates) < CONSOLIDATION_MIN_CANDIDATES:    # 默认 5
        continue
    proposals = run_agent_with_prompt(
        "读这些 worklog。把反复出现的模式 / 决策 / 踩坑提炼成业务知识 proposal。
         每条 proposal 输出一份 Markdown，frontmatter `sources: [...]` 引用输入 worklog。",
        inputs = candidates
    )
    for proposal in proposals:
        write to knowledge_docs (layer='business', path='_pending/<proposal.name>.md', ...)
        通知人审核员
```

**晋升**（人工，人审核门控）：通过清单同步 API（带 `lastPullVersion`），把文件从 `_pending/` 移到 `business/` 层的根部。

**来源追溯规则**：业务层任何带 `sources:` frontmatter 的文档视为 consolidated（agent 提炼）。无 `sources:` 的视为人类作者。

---

## §3 监控子系统（Pulse）

### §3.1 数据模型

```sql
CREATE TABLE pulse_metrics (
  id            TEXT PRIMARY KEY,                  -- 平台生成；推荐 UUID v4 或 `{workspace_slug}.{key}`
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  key           TEXT NOT NULL,                     -- 面向用户的稳定标识符，在 workspace 内唯一；匹配 [a-z0-9_-]+
  query         TEXT NOT NULL,                     -- SQL 或 DSL 字符串
  schedule      TEXT NOT NULL,                     -- cron 表达式
  thresholds    TEXT NOT NULL,                     -- JSON 规则数组
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
  values_json   TEXT,                              -- 数值结果
  rule_trips    TEXT,                              -- JSON：触发了哪些规则
  error_reason  TEXT
);

CREATE TABLE pulse_insights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES pulse_runs(id),
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  root_cause    TEXT NOT NULL,
  evidence      TEXT NOT NULL,                     -- JSON：时间戳、值、配置
  scope         TEXT NOT NULL,                     -- 评估了哪些假设 / 排除了哪些
  created_at    INTEGER NOT NULL
);
```

### §3.2 指标 Schema

一个指标完全由配置定义（无 per-metric 代码）。

```yaml
metric:
  key: dau_main_app                         # 稳定标识符，在 workspace 内唯一
  query: |                                  # 传给 AsyncQueryAdapter（§5.2）
    SELECT COUNT(DISTINCT user_id) AS dau
    FROM events
    WHERE event_date = '{{ds}}'
  schedule: "0 2 * * *"                     # cron：每日 02:00
  thresholds:
    - type: drop_pct
      params: { value: 0.05, baseline: "7d_avg" }
    - type: consecutive_drop
      params: { count: 3 }
```

`{{ds}}` 等占位符在提交前渲染（实现定义的 renderer；至少提供 `{{ds}}` = 当前日期）。

### §3.3 规则类型

必须支持以下 5 种。可新增（保留确定性：相同输入序列 → 相同结果）。

| `type` | `params` | 触发条件 |
|---|---|---|
| `drop_pct` | `{ value: float, baseline: "7d_avg"\|"1d_prev"\|"30d_avg"\|... }` | `current ≤ baseline × (1 − value)` |
| `spike_pct` | `{ value: float, baseline: ... }` | `current ≥ baseline × (1 + value)` |
| `absolute_below` | `{ value: float }` | `current < value` |
| `absolute_above` | `{ value: float }` | `current > value` |
| `consecutive_drop` | `{ count: int }` | 最近 `count` 次运行每次都比上一次跌 |

Baseline 由该指标自己的历史 `pulse_runs.values_json` 在匹配窗口上计算。

### §3.4 调度 Tick

每 60 秒：

```
now = current_time()
for each metric in pulse_metrics where state='active' AND next_run_at <= now:
    insert into pulse_runs (metric_id, state='pending', scheduled_at=now)
    update pulse_metrics set next_run_at = cron.next_after(metric.schedule, now)
    通知 worker 池（SSE 事件 'pulse-run:pending' 带新 run id；polling 兜底亦可）
```

### §3.5 原子认领

多个 worker 可对同一调度器操作。通过 SQL CAS 认领：

```sql
UPDATE pulse_runs
SET state = 'running', claimed_by = :worker_id, claimed_at = :now
WHERE id = :run_id AND state = 'pending';
```

成功认领 → 影响 1 行。失败者 → 0 行。失败者不重试；等待下一次 `pulse-run:pending` 事件。

### §3.6 调查流程

任一规则在 `pulse_runs` 行上触发时：

```
1. 创建调查 session：
     insert into sessions (workspace_id, title=f"Investigate: {metric.key}", state='processing', ...)

2. 在新 session 中注入 system 消息作为异常上下文：
     {
       metric_key, current_value, baseline, threshold_type, threshold_params,
       recent_runs: [{ scheduled_at, value }, ...]   // 最近 14 次
     }

3. 启动 agent，allowed_tools 包含（签名见 §5.4）：
     - async_query_submit / async_query_fetch     （发起更多 SQL）
     - knowledge_grep / knowledge_read            （搜索 business / common 知识）
     - worklog_push                               （边发现边写）
     - pulse_insight_complete                     （signal 调查完成；写入 pulse_insights 行）

4. 多轮循环：
     - Agent 提交一个查询 → 异步；agent 当前轮次结束。
     - Wakeup（§4.1）被 arm 在「查询完成」条件上。
     - 结果到达时，session 在下一轮被恢复，结果作为新消息注入。
     - 重复，直到 agent 发出 `pulse_insight_complete` 工具调用 OR 穷尽假设。

5. 持久化最终 insight：
     insert into pulse_insights (run_id, session_id, root_cause, evidence, scope)
```

单 session 内必须支持 `≥ 30 分钟实际时间` 和 `≥ 5 轮异步查询`。

### §3.7 Insight 输出规则

过滤或拒绝匹配下列措辞的 insight（调查 skill 的 system prompt 强制；持久化层双重检查）：

- "recommend further investigation of …" / "建议进一步排查"
- "continue to observe" / "持续观察"
- "consider checking …" / "建议查"
- "more data is needed"（未指明何种数据）/ "需要更多数据"（未指明）

必需输出字段（`pulse_insights` 列）：

- `root_cause`：明确的陈述 OR 显式封闭如 *"评估 N 个假设后未识别根因：A、B、C。"*
- `evidence`：具体——明确的时间戳、指标值、配置变更等（禁止「大约 X 时间」之类的甩锅措辞）。
- `scope`：评估了哪些假设、排除了哪些、为什么。

### §3.8 失败与重试

瞬时失败（查询超时、下游 5xx）：

```python
delay_seconds = min(base * (2 ** min(attempt - 1, 10)), max_backoff)
# 默认：base = 600，max_backoff = 3600，max_attempts = 6
```

连续失败 `max_attempts` 次后：
```sql
UPDATE pulse_metrics SET state = 'error' WHERE id = :metric_id;
```
指标退出调度，直到人工重置（`state='active'`，`fail_count=0`）。防止无限报警风暴。

---

## §4 运行时原语

### §4.1 Wakeup 引擎

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

暴露给 agent 的工具（传输实现定义——MCP 工具、进程内函数等）：

```
schedule_wakeup(sessionId, delaySeconds, prompt) → wakeupId
cancel_wakeup(wakeupId) → void
```

Tick（60 秒）：
```
for each wakeup where state='pending' AND fire_at <= now:
    set wakeups.state = 'fired'
    把 `prompt` 作为新 user 消息注入 sessions.id（恢复原对话线程，非全新开始）
    enqueue session 等待下一轮 agent turn（sessions.state = 'pending'）
```

**漂移**：唤醒可以晚于 `fire_at` 触发，绝不早于。漂移超过 30,000 ms 应记录日志供运维观察。

**链长限制**：每个 session 有一个累计唤醒计数。每次成功的 `schedule_wakeup(sessionId, ...)` 累加 **target** session（即传入的 `sessionId`）的 `chain_count`。当 `chain_count >= 50` 时，targeting 该 session 的后续 `schedule_wakeup` 调用返回错误。计数器**不**因 session 状态变更而重置；只有显式的运维操作才能清零。防止 agent 把自己循环成死锁。

**持久性**：唤醒持久化在 SOT DB 中，进程重启后存活。引擎每次 tick 从表里重新读。

### §4.2 Monitor 引擎

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

工具：
```
arm_monitor(sessionId, condition, prompt, singleFire=true) → monitorId
list_monitors(sessionId) → monitorId[]
stop_monitor(monitorId) → void
```

`condition` 是一个谓词描述符。至少支持：

```json
{ "type": "deliverable_exists", "sessionId": 42, "path_glob": "reports/*.md" }
{ "type": "agent_idle", "sessionId": 42, "ms": 30000 }
{ "type": "async_query_ready", "externalId": "snowflake-job-abc" }
```

实现可新增自定义谓词类型。

Tick（5 秒）：
```
for each monitor where state='armed':
    if evaluate_predicate(monitor.condition_json) is True:
        set monitors.state = 'fired'
        把 monitor.prompt 作为新 user 消息注入 monitor.session_id
        enqueue session 等待下一轮 agent turn
        if monitor.single_fire:  # 状态转换已自动 cancel
            continue
```

**Session 关闭自动停止**：当 `sessions.state` 进入 `('completed','cancelled','failed')`，把该 session 拥有的所有 monitor 的 `state` 置 `'cancelled'`。

**持久性**：同 Wakeup——DB 支持，重启后存活。

---

## §5 适配器

### §5.1 AgentRunnerAdapter

```typescript
interface AgentRunnerAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentRunEvent>;
}

interface AgentRunInput {
  cwd: string;                        // 物化 workspace 的绝对路径
  systemPrompt: string;
  allowedTools: string[];
  model: string;
  messages: Message[];                // 首轮为空；resume 时为历史
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

参考实现：Claude Agent SDK、OpenAI Codex app-server、Anthropic SDK 直连。

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

参考实现：Snowflake REST、BigQuery jobs.query、DuckDB-via-HTTP、PostgreSQL `LISTEN`、内存 mock。

### §5.3 StorageAdapter

```typescript
interface StorageAdapter {
  readFile(path: string): Promise<Buffer | null>;
  writeFile(
    path: string,
    content: Buffer,
    expectedVersion?: string,           // 乐观并发
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

参考实现：SQLite blob 存储（单机）、PostgreSQL（多机）、S3 + 元数据 DB、本地文件系统（仅开发）。

### §5.4 暴露给 Agent 的工具

下列工具是**平台暴露给 agent** 的（区别于 §5.1–§5.3，那些是平台向外部系统消费的接口）。Agent 通过平台选择的任何传输方式调用这些工具（进程内函数、MCP server、JSON-RPC 等）。下面的签名是规范的；传输方式实现定义。

```typescript
// 知识 & 产出（每个 agent 都用）
worklog_push(sessionId: number, content: string): Promise<{ version: string }>;
deliverable_push(sessionId: number, path: string, content: string, encoding?: 'utf-8' | 'base64'): Promise<{ version: string }>;
knowledge_grep(workspaceId: string, layer: 'common' | 'domain' | 'business', query: string): Promise<Array<{ path: string; snippet: string }>>;
knowledge_read(workspaceId: string, layer: 'common' | 'domain' | 'business', path: string): Promise<{ content: string; version: string }>;
knowledge_write(workspaceId: string, path: string, content: string, lastPullVersion?: string): Promise<{ version: string }>;   // 仅 business 层

// 异步查询（Pulse 调查、ad-hoc 分析）
async_query_submit(query: string, params?: Record<string, unknown>): Promise<{ externalId: string }>;
async_query_fetch(externalId: string): Promise<{ rows: unknown[][]; columns: string[] }>;

// 运行时原语（§4）
schedule_wakeup(sessionId: number, delaySeconds: number, prompt: string): Promise<{ wakeupId: number }>;
cancel_wakeup(wakeupId: number): Promise<void>;
arm_monitor(sessionId: number, condition: object, prompt: string, singleFire?: boolean): Promise<{ monitorId: number }>;
list_monitors(sessionId: number): Promise<number[]>;
stop_monitor(monitorId: number): Promise<void>;

// Pulse 调查闭合（§3.6、§3.7）
pulse_insight_complete(runId: number, rootCause: string, evidence: object, scope: string): Promise<void>;
```

平台可通过 AgentRunnerAdapter 的 `allowedTools` 暴露更多工具（见 §7.5）。以上是符合规范的 BizAgent 必须暴露给调查 agent（§3.6）和通用 session agent 的最小集合。

---

## §6 符合性测试

为下列每个 ID 提供自动化测试。声称符合 BizAgent 规范的平台需通过 §6.1–§6.3 全部测试。

**布局**：测试位于 `tests/conformance/`（见 §1），可用单一命令运行。规范不强制 runner——用适合你栈的（`npm test:conformance`、`pytest tests/conformance/`、`cargo test --test conformance` 等）。每个测试 ID 对应一个测试用例；实现按 ID 报告通过/失败。

### §6.1 记忆测试

| ID | 断言 |
|---|---|
| M1 | 4 层全部持久化，可通过清单同步（§2.3）寻址。 |
| M2 | 带外文件系统编辑**不**进入 DB；从 DB 重建文件系统得到字节相同的布局（不计时间戳）。 |
| M3 | Worklog 与 Recap 制品分别存储（不同表）；任一制品的读者可判断它来自哪条 authorship 路径。 |
| M4 | 只读层写入 → 403。业务层带 stale `lastPullVersion` 的并发写 → 409。会话层 CLI 与 watcher 并发写收敛。 |
| M5 | Worklog push 缺必需 frontmatter → 422 带清晰 `error` 消息。 |
| M6 | Recap 在隔离上下文（fork session）中运行；输出 ≤ 40 字；持久化在 `recaps` 表。 |
| M7 | Consolidation proposal 落在 `business/_pending/`；晋升需要显式人工操作。 |

### §6.2 监控测试

| ID | 断言 |
|---|---|
| P1 | 指标完全由 YAML/JSON 配置定义；不需要 per-metric 代码。 |
| P2 | 原子认领：并发 worker 下，任一 pending run 恰好被一个 worker 认领。 |
| P3 | 相同输入序列下规则评估确定性可复现。 |
| P4 | 规则触发启动调查 session（`sessions` 表新行），而非一次性输出。 |
| P5 | 调查 session 可跨 ≥ 30 分钟 + ≥ 5 轮异步查询。 |
| P6 | Insight 行拒绝禁用措辞（§3.7）；root_cause/evidence/scope 都填写。 |
| P7 | 连续 max_attempts 次失败后，指标转为 `state='error'` 并退出调度。 |

### §6.3 运行时测试

| ID | 断言 |
|---|---|
| W1 | 已调度的 wakeup 在 `fire_at` 或之后（漂移有界）触发；绝不早于。 |
| W2 | Wakeup 在 worker 进程重启后存活。 |
| W3 | `chain_count` 强制；session 内第 51 次 `schedule_wakeup` 返回错误。 |
| W4 | Monitor 谓词为真 → session 以配置 prompt 恢复。 |
| W5 | Session 进入终态时自动取消其所有 monitor。 |

---

## §7 特化指南

§1–§6 搭出的 baseline BizAgent 是行业中立的。要让它对你的业务有用，在其之上叠加以下内容。

### §7.1 加 Common 知识

把跨 workspace 的方法论、定义、playbook 填入 `knowledge/common/`（如事件复盘模板、KPI 词汇表、升级矩阵）。配 `INDEX.md`。对 agent 只读。

### §7.2 加 Domain 知识

每个业务领域（如 `e-commerce`、`ads`、`b2b-saas`），创建 `knowledge/domain/{domain-key}/` 填充领域专属概念（如 `gmv-definition.md`、`attribution-model.md`）。Workspace 通过引用加入某领域；agent 看到的是 `common` + 该 workspace 所在 domain + 该 workspace 的 business 层的并集。

### §7.3 加业务 Workspace

每条业务线建一个 workspace。每个 workspace 拥有：
- 自己的 `claude_md`（世界观），
- 自己的可写 `business/` 知识层，
- 自己的指标（§7.4）与技能（§7.5）。

### §7.4 加指标

按 §3.2 编写 YAML 指标定义。使用 5 种 baseline 规则类型；按需新增自定义规则类型（保留确定性契约）。

### §7.5 加 Agent 技能

技能 = 可复用的 agent 能力（如 `run-sql`、`generate-pptx`、`query-tracker`）。技能系统规范在 v0.1 中超出范围；技能实现为通过 AgentRunnerAdapter 的 `allowedTools` 暴露的扁平工具注册表。

### §7.6 加 UI

UI 层超出范围。在 SOT DB 之上按你团队的需要构建视图（session 检查器、指标 dashboard、知识浏览器等）。

---

## 附录 A：设计原理（可选阅读）

本附录记录关键设计决策背后的理由。实现 §1–§7 不需要阅读它；遇到歧义或考虑偏离规范时再查阅。

### A.1 为什么 DB 是 SOT（FS 是物化）

文件系统对 agent 用 `glob`、`grep` 读取很方便，但它无法成为跨进程、跨机器、跨部署模式的真理来源。两个进程同时编辑同一文件就漂移；平台模式与本地模式无法和解。把真理集中在单一 DB、把文件系统当作派生视图，消除了这类差异。任何客户端（server、worker、本地 agent）通过 DB 回放把同一个 workspace 物化为完全相同的样子。

### A.2 为什么 Agent 主笔 vs 系统压缩 分离

混合两者既混淆审计也混淆行为。MemGPT 让 LLM 决定保留什么（不透明的 eviction）。Letta 把记忆作为工具暴露（混淆作者权与工具语义）。mem0 从对话中事后抽取事实（丢失 agent 意图）。拆分作者权使 agent 成为它自己记忆的 *writer*（worklog、knowledge），而系统处理机械残留（idle session 的 recap）作为单独打标签的制品。读者总能判断谁写了什么。

### A.3 为什么是 scope-based sync（三种策略，不是一种）

单一同步规则无法同时满足三种语义。只读层代表共享真理（不能 fork）。业务层是协作的（并发编辑需要显式冲突信号，因此 `lastPullVersion`）。会话层在 `(session, path)` 维度上是单写者（upsert 足够，无需仪式）。对三者强加同一规则要么牺牲安全要么增添不必要的摩擦。

### A.4 为什么 Alert-as-Diagnosis（而非 Notification）

Datadog/Grafana/PagerDuty 止步于「指标 X 下跌 Y%」——接收者必须自己调查。Pulse 范式则启动 agent 调查、返回根因陈述。接收者基于诊断行动。支撑异步多轮调查（§3.6）和强制输出质量（§3.7）的基础设施并不简单——但*契约本身*（insight 而非 signal）才是差异化点。

### A.5 为什么不用 RAG

对于本规范的 agent 记忆，vector retrieval 是错的工具：

1. **范式错位**。RAG 把模型当作 top-k retrieval 的 *被动消费者*。Agent 用 `glob` / `grep` / 多轮 *主动 navigate*——它有上下文、有目的。RAG 是退化。
2. **信号质量**。Worklog 与 knowledge 文档关键词丰富且结构化。对这类内容，全文检索（FTS5、ripgrep）的召回质量优于 embedding 相似度——同样的原因让 Sourcegraph/Cursor/GitHub 在代码搜索上默认 ctags+regex。
3. **扩展路径**。当语料超出 agent 可消费量时，正解是 *Consolidation*（§2.7）——提炼成更少更密的制品——而不是 retrieve 得更聪明。

RAG 在跨语言模糊搜索、用户不知要找什么的开放探索、长尾非结构化网页内容上是正解。本规范的记忆制品没有一项满足这些条件。

---

## 文档历史

| 版本 | 日期 | 说明 |
|---|---|---|
| Draft v0.1 | 2026-05-26 | 首个公开草案。给 Code Agent 用的 BizAgent build 规范。 |
