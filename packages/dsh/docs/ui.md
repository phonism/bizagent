# BizAgent 插件化 UI

## 目标

UI 的职责是让用户先创建可工作的 Agent 组织，再让组织学习变得可观察、可检查、可裁决；它不拥有 Memory
规则，也不实现第二套 Agent Runtime。组织面板提供 **Organization / 组织**、**Learning / 学习**、
**Projects / 项目**、**Quality review / 质量复核**、**Subscriptions / 订阅**、**Plugins / 插件**、
**Apps / 应用**、
**Business Pulse / 业务脉搏** 与
**Metrics / 性能**视图；对话区另有 Frame 上下文栏。

## 插件边界

```text
@bizagent/dsh                     DSH Host
├── bizagent                      Learning Kernel Cordis row
│   ├── HomeStore                 文件事实源
│   ├── LearningLedger            DSH Storage Domain 运行账本
│   ├── Home Context              DSH durable agent.inject snapshot
│   └── tools                     Agent 学习、协作、订阅、Worklog 与证据入口
├── bizagent-ui                   独立 Host adapter Cordis row
│   └── /api/bizagent/v1/*        Web-only 同源 JSON API
└── dsh.client                    DSH 自动发现的 Web Client 插件
    ├── sidebar.footer.action      入口
    ├── shell.overlay              首次引导、组织图与学习台
    ├── @Agent input trigger        Session 可见共享 Home 候选
    └── conversation.input.dock    当前 Session 的只读 Frame 上下文状态
```

约束：

- learning kernel 不 import React、DOM 或 WebServer；
- Client 不读取 Home 文件，不直接依赖 Host service；
- UI Host adapter 只编排已有 `BizAgentService`、`HomeStore` 与 DSH 账本；
- Client 只通过版本化 HTTP contract 通信；
- UI row 或 Client 失败不改变 Home 文件格式和 Agent 学习语义。

## 信息架构

- **First-run setup**：定义组织使命，选择团队模板，编辑成员/角色，确认共享能力与组织目录；
- **Organization map**：Business 为组织根，成员以 Personal + Role 配对展示，Capability 构成共享能力层；
- **Home directory**：四类 Home、revision、pending proposal；
- **Memory strata**：Episode → Memory → Insight → Knowledge → Method；
- **Worklog**：当前 Home 最近 20 个 Session 的摘要、正文和来源引用；正式 Work 结果及普通 Session 工具活动自动补写的记录有来源标签，
  来源及文件的当前状态需用 Agent 工具核验；
- **Projects**：按当前 Session 的 Home 列出 lead 或活跃 Seat 可见的项目；分页查看目标、完成标准、暂停原因、
  Workflow 节点推导状态、关联 Work、Seat 与当前交付。待处理筛选包含 intake、暂停和待验收；刷新读取账本最新状态。
  宿主挂载真人审核路由后，「我的审核待办」按当前账号列出可裁决的节点 Work 与待验收项目交付，
  包括交付引用的正式 Work 成果文字和固定文件版本，不依赖当前 Session Home；
  宿主挂载计划路由后，负责人可修订计划、重做节点或改派待复核人。
- **Requirement Sources**：宿主挂载已认证路由后，在项目视图按 Home 浏览已安装 App 的无 effect query，
  按时期与文本筛选条目；人点击纳入时重新读取来源，再在 intake Project 中确认内部目标和完成标准。
- **Apps**：按 Home 查看 App 制作、发布与安装证据。宿主挂载真人认证的审批路由后，可信工作台还可列出
  当前审核人可见的待批 Action，核对确切输入、目标修订与回执，二次确认批准或带理由驳回。Inbox 深链
  打开此页并定位回执。
- **Quality review**：宿主挂载真人认证路由后，按 Home 列出最近的 turn 断言和待确认失败项。详情重新核验
  原 Session 来源，只显示有界文字和工具失败概况；可在页面选择时间窗异步、有界回填已持久化 Session，
  标注可修订，期望结果保留为以后回归判据的种子。宿主配置模型通道后可手动运行三项异步模型判断，
  查看逐项进度、耗时和最近一次持久结果；失败项可提交可修订的人工标签，并按判据查看样本门槛。
- **Business Pulse**：宿主挂载用户认证的 Pulse 路由后，按 Business Home 和上海业务日查看日报、启用指标的
  14 天序列、缺数和运行中状态、指标定义与最近取数、按日期的运行矩阵；可下载已完成日报的 Markdown。
  可为当前认证用户启停该业务的自动日报订阅；生成或重新生成日报、立即取数、启停指标和订阅写入
  都要通过宿主写入校验；启停指标与订阅使用修订号避免覆盖并发修改。
- **My Pulse**：宿主按个人 Pulse 接入本人认证与真人会话源后，可先看近 30 天足迹和
  关注业务，再懒创建个人档案、置顶/屏蔽业务并手动生成今日报告。页面不依赖组织 Home 列表来推断本人身份。
