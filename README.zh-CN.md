# BizAgent

**BizAgent 的开放规范——面向跨职能业务团队的 AI Agent 平台品类。**
**基于规范快速搭出你自己的 BizAgent，再按你的行业、业务线、工作流去特化。**

> *Code Agent 给开发者；BizAgent 给业务团队。*

[![Spec Status](https://img.shields.io/badge/spec-Draft%20v0.1-orange)](./SPEC.zh-CN.md)
[![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](./LICENSE)

**语言**：[English](./README.md) · [**中文**](./README.zh-CN.md)

---

## 这是什么

AI Agent 正在分工。开发者拿到了 **Code Agent**（Claude Code、Cursor、Devin）。浏览器自动化有 **Web Agent**（Operator、Computer Use）。但**跨职能业务团队**——一起负责一条业务线的数据分析师、PM、工程师、运营——还没有为他们做的 agent。

**BizAgent** 来填这个空：为业务团队定制的 AI Agent 平台。不是 chatbot、不是框架，而是一个**持续运转的工作场**——业务团队与一支自主 Agent 队伍共享同一个 workspace，围绕同一条业务线协作。

本仓库是 BizAgent 品类的 **开放规范**。基于它，任何团队都能：

- ✅ **快速搭起一个 BizAgent**——规范定义了平台的数据模型、记忆层、监控引擎、适配器契约。不用从地基重新造。
- ✅ **按你的业务做特化**——你的行业垂直（电商 / 广告 / SaaS / 金融 / 游戏 / …）、你的指标、你的技能都叠在规范之上，不用分叉一份。
- ✅ **保持可互通**——基于一种符合规范的 BizAgent 搭的 workspace，可以导出并在另一种实现上跑起来，类似 OpenAPI 定义在工具链之间流转。

按规范搭出的 BizAgent，自带两个核心能力：

1. **长期记忆**——Agent 跨 session 积累、检索、更新业务知识，团队不用每次新任务都从零讲业务上下文。
2. **异常监控 + 异步根因调查**——Agent 主动发现业务指标异常，跨多轮异步查询追到根因，不是发一条群告警就结束。

## 核心 harness

搭一个 BizAgent，不是把 LLM 接个 prompt 就行。难的是 **harness**——围绕 agent 让它在业务场景里真正能跑下去的底子：跨 session 的持久记忆、主动监控、长任务的异步恢复、平台和本地模式之间按作用域分层的同步。大多数团队每次都得从头造一遍。

我们跑了半年生产，沉淀出这套写法。分两块：

### 1. 记忆 harness

记忆 harness 主要靠两件事：**4 层分层** 与 **worklog 当一等公民**。

**4 层记忆**：知识按 4 个作用域分层，每层有自己的生命周期与可写性：

| 层 | 这里放什么 | 可写性 |
|---|---|---|
| **Common** | 跨业务的通用方法、playbook（KPI 词汇表、事件复盘模板） | Curator |
| **Domain** | 按业务领域共享的概念（电商 GMV 定义、广告归因模型） | Curator |
| **Business** | 单 workspace 的业务知识（这条业务线的领域模型、踩坑、提炼出的结论） | Agent + 人 |
| **Session** | 单 session 的 worklog + deliverables——一次任务的执行轨迹 | Agent（追加） |

Agent 一次看到 4 层。这样切的好处：业务特化（你的领域、你的业务）叠在规范之上——不用 fork。

**Worklog 当一等公民**：每个 session 写一份 `worklog.md`——frontmatter（title / description / 时间戳）加 Markdown 正文，记录 plan、决策、发现、confusions。Worklog 通过 CLI（agent 每次有意义的更新就调）push 到 DB，文件系统 watcher 兜底。它们沉淀成**长期过程记忆**，下个 session 可以 `grep`；也是 **Consolidation**（定时跑，把 worklog 里反复出现的模式提炼到 Business 知识层）的源数据。

（完整数据模型、同步 API、引擎算法见 [SPEC §2](./SPEC.zh-CN.md#2-记忆子系统)。）

### 2. 监控 harness（Pulse）

> **报警即诊断，而非通知。监控回路应输出根因，不是噪声。**

三抽象：

| 抽象 | 一句话 |
|---|---|
| **Definition** | 指标 = `SQL + 阈值 + cron`，完全配置驱动 |
| **Analysis** | 异常触发 agent 异步多轮调查（不是一次性 LLM 摘要） |
| **Quality** | 硬性 prompt 约束禁止甩锅句式（"建议查 X" 这种） |

**与现有监控工具对比：**

| 系统 | 报警输出 | 多轮 | 根因约束 |
|---|---|---|---|
| Datadog / Grafana | 指标读数 + 阈值 | ✗ | ✗ |
| Datadog AI Monitoring | + LLM 摘要 | 单轮 | 弱 |
| PagerDuty Ops Cloud | + LLM incident 摘要 | 弱 | 弱 |
| **BizAgent Pulse** | **+ agent 推出的根因** | **✓ 异步多轮** | **✓ 硬性约束** |

## 状态

| | |
|---|---|
| 规范 | **Draft v0.1**（2026-05-25） |
| 参考实现 | 进行中（独立发布） |
| 采用者 | 欢迎 PR |

草案期会随社区反馈做不兼容改动。等至少两个独立实现跑起来，再切 `v1.0`。

## 如何使用规范

[**SPEC.zh-CN.md**](./SPEC.zh-CN.md) 是写给 **Code Agent**（Claude Code、Cursor、Devin 等）看的。预期工作流：

```bash
# 1. Clone 本仓库（或把 SPEC.md 的 URL 给 agent）
git clone https://github.com/phonism/bizagent
cd bizagent

# 2. 在 Claude Code / Cursor / 你选的 agent 里：
> 读 SPEC.zh-CN.md，按它描述的内容把 BizAgent 平台搭到 ./my-bizagent。
> 然后跑 §6 的符合性测试。

# 3. 按你的业务做特化（§7）
> 把公司内的业务平台、数据表、运营工具、业务知识接进来。
```

每节都给 **schema、API、算法、TypeScript 接口**——足以让 agent 不需要进一步解释就生成可运行的代码。章节地图：

| 章节 | 规定的内容 |
|---|---|
| [§1 项目布局](./SPEC.zh-CN.md#1-项目布局) | Agent 要生成的目录树 |
| [§2 记忆子系统](./SPEC.zh-CN.md#2-记忆子系统) | SQL DDL · 清单同步 API · Worklog · Knowledge · Recap · Consolidation |
| [§3 监控（Pulse）](./SPEC.zh-CN.md#3-监控子系统pulse) | 指标 schema · 5 种规则 · 调度 · 原子认领 · 调查流程 |
| [§4 运行时原语](./SPEC.zh-CN.md#4-运行时原语) | Wakeup 引擎 · Monitor 引擎 |
| [§5 适配器](./SPEC.zh-CN.md#5-适配器) | AgentRunner / AsyncQuery / Storage 的 TypeScript 接口 |
| [§6 符合性测试](./SPEC.zh-CN.md#6-符合性测试) | 用来验证 build 的测试 ID |
| [§7 特化指南](./SPEC.zh-CN.md#7-特化指南) | 怎么把你的行业 / 业务叠在 baseline 之上 |
| [附录 A：设计原理](./SPEC.zh-CN.md#附录-a设计原理可选阅读) | 关键决策的理由（可选阅读） |

[SPEC.md](./SPEC.md)（英文）与 [SPEC.zh-CN.md](./SPEC.zh-CN.md)（中文）平行维护，1:1 对应。歧义时以英文为准。

## 为什么是规范而不是库

库只能让一种实现变容易。规范让 *每种* 实现之间互通。BizAgent 关注：

- **跨基础设施可移植**——你的记忆与监控选型不会被某个 agent SDK 或模型绑死。
- **跨实现可测试**——第五部分的测试矩阵让「符合规范」可被验证，不是自说自话。

## 贡献

欢迎 Issue、PR、讨论。

- **编辑性修订**（拼写、澄清、补例子）—— 直接 PR。**英文 `SPEC.md` 与中文 `SPEC.zh-CN.md` 在同一 PR 内同步改动。**
- **语义性变更**（实体形状、协议契约、符合性规则）—— 先开 RFC issue 讨论，再 PR。
- **新适配器** —— 在 [§5 适配器](./SPEC.zh-CN.md#5-适配器) 下提议。

变更历史见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## 许可

本规范采用 [CC BY 4.0](./LICENSE)——可自由分享与改编，包括商用，需署名。
