# BizAgent v0.1-alpha.2 本地快速上手

本页对应当前 checkout，包括 [Unreleased](../CHANGELOG.md) 的候选发布功能。若只想先理解行为，
从 [Learning Lab](../examples/README.md) 开始；完整概念与参数见[架构](architecture.md)和[工具参考](tools.md)。

## 前置条件

- Node.js `^22.19.0` 或 `>=24.0.0`；
- pnpm `>=11.8.0`（DSH 的 profile 插件管理器会调用它）；
- DeepSeek Harness `0.1.1-rc.2`；
- DSH `web` profile。alpha 依赖该 profile 已挂载的 `ctx.storageDomain`；
- 本地单用户环境。

## 1. 构建与测试

```sh
git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci
npm test
npm run typecheck
npm run smoke
```

本机安装了兼容版 `dsh` CLI 后，还可运行 `npm run smoke:profile`。它使用独立临时 `DSH_HOME`
和随机 localhost 端口，将当前 checkout 链入真实 Web profile，检查 BizAgent API、客户端资源、
Home 创建及 DSH 重启后的持久化；还验证第二写者拒绝和自己启动的隔离进程异常退出后的锁恢复。
结束时停止自己启动的进程并清理临时目录。不调用模型，也不安装 tarball。
这个检查不能替代下文的包管理安装和 Agent 工具调用验收。
`npm run smoke:packed` 会先生成 npm tarball，再从解包后的发布内容启动同一隔离 Web profile，
核对 UI、API、Home 创建与重启持久化。它借用当前 checkout 已安装的运行时依赖；
`npm run smoke:install` 则在全新临时目录用 npm 安装 tarball 与锁文件指定的 DSH 同行依赖，并从安装目录加载包；
CI 在 Node 22/24 执行这项检查。宿主安装用已验证的 Cordis 可选插件版本覆盖，避免上游较新版本范围拉入
与当前基线不兼容的依赖。装有兼容版 `dsh` CLI 时，`npm run smoke:installed` 还会从这个安装目录启动隔离 Web
profile，检查 UI/API、Home 持久化、重启和异常退出恢复。`npm run smoke:plugin-add` 则在全新临时
`DSH_HOME` 用真实 `dsh plugin --profile web add` 命令安装 tarball，并验证 Bundle 自动加入、UI/API、
Home 持久化、重启与异常退出恢复；本机用 DSH `0.1.1-rc.2` 验证通过。三项检查不修改已有 profile，
只停止各自启动的临时进程，也不调用模型。其他 DSH 版本及公开仓库发布后的安装仍需单独验收。
运行 `npm run smoke:agent` 可在独立 Headless profile 中补上真实 Agent Loop 验证。命令用本地模拟
OpenAI 兼容模型，让 DSH 原生工具依次调用 `bizagent_home_status`、`bizagent_agent_search` 和
`bizagent_frame_open`，核对首次打开、未变化重开及显式刷新的模型可见结果。不使用外部模型或现有 DSH profile；
它尚不覆盖正式 Work 的执行路径。
运行 `npm run smoke:project` 可验证 Project 创建、Seat 邀请、独立 Inbox Session 的上下文、项目读取、回复和重启后的账本回读，再由普通 Home turn 加入 Project、派发正式 Work、等独立 worker 完成后提交结果声明，并在重启后回读。
运行 `npm run smoke:work` 可验证正式 Work：在隔离 Headless profile 中预置请求方与执行 Home，
由本地模拟模型驱动真实 DSH Agent 派工、启动独立 worker Session、完成结果、投递回请求方，
再启动第二个 DSH 进程读取持久的 `completed` Work 和 `delivered` 结果回执。
它验证工具与运行时接线，不证明外部模型能独立完成真实业务任务，也不代替 tarball 安装验收。

还可以运行三个无需 DSH 或模型的教学案例：`npm run examples`。它们使用模拟会话与隔离临时 Home，
不替代下面的真实 DSH 安装验证。

最后一条命令会在隔离临时目录里真实运行 `init → home create → home list → doctor`。成功时输出：

```text
BizAgent DSH smoke test passed: 2 Homes, doctor ok.
```

## 2. 创建两个 Agent Home

下面使用隔离目录演示底层 Home CLI；正式通过 Web 创建组织时，数据会写入选定 DSH 工作区的
`bizagent/<组织 ID>`，而不是堆在 `$DSH_HOME` 中。

