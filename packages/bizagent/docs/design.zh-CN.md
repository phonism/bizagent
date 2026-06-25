# BizAgent 设计文档（v0）

> 本文与 `packages/bizagent/src/` 的实现保持同步，修改代码时应同步更新本文。
> 约定：代码内的一切文本（注释、CLI 输出、物化模板）使用英文，本设计文档使用中文。

---

## 1. 核心模型

Claude Code 的记忆以**代码仓库**为边界（一个 project 对应一个 repo）；BizAgent 的记忆以**业务**为边界，沿两个维度组织：产品线 × 组织层。

分区本身并不构成差异点——Claude Code 同样可以做到分区。BizAgent 的价值集中在两件事上：

- **写入治理**：对记忆的写入施加 schema 与权限约束（见 §6）。
- **worklog 蒸馏**：把每次会话产出的 worklog 提炼为可复用的 business memory（`promote`，见 §6.3）。

二者都由 hook 层实现。

一等实体就是**业务（business）**：业务由多个共享的**模块**（策略、后端、前端、数据等，各有自己的代码与部署）构成，业务与模块多对多。需求在业务下发生、去更新模块——这部分模型见 §2.1。

**命名与层级约定**（2026-06-10 定）：概念栈全部用领域词——**根**（一次安装的目录，纯物理、无领域语义，文档与代码不再使用 "org"）→ **产品线**（line，实体目录 `lines/<line>/`，装本线的知识层、模块与业务）→ **业务**（business，曾叫 workspace——那个词描述的是目录形态而非领域实体，已弃用）→ **需求** → **会话**；**模块**挂在产品线级、与本线业务多对多、**永不跨线**。三条硬规则：业务必须属于一条产品线（`--line` 必填）；业务 slug 全局唯一（跨线也不重名，CLI / 路由 / Remote 因此无需带 line 前缀，按 slug 扫描定位）；模块任何情况下不跨线 link。

---

## 2. 目录布局（跨 runtime 契约）

CLI 与 Agent SDK 都以同一个 business 目录为工作目录、读取同一批文件。**目录布局本身即是库与两个 runtime 之间的接口**。

```
acme/                                  ← 根（biz init 创建）
├── bizagent.config.json               ← { version, store, createdAt, web?, remote? }
├── prompts/                           ← 可选：根级 prompt 覆盖（*.custom.md）
├── skills/                            ← 根级 Claude Code skill 包（只读，文件即 SOT，见 §2.3）
│   └── <name>/SKILL.md
├── knowledge/
│   └── common/                        ← common 层（由 curator 维护，跨产品线共享）
└── lines/
    └── <line>/                        ← 产品线实体目录（biz line new，或首次使用惰性创建）
        ├── knowledge/                 ← 产品线层知识（curator 维护）
        ├── modules/                   ← 模块：本线共享技术组件，永不跨线（见 §2.1）
        │   └── <mod>/
        │       ├── module.json        ← { slug, type, source?, deploy?, createdAt, updatedAt }
        │       ├── code/              ← vendor 的模块代码（一个 git 仓，master = 源）
        │       └── memory/            ← 模块记忆（代码结构、部署流程、约定）
        └── businesses/
            └── <slug>/                ← 一个业务（slug 全局唯一，跨线扫描定位）
                ├── business.json      ← { name, slug, line, domain?, modules[], ... }
                ├── CLAUDE.md          ← 最小指针；重要信息在注入的 system prompt 中，不在此文件
                ├── .claude/settings.json  ← hook 接线：UserPromptSubmit=inject / PreToolUse=guard / Stop=stop
                ├── .claude/skills -> 根 skills/   ← skill 装配（biz new 创建，会话启动时补建）
                ├── knowledge/
                │   ├── business/      ← business 层文档（本业务私有）
                │   ├── common  -> 根 knowledge/common
                │   └── <line>  -> ../../knowledge（本线知识层）
                ├── modules/
                │   └── <mod>  -> ../../modules/<mod>   ← 链接的本线模块（只读 master，供分析）
                ├── memory/            ← business memory 记录（frontmatter 单元）
                ├── requirements/      ← 需求：跨会话任务容器（见 §2.2）
                │   └── <req>/requirement.md  ← 需求的活状态文档（目标 / story 清单 / 当前结论）
                └── .bizagent/         ← bizagent 自身的工作状态（隐藏）
                    ├── deliverables/<runId>/worklog.md  ← session 层：worklog 及中间产出
                    │   ├── .req                           ← 本次会话挂的需求 id（启动时由机器写入）
                    │   └── dev/<mod>/                     ← 开发时按需创建的 git worktree（分支 req/<req|runId>）
                    ├── worklog-index.md                  ← 所有 session 的摘要索引
                    └── remote-memory/                    ← 拉取的他人 business memory 缓存（启用 Remote 时）
```

> v0 不生成 `.mcp.json`：没有 MCP server，避免 claude 启动时挂上空接线。MCP 推迟到出现真实需求（更强的检索、或外部消费者）时再引入。

**标识符边界**：`business slug`、`module slug`、`line` 都使用同一类白名单（小写字母 / 数字 / 连字符，且必须以字母或数字开头）。这些值都会进入文件系统路径或 symlink 路径，不能接受 `../`、斜杠、空格或大写变体。公共 API（`newBusiness` / `newModule` / `linkModule` / `writeMemory`）和 CLI 入口都在写盘前校验；`writeMemory` 还要求目标 business 已存在，避免程序 API 绕过路径边界。

### 2.1 模块（共享技术组件，多对多）

业务由多个**模块**构成——策略、后端、前端、数据等，每个模块有自己的代码与部署。模块是**产品线级**的共享实体（`lines/<line>/modules/<mod>/`）：**业务与本线模块是多对多**（一个业务用多个模块；一个共享模块，如数据平台，服务本线多个业务），但**任何情况下不跨线**——另一条线要用同名组件，就在自己线里再登记一个。一条**需求**就是某业务下的一次会话，目标是更新某些模块。

概念上：**业务 = WHY**（需求、领域知识），**模块 = WHERE**（真实代码、部署、技术知识）。模块约等于 Claude Code 的一个 repo，业务是横切在多个 repo 之上的上下文。

**代码从哪来：source 只当知识，harness 不执行。** 与 `deploy` 同构：`module.json` 的 `source` 字段是一段**自由文本**（内部 Git 服务器、GitHub URL + clone 方式，随便写），注入进上下文让 agent 知道代码在哪、怎么拿；harness 不解析、不校验、不执行 clone/pull。`code/` 为空时由 agent 按 source 描述自行 clone（凭证来自用户环境）；需要最新代码时 agent 自己 `git pull` master。这使内部托管与外部 git 都能接入，而 harness 零感知鉴权与传输细节。「master 只读」指的是**不在 master checkout 上改代码、提交、切分支**；clone / pull / `worktree add` 这类维护操作是允许的（约定写在 `prompts/modules.md`）。

**代码访问：只读分析 vs 分支开发。** 模块代码 vendor 在 `lines/<line>/modules/<mod>/code/`（一个 git 仓）。业务把链接的模块 **symlink 进来**（业务目录下的 `modules/<mod>`，`linkModule` 按业务所在线解析），但分两种用法：

- **分析任务**：直接读 `modules/<mod>/code/`（master）。只读不冲突，多个业务、多条需求同时读同一个 master 也没问题——symlink 在这里完全够用。
- **开发任务**：**不在 master 上原地改**。需要改代码时，agent 按注入的约定**临时 `git worktree add` 一个独立工作树 + 独立分支** `req/<runId>`，在 `.bizagent/deliverables/<runId>/dev/<mod>/` 里改、提交。独立工作树 + 独立分支天然支持并发、互不干扰；分支上的提交就是交付物。

为什么不用 symlink 直接改：一个 git 工作树同一时刻只能在一个分支上，多对多 + 并发需求各自要分支，共享一个工作树会互相踩。worktree 解决这个，且共享 `.git` 对象库、很便宜。

**部署只当知识**：`module.json` 的 `deploy` 字段注入进上下文让 agent 知道模块怎么发，但 **agent 不执行部署**——它只产出分支，发布是外部流程。

注入：`buildSystemPrompt` 把业务链接的模块（类型 + source + 部署信息 + 模块记忆 + 上述取码/读/开发约定）拼进 system prompt 的「Modules」段（`prompts/modules.md`，分支名用本次 `runId`）。

