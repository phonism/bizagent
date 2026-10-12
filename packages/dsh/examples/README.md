# Learning Lab

三个无需模型服务的案例，演示 BizAgent 当前的学习逻辑：

| 场景 | 来源 → 目标 | 内容类型 |
| --- | --- | --- |
| `growth` | Personal 分析师 → Role 增长策略 | 有适用范围的留存比较 Method |
| `engineering` | Personal 开发者 → Capability 配置审查 | 验证备份可恢复的 Method |
| `support` | Personal 客服 → Business 演示商店 | 带产品版本的 Knowledge |

场景背景、操作提示与预期结果见[案例指南](../docs/casebook.md)。

## 运行

在仓库 checkout 中，需要满足[包清单](../package.json)的 Node 版本。首次安装依赖需要访问包源；案例执行本身
不访问网络、不调用模型、不启动 DSH，也不安装或修改本机 DSH profile。

```sh
cd packages/dsh
npm ci
npm run examples
```

只运行一个案例：

```sh
npm run examples -- growth
npm run examples -- engineering
npm run examples -- support
```

`npm run examples` 先构建源码再运行案例。已经构建或从 tarball 解包后，可直接执行：

```sh
node examples/learning-lab.mjs all
```

每个场景使用新建的系统临时目录，结束后只清理自己创建的目录。脚本会输出十一个阶段，全部通过后以 exit 0 结束：

```text
[growth] Growth analysis: comparable retention cohorts
  1. Candidate saved; default search excludes it; source evidence is readable.
  2. Stale publication rejected; the reviewed revision is now active.
  3. Sender cannot approve; target owner accepts; replay creates no duplicate.
  4. A read-only Agent Frame reuses the target index without changing the author Home.
  5. Future context contains only the index; feedback requests review; owner retires the asset.
  6. Home files reload correctly; retirement does not alter the author's copy.
  7. Review progress is explicit; later Session changes remain pending after a ledger reopen.
  8. Inbox delivery, reply, and handling survive a ledger reopen without changing Work or Memory.
  9. Formal Work binds one worker Session and one returned result beyond ordinary Inbox replies.
  10. Project submission records linked Work and an exact owner review across ledger reopen.
  11. Session Worklog links formal Work, verifies source events, and tracks a Workspace file.
```

全部三个案例的最后一行：

```text
Learning lab passed: 3 scenarios. Temporary data removed.
```

## 演示是真实到哪一层

| 部分 | 如何执行 | 验证范围 |
| --- | --- | --- |
| HomeStore | 真实实现，读写临时 Markdown / YAML | 候选、版本、索引、退休与重新加载 |
| BizAgentService | 真实实现，调用学习、裁决和反馈方法 | Home 所有权、版本冲突、目标接受、结果复核 |
| LearningLedger | 真实 schema 与逻辑，底层使用内存表 | 此次进程内的绑定、Frame、Inbox、提案、回执与材料处理水位；重新打开内存账本不是跨进程持久化验证 |
| WorkLedger | 真实 schema 与逻辑，底层使用内存表 | 正式责任、结果预留与终态；不验证真实 worker Session 启动和跨进程竞争 |
| ProjectLedger | 真实 schema 与逻辑，底层使用内存表 | 关联 Work 的结果声明与审阅；不验证真人身份、文件快照或运行状态 |
| WorklogLedger | 真实 schema 与逻辑，底层使用内存表 | Session 摘要修订、Work/Project 关联、来源指纹和文件哈希；不验证跨进程持久化 |
| DSH Session / sessionQuery | 最小合成事件与内存查询 adapter | 来源引用与有界回读接口 |
| 模型与业务数据 | 未运行模型；数据为虚构 fixture | 不验证模型调用工具的成功率或业务收益 |

最后一步重新加载的是 Home 文件，**不是生产 DSH 账本的跨进程恢复测试**。内存 adapter 不适用于生产。
在真实 DSH 中，宿主提供持久 storageDomain 与原始 Session；参见[架构的数据分工](../docs/architecture.md)。

## 阅读代码

- [learning-lab.mjs](learning-lab.mjs)：按执行顺序阅读完整流程，每一步都有行为断言。
- [scenarios.mjs](scenarios.mjs)：三个场景的输入、已审阅正文与后续反例。
- [demo-runtime.mjs](demo-runtime.mjs)：让示例不依赖启动 DSH 的教学 adapter。

这些脚本使用构建产物中的内部模块以便演示当前实现，不承诺成为独立稳定 SDK。真实 Agent 调用方式见
[工具参考](../docs/tools.md)；真实安装与自动检查点验证见[快速上手](../docs/quickstart.md)。
