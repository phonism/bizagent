# BizAgent

BizAgent 是一个面向 DeepSeek Harness（DSH）的开源组织学习插件。

它给长期 Agent 增加 DSH 本身不负责的能力：稳定的 Agent Home、多级 Memory、基于真实证据的自进化、
以及跨 Agent 的经验提案与组织级协作。

> DSH 负责让 Agent 运行；BizAgent 负责让 Agent 和组织持续变强。

## 状态

`v0.1.0-alpha.2` 已实现，可从当前 checkout 构建并作为 DSH Bundle 打包安装。当前兼容基线为
DSH `0.1.1-rc.2`。该 tarball 已在隔离的 DSH `web` profile 中完成安装、配置展开和运行时启动验证。
这是本地单用户 alpha，尚未发布到 npm。

v0.1 首先证明两个闭环：

1. 同一个 Agent 能把一次真实工作的经验沉淀到自己的 Home，并在新的 Session 中主动复用；
2. 一个 Agent 能向另一个 Agent 提交带证据的经验，但不能越权改写目标 Home，目标 owner 接受后形成新的
   Home Revision。

P0 Lite 进一步跑通明确纠正的自动学习：只有识别到强信号时才追加一次有界 Learning Checkpoint；普通 Turn
不增加模型调用。新 Session 通过 DSH 持久消息获得精确的 Home Revision，资产证据可以回读到原始事件。