```sh
node lib/cli.js --root /tmp/bizagent-demo init --default-home personal:alice
node lib/cli.js --root /tmp/bizagent-demo home create role:growth-strategy
node lib/cli.js --root /tmp/bizagent-demo home list
node lib/cli.js --root /tmp/bizagent-demo doctor
```

生成的数据结构：

```text
/tmp/bizagent-demo/
├── directory.yaml
├── organization.yaml       # 使用 Web 引导创建组织后出现
└── homes/
    ├── personal--alice-.../
    │   ├── home.yaml
    │   ├── identity.md
    │   ├── memory/
    │   ├── insights/
    │   ├── knowledge/
    │   └── methods/
    └── role--growth-strategy-.../
```

## 3. 打包并安装进 DSH

```sh
npm run build
npm pack
dsh plugin --profile web add ./bizagent-dsh-0.1.0-alpha.2.tgz
dsh --profile web --dump-config
dsh --profile web --no-open
```

`--dump-config` 中应出现：

```yaml
- id: bizagent
  name: '@bizagent/dsh'
- id: bizagent-ui
  name: '@bizagent/dsh/ui-host'
  config:
    metricsUrl: http://MODEL_HOST:8000/metrics
```

`homeRoot` 默认是 `$DSH_HOME/bizagent`。在 Web 组织模式中它只作为运行时注册目录，保存当前组织位置；
实际 Home root 由创建组织时选择的 DSH 工作区决定。下面的覆盖配置主要用于底层 CLI/兼容场景：

```yaml
- id: bizagent
  config:
    homeRoot: /tmp/bizagent-demo
    defaultHome: personal:alice
    autoCreateDefaultHome: false
    identityMaxBytes: 6144
    indexMaxBytes: 16384
    learningCheckpointEnabled: true
    workspaceHomes:
      /path/to/reviewer-workspace: role:growth-strategy
```

首次 Home Context 注入后，Session 的 Home binding 不再改变。完整组织创建后，未显式分配身份的会话使用该组织的
Business Home，而不是某个全局 `personal:default`。
`workspaceHomes` 是可选的独立 worker 工作区映射：目标必须是已存在的真实目录，映射值必须是目标 Home 地址。
正式 Work 派发到该 Home 时会尝试启动独立 DSH Session；启动失败可由请求方用 `bizagent_work_start` 重试。

定时学习默认关闭。若要让宿主自动整理已有 Episode，在负责该 profile 调度的单个进程中配置：

```yaml
- id: bizagent
  config:
    workspaceHomes:
      /path/to/reviewer-workspace: role:growth-strategy
    learningSchedulerEnabled: true
    learningSchedules:
      - home: role:growth-strategy
        cron: "0 3 * * *"
        model: your-model-id
        dailyRuns: 1
        maxTokens: 2048
```

首次启用从下一个 cron 时刻开始。到期后先无模型扫描增量材料；没有待审来源时不会启动 Session。
调度游标和启动预留可随逻辑状态恢复包保存。当前模型费用仍由 DSH 模型配置承担，没有逐人额度账本。
配置后，可在 BizAgent **学习**页查看每个 Home 的排程、最近运行，调整检查时间与每日次数，或关闭后续排程。
UI 不能换掉宿主指定模型，也不能超过宿主设定的每日上限；设置更新以版本号防止过期页面覆盖。
详见[学习生命周期](learning-lifecycle.md)。

## 4. 单 Agent 学习

在 `personal:alice` 的 Session 中完成真实任务并给出明确纠正，例如：

```text
记住：以后修改配置之前必须先创建备份。
```

如果当前 Turn 尚未主动写入 Memory，BizAgent 会在 Turn 结束前追加一次有界 Learning Checkpoint。Agent 只能选择
`remember` 或 `skip`；同一个 Session/Turn 最多结算一次。Agent 也仍可在正常工作中主动调用：

```text
bizagent_memory_remember
```

Checkpoint Memory 引用明确纠正所在的原始 `user/message`；主动 remember 则引用当前 DSH turn。两者都不要求模型
手填事件序号。之后开启一个新的 Personal Session：

1. Home Revision 已递增；
2. 新 Context 只包含 Memory 一行索引；
3. Agent 使用 `bizagent_memory_search` 和 `bizagent_memory_read` 读取正文；
4. `bizagent_evidence_read` 可以回读资产引用的有界原始事件；
5. 使用结果通过 `bizagent_memory_feedback` 记录为 applied、confirmed、contradicted 或 failed。

`retrieved` 和 `applied` 不改变 Fitness；只有 confirmed、contradicted 和 failed 改变分数。累计两次负向结果会返回
`reviewRequired: true`，但不会自动删除资产。

### 候选与发布

