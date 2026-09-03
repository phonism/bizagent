# BizAgent 插件化 UI

## 目标

UI 的职责是让用户先创建可工作的 Agent 组织，再让组织学习变得可观察、可检查、可裁决；它不拥有 Memory
规则，也不实现第二套 Agent Runtime。界面由 **Organization / 组织** 与 **Learning / 学习** 两个视图构成。

## 插件边界

```text
@bizagent/dsh                     DSH Host
├── bizagent                      Learning Kernel Cordis row
│   ├── HomeStore                 文件事实源
│   ├── LearningLedger            DSH Storage Domain 运行账本
│   ├── Home Context              DSH durable agent.inject snapshot
│   └── 12 tools                  Agent 学习、Checkpoint 与证据入口
├── bizagent-ui                   独立 Host adapter Cordis row
│   └── /api/bizagent/v1/*        Web-only 同源 JSON API
└── dsh.client                    DSH 自动发现的 Web Client 插件
    ├── sidebar.footer.action      入口
    └── shell.overlay              首次引导、组织图与学习台
```

约束：

- learning kernel 不 import React、DOM 或 WebServer；
- Client 不读取 Home 文件，不直接依赖 Host service；
- UI Host adapter 只编排已有 `BizAgentService`、`HomeStore` 与 `LearningLedger`；
- Client 只通过版本化 HTTP contract 通信；
- UI row 或 Client 失败不改变 Home 文件格式和 Agent 学习语义。

## 信息架构

- **First-run setup**：定义组织使命，选择团队模板，编辑成员/角色，确认共享能力；
- **Organization map**：Business 为组织根，成员以 Personal + Role 配对展示，Capability 构成共享能力层；
- **Home directory**：四类 Home、revision、pending proposal；
- **Memory strata**：Episode → Memory → Insight → Knowledge → Method；
- **Learning ledger**：全文搜索、kind/status 筛选、asset body、fitness、receipt、evidence；
- **Proposal inbox**：只显示当前目标 Home 的 pending proposal，留下 decision 后结算；
- **Create Home**：创建新的长期所有权边界。

UI 故意不提供直接创建或编辑 Memory 的表单。Memory 必须来自真实 Agent turn，或来自带 evidence 的 proposal；
否则界面会成为绕过自进化治理规则的后门。

## API

```text
GET  /api/bizagent/v1/overview
GET  /api/bizagent/v1/home?address=<HomeAddress>
POST /api/bizagent/v1/organization
POST /api/bizagent/v1/homes
POST /api/bizagent/v1/proposals/decision
```

安全与运行约束：

- 所有响应 `Cache-Control: no-store`；
- mutation 要求浏览器 `Origin` 与当前 `Host` 相同；
- JSON request body 上限为 64 KiB；
- Zod 校验组织标识、成员/角色/能力、Home address、proposal id、decision 与目标 kind；
- proposal decision 必须显式携带 owner Home，Service 再次验证其与 proposal target 一致；
- 当前 API 只适用于 DSH 本地 Web profile，不承诺 Electron/远程多租户认证语义。

## 视觉系统

界面沿用 DSH theme token，新增少量语义信号色：

- Signal blue `#4176E6`：Memory、当前选择、主动作；
- Cognition purple `#7357D8`：Insight；
- Transfer orange `#E58A3A`：Method 与跨 Home proposal；
- Synthesis cyan `#2D9CA8`：Knowledge；
- Fitness green `#35A46F`：正向验证。

标志性组件是 Organization map：它明确显示组织根、Personal/Role 责任配对和共享能力层；Learning 视图中的
Memory strata 则直接投影 GrowthOS 多级 Memory 模型。界面支持窄屏重排、键盘 focus ring、Escape 关闭、
点击遮罩关闭和 `prefers-reduced-motion`。

## 持久化与故障语义

Organization 不是第五类 Home，而是引用四类 Home 的关系清单，持久化为 Home root 下的 `organization.yaml`。
创建过程先校验整份请求，再以原子目录 rename 创建每个 Home，最后原子写入组织清单；因此 UI 不会看到引用
不存在 Home 的半成品组织。若进程在写清单前中断，用相同组织 id 重试会复用已完成的 Home 并继续收敛。
现有独立 Home 不自动加入，也不被修改。