- **Operations**：宿主挂载运维事件的真人认证路由后，按 Business Home 查看待处理或历史事件，分页核对报出证据、真人补充及结论回流入列数；宿主逐动作授权的真人可补充信息、调整严重度、标记已解决或记录原因后忽略，所有写入复核修订号。新事件的真人 Inbox 通知可深链到此页。
- **My Inbox**：宿主挂载[真人 Inbox](human-inbox.md)的本人认证路由后，查看收件、发件及待处理信，
  打开升级说明、标记处理、开关外部通知，并用稳定幂等键回复原 Agent 会话。
- **Business opportunities**：宿主挂载人侧认证路由后，按 Business Home 查看关注目标、检查证据与机会，
  保存人的决定及其原因，先预览真实 Pulse 基线再确认效果约定，并单独登记措施生效时间。检查本身由
  绑定业务 Home 的 Agent 对话提交，页面不接收或暴露内部检查 Session ID。到期回访在机会列表提示；
  认证负责人可选择每天、工作日或每周一的检查周期，查看下次排期和宿主开关状态；也可改期、取消回访、
  查看 Agent 冻结证据的回访结果并确认已查看。宿主启用自动发现或到期回访后，启动不明的记录可在页内
  尝试恢复原已持久化 Session，不会新建第二个执行会话。取消自动检查和五分钟到期后，近期记录显示
  终态与原会话的中断请求回执。
- **Learning ledger**：全文搜索、kind/status 筛选、asset body、fitness、receipt、evidence；展开资产时按当前 DSH Session 的 Home 核查后续正式 Work，分页显示冻结交付、版本化读取或自报使用回执及来源状态。没有该 Home 的 Session 时不读取这部分记录；它们不是收益评分；
- **Proposal inbox**：显示当前目标 Home 的 pending proposal、目标资产与提案正文；只有宿主挂载认证裁决路由后才可结算；
- **Organization location**：选择 DSH 工作区，预览并持续显示 `工作区/bizagent/组织 ID`；
- **Create Home**：创建新的长期所有权边界。
- **Frame context**：对话输入框上方显示当前 Session 的主 Home、Frame 模式与 focus；状态来自宿主 Session 和 Frame 账本，不表示另一个 Agent 正在执行。
- **Inference console**：每 2 秒观察服务总解码/Prompt 吞吐、运行/等待请求、KV Cache、MTP 接受率、
  前缀缓存、TTFT、token 间隔和最近样本。

学习台的使用线索路由复核服务端 Session 绑定和 Workspace；浏览器传入的 Session ID 仍需由多用户宿主认证并授权，当前本地 UI 不提供这层用户身份保证。

UI 故意不提供直接创建或编辑 Memory 的表单。Memory 必须来自真实 Agent turn，或来自带 evidence 的 proposal；
否则界面会成为绕过自进化治理规则的后门。

当前 UI 可按 candidate 状态查看资产，但尚未提供候选发布按钮；审阅与发布通过
[Agent 工具](tools.md)完成。点击组织图中的 Home 只改变浏览对象，不修改当前聊天 Session 的 binding。

## API

```text
GET  /api/bizagent/v1/overview
GET  /api/bizagent/v1/metrics
GET  /api/bizagent/v1/home?address=<HomeAddress>
GET  /api/bizagent/v1/agents?sessionId=<SessionId>&query=<query>
GET  /api/bizagent/v1/agents/resolve?sessionId=<SessionId>&target=<address-or-name>
GET  /api/bizagent/v1/frames?sessionId=<SessionId>
GET  /api/bizagent/v1/projects?sessionId=<SessionId>&beforeProjectId=<ProjectId>
GET  /api/bizagent/v1/projects/detail?sessionId=<SessionId>&projectId=<ProjectId>
POST /api/bizagent/v1/organization
POST /api/bizagent/v1/homes

# 宿主显式注册、要求用户认证的 Pulse 路由
GET  /api/bizagent/v1/pulse?homeAddress=<BusinessHome>&date=YYYY-MM-DD[&key=<MetricKey>]
POST /api/bizagent/v1/pulse  # action: collect | report | toggle
GET  /api/bizagent/v1/pulse/dashboards?homeAddress=<Home>[&key=<DashboardKey>]
POST /api/bizagent/v1/pulse/dashboards  # definition + expectedRevision
GET  /api/bizagent/v1/opportunities?homeAddress=<BusinessHome>[&id=<OpportunityId>]
POST /api/bizagent/v1/opportunities  # focus.save | decide | effect.preview | effect.confirm | effect.start | check.cancel | check.resume | review.plan | review.ack

# 宿主显式注册、要求真人认证和逐提案授权的裁决路由
GET  /api/bizagent/v1/proposals/decision?ownerAddress=<Home>&proposalId=<ProposalId>  # 当前用户可用的 accept/reject 动作
POST /api/bizagent/v1/proposals/decision
```

安全与运行约束：

- 所有响应 `Cache-Control: no-store`；
- mutation 要求浏览器 `Origin` 与当前 `Host` 相同；
- JSON request body 上限为 64 KiB；
- Zod 校验组织标识、成员/角色/能力、Home address、proposal id 与 decision；
- 可选裁决路由由 `registerProposalReviewRoute` 挂载；宿主提供 `authenticateHuman`、`authorizeMutation`
  和 `authorizeProposal`，后者核验用户对确切目标 Home、提案及动作的权限并返回持久授权引用。请求体不能
  提供审核人或授权引用；读取动作能力和提交裁决都会调用逐提案权限回调，提交时重新复核；Service 再次验证
  owner Home 与 proposal target 一致；无授权时页面仅展示提案；