尚需核验的经验可以先保存在自己的 Home：

```text
bizagent_memory_remember(
  kind="method", status="candidate",
  description="修改配置前验证备份可恢复的方法",
  body="在隔离目录恢复备份，核对文件内容和关键配置；尚需验证不同配置格式下的适用性。"
)
```

`kind` 可为 `memory`（具体观察与原始语境）、`insight`（有依据的推断）、`knowledge`（可复用事实）或
`method`（可重复执行的方法）。字段省略时仍保存 active Memory，与已有调用兼容。

1. 使用 `bizagent_memory_search(status="candidate")` 查找候选；`bizagent_home_status` 返回候选数量。
2. 用 `bizagent_memory_read` 和 `bizagent_evidence_read` 核验正文与原始证据。
3. 如需修改，用 `bizagent_memory_update(action="revise", expected_revision=<读取到的 revision>, ...)`。
   修改后仍为 candidate，读取更新后的版本再审阅。
4. 核验通过后调用 `bizagent_memory_update(asset_id=..., action="publish", expected_revision=<审阅的 revision>)`。
   只有 candidate 能发布，版本冲突时重新读取、核验再提交。

候选以 Markdown 持久保存，可跨重启继续审阅；它不进入默认检索和常驻索引，也不改变 Home Context Revision。
发布后 Home Context Revision 递增，后续 Session 获得新的索引，正文仍按需读取。`revise` 保持原状态，
包括 retired/superseded，不会意外重新启用旧结论。发布必须携带 revision；建议编辑、退休也携带 revision。
并发检查在当前插件进程的串行写入内执行；同 profile/Home root 的第二个插件进程会被启动守卫拒绝，
但不提供跨主机事务或记录级 CAS，见[一致性边界](architecture.md#写入一致性与边界)。

此流程只处理当前 Home 的学习资产。跨 Home 仍通过下面的 proposal 流程；提案包含完整正文和证据，
目标 owner 接受后形成 active 资产。

## 5. 跨 Agent 学习

Personal Agent 发现经验属于 `role:growth-strategy` 时调用：

```text
bizagent_memory_propose
```

Role Session 可读取提案：

```text
bizagent_proposals
```

发布与拒绝由宿主显式挂载的认证真人裁决路由执行，Agent 无裁决工具。宿主须验证用户会话、写入防护和
该用户对确切提案及目标 Home 的权限；参见 [UI 接口](ui.md)。接受操作以 proposal id 生成确定性 asset id，
相同裁决重试不会创建第二份资产。未接入宿主认证时提案保持待审。

## 6. 当前工具

除上述 Home 学习和提案工具外，当前 checkout 还提供 Episode 回读、显式 Worklog 修订、增量学习审阅、只读 Frame、持久 Inbox 和正式
Work 和 Project 工具。先用 `bizagent_agent_search` 找到共享 Home 的规范地址，再用 `bizagent_frame_open` 按地址或唯一显示名打开只读视图，可搜索和读取其资产；这不会切换当前 Session
的写入身份。在 DSH Web 对话输入框键入 `@` 可选择当前 Session 可见的共享 Home。候选不会显示其他 Personal Home；
发送时会重新核验目标，并把显式 Frame 请求交给模型。只有 `bizagent_frame_open` 成功后才算加载了 Home 上下文。
DSH 成功压缩 Session 后，再次打开已有 Frame 会自动重发其上下文；`bizagent_frame_status` 可查看待刷新的地址。
对话输入框上方的上下文栏显示已打开 Frame 的模式和当前 focus；它只描述本 Session 的只读上下文，
不表示另一个 Agent 已运行或承担正式 Work。
`lead` 让共享 Home 引导当前请求的领域分析，`contribute` 提供专业视角，`reference` 只作具名资料引用。
切换 mode 会把新的参与指令交给模型，但不会切换 Session 身份、工具权限或学习写入者。

`bizagent_project_create` 固定目标与完成标准；lead 用 `bizagent_project_invite` 邀请 Seat，用
`bizagent_work_dispatch` 的 `project_id` 关联正式责任。配置了目标工作区时会尝试启动独立 worker。
Work 都结束后，lead 用 `bizagent_project_submit` 提交结果声明；接受只能由真人经认证路由完成，
lead 只能用 `bizagent_project_review` 退回返工。Project 提交与审阅会保存每版声明和决策。
完整工具的参数与结果见[工具参考](tools.md)。

Home 文件的版本化归档、完整性校验和空目录恢复见[Home 文件归档](home-archive.md)。该归档不包含 DSH
账本或原始 Session，不能替代完整 profile 备份。

## 7. 创建并使用一个完整组织

启动 DSH Web 后，点击左侧栏底部的 **BizAgent 组织**。首次打开直接进入四步引导：

1. 填写组织名称、稳定的英文/数字标识和使命；
2. 选择产品研发、增长团队或精简创业模板，再修改成员、角色和长期职责；
3. 确认需要跨成员复用的能力；
4. 选择承载组织的 DSH 工作区，确认 `工作区/bizagent/组织标识` 目录，然后创建组织。

例如工作区是 `/path/to/workspace`、组织标识是 `search-ops`，一次提交会在
`/path/to/workspace/bizagent/search-ops` 创建一个 Business Home、每位成员的 Personal Home 与 Role Home，
以及每项能力的 Capability Home。`organization.yaml` 保存 `member-of`、`fulfills-role` 和 `serves` 关系。只有所有
Home 均成功后组织才会出现在 UI；中断后用同一组织标识重试即可收敛，不会重复创建 Home。

目录关系如下：

```text
/path/to/workspace/
└── bizagent/
    └── search-ops/
        ├── organization.yaml
        ├── directory.yaml
        └── homes/
            ├── business--search-ops-.../
            ├── personal--.../
            ├── role--.../
            └── capability--.../
```

`$DSH_HOME/bizagent/active-organization.yaml` 只保存这三个信息：DSH 工作区路径、组织标识和组织根目录。DSH
重启后根据这个指针重新打开组织，不复制或映射 Home。

提案、使用回执和 Session binding 仍保存在 DSH `storageDomain`，原始证据仍在 DSH Session 存储。
组织目录只承载关系与长期资产，完整恢复边界见[架构](architecture.md)。

创建后默认进入**组织**视图：组织图中的成员和能力都可点击，并会切换到对应 Home 的**学习**视图。在学习视图中：

1. 通过 Memory strata 查看 Episode、Memory、Insight、Knowledge 和 Method 的数量与成熟方向；
2. 在 Learning ledger 中搜索、筛选并展开资产，检查正文、fitness 和 evidence；
3. 在 Proposal inbox 中以目标 Home owner 的身份留下裁决说明，再接受或拒绝；
4. 需要组织图之外的新所有权边界时，使用 Create Home。UI 不提供无证据的直接 Memory 编辑入口。

组织视图中的 **BizAgent 目录**会持续显示这个三层目录树和绝对路径，明确当前组织属于哪个 DSH 工作区。组织创建
完成后不再出现“工作区应该绑定哪个 Home”的二次概念。

UI 作为 DSH Client 插件加载。Host adapter 是独立 Cordis row `bizagent-ui`，通过同源、无缓存、64 KiB
上限的 `/api/bizagent/v1/*` 接口读写；跨源 mutation 会被拒绝。组织引导通过
`POST /api/bizagent/v1/organization` 一次提交工作区路径与组织定义，学习账本仍沿用原有 Home 与 proposal 接口。

性能页通过 Host 端 `GET /api/bizagent/v1/metrics` 每 2 秒采样一次 vLLM Prometheus endpoint。将
`bizagent-ui.config.metricsUrl` 指向模型服务的 `/metrics`，或设置 `BIZAGENT_METRICS_URL`。首次采样建立 counter 基线，
约 2 秒后即可看到实时服务总吞吐、KV Cache、MTP 接受率和前缀缓存趋势。

## 8. Alpha 限制

- 只支持单个受守卫的写进程、单用户 owner 语义；同机 PID 已不存在的陈旧写者锁可自动回收，无法判定的锁或残留领取闸门仍须人工核验，见[一致性边界](architecture.md#写入一致性与边界)；
- 当前主 Home 可写；跨 Home 的 Frame 仅可读取共享 Home；
- 正式 Work 的 worker 自动启动需要明确配置目标 Home 的 `workspaceHomes`；
- DSH headless profile 默认不提供 `storageDomain`，需要额外组合存储插件；
- 不做 embedding、自动 Insight 生成或 Identity 自动修改；
- 组织目录位于 DSH 工作区的 `bizagent/` 下；不要手工编辑其 Home 文件，并应配合 DSH sandbox；
- 自动 Checkpoint 只识别保守的明确纠正，不总结普通 Turn，也不自动生成 Insight 或修改 Identity；
- `pnpm` 在独立 profile 中可能报告 DSH peer 缺失；DSH 通过 host/profile 双锚点解析这些 peer。只要
  `--dump-config` 与实际启动均通过，该安装就是有效的。