> 本切片是最小实现。**模块轴的 worklog 索引/共享**（让动过同一模块的需求跨业务互见）、**模块记忆写治理**、**业务×模块交叉记忆**、SessionManager/web 接 `{业务, 模块}` 都留到下一刀。

### 2.2 需求（requirement，跨会话任务容器）

一件任务往往不是一个会话能干完的：需求拆成多个 story，每个 story 一个或几个会话。我们**不希望在一个对话里持续滚**（上下文越滚越长、compaction 丢细节、cache 前缀失效），正确姿势是**多个短会话 + 蒸馏过的交接**。需求就是承载这个交接的容器——它为**上下文**而生，不是工单系统：没有 DB、没有状态机、没有类型枚举。

- **形态**：一个需求 = `requirements/<req>/` 一个目录，核心是 `requirement.md`——活的状态文档（frontmatter `status:` + 目标 / story 清单 / 当前结论）。agent 用普通文件工具读写它；每个会话结束前更新「当前结论」，下个会话从这里接力。「做完了」= 把 `status:` 改掉，仅此而已。
- **关联**：1 需求 : N 会话，1 会话至多挂 1 个需求。链接是**机器在启动时写**的 marker（`deliverables/<runId>/.req`，与 `.session-id` 同款），不会漂移；反向（需求→会话列表）靠扫描推导（`listRuns` 的 `req` 字段），从不存储。
- **启动上下文**：挂需求的会话，`buildSystemPrompt` 注入需求状态文档**全文** + 同需求最近几个姐妹会话的 worklog **全文**（上限 5 个，更早的留在索引里）；business 其余工作维持一行索引。不挂需求的会话完全不受影响。
- **分支**：模块开发分支从 `req/<runId>` 改为 `req/<req-id>`（无需求时仍回退 runId）——同需求的第二个会话天然接上前一个会话的分支；分支已存在时复用（worktree 还挂着就直接进去干，不在了就不带 `-b` 重新挂）。
- **入口**：CLI `biz run --req <id>`；SDK `manager.start({ req })`（resume 时也要带 `req`，因为 resume 会铸新 runId）；web `POST /api/start?req=`；读取 `GET /api/businesses/:slug/requirements`。需求**懒创建**：第一次使用即建目录 + 骨架文档（`prompts/requirement.md`）。req id 会成为目录名和分支名，按 slug 白名单校验。

> 为什么不做成实体/表：先前版本用 work-item 实体的实践证明，status 没人更新、type 大半闲置，真正被用的只有「会话归组 + 共享产出」。这两样文件就够。story 也不实体化——就是 requirement.md 里的一个清单，会话认领一条去干。

### 2.3 Skills（只读能力包，src/skill.ts）

Skill 是 Claude Code 的原生机制（`.claude/skills/<name>/SKILL.md` + 脚本），bizagent 只做两件事：

- **装配**：根级 `skills/` 是唯一 SOT；每个业务一条 symlink（`.claude/skills -> 根 skills/`），`biz new` 时创建、会话启动时幂等补建（老业务下次运行自动接上）。两个 runtime 都从会话 cwd 自动发现，无需任何注入。
- **只读展示**：`biz skills` / `GET /api/skills[/:id[/file?path=]]` / client `listSkills`、`skillDetail`、`skillFile`。**刻意不提供写 API**——维护 = 直接改文件（编辑、git、部署/同步），平台只是展示窗口。`id` 是目录名（寻址键），`name` 是 frontmatter 展示名，两者可不同。文件读取与 hub 同款防护（安全段名、拒 `..`、不跟 symlink、realpath 圈定）。

> 为什么不用「DB 存内容 + fs 镜像」：SDK 没有编程注册 skill 的 API，skill 注定是文件——DB 拷贝只是第二真相源，还要为它写对账。与 run 映射标记同一个判断：文件即 SOT。

---

## 3. 记忆分层与可写性

记忆沿两个正交维度组织：

| 层（纵轴） | 写入者 | 落盘位置 |
|---|---|---|
| common | curator | 根 `knowledge/common`，symlink 进各 business |
| domain（line） | curator | `lines/<line>/knowledge/`，symlink 进本线各 business |
| business | agent + human | business `memory/` 与 `knowledge/business/` |
| session | agent | business `.bizagent/deliverables/<runId>/worklog.md` |

- **layer = 目录**：决定记忆的生命周期与写入权限。横向的工作类型划分由产品线（line）承担——line 既是目录也是知识层；记忆本身不再打标签（曾有过 scenario 标签设计，line 成为实体后职责重叠，已删除）。

---

## 4. 记忆记录格式

每条记忆是 `memory/<id>.md`：

```markdown
---
scope: business               # common | domain | business | session
source_session: 4081          # 来源：从哪个 worklog 蒸馏而来
confidence: 0.5               # 蒸馏产出默认 0.5，表示待审
writable_by: agent+human
updated_at: 2026-06-04T...
---
<正文：一条业务事实>
```

`id` 默认由「时间戳 + 正文 slug」生成（`writeMemory`）。frontmatter 解析器是零依赖的受限实现（`frontmatter.ts`），仅支持标量、`[a, b]` 数组与布尔值。

---

## 5. 记忆的三种使用方式

| 方式 | 作用 | 载体（v0） | 实现 |
|---|---|---|---|
| 被动注入 | business memory / 规则 / 协议 / 历史会话常驻于上下文 | 启动时拼装为 system prompt，经 `--append-system-prompt` 注入 | `context.buildSystemPrompt` |
| 主动读写 | agent 在任务中查询其他场景、写入新发现 | agent 内建文件工具（Grep / Read / Write）读写 `memory/` | 约定写在注入的 system prompt 中 |
| 生命周期治理 | 写入校验、worklog 蒸馏（可选） | hook（见 §6） | `governance.ts` |

**重要信息全部置于注入的 system prompt，不放入 CLAUDE.md。** CLAUDE.md 是可编辑文件（用户与 agent 均可修改），把受保护的规则与业务知识放在其中并不可靠。`--append-system-prompt` 注入的内容由 biz 完全控制、用户无法修改，因此是权威来源。CLAUDE.md 仅保留一句说明：本 business 由 biz 管理、上下文在启动时注入。`biz context <slug>` 可预览将要注入的内容。

关于「主动读写」为何使用文件工具而非 MCP：记忆的本质是文件，两个 runtime 都已内置可读写共享目录的文件工具。仅在「裸文件无法施加治理、或无法满足检索」时才引入额外代码——而 v0 在这一点上选择 hook，而非 MCP。

---

## 6. 治理与 hook 层

