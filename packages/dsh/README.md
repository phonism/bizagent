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

## 核心模型

- **Agent Home**：长期身份、记忆、知识、方法与学习出口；不等于 Session、Workspace 或 AgentPreset。
- **多级 Memory**：Working Context → Worklog/Episode → Memory → Insight → Knowledge/Method → Identity。
- **单 Agent 自进化**：Observe → Route → Propose → Validate → Promote → Use → Measure → Revise/Retire。
- **组织级学习**：经验按 Personal、Business、Role、Capability 的所有权流动；跨 Home 只能走 proposal。
- **DSH 原生**：以 Cordis Bundle 安装，不 fork DSH，不实现另一个 Agent Loop，也不运行独立服务。
- **插件化 UI**：Host UI adapter 与 Web Client 分离；DSH 自动发现 Client bundle，learning kernel 不依赖 React。

## UI

安装后，DSH 左侧栏会出现 **BizAgent 组织**：

- 首次打开用三步引导定义使命、成员/角色和共享能力，并批量创建四类 Home；
- 组织视图展示 Business 根、Personal/Role 责任配对和 Capability 共享能力层；
- 组织与关系持久化到 `organization.yaml`，已有独立 Home 不会被引导修改；
- 左侧浏览 Personal、Business、Role、Capability Home；
- 中间用 Memory strata 展示 Episode → Memory → Insight → Knowledge → Method 的沉淀结构；
- 展开资产可检查正文、revision、fitness、使用回执和证据链；
- 右侧 proposal inbox 由目标 Home 接受或拒绝跨 Agent 经验；
- 可创建组织图之外的新 Agent Home，但不能绕开 evidence 规则直接手工创建 Memory。

UI 的 Host API、Client slot 与安全边界见[插件化 UI 设计](docs/ui.md)。

## 计划

- [本地快速上手](docs/quickstart.md)
- [完整产品、架构与实施计划](docs/plan.md)
- [v0.1 最小版本](docs/mvp.md)
- [P0 Lite：明确纠正的自动学习](docs/p0-lite.md)
- [插件化 UI 设计](docs/ui.md)
- [架构决策：UI 插件边界](docs/decisions/0002-ui-plugin-boundary.md)
- [历史决策：外置 RuntimeProvider 方案（已废弃）](docs/decisions/0001-dsh-runtime-boundary.md)

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