Agent 可将观察、推断、知识和方法分别保存为 Memory、Insight、Knowledge、Method。尚待验证的内容用
`candidate` 保存，默认检索和后续 Session 索引只使用 `active` 资产；核验正文与证据后，按所读 revision
显式发布候选。编辑保留原状态，发布与携带 revision 的编辑会拒绝过期版本，避免覆盖其他会话的修改。
具体流程见[候选与发布](docs/quickstart.md#候选与发布)。

Agent 现在也能列出本 Home 已绑定的 DSH Session，并分页回读原始事件作为学习材料；历史事件不会自动成为记忆。
它可为当前 Session 显式记录带修订的 Worklog，按摘要检索，并在读取时核验 Session 指纹和所引工作区文件哈希；
新修订会保留文件版本快照，可在原文件变化后按范围回读。
正式 Work 完成且对应的工具调用与 turn 结束都持久化后，插件会从冻结结果补写一版有来源指纹的 Worklog；
重启可补齐缺失记录，已由 Agent 显式写成的同一 Work completed 记录不会重复生成。
普通 Session 的持久工具活动 turn 也会自动形成可核验的活动 Worklog，纯对话不触发，重启后可补录；
显式 Worklog 仍用于 Agent 自己写出的业务结论。
增量学习会分别扫描原 Session 事件和 Agent 撰写或正式 Work 结果的 Worklog 修订；候选可引用确切修订，
在原 Session 暂不可读时仍可回读 Worklog 正文和来源状态。
学习批次还会保存受管理 Home 资料的前后文件字节，完成或放弃时列出实际创建、更新或删除，并可按权限回读。
DSH 已结束的 turn 还可生成带原事件哈希的零模型调用输出断言，并可显式有界回填历史；
正式 Work 可对冻结交付文件按需复算空文本与占位符断言；两类断言都不证明业务结果正确。
有可信用户身份的宿主可挂载真人标注 API，在质量复核面板对具体失败判定
留下可修订的确认标签与期望结果；详情会复核原 Session 并显示有界摘要。页面也可在 7/14/30 天窗口内
异步、有界回填历史判定，不调用模型。
宿主还可显式配置模型判断通道，在质量复核面板由真人手动发起三项异步判据；结果与原 Session 指纹绑定并随
恢复包校验，失败项也能留下可修订的真人校准标签；调用前持久预留请求，重启后的未完成请求返回结果未知并须真人核查用量；提供可选的 OpenAI 兼容 HTTP 适配器。
宿主可接入显式回归重跑：从已确认的失败创建人工断言，审核有序图文提问和纯文本工具夹具，
由真人在质量复核面板确认模型调用后，用独立且只允许冻结夹具的 DSH Session 重跑并查看持久结果。
增量扫描会找出新内容，只有显式审阅回执才推进该版本的处理进度；工具参数与归属边界见
[工具参考](docs/tools.md)。
当前 Agent 也可在专门 Session 冻结最多 8 份材料为一个持久学习批次，逐条引用原 Session 事件创建候选，
记录无变化的理由，并在中断后查询进度或明确放弃；显式 `learning_launch` 可在映射 Workspace 启动独立
学习 Session，未知启动不重建。可选宿主定时器按 Home 配置上海时间 cron、模型和每日上限；读取启动状态时
会从 worker Session 持久事件汇总已上报的 token 用量，缺报单列。尚无真实费用定价与逐人额度归属。

同一 Session 可显式打开多个只读 Agent Frame，借用共享 Home 的 Identity 与 active 资产索引，再按需搜索、
读取正文。Frame 不更换实际 Agent 身份或工具权限，也不让来源 Home 独立执行；写入仍归主 Home。

跨 Home 的普通异步消息现在可通过 Inbox 工具发送、分页查看、读取、回复和标记处理。发件 Home 与回信
Session 由当前 DSH 绑定确定，投递结果按收件地址记录。同显式 owner 且有 Workspace 映射的主收件
Home 可由 urgent 信立即、normal 信按本 Home `inbox.json` 作息启动独立 Session；缺省为 15 分钟批处理，
也可设为立即、定时或只随下次 Session 带读。其提示只含本批信头，失败计划可恢复。
主送原发件 Home 的普通回信优先送回原 Session；原 Session 确定不可恢复时才进入新会话唤醒路径。
主送信到 `due` 后仍未处理会催办一次；无期限信滞留 24 小时、已注入原 Session 的回信滞留 2 小时也会催办。
普通话题触及 6 跳或 12 封限制时，可用有 Workspace 文件佐证的结论信关闭话题；结论信入箱但不唤醒，
已关闭话题不再催办。无法收口时可主送 `user:<id>` 并带期限和行动说明，交由宿主认证的
[真人信箱](docs/human-inbox.md)读取与回复。宿主可接入超时话题扫描器，在触顶且静置 24 小时后
以已核验的责任人授权记录自动升级；核心包不自带登录、扫描定时器或实际渠道凭据。
宿主可接入持久通知运行器；它将站内投递与渠道确认分开记录，结果未知时不会盲目重发。
`cc` 只入箱；入箱和唤醒都不建立正式 Work 责任。参见[工具参考](docs/tools.md#异步-inbox)。

需要明确交付责任时，可创建独立 Work：请求方给出目标、完成标准和幂等键；执行方先用自己的 Session
独占认领，再以正式完成工具交回
唯一结果，请求方可在结果预留前取消。请求与结果通知仍由 Inbox 传递，Work 状态由独立账本保存。
执行方也可随唯一结果冻结 `artifacts/` 文件版本；请求方可按范围回读。
配置了执行方 Workspace 映射、且双方 Home 的 owner 相同时，派发会尝试启动独立 DSH worker Session；
启动失败保留责任，可重试。owner 不同时只创建 Work，由执行方自己的 Session 认领。
Project 现在单独保存目标、完成标准、关联 Work、版本化结果声明、Agent 返工与真人接受记录；
提交时可冻结 `artifacts/` 下的文件版本，之后按范围回读，验收与恢复包会核验快照。
基本流程是：创建 Project → 邀请 Seat → 派正式 Work → 执行方完成 Work → lead 提交结果声明 →
真人经认证路由接受，或由 lead / 真人退回返工。Project Seat 支持邀请、职责、地址路由和唤醒时的项目上下文；
普通 Home Session 可按 Project turn 显式加入。Agent 只能退回返工，结项验收需要宿主接入身份、grant 和请求保护；
未加入 Home 轮次的自动归属和跨进程单飞仍缺。见[Project 工具](docs/tools.md#正式-project)与
[正式 Work 工具](docs/tools.md#正式-work)。

上述候选与发布能力属于当前 checkout 的 [Unreleased 改动](CHANGELOG.md)，不意味着此前构建的 alpha.2
tarball 自动拥有这些能力。请按当前源码重新构建；本文档说明当前实现。

## 先跑一个案例

在 `packages/dsh` 目录执行：

```sh
npm ci
npm run examples
```

三个虚构场景覆盖增长分析、研发配置审查、客服业务知识。它们调用真实学习服务，用临时 Home 与模拟 DSH
会话验证候选发布、跨 Home 审核、按需读取、反馈和退休；不需要模型服务。详见
[Learning Lab](examples/README.md)与[案例指南](docs/casebook.md)。
本机有兼容版 DSH CLI 时，可用 `npm run smoke:profile` 在独立临时 Web profile 中验证当前 Bundle
的加载、UI/API 与 Home 跨重启持久化；`npm run smoke:packed` 对解包后的 npm tarball 内容运行相同检查；
`npm run smoke:install` 在全新临时目录安装 tarball 与锁定的 DSH 同行依赖并验证导入；有兼容版 DSH CLI 时，
`npm run smoke:installed` 进一步从安装目录运行同一隔离 Web profile 验收；
`npm run smoke:plugin-add` 使用真实 DSH CLI 在临时 profile 中安装 tarball 并验证 Bundle 自动加入和重启恢复；
`npm run smoke:agent` 用本地模拟模型验证真实 Headless
Agent Loop 的 Home 工具调用；`npm run smoke:work` 再验证独立 worker 的正式 Work 交付与跨重启读取。
`npm run smoke:project` 验证 Project 创建、Seat 邀请、定向信件、独立 Session 唤醒、回复和重启后回读，再验证 turn 加入、正式 Work 派发与完成、结果声明提交和重启后的回读。
`npm run smoke:learning` 使用真实 DSH Session 验证专用 worker 启动、批次扫描、原事件证据候选与完成回执。
详见[快速上手](docs/quickstart.md)。

## 核心模型

- **Agent Home**：长期身份、记忆、知识、方法与学习出口；不等于 Session、Workspace 或 AgentPreset。
- **多级 Memory**：Working Context → Worklog/Episode → Memory → Insight → Knowledge/Method → Identity。
- **单 Agent 自进化**：Observe → Route → Propose → Validate → Promote → Use → Measure → Revise/Retire。
- **组织级学习**：经验按 Personal、Business、Role、Capability 的所有权流动；跨 Home 只能走 proposal。
- **工作区内聚**：一个组织完整存放在 `<DSH 工作区>/bizagent/<组织 ID>`，所有 Home 与学习资产从这里生长。
- **DSH 原生**：以 Cordis Bundle 安装，不 fork DSH，不实现另一个 Agent Loop，也不运行独立服务。
- **插件化 UI**：Host UI adapter 与 Web Client 分离；DSH 自动发现 Client bundle，learning kernel 不依赖 React。

## UI

安装后，DSH 左侧栏会出现 **BizAgent 组织**：

- 首次打开用四步引导定义使命、成员/角色、共享能力和组织目录，并批量创建四类 Home；
- 例如在工作区 `dsh` 创建 `search-ops`，完整目录就是 `dsh/bizagent/search-ops`；
- 组织视图展示 Business 根、Personal/Role 责任配对和 Capability 共享能力层；
- 性能视图每 2 秒读取 vLLM Prometheus 指标，展示服务总解码/Prompt 吞吐、并发队列、KV Cache、MTP 接受率、前缀缓存与延迟趋势；
- 组织、关系、Home 和学习资产都保存在组织目录中；`$DSH_HOME/bizagent` 只记录当前组织位置；
- 左侧浏览 Personal、Business、Role、Capability Home；
- 中间用 Memory strata 展示 Episode → Memory → Insight → Knowledge → Method 的沉淀结构；
- 学习台展示当前 Home 最近 20 条 Worklog，可展开正文与 Work、Project、文件引用；
- 项目视图按当前 Session 的 Home 显示可见 Project、待处理状态、关联 Work、Seat 和当前交付；
  宿主挂载已认证需求源路由后，可浏览已授权来源、纳入 intake Project 并确认目标。宿主还可挂载真人验收路由；「我的审核待办」按当前真人账号展示待验收的结项交付，不要求当前 Session Home 参与项目；
- 展开资产可检查正文、revision、fitness、使用回执和证据链；
- 右侧 proposal inbox 展示跨 Agent 经验和目标资产；宿主挂载认证真人裁决路由后可接受或拒绝；
- 可创建组织图之外的新 Agent Home，但不能绕开 evidence 规则直接手工创建 Memory。

UI 的 Host API、Client slot 与安全边界见[插件化 UI 设计](docs/ui.md)。

## 文档

- [本地快速上手](docs/quickstart.md)
- [架构与责任边界](docs/architecture.md)
- [Home 文件归档与恢复](docs/home-archive.md)
- [真人 Project 验收](docs/project-review.md)
- [学习生命周期](docs/learning-lifecycle.md)
- [Agent 工具参考](docs/tools.md)
- [增长、研发、客服案例指南](docs/casebook.md)
- [可运行 Learning Lab](examples/README.md)
- [仓库贡献指南](../../CONTRIBUTING.md)

设计背景与计划（尚未实现的内容不构成 API 承诺）：

- [完整产品、架构与实施计划](docs/plan.md)
- [v0.1 最小版本](docs/mvp.md)
- [P0 Lite：明确纠正的自动学习](docs/p0-lite.md)
- [插件化 UI 设计](docs/ui.md)
- [架构决策：UI 插件边界](docs/decisions/0002-ui-plugin-boundary.md)
- [历史决策：外置 RuntimeProvider 方案（已废弃）](docs/decisions/0001-dsh-runtime-boundary.md)

Home 资产保存为 Markdown/YAML，绑定、提案和回执保存在 DSH 学习账本，原始证据由 DSH Session 保存。
复制组织目录并不等于完整备份；数据分工与恢复边界见[架构文档](docs/architecture.md)。

## 本地验证

从 GitHub checkout 开始：

```sh
git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci
npm test
npm run typecheck
npm run smoke
```

`npm run smoke` 会在临时目录中真实执行 `init`、`home create`、`home list` 和 `doctor`，断言创建了
两个 Home 且诊断无异常，并在结束后清理临时数据。若要保留数据并逐步体验 CLI：

```sh
node lib/cli.js --root /tmp/bizagent-demo init --default-home personal:alice
node lib/cli.js --root /tmp/bizagent-demo home create role:growth-strategy
node lib/cli.js --root /tmp/bizagent-demo home list
node lib/cli.js --root /tmp/bizagent-demo doctor
```

## DSH 安装方式

先构建 tarball，再安装到带 `ctx.storageDomain` 的 DSH `web` profile：

```sh
npm run build
npm pack
dsh plugin --profile web add ./bizagent-dsh-0.1.0-alpha.2.tgz
dsh --profile web --dump-config
dsh --profile web
```

详见[快速上手](docs/quickstart.md)。包名在首次 npm 发布前仍可能调整。