`newBusiness` 物化的 `.claude/settings.json` 接线如下：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "biz hook inject --business ." }] }
    ],
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "biz hook guard --business ." }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "biz hook stop --business ." }] }
    ]
  }
}
```

**hook 决策集中在 `hooks.ts`，runtime 只负责翻译。** `guardHook` / `injectHook` / `stopHook` 是 runtime 中立的决策函数，返回「拒绝 / 注入 / 拦截」的结构化结果，自身不做线格式转换。两个 runtime 调用同一批函数，各自翻译为对应的线格式：

- **CLI**（`cli.ts`）：settings.json 让 claude 调用 `biz hook ...` 子进程，输出 Claude Code 的 hook JSON（`permissionDecision` / `additionalContext` / `decision`）。
- **Agent SDK**（`runtime-sdk.ts` 的 `buildSdkOptions`）：进程内 hook 回调直接调用上述决策函数，返回 SDK 的 `HookJSONOutput`（同一族字段）。系统上下文经 `query()` 的 `systemPrompt`（`claude_code` 预设 + `append`）注入。SDK 侧的回调采用 fail-open 包装：决策函数抛错时记录并放行，不让单个 hook 中断会话。

策略只写一遍、两个 runtime 共用，这正是 §10「CLI ≡ SDK」在 hook 层的体现。决策函数可直接单测（`test/hooks.test.ts`）；SDK 装配也能在不安装 SDK、不调用模型的情况下单测（`test/runtime-sdk.test.ts`）。`--business .` 之所以成立，是因为 claude 与 SDK 均以 business 目录为工作目录。

### 6.1 写入治理（PreToolUse · guard）

`guardHook` 读取工具调用的 `tool_name` / `file_path` / `content`，对 `Edit` 还会读取 `old_string` / `new_string` 并在本地重建编辑后的完整文件，再调用 `validateMemoryWrite`。违规则返回 `permissionDecision: "deny"` 与 `permissionDecisionReason`（PreToolUse 的现行契约；`decision: "block"` 在此事件已弃用）；合法则不输出。

`validateMemoryWrite` 规则（路径先经 realpath 规范化，因此 business 内的 symlink 会解析到真实的 curator 目标）：

| 写入路径（realpath 后相对根） | 判定 |
|---|---|
| 根之外 | 放行（不归本库管理） |
| `knowledge/...`（根 common 层） | 拒绝：curator-only，agent 不得写入，应改写入 `memory/` |
| `lines/<line>/knowledge/...`（产品线层） | 拒绝：curator-only（业务透过 `knowledge/<line>` symlink 写到这里同样被拒） |
| 业务自己的 `knowledge/business/...` | 放行（业务文档，无 schema 要求，落在 `lines/<line>/businesses/<slug>/` 内） |
| `lines/<line>/businesses/<slug>/memory/*.md`（Write，含完整 content） | 校验 frontmatter：`scope: business`、正文非空；不满足则拒绝并给出具体原因 |
| 同上（Edit，可重建完整 content） | 校验编辑后的完整 frontmatter 与正文；不满足则拒绝 |
| 同上（Edit，无法重建完整 content） | 拒绝：memory 写入必须提供完整的 post-write content，不能只靠路径放行 |
| 其他（代码、worklog、模块 memory 等） | 放行（v0 不治理） |

`biz mem add` 与 web 的 memory 写入接口同样走 `validateMemoryWrite`，因此 CLI / web 不构成绕过 hook 治理的后门。

### 6.2 按轮注入（UserPromptSubmit · inject）

索引在会话启动时被拼入 system prompt，会话内是冻结的。要让运行中的会话感知到**其他会话期间新增的** worklog，依靠此 hook，在用户每次发消息时触发。

- Claude Code 没有「外部进程随时向运行中会话推送 `<system-reminder>`」的接口；模型只在轮次 / hook 边界吸收新上下文。因此选择 `UserPromptSubmit`。
- `freshIndexSince`（通过 `BIZ_RUN_ID` 识别当前 session）在 session 自己的目录中维护游标 `.seen-index`，每轮只返回新增的行（排除自身那一行）并推进游标。
- 有新增则返回 `additionalContext`；无新增则不输出，不注入也不消耗 token。
- **不自行包裹 `<system-reminder>`**：Claude Code 会用 `hook-additional-context` 模板自动包裹 hook 注入的内容，重复包裹会产生双层。提醒文案位于 `prompts/reminder-new-sessions.md`（模板，含 `${ENTRIES}`）。

启用 Remote 时，此 hook 还会在计算增量前先拉取远端索引与他人的 business memory（见 §7）。

### 6.3 worklog 强制与索引（Stop · stop）

`stopHook` 完成两件事：

**(1) 强制 worklog。** 实测中，真实任务下 agent 经常不主动写 worklog，仅靠注入的 prompt 无法保证。因此 Stop 时检查本次 run 是否已写 worklog：

- 启动时 runId 经环境变量 `BIZ_RUN_ID` 传入，hook 据此确定应检查哪个 `.bizagent/deliverables/<runId>/worklog.md`（`worklogWritten`）。
- 未写入则返回 `{"decision":"block","reason": <提醒>}` 拦截 Stop，agent 随后补写、再次触发 Stop。提醒文案位于 `prompts/reminder-worklog-missing.md`。
- 通过输入中的 `stop_hook_active` 防止死循环：已提醒一次仍未写入则放行，不再无限拦截。

**(2) 维护索引。** agent 只写自己的 worklog（含 frontmatter `description`），不直接操作共享索引；由 stop hook 将 `description` 汇入索引。

`updateIndex` 的行为：

- 扫描 `.bizagent/deliverables/*/worklog.md` 中尚未索引的项（按目录名排序，即时间序）。
- 用 `extractSummary` 取 worklog 的 frontmatter `description`（取不到则退化为旧式 `summary:` 行，再退化为首行）。
- 向 `.bizagent/worklog-index.md` 追加一行 `- <日期> · <description> · <runId>`。
- **并发安全**（共享 business 多 session 同时 Stop）：用 `wx` 原子方式认领 `.indexed` 标记（先创建成功者负责索引，其余因 EEXIST 跳过），追加用 O_APPEND（并发写不互相覆盖）。`.indexed` 同时充当幂等标记。该机制基于本地文件系统假设；NFS 需真正的锁。

worklog 采用 frontmatter 格式（与 Claude 的 memory / skill 一致，便于渐进加载——只有 `description` 进索引并常驻，正文按需读取）：

```markdown
---
description: <本次任务> → <结论 / 产出>
---
# Worklog
...（Request / Actions / Findings / Outcome）...
```

新 session 通过 `buildSystemPrompt` 将索引内联进 system prompt 的「Past sessions」段，浏览摘要后可按 runId 查阅对应的 worklog 全文。

> `biz hook promote`（将 worklog 的 `## Conclusions` 蒸馏为 business memory）保留为可选命令，默认不挂在 Stop 上。

---

## 7. 跨用户共享：Remote

**场景**：一个平台、多名用户，各自机器上都有本地 `biz`，共用同一个 business（同一 slug、不同 根、不在同一台机器）。目标是让他们看到彼此的 worklog 与 memory。

**前提不变**：每个 agent 自身的真相始终是本地文件。Remote 是其上叠加的一层**可选共享**；不配置时退化为纯本地，行为与单机一致。

### 7.1 接口

SDK 只依赖一个接口，共 5 个方法，由平台实现；SDK 不引入任何平台代码。

```ts
interface Remote {
  publishWorklog(o: { runId; line; content }): Promise<void>;
  fetchIndex(): Promise<IndexEntry[]>;
  fetchWorklog(runId): Promise<string | null>;
  publishMemory(o: { id; content }): Promise<void>;
  fetchMemory(): Promise<Blob[]>;
  publishTranscript?(o: { runId; offset; content }): Promise<void>; // 可选：transcript 只读镜像
}
```

它只是搬运索引行与 markdown 文本的存储，不理解业务类型，解析由调用方负责。一个 Remote 实例对应一个 business（按 slug 划分命名空间）。`publishTranscript` 是唯一的可选方法：原始 transcript 比 worklog 暴露多得多（文件内容、命令输出），所以共享它需要单独 opt-in（配置 `transcripts: true`，见 §7.3）；未开启时方法不存在，推送侧自动跳过。

### 7.2 接入点：publish 在 Stop，pull 在 inject

复用 §6 已有的两个 hook，不另起机制：

- **publish（`stopHook`）**：`updateIndex` 之后，将新索引的 worklog 发送到 remote；此外每轮把当前 run 的 worklog 正文重发一次（按 runId 覆盖，最新者生效），使他人能看到进度。索引行由 remote 端按 runId 去重，只追加一次。
- **pull（`injectHook`）**：在 `freshIndexSince` 之前先拉取 remote 索引，把本地 `.bizagent/worklog-index.md` 中缺失的行并入（解析本地索引后按 runId 集合去重，不做字符串包含判断）。并入后，`freshIndexSince`（按轮注入）与 `buildSystemPrompt`（启动注入）都透明地感知到他人的工作，无需另起一套。
- **transcript 镜像（`publishTranscript`，opt-in）**：Stop 时把本地 Claude Code transcript（inject hook 记录的 `.transcript-path`）自上次水位（`.transcript-pushed`，按 runId）以来的**完整行**推给 remote，单次封顶分块（积压跨多块/多轮追平）。水位在对方 ack 后才推进——丢 ack 重推的重叠由对方丢弃（幂等）；对方丢数据则以 gap 拒绝并带回它的水位，推送侧回退一次重推；本地 transcript 轮替（变短）则从头以 offset 0 重推（对方按覆盖处理）。**只推不拉**：镜像是 hub 上 web 只读查看的渲染源，不是数据同步——本地永远不拉别人的 transcript。

business memory 同样共享，但有一处刻意的差异：

- **publish（`publishMemories`）**：Stop 时扫描本地 `memory/`，按内容指纹去重（变更才发送）后发往 remote。
- **pull（`pullRemoteMemory`）**：inject 时拉取他人 memory，写入 `.bizagent/remote-memory/` 缓存（独立目录，不混入用户 git 跟踪的 `memory/`），按 id 去重并跳过自己原创的记录。`buildSystemPrompt` 的 business memory = 本地 `memory/` ∪ 缓存 `remote-memory/`（id 冲突时本地优先）。
- **差异**：worklog 进展是动态的，走每轮增量注入；business memory 是慢变的背景知识，进入启动时的 system prompt 即可，不做每轮增量注入。缓存跨 session 持久，business 活跃后基本始终为热。
- **不会回环**：publish 只读 `memory/`，pull 只写 `remote-memory/`，两个目录不相交，拉取的记录不会被重新发回。

