# BizAgent

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 长期 Agent 的组织学习插件。

**语言**：[English](./README.md) | [中文](./README.zh-CN.md)

BizAgent 是一个 DSH 插件。DSH 负责让 Agent 运行；BizAgent 帮 Agent 和它所在的组织把学到的东西留下来：

- **Agent Home**：每个长期 Agent 有一个稳定的身份，不随某个 Session 或 Workspace 变化。
- **带证据的记忆**：经验存成记忆、洞察、知识或方法，并关联到产生它的原始事件。新经验先作为候选，
  核验后才生效。
- **受控的共享**：一个 Agent 可以向另一个 Agent 的 Home 提交经验提案，只有对方的 owner 能接受。

## 状态

BizAgent 正在准备 1.0。目前已发布的代码是 `0.1.0-alpha.2`，本地单用户 alpha 版。1.0 之前，
接口和存储格式仍可能变化。

## 开始使用

插件在 [`packages/dsh`](./packages/dsh/README.md)。构建和安装到 DSH 的步骤见
[快速上手](./packages/dsh/docs/quickstart.md)。

```sh
cd packages/dsh
npm ci
npm test
```

## 仓库历史

本仓库早期还包含一个面向 Claude Code / Agent SDK 的运行时（`packages/bizagent`）。它已不在这里继续开发，
DSH 是唯一支持的运行时。

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 协议

[MIT](./LICENSE)