- Project 读取先核验宿主 Session，再由 Service 的 lead/活跃 Seat Home 可见性规则筛选；列表每页最多 50 条，
  节点状态从持久 Work 记录推导，不代表实时进程状态。切换 Session 会重置页面数据；
- Project 的暂停、恢复、节点复核、最终验收和计划调整经可选宿主真人认证路由执行；宿主必须提供当前身份、
  逐 Project/Home 授权、写入请求校验及所需运行时回调。未挂载相应路由时，面板只展示可读状态；
- 需求源的纳入与 intake 确认使用独立的可选宿主认证路由；认证用户来自宿主，Service 再检查 Home 与 App grant。
  该入口不授予其他 Project 干预权；
- App Action 审批使用独立的可选宿主认证路由，读取时逐票核验审核权限，POST 还需宿主防跨站校验与服务层
  决策授权；App 自带 HTML 不承载授权控件。路由默认不挂载；
- Pulse 面板使用独立的可选认证路由；宿主必须提供已验证用户、Home 授权和写入请求校验。
  路由仅返回可展示的日报字段，不暴露冻结 prompt 或 Session ID；
  智能看板页签另需宿主挂载同样受控的 dashboards 路由，定义保存在对应 Home 内。
- 当前 API 只适用于 DSH 本地 Web profile，不承诺 Electron/远程多租户认证语义。

### 实时性能指标

`bizagent-ui` 由 Host 端读取 vLLM 的 Prometheus `/metrics`，浏览器不直接连接模型服务器。推荐显式配置：

```yaml
- id: bizagent-ui
  name: '@bizagent/dsh/ui-host'
  config:
    metricsUrl: http://MODEL_HOST:8000/metrics
    metricsSampleIntervalMs: 1500
    metricsHistoryLimit: 180
    metricsTimeoutMs: 3000
```

也可设置 `BIZAGENT_METRICS_URL`。URL 中的账号、密码、query 和 fragment 不会返回浏览器。

吞吐、MTP 与前缀命中率均由相邻 Prometheus counter 的差值计算，是采样窗口内的服务级指标。因而“服务总解码
吞吐”会汇总多个并发请求，不能直接当作单请求 tok/s。首次采样只建立基线，第二次采样开始显示速率；断线时保留
已有历史并显示离线原因。历史仅保存在 UI Host 内存中，重启后重新开始。

## 视觉系统

正文与工作区沿用 DSH theme token，品牌入口和组织主视觉使用固定的高对比色板：

- Cobalt `#2949EB`：侧栏入口卡片、组织首页和首次设置主视觉；
- Coral `#FF9278` 与 Aqua `#70E6DF`：三层叠片标识，对应逐层积累的学习资产；
- White `#FFFFFF`：钴蓝底上的标题、标识顶层和主动作；
- 展示字体优先 Avenir Next / PingFang SC，正文保留 DSH 字体，不加载外部字体。

学习资产继续使用语义信号色：

- Signal blue `#526FF5`：Memory、当前选择、主动作；
- Cognition purple `#9469DF`：Insight；
- Transfer orange `#CD6835`：Method 与跨 Home proposal；
- Synthesis cyan `#24868F`：Knowledge；
- Fitness green `#35A46F`：正向验证。

侧栏入口在展开时显示品牌与组织名称，收起时保留分层标识。组织首页优先展示使命、成员与能力关系图，
目录信息保留在下方；Business 根节点也可直接进入学习视图。Learning 的 Memory strata 使用更大的计数和
分层色带，正文保持安静的阅读表面。

界面支持窄屏重排、键盘 focus ring、弹窗内 Tab 循环、关闭后归还焦点、Escape/遮罩关闭和
`prefers-reduced-motion`。主视觉只在悬停时做一次轻微位移，不持续闪烁。窄屏 Home 列表与 Memory strata
在自身容器内横向滚动，不撑宽整页；新建 Home 入口定位在 Home 目录内。

## 持久化与故障语义

Organization 不是第五类 Home，而是引用四类 Home 的关系清单。每个组织的 Home root 固定为
`<DSH Workspace>/bizagent/<organization-id>`，`organization.yaml`、`directory.yaml`、所有 Home 与学习资产都在
这条边界内。

`$DSH_HOME/bizagent/active-organization.yaml` 是很小的运行时指针，只记录当前工作区、组织 id 与组织根目录。DSH
启动时先读取指针，再直接打开组织目录；它不是另一份组织数据。

创建过程先校验整份请求，再以原子目录 rename 创建每个 Home，最后原子写入组织清单；因此 UI 不会看到引用
不存在 Home 的半成品组织。若进程在写清单前中断，用相同组织 id 重试会复用已完成的 Home 并继续收敛。
现有独立 Home 不自动加入，也不被修改。