**不采用后台定时拉取**：agent 只在轮次边界吸收新上下文，因此拉取时机就是 inject 这一刻；且 CLI 使用阻塞的 `spawnSync`，事件循环被占用，定时器无法触发，会导致 CLI 与 SDK 行为不一致。

**尽力而为**：每次 remote 调用都设超时（`withTimeout`，2s），拉取附带 TTL（`.bizagent/.remote-pull`，窗口内不重复拉取）。remote 缓慢或不可用时，本轮照常使用本地，不阻塞、不报错。

### 7.3 定制：固定接口与默认契约，实现由使用方决定

对外提供的是「接口 + 默认契约」，底层接什么由使用方决定。三档，从零代码到完全自定义：

| 档 | 配置 | 适用 |
|---|---|---|
| `file` | `{ "type": "file", "dir": "../hub" }` | 本地 / 共享文件夹，无鉴权。参考实现，也供测试使用 |
| `http` | `{ "type": "http", "url": "...", "headers": { "Authorization": "Bearer ${BIZ_TOKEN}" } }` | 遵循固定契约的平台。方法 / 路径 / body 固定，配置只提供 URL 与请求头 |
| `module` | `{ "type": "module", "path": "./my-remote.js" }` | 鉴权特殊、已有 API 不一致、或不走 HTTP——自行实现工厂返回 `Remote` |

- **token 不进入配置文件**：`http` 请求头中写 `${BIZ_TOKEN}`，运行时从环境变量替换，密钥留在环境中，不会被提交进版本库。
- **`http` 固定契约**（平台后端据此实现；方法与路径不可配置，需要变更则改用 `module`）：
  ```
  GET  {base}/index            -> 200 [{ runId, line }]
  GET  {base}/worklog/:runId   -> 200 text body | 404
  POST {base}/worklog          <- { runId, line, content }
  GET  {base}/memory           -> 200 [{ id, content }]
  POST {base}/memory           <- { id, content }
  POST {base}/transcript       <- { runId, offset, content } -> 200 { have } | 409 { have }
  ```
  方法 / 路径不开放给配置，是为避免在 JSON 中演化出一套难以维护的 HTTP 模板 DSL。任意请求塑形属于代码的职责，因此交给 `module`。`POST /worklog` 与 `POST /memory` 返回非 2xx 时，`httpRemote` 会抛错；上层 `publishWorklogs` / `publishMemories` 再用 best-effort 超时包装把它计为发布失败，而不会误报成功。
- **transcript 共享是单独的 opt-in**：`file` / `http` 块加 `"transcripts": true` 才会带上 `publishTranscript`（`resolveRemote` 按配置裁剪）；`module` 工厂自行决定返回哪些方法。`POST /transcript` 的 409 表示「会留洞」，body 带服务端水位 `have`，`httpRemote` 把它抛成带 `have` 的错误供推送侧回退。
- **`module` 工厂**：导出 `createRemote(ctx)`（或 default），`ctx` 为 `{ root, slug, config, env }`，返回（或异步返回）一个 `Remote`。`resolveRemote` 动态 import 它。
- **走 SDK 而非 CLI 时**：无需配置文件，直接构造 `Remote` 实例传入 `injectHook` / `stopHook`（及后续的 `SessionManager`）。CLI 因 hook 是新起的子进程、只能依赖配置与环境变量，才需要上述加载器。

开启共享只需修改配置，两个 runtime 适配器（CLI / SDK）无需改动——hook 自行从配置解析 remote。

> 若需要在自己未发起轮次时也实时看到他人进度（例如盯着仪表盘的 web 场景），不应让 SDK 轮询，而应在 `Remote` 上增加可选的 `subscribe`，由平台服务端主动推送。

### 7.4 hub：契约的服务端（平台侧，src/hub.ts）

跑着 `biz web`（或挂载 `createBizHandler` 的任意宿主，如 Next catch-all）的部署即可充当 `http` 契约的服务端——**hub 直接落在业务活数据上**，不另设中转存储：推上来的 worklog 写进 `deliverables/<runId>/`（立刻被 `listRuns` 列出，平台 UI 直接可见，但无 `.session-id` 故不可 resume——会话本体在对方机器上）；推上来的 memory 经 `validateMemoryWrite`（与写 hook 同一套治理，hub 不是后门）写进业务自己的 `memory/`，平台会话即刻可用；推上来的 transcript 块落成 `deliverables/<runId>/.transcript.jsonl` 镜像——`runHistory`（历史回放）与 `/api/run/:slug/:runId/stream`（live 视图，按对方的轮次更新）在本地 `.transcript-path` 缺席时回退读它，于是远端用户的会话在平台 web 上**只读可看**（镜像永远不带 `.session-id`，构造上不可 resume；镜像文件本身也不在 manifest 白名单中，不会被别的本地拉走）。

```
GET  /api/businesses/:slug/hub/index           契约 GET /index
GET  /api/businesses/:slug/hub/worklog/:runId  契约 GET /worklog/:runId
POST /api/businesses/:slug/hub/worklog         契约 POST /worklog（按 runId 幂等追加索引行 + 写 .indexed 防平台 Stop hook 二次索引）
GET  /api/businesses/:slug/hub/memory          契约 GET /memory
POST /api/businesses/:slug/hub/memory          契约 POST /memory（治理拒绝 → 422）
POST /api/businesses/:slug/hub/transcript      契约 POST /transcript（重叠丢弃幂等；留洞 → 409 + { have }）
GET  /api/businesses/:slug/hub/manifest        只读拉取面：[{ path, size, mtime, sha256 }]
GET  /api/businesses/:slug/hub/file?path=      只读拉取面：单文件原文
```

本地端配置一份即可覆盖全部业务——`url` 支持 `${SLUG}` 插值（先替换 slug 再替换 `${ENV}`）；`transcripts: true` 额外开启会话 transcript 的只读镜像（不加则只共享 worklog / memory）：

```json
{ "remote": { "type": "http",
    "url": "https://platform/api/businesses/${SLUG}/hub",
    "headers": { "Authorization": "Bearer ${BIZ_REMOTE_TOKEN}" },
    "transcripts": true } }
```

**manifest / file 是给将来 `biz pull` 冷启动准备的只读面**，按白名单服务：`business.json`、`memory/`、`knowledge/business/`、`requirements/`、worklog 索引与各 run 的 `worklog.md`。其余一概不出（run 标记、缓存、`.claude/`、模块符号链接）。安全三层：runId / memory id 必须是单段安全文件名；路径拒绝绝对路径与 `..`；遍历不跟符号链接 + realpath 必须落在业务目录内——因此 knowledge 的 common / line 符号链接层天然不在清单中，curator 内容只能平台 → 本地单向分发，永远不会被推回。

尚未做（按需）：`biz pull <slug>` 冷启动命令、本地非会话时段的定时 tick 同步、`Remote.subscribe` 实时推送。

两个 runtime 共用 §6 的 hook 决策与本目录布局，区别仅在如何启动 agent。

### 8.1 CLI launcher（`biz run`）

不采用 `cd businesses/<slug> && claude` 的方式，而是以 `biz run`（或在 business 内直接 `biz`）作为 launcher，由 biz 负责 spawn agent。agent 进程继承 business 的 CLAUDE.md 与 `.claude/settings.json`（hooks）。

- 启动前重新物化 CLAUDE.md，并将完整上下文经 `--append-system-prompt` 注入。
- agent 选择顺序：`--agent <name>` > `$BIZ_AGENT` > 默认 `claude`。
- 二进制路径可经 `CLAUDE_PATH` / `BIZ_AGENT_BIN` 覆盖。
- 实现：`runtime-cli.ts` 的 `runAgent`，阻塞式 `spawnSync`，stdio 继承。

**引导式初始化（`biz setup`）**：结构性的初始化只要求 slug + 产品线，其余元数据全部可以由对话补齐。`biz setup <slug>` 用与 `biz run` 相同的 launcher，但以 `prompts/business-setup.md`（经 `buildBusinessSetupPrompt` 渲染，含 `${LINE}`）作为开场任务：agent 访谈用户补业务画像（`biz set --name --domain`）、登记并链接本线模块（`biz module new --line <line> --source --deploy` + `biz link`，随后按 source 把代码 clone 进 `code/`）、最后给 `knowledge/business/` 做第一轮冷启动，缺口写进 worklog 的 Open questions 交给下个会话。访谈交给 agent、结构落盘交给 CLI 命令——不做 readline 表单向导（那是往 harness 里塞 TUI），也不用 SDK 自建轻量 TUI（权限审批、提问 UI、流式渲染 Claude Code 全有，重造不值）。web 侧对等入口是 `POST /api/start?task=setup`（服务端拼同一个 prompt，见 §9.2）。最短路径因此是三步：`biz init` → `biz new <slug> --line <line>`（线惰性创建）→ `biz setup <slug>`。

**模块同款（`biz module setup <mod> [--in <biz>]`）**：引导会话给单个模块做冷启动——按 source 把代码 clone 进来（已有则 pull）、访谈中纠正记录的事实（`biz module set`）、把代码结构 / 构建测试约定 / 部署流程 / 坑写进 `modules/<mod>/memory/`（模块记忆是线内共享的技术知识，业务专属事实不写这里）。session 机器是业务锚定的，所以会话**在某个 link 了该模块的业务里跑**：恰好一个业务 link 它就自动选，多个则 `--in <biz>` 指定，没有则提示先 `biz link`（解析逻辑是纯函数 `businessesLinking`，扫描派生）。web 对等入口 `?task=module-setup:<mod>`（该业务必须 link 它，否则忽略）。

### 8.2 Agent SDK（`buildSdkOptions`）

`runtime-sdk.ts` 将本 business 的 harness 接入 `claude_code` 的 `query()`：`systemPrompt` 用 `{ type: "preset", preset: "claude_code", append }`，并以进程内回调接入 PreToolUse / UserPromptSubmit / Stop（调用与 CLI 相同的决策函数）。本模块只做纯 options 装配；SDK 是可选 peer 依赖，由 `SessionManager`（session.ts）在实际运行时通过变量化的 import specifier 动态加载，故构建期不要求其存在。

不启用 project `settingSources`：否则 business 物化的 `.claude/settings.json` 命令 hook 会与进程内回调重复触发。

### 8.3 Claude 可执行文件解析

Agent SDK 必须收到 Claude Code 二进制的**绝对路径**。若仅给出名称、shell 别名，或交由 SDK 自行解析，可能落到非二进制文件上，spawn 失败并报 `EBADMACHO`（"Malformed Mach-o file"）。

`resolveClaudeExecutable`（`runtime-cli.ts`）采用分层解析，覆盖多数环境并保留逃生口：

1. 显式覆盖：`BIZ_AGENT_BIN` / `CLAUDE_PATH`，优先级最高。
2. PATH 扫描：`findOnPath("claude")`，覆盖从 shell 启动的常规安装。
3. 已知安装目录：`~/.local/bin`、`~/.claude/local`、`/opt/homebrew/bin`、`/usr/local/bin`——应对 PATH 被精简的场景（如以 service / daemon 方式启动）。
4. 均未命中则返回 undefined，调用方据此给出「请设置 `CLAUDE_PATH`」的清晰错误，而非晦涩的 `EBADMACHO`。

`session.ts` 通过 `pathToClaudeCodeExecutable` 传入解析结果。

### 8.4 权限模式

无人值守的服务端 agent 没有人工逐项审批工具调用，默认权限模式下文件写入（包括 worklog）会被拒绝。`SessionManager` 暴露 `permissionMode`：

- 默认 `acceptEdits`：自动放行文件写入（worklog / memory 可写），但不放开 Bash 等。
- 需要完全自主（agent 要执行 Bash 等）时由运维显式设为 `bypassPermissions`（等价于 `--dangerously-skip-permissions`），这是一项明确的部署决策，不作为默认。
- 需要更细的策略时可传入 canUseTool 回调。

---

## 9. web 层

web 不是第三个 runtime，而是在 Agent SDK runtime 之上叠加的 HTTP 层。

### 9.1 SessionManager

`src/session.ts` 是该层传输无关的核心：一个会话对应一个长活的 SDK `query()`（streaming-input 模式，输入是可多轮推送的 async iterable），输出被映射为一串 typed `SessionEvent`，做多订阅者广播并支持 resume。`systemPrompt` 与三个进程内 hook（worklog 强制、共享）完全复用 `buildSdkOptions`。

事件类型：

```ts
type SessionEvent =
  | { type: "message"; text; uuid? }       // assistant 文本
  | { type: "tool"; name?; phase; uuid? }
  | { type: "worklog"; runId; content }     // 由 agent 写入 worklog 文件投影而来
  | { type: "job"; ticket; status; label?; result? } // 后台作业生命周期（见 §9.3）
  | { type: "idle" }                        // 本轮应答结束
  | { type: "error"; message }
  | { type: "closed" };
```

**围绕 `query()` 的双工**：输入是可推送的 async 生成器（`makeInputChannel`：`push(text)` 入队、`close()` 结束），streaming-input 模式下多轮复用同一个 query；输出迭代 `query()`，`mapMessage` 将每条 SDK 消息映射为事件，`Broadcast` 分发给所有订阅者（附带一小段最近事件缓冲，使后加入的标签页能补齐）。一轮结束以 SDK 的 `{type:"result"}` 标记并发出 `idle`；起始的 `{type:"system",subtype:"init"}` 用于捕获 `claudeSessionId`。

**worklog 事件**：不要求 agent 学习新接口——它照常用 Write / Edit 写 `.bizagent/deliverables/<runId>/worklog.md`，`makeWorklogWatcher` 检测到文件变化即投影一条 `{type:"worklog"}`（按内容去重）。

**worklog 强制**：沿用现有 Stop hook（未写则拦截提醒一次，已写则放行），多轮聊天下同样适用，无需特殊处理。

**多用户鉴权**：`resolveAuth(identity)` 预留接口，默认返回 `{}`，沿用宿主机 `claude login` 的订阅；需要 per-user key 或自定义 claude 路径时返回相应字段。鉴权细节由部署方决定。

**恢复（三部分各自负责）**：

| 待恢复内容 | 负责方 | 方式 |
|---|---|---|
| agent 上下文（继续对话） | SDK | `resume(claudeSessionId)`，对应 `manager.resume()` |
| worklog | 本库 | 读取 worklog 文件 |
| 聊天历史（界面显示既往消息） | 平台 | 自行持久化与回放，core v0 不实现 |

`resume` 只重新发出新消息、不回放既往 transcript，因此本库不解析 Claude Code 内部的 jsonl。

**分叉（fork）**：`manager.fork({ business, fromClaudeSessionId, atMessageUuid? })` 从一个已有会话的 transcript 分叉出新会话——底层是 SDK 的 `resume + forkSession`，复制 transcript、原会话不动；分叉出的会话有自己的 `claudeSessionId`。`atMessageUuid` 可从某条历史消息处分叉而非末尾（SDK 不识别该字段时退化为从末尾分叉）。新 id 由平台保存，本库不存。

**隔离作用域（scope）**：`start` / `resume` / `fork` 都接受可选的 `scope?: Scope`（`src/scope.ts`：分层、不透明、可序列化的隔离标识，如 `scope("commerce","webstore")`）。本库只把它**透传 + 命名空间化**（`scopeKey` 用于键/前缀），从不存储或鉴权——「谁能访问哪个 scope」属于部署方的数据库与鉴权。它把原本隐含在 business slug 里的隔离提为显式的一等参数，供调度等 SPI 共用。

**模型解析（ModelResolver）**：`createSessionManager({ resolveModel })`（`src/model.ts`）把调用方给的**逻辑 model key**（如 `"opus"`）解析为 SDK 需要的具体配置 `{ model, claudeExecutable?, env? }`——同一个 key 在不同后端（官方 API 与私有网关）会映射成不同 model id。本库只给契约与默认实现（原样透传 = 旧行为），注册表与后端路由由部署方实现。与 `resolveAuth` 的分工：后者按「谁在用」决定凭证/默认二进制，前者按「用哪个模型」决定后端；两者都触及二进制/env 时，模型级结果在 `authOptions` 之后合并、优先生效。

**位置与测试**：`src/session.ts` 位于 core 包，SDK 仍为动态 import（可选 peer 依赖）。纯逻辑（输入通道、广播、`mapMessage`、worklog 投影）全部导出且不依赖 SDK 即可测试（`test/session.test.ts`），与 `runtime-sdk` 一致；真正调用 `query()` 的只有 `start()` / `resume()`。

### 9.2 `biz web`：内置 web 平台

平台不在 init 时生成可编辑的 server 文件（那样每个根 都会分叉一份，难以维护，且违背「重要内容不落成可编辑文件」的原则），而是做成 `biz` 的内置命令，与 `biz run` 对称：

- `biz run`：启动一个 agent（CLI 入口）。
- `biz web`：启动平台服务器（web 入口），读取同一个根，列出全部 business，选择后进入对话，右侧实时显示 worklog。

`src/web.ts`（`createWebServer` / `startWebServer`）用 node:http 将 `SessionManager` 暴露为 SSE（输出）+ POST（输入）：

| 方法与路径 | 用途 |
|---|---|
| `GET /` | 返回页面 |
| `GET /api/health` | 根概览（root / version / business 数），兼作探活 |
| `GET /api/lines` | 列出全部产品线（= `biz line list`） |
| `POST /api/lines` | 创建产品线（= `biz line new`，body `{ line }`） |
| `GET /api/lines/<line>/modules` | 列出该线的模块，meta 已解析（= `biz module list --line`） |
| `POST /api/lines/<line>/modules` | 在线内创建模块（= `biz module new`，body `{ slug, type, source?, deploy? }`） |
| `GET /api/lines/<line>/modules/<mod>` | 单个模块的 meta |
| `PATCH /api/lines/<line>/modules/<mod>` | 纠正模块记录（= `biz module set`，仅 type/source/deploy 可改） |
| `GET /api/businesses/<slug>/modules` | 业务链接的模块，meta 按其所在线解析 |
| `POST /api/businesses/<slug>/modules` | 链接模块（= `biz link`，body `{ module }`，仅限同线） |
| `GET /api/businesses` | 列出根内全部 business（JSON，含所属 line） |
| `POST /api/businesses` | 创建 business（= `biz new`，body 为 JSON，`line` 必填） |
| `GET /api/businesses/<slug>` | 单个 business 元数据（= `biz show`） |
| `GET /api/businesses/<slug>/context` | 预览启动注入的 system prompt（= `biz context`） |
| `GET /api/businesses/<slug>/memory?scope=&query=` | 检索 business memory（= `biz mem list`） |
| `POST /api/businesses/<slug>/memory` | 写入一条 business memory（= `biz mem add`） |
| `GET /api/businesses/<slug>/worklog` | worklog 索引（结构化条目数组） |
| `GET /api/businesses/<slug>/worklog/<runId>` | 单个 session 的 worklog 全文 |
| `GET /api/businesses/<slug>/deliverables/<runId>` | 列出某 run 的产出文件 |
| `GET /api/sessions` | 当前活跃（内存中）会话列表 |
| `POST /api/start?business=<slug>[&resume=<claudeSessionId>][&task=setup]` | 建立或恢复会话，返回 `{ id, runId, business }`；`task` 在新建时预置开场任务（如引导式 setup），resume 时忽略 |
| `POST /api/send?id=<id>` | 推送一轮用户输入（body 为文本） |
| `GET /api/stream?id=<id>` | 以 SSE 流式推送该会话的 `SessionEvent` |

除会话三件套（`start` / `send` / `stream`）走 SDK 外，其余接口都是对 core 纯函数（`listBusinesses` / `readBusinessMeta` / `recall` / `writeMemory` / `buildSystemPrompt` / `readWorklogIndex` 等）的薄包装，不依赖 SDK，与列表路由一同单测（见 §13）。它们与 §10 的 CLI 命令一一对应——同一批 core，两个前门。写入 business memory 经与 hook 相同的 `validateMemoryWrite` 治理，**web 不构成绕过治理的后门**。

传输为 **SSE + POST**：输出单向流走 SSE（`text/event-stream`，前端用 `EventSource`），输入单独 POST。相比 WebSocket 更简单，且对代理与重连更友好。页面 HTML 是打包资源 `web/app.html`，随包分发（与 `prompts/` 同理），不是根内的可编辑文件。

**init 负责配置平台**：`biz init --web [--port N]` 向配置写入 `web: { port, host }` 块，`biz web` 据此启动（不带配置也可运行，使用默认端口）。`biz init --remote file:DIR|http:URL` 同时写入共享配置。因此 `biz init --web --remote file:../hub` 一条命令即可初始化一个「可多人 web 访问且互相共享」的平台。

> 这是 v0 的内置简易服务器（node:http，零新增依赖）。可复用、不绑定框架的 HTTP 适配层（标准 `Request → Response` + SSE 编解码 + 浏览器 client，独立成包）是后续工作。

### 9.3 长任务（后台作业）

有些活是异步的、还慢：典型如提交一段 SQL 到某个外部查询服务，提交后只拿到一个 id，要等几分钟才有结果。需求很明确：**提交后不能挡着对话**（用户还要继续和 agent 讨论别的），**结果出来要自动回到当前对话**（而不是让 agent 自己原地轮询）。

把这件事抽象成一个**后台作业**：一份活过当前回合的待办。agent（或某个工具）发起它，立刻拿到一个 ticket，不阻塞；作业结束时，结果通过**同一条 input 通道 push 回去**——即在原上下文里重新唤起 agent 接着说——同时广播一条 `{type:"job"}` 事件给界面。

**为什么靠 push 回 input 通道**：streaming-input 模式下，`query()` 在一轮 `{type:"result"}` 后不结束、挂起等待下一条输入。作业结束时 `input.push(结果)` 正好唤醒它，开启新一轮，且上下文不变。这就是「重新唤起」，复用既有机制而非新造通道。Claude Code 交互式自带「后台跑完自动叫醒」，但 Agent SDK 没有——用 SDK 时 host 自己就是那个调度者，本库把这一层补上。

**两种完成方式**（对应「要么轮询、要么人触发」）：

| 方式 | API | 触发者 |
|---|---|---|
| 轮询 / 内部 await | `JobRegistry.run(label, fn)` | `fn()` 在后台跑（轮询外部任务状态等），resolve 即完成 |
| 外部触发 | `JobRegistry.open(label)` + `resolve(ticket, result)` | 人点一下 / webhook / 外部 poller |

两条最终都走同一个动作：注入结果 + 发 `job` 事件。`run` 的 `fn` 是 detached 执行（`JobRegistry.run` 同步返回 ticket，绝不在工具处理函数里 await），因此既不挡对话，也避开了 SDK「单个 MCP 调用超过 60s 要改超时」的限制。

**agent 怎么用**：

- 进程内自带工具 `expect_result(note)`：对应「外部触发」——agent 表示「我在等一个带外结果」，拿到 ticket 后照常聊；结果由 `biz job done` / web 按钮 / webhook 送回。
- 领域轮询工具（如外部 SQL 查询）由部署方通过 `createSessionManager({ makeTools })` 注入：工具处理函数里调 `ctx.runJob("sql …", () => 提交并轮询())` 后立即返回；agent 调它就像调任何工具，只是结果晚点自动到。这条路里 **agent 不轮询**，轮询是 host 的事。

进程内工具用 SDK 的 `createSdkMcpServer` + `tool()` 构造，名字列入 `allowedTools`（自动批准，headless 下不会卡在审批）。

**落在哪一层**：作业机制属于 `SessionManager`（传输无关，任何宿主都能用，不只是 web）；web 只多两个口子，且 `job` 事件本就随既有 SSE 流出去，无需额外接线：

| 方法与路径 | 用途 |
|---|---|
| `GET /api/jobs?id=<id>` | 列出该会话仍在等待的作业（界面渲染待办卡片） |
| `POST /api/jobs/done?id=<id>&ticket=<ticket>` | 外部触发完成（body 为结果文本），等价于 `resolveJob` |

**常驻前提**：作业要活得比单个回合久，因此需要一个常驻进程托管 `SessionManager`——`biz web` 就是默认的那个 host。`biz run` 那条一次性 CLI 路（spawn 完即退）拿不到后台作业，但这不亏：CLI-交互那头是真 Claude Code，自带后台与调度，本就不需要这套。

### 9.4 CLI 的实时渲染（transcript 镜像）

`biz run` 保留真正的 Claude Code TUI（终端归它画），但 agent 在对话里会随手吐 ```chart / ```mermaid / 表格这类富内容，终端渲染不了。于是给一个**只读的浏览器镜像**：终端照常驱动，浏览器实时渲染这些 fence。

**为什么读 transcript**：fence 出现在对话里、不只在最终报告里，而 TUI 又不把渲染流分给外部。保留 TUI 的前提下，对话内容唯一可靠的来源就是 Claude Code 自己的会话 transcript（一个 JSONL）。Claude Code 通过 hook 输入把 `transcript_path` 正式交给我们，所以这不是 hack；我们只读其中最稳的部分（assistant 文本块 + 人类提问 + 工具标记），格式变了就少渲染、不崩。真正的 SOT 仍是本库自己的文件，transcript 只当渲染源。

**复用既有的流**：transcript 每行≈一条 SDK 消息，`transcriptToEvents` 直接复用 `mapMessage` 投影成 `SessionEvent`；于是 web 会话和 `biz run` 会话**汇到同一种事件流、同一套渲染**，只是源不同（live `query()` vs transcript 文件）。

| 部分 | 做法 |
|---|---|
| 捕获路径 | `biz run` 的 inject hook 把 `transcript_path` 写到 run 目录（`.transcript-path`，best-effort） |
| 投影 + tail | `src/transcript.ts`：`transcriptToEvents` / `readTranscriptEvents` / `makeTranscriptTailer`（按整行增量，复用 `mapMessage`） |
| 服务端 | `GET /run/<slug>/<runId>` 返回 viewer；`GET /api/run/<slug>/<runId>/stream` tail 该 run 的 transcript 并 SSE。纯文件驱动，不经 SessionManager |
| 页面 | 专用自包含 `web/viewer.html`（**不复用 app.html**）：只读镜像，marked + echarts + mermaid 走 CDN 懒加载、离线优雅降级 |
| 启动 | `biz run --view [--view-port N]`：旁起一个 `biz web` 子进程并打开浏览器到该 run 的 URL；TUI 退出时收掉子进程 |

> 渲染的是"对话里实时出现的 fence"（transcript 镜像）；agent **存盘**的 deliverable 文件可走同一个渲染器作为附加。刻意不打包成平台级 React 副本——一个自包含 viewer 页 + 懒加载 viz，量级轻得多。

---

### 9.5 跨会话调度：自唤醒（wakeup）

§9.3 的后台作业解决「同一个活跃会话内」的等待；这里解决「跨会话、跨重启」的调度：让 agent 安排自己在一段时间后被重新唤起，即使期间会话已空闲、标签页已关、进程已重启。

边界划分是这一层的核心——三方各管一摊：

| 零件 | 谁做 |
|---|---|
| 表达意图的工具 `defer_continue` | 本库（内置进程内工具） |
| 决策纯函数（到点判定、延迟夹取、链计数防失控） | 本库（`src/schedule.ts`，可单测） |
| `SchedulerStore` / `Notifier` 契约 | 本库 |
| 存 wakeup 的表、那个定时器、到点真正重跑会话 | 宿主（`biz web` 给参考实现，平台用自己的 DB/进程） |

**为什么不直接用 Claude Code 的 ScheduleWakeup**：SDK 会话里原生 ScheduleWakeup 确实存在，但它的「到点唤醒」落地在 Claude Code 自己的调度器里，进不了本库/平台的存储与重跑逻辑。所以本库提供进程内工具 `defer_continue` 取而代之，把唤醒意图写进注入的 `SchedulerStore`。

**`defer_continue` 工具**：仅当 `createSessionManager({ scheduler })` 配置了 store 时才注入（用法说明也随之注入 system prompt——见 §11，谁注入工具谁描述）。agent 给 `delaySeconds`（夹取到 [60, 3600]）与 `wakePrompt`（醒来后的指令）；handler 把一行写入 store（含 `claudeSessionId`、`business`、`wakeAt`、`wakePrompt`、`chainCount`），立即返回，让 agent 结束本轮。

**链计数防失控**：每次唤醒起的会话带着 `wakeupChain`（这是第几次唤醒），`defer_continue` 写入时 `chainCount = wakeupChain + 1`；宿主到点 `resume` 时必须把上一行的 `chainCount` 透传回去，链才不会断。到上限（50）后工具拒绝再排，逼 agent 收尾。

**tick 纯函数**：`dueWakeups(rows, now)` 给定待处理行与当前时间，分出「该触发」与「超限该退休」两组；`clampDelay` / `chainExhausted` 是配套判定。无 I/O、可测。

**SchedulerStore 契约**：`insert / due / settle` 三个方法。`src/scheduler-file.ts` 是 JSONL 文件参考实现（单进程够用）；平台用自己的表。

**为什么不出 cron 订阅契约**：周期性「按计划跑一段 prompt」（订阅 / 定时任务）看似 wakeup 的同胞，但它不是 harness 原语。剥掉宿主本就该自管的 cron 解析、时区 / DST 政策与存储后，本库能贡献的通用内核几乎为零——到点判定只是一行 `nextAt <= now`。所以本库刻意**不**出 `SubscriptionStore` 这类契约：宿主用 wakeup 原语 + `start` / `resume` 自行搭建，订阅定义存哪、cron 文法都归宿主。给死契约只会用一个走样的形状（DB row，把定义与运行态焊在一起）绑住宿主——实测平台选择「定义即文件、运行态进 DB」，根本套不进 row 模型。周期任务属于应用层，参考实现见平台的订阅 / Pulse 引擎。

**宿主参考实现（`biz web`）**：`createWebServer` 起一个 60s 的 `setInterval`（unref，不阻塞进程退出），每次 `due → dueWakeups → 触发`。触发时维护一张 **`claudeSessionId → 活跃会话` 注册表**：会话还活着就直接 `send(wakePrompt)`，否则 `resume(..., wakeupChain)` 重新拉起——**保证唤醒与用户重连收敛到同一个 query，不会对同一份 transcript 开两个并行 query**。会话 ready 时登记、closed 时注销。平台用自己的 scheduler + worker 替换这套即可。

**Notifier**：`src/notify.ts` 的窄 SPI（`(Notification) => Promise<void>`，默认 no-op）。定时任务跑完、链超限等场景推给人；收件人是不透明 id，由部署方解释。本库不实现具体通道。

**Monitor 不在本库重做**：监控后台进程用 Claude Code 原生 Monitor 即可——SDK 会话里它可用，spawn / tail / 超时 / 事件过多自动停都由 claude 二进制完成（生命周期以 `system` 消息的 `task_started` / `task_updated` 出现在流里）。本库不造 `arm_monitor`、不 spawn 进程，最多把这些事件映射进 `SessionEvent` 流。这与 wakeup 正相反：wakeup 原生工具的落地不归我们、故自造；monitor 原生工具自带落地、故直接用。

> 已用真实会话验证：agent 正确调用 `defer_continue`、handler 按预期写入 store、capabilities prompt 注入生效、Stop hook 的 worklog 强制在 SDK 路径同样工作。「到点 resume」依赖 SDK 已确认的 resume 路径，与 `start` 同源。

## 10. CLI 与编程 API 的对等

`cli.ts` 与 SDK 使用方 import 的是同一批 core 函数（由 `index.ts` 导出），CLI 不含业务逻辑。

| CLI | 等价编程接口 |
|---|---|
| `biz init [dir] [--web] [--port] [--remote]` | `initRoot({ root, web, remote })` |
| `biz line new <line>` / `biz line list` | `newLine({ root, line })` / `listLineSlugs(root)` |
| `biz new <slug> --line <line> [--name --domain --module]` | `newBusiness({ root, slug, line, modules, ... })` |
| `biz module new <slug> --line <l> --type [--source --deploy]` | `newModule({ root, slug, line, type, source, deploy })` |
| `biz module list [--line <l>]` | `listModuleSlugs(root, line)` |
| `biz module set <mod> --line <l> [--type --source --deploy]` | `updateModuleMeta(root, line, mod, patch)` |
| `biz module setup <mod> [--in <biz>]` | `businessesLinking(...)` + `buildModuleSetupPrompt({ root, slug, mod, line })` + `runAgent({ initialPrompt })` |
| `biz link <biz> <module>` | `linkModule({ root, biz, module })`（按业务所在线解析模块） |
| `biz run [slug] [--agent] [-- args]` | `runAgent({ root, slug, agent, args })`（CLI runtime） |
| `biz setup <slug> [--agent]` | `buildBusinessSetupPrompt({ root, slug, name, line })` + `runAgent({ initialPrompt })` |
| `biz set <slug> [--name --domain --ext]` | `updateBusinessMeta(root, slug, patch)` |
| `biz web [--port] [--host]` | `startWebServer({ root, port, host })` |
| `biz mem add <slug> "body" [--scope --confidence --session]` | `writeMemory({ root, slug, body, ... })` |
| `biz mem list <slug> [--scope --query]` | `recall({ root, slug, ... })` |
| `biz context <slug>` | `buildSystemPrompt({ root, slug, runId })` |
| `biz ls` | `listBusinesses(root)` |
| `biz show <slug>` | `readBusinessMeta(root, slug)` |
| `biz status` | `rootSummary(root)` |
| `biz worklog <slug> [runId]` | `readWorklogIndex(root, slug)` / `readWorklog(root, slug, runId)` |
| （Agent SDK runtime） | `buildSdkOptions({ root, slug, runId })`（`SessionManager` 消费） |
| `biz hook guard\|inject\|stop --business .` | `guardHook` / `injectHook` / `stopHook` |
| `biz hook promote --business .` | `promote({ root, slug, sessionId? })` |

`recall` 在 v0 为朴素过滤：`scope` 精确匹配 + `query` 子串。不引入 embedding（留待后续的 Retriever 适配器）。

---

## 11. Prompt 管理

所有面向模型的文案以文件形式置于 `prompts/`，代码不内联文案，只负责读取文件、填充变量、拼接，与 Claude Code 的 system-prompt 组织方式一致。

| 文件 | 用途 |
|---|---|
| `prompts/system.md` | 启动注入的总 system prompt（重要信息均在此） |
| `prompts/worklog.md` | worklog 指令骨架（拼入 system.md） |
| `prompts/claude-md.md` | 最小 CLAUDE.md 模板（不含重要信息） |
| `prompts/modules.md` | 链接模块的注入段（含按 source 取码 / 读 master / worktree 开发约定，带 `${MODULES_LIST}` `${RUN_ID}`） |
| `prompts/business-setup.md` | `biz setup` 的开场任务（访谈补画像 / 登记模块 / 知识库冷启动，带 `${NAME}` `${SLUG}` `${LINE}`，支持 `business-setup.custom.md` 覆盖） |
| `prompts/module-setup.md` | `biz module setup` 的开场任务（取码 / 纠正记录 / 模块记忆冷启动，带 `${MOD}` `${LINE}` `${SLUG}`） |
| `prompts/fence.md` | block 协议默认骨架（不物化文件，内容拼入 system prompt） |
| `prompts/reminder-new-sessions.md` | 每轮注入「其他 session 新进展」的提醒（含 `${ENTRIES}`） |
| `prompts/reminder-worklog-missing.md` | Stop 时「尚未写 worklog」的提醒（含 `${WORKLOG_PATH}`） |

每个文件以 `<!-- -->` 说明开头（name / description / variables），正文用 `${VAR}` 占位。`loadPrompt` 读取文件，`renderPrompt` 去除说明头并填充变量（见 `prompts.ts`）。提醒文案不自行包裹 `<system-reminder>`——harness 注入时会自动包裹。

worklog 与 fence 支持团队覆盖：放置 `worklog.custom.md` / `fence.custom.md`（查找顺序 business > 根 `<root>/prompts/` > 用户 `~/.bizagent/prompts/`），biz 将其拼入对应骨架。受保护的部分（worklog 的 frontmatter `description`、索引写入规则等）用户无法修改。

---

## 12. v0 范围与取舍

**已实现并验证**：

- 根 / 业务的初始化与创建（`init` / `new`）、filesystem 存储、symlink 共享层与产品线惰性创建。
- 模块模型最小切片（见 §2.1）：模块实体（`module new`）、业务↔模块多对多链接（`link` / `new --module`）、只读 master symlink + worktree 开发约定的注入。
- frontmatter 记忆单元、写入治理。
- hook 层（guard / inject / stop）与两个 runtime 的对等接入。
- CLI launcher（`biz run`）与 Agent SDK runtime（含 Claude 二进制解析与权限模式）。
- 跨用户共享 Remote（`file` / `http` / `module` 三档；worklog 与 business memory 均已接通）。
- web 层 SessionManager 与内置平台 `biz web`（SSE + POST），含长任务后台作业（`JobRegistry` + 自带 `expect_result` 工具 + `makeTools` 注入域工具 + `/api/jobs`，见 §9.3）。
- CLI 实时渲染：`biz run --view` 浏览器镜像（transcript 投影 + 专用 `web/viewer.html`，见 §9.4）。
- 85 个自动化用例、`tsc --noEmit` 通过。

**刻意暂不做（按需增量）**：

- MCP server——仅当需要更强检索或外部 agent 消费记忆时再加，届时复用同一批 core。
- worklog append-only 的硬性强制。
- 将单机本地存储替换为 sqlite——所有磁盘访问都经 `fsutil.ts` 一处，替换只改该文件。
- promote 的 LLM 蒸馏 / 去重 / 置信度评估。
- `promote` 蒸馏出的 memory 自动共享、live 仪表盘的 `subscribe` 推送。
- 可复用、不绑定框架的 HTTP 适配层与浏览器 client，以及聊天历史的持久化。

---

## 13. 安装、开发与测试

构建并链接为真实命令：

```sh
cd packages/bizagent
npm install
npm run build       # 产出 dist/biz.mjs（bin）+ dist/index.mjs（lib）
npm link            # 将 biz 加入 PATH
biz                 # 查看帮助
```

随后可在任意目录使用，例如 `biz init ./acme` → `cd acme` → `biz new webstore --line commerce`。物化的 `.claude/settings.json` 调用裸 `biz hook ...`，因此 `biz` 加入 PATH 后，真实 claude 会话中的 hook 即生效。修改源码后执行 `npm run build` 刷新被链接的 `biz`（开发期也可用 `npm run biz -- ...` 直接运行源码）。

测试：

```sh
npm test            # node:test，85 用例
npm run typecheck   # tsc --noEmit
npm run sandbox     # 可手动体验的 sandbox（examples/quickstart.sh）
```

自动化测试零额外依赖（Node 内建 runner），每个用例在 `os.tmpdir()` 下建立隔离的根：

| 文件 | 覆盖 |
|---|---|
| `test/biz.test.ts` | init / new（含 symlink 解析、产品线惰性创建、slug / line / 缺根等拒绝）、writeMemory / recall（含非法 / 缺失 business 拒绝）、assemble 渲染、`validateMemoryWrite` 全部分支、`extractConclusions`（含中文标题）、`promote`（蒸馏 + 幂等 + 指定 session） |
| `test/hooks.test.ts` | guard / inject / stop 三个决策函数（含 memory Write 校验、Edit 后内容校验、worklog 强制、按轮注入增量） |
| `test/prompts.test.ts` | prompt 加载 / 渲染 / 自定义覆盖 |
| `test/runtime-sdk.test.ts` | `buildSdkOptions` 的三个 hook 回调（不装 SDK、不调用模型） |
| `test/remote.test.ts` | fileRemote 往返、两个用户跨根经 Stop→inject 互见 worklog、business memory 共享、指纹去重、TTL、按 runId 解析去重、`httpRemote` 固定契约与鉴权头、非 2xx publish 失败、`http` 档 `${ENV}` 插值、`module` 档加载工厂 |
| `test/session.test.ts` | 输入通道（按序 / 阻塞 / 关闭）、广播多订阅与晚加入回放、`mapMessage`、`sessionIdOf`、worklog 投影仅在变更时触发、后台作业 `JobRegistry`（open/resolve 注入一次、未知 ticket no-op、run 轮询路径、失败上报、`formatJobResult`） |
| `test/web.test.ts` | `biz web` 的静态、列表与读写路由（均不装 SDK）：`webConfig` 默认、`GET /`、`GET /api/businesses`、未知 business 返回 404、`/api/health`、business 详情、`POST /api/businesses`（含非法/重复拒绝）、business memory 读写往返与非法 scope 被治理拒绝（422）、worklog 索引/全文/未知 runId 404、deliverables 列文件、context 预览、空 `/api/sessions` |
| `test/module.test.ts` | 模块：`newModule` 建结构、`linkModule` 多对多 + symlink + 幂等、`new --module`、未知模块 / 非法 slug 拒绝、`buildSystemPrompt` 注入模块与 worktree 约定 |
| `test/transcript.test.ts` | transcript 投影：assistant 文本/工具、thinking 丢弃、user 提问/meta 跳过、sidechain 与噪声行跳过、多行解析容错（复用 `mapMessage`） |

> 生产环境应使用预编译产物，避免每次 hook 触发都启动 tsx 进程的开销。
