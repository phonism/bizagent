# BizAgent

面向 Claude Code CLI 与 Agent SDK 的业务记忆与运行时 harness。

> Claude Code 的上下文边界通常是一个代码仓库。BizAgent 的上下文边界是一个业务：
> 产品线、共享模块、长期 worklog、可复用业务记忆。

**语言**：[English](./README.md) | [中文](./README.zh-CN.md)

## 这是什么

BizAgent 给 agent runtime 外面包了一层业务团队反复使用所需的底座：

- 产品线是实体目录，每条线装自己的业务和共享模块。
- 业务记忆以 frontmatter Markdown 记录在 `memory/` 下。
- 每次 session 的 worklog 写在 `.bizagent/deliverables/<runId>/worklog.md`。
- 通过 Claude Code / SDK hooks 做记忆写入治理与 worklog 强制。
- 支持跨 session、可选跨用户共享上下文。
- CLI、Agent SDK、内置 web 平台共用同一套 core 实现。

本仓库包含可运行的 BizAgent 实现。

## 当前能力

- `biz init` 创建根目录；`biz line new` 创建产品线（首次使用也会惰性创建）。
- `biz new <slug> --line <line>` 在线内创建业务，物化共享知识 symlink 与 hook 接线。
- `biz module new --line` / `biz link` 建模线内共享技术模块（模块永不跨线）。
- `biz setup <slug>` 引导式初始化：对话补业务画像、登记模块、冷启动知识库。
- `biz mem add/list` 写入和检索业务记忆，并走治理校验。
- `biz run` 在业务内启动 Claude Code，并注入完整 system prompt。
- `biz run --view` 打开终端会话的只读浏览器镜像。
- `biz web` 启动内置 HTTP/SSE web 平台。
- Agent SDK helper 用进程内方式接入同一套上下文和 hooks。
- Remote sharing 支持 `file`、固定契约 `http`、自定义 `module` 三档。

当前没有实现：指标异常监控、SQLite 真正 SOT、MCP 检索、embedding、生产级多租户平台服务。

## 安装

```sh
cd packages/bizagent
npm install
npm run build
npm link
biz --help
```

CLI 默认启动 `claude`。可以用环境变量覆盖 agent 可执行文件：

```sh
CLAUDE_PATH=/path/to/claude
BIZ_AGENT_BIN=/path/to/custom-agent
```

## 快速开始

```sh
biz init ./acme --web
cd acme

biz new webstore --line commerce         # commerce 线惰性创建
biz setup webstore                       # 引导式初始化，全程对话
biz mem add webstore "GMV excludes cancelled orders" --confidence 0.9
biz mem list webstore

biz run webstore
# 或：
cd lines/commerce/businesses/webstore && biz
```

启动 web 平台：

```sh
biz web
```

预览一次 agent run 会注入的完整上下文：

```sh
biz context webstore
```

## 目录模型

根目录装产品线；产品线装自己的知识层、模块和业务。业务 slug 全局唯一（跨线也不重名），
所以命令和路由只用 slug。模块永不跨线 link。

```text
acme/
├── bizagent.config.json
├── prompts/
├── knowledge/
│   └── common/
└── lines/
    └── commerce/
        ├── knowledge/
        ├── modules/
        │   └── backend/
        │       ├── module.json
        │       ├── code/
        │       └── memory/
        └── businesses/
            └── webstore/
                ├── business.json
                ├── CLAUDE.md
                ├── .claude/settings.json
                ├── knowledge/
                │   ├── business/
                │   ├── common   -> 根 knowledge/common
                │   └── commerce -> ../../knowledge
                ├── modules/
                │   └── backend -> ../../modules/backend
                ├── memory/
                └── .bizagent/
                    ├── deliverables/<runId>/worklog.md
                    ├── worklog-index.md
                    └── remote-memory/
```

可编辑来源主要是 `memory/`、`knowledge/business/`、模块记忆和可选 prompt 覆盖。
真正重要的运行规则、业务记忆、历史 session、输出 block 协议、模块上下文和
worklog 指令由 `buildSystemPrompt` 在启动时组装，不放进 `CLAUDE.md`。

## 记忆与治理

业务记忆是 Markdown 文件：

```markdown
---
scope: business
confidence: 0.9
writable_by: agent+human
updated_at: 2026-06-05T00:00:00.000Z
---

GMV excludes cancelled orders.
```

hook 层负责治理：

- agent 不能写 curator 层：根 `knowledge/common` 和产品线的 `knowledge/`。
- business memory 必须是 `.md`，必须有 `scope: business`，正文不能为空。
- `Write` 和 `Edit` 都按写入后的完整内容校验。
- 如果当前 run 没写 worklog，Stop 会拦截一次并提醒补写。
- 完成的 worklog 会索引进 `.bizagent/worklog-index.md`。

`biz mem add` 和 web memory API 使用同一套校验，不是治理后门。

## Remote 共享

Remote sharing 是可选的。每个本地业务仍是自己的真相来源；remote 只是
尽力而为的共享层，用于同步 worklog 摘要、worklog 正文和 business memory。

```sh
biz init ./acme --remote file:../hub
```

支持三档 remote：

- `file`：共享本地目录，适合测试或简单共享存储。
- `http`：固定 REST 契约，配置 base URL 和 headers。
- `module`：用户提供 JavaScript factory，返回自定义 Remote 实现。

remote 调用有超时并且 fail open：远端慢或不可用时，不会破坏本地 agent run。

原始会话 transcript 是单独的 opt-in（remote 块加 `"transcripts": true`，它带有文件内容
和命令输出）：每次 Stop 把会话新增的 transcript 行镜像到 hub，平台 web 据此只读渲染
对话——远端会话在平台上可看、永不可 resume。

跑着 `biz web` 的部署（或任何挂载 `createBizHandler` 的宿主）同时就是 `http` 契约的服务端：
`/api/businesses/:slug/hub/*` 在平台活数据上服务 index/worklog/memory/transcript，并提供只读的
`manifest` + `file` 拉取面（给将来的冷启动 pull）。`remote.url` 支持 `${SLUG}` 插值，
一份配置覆盖全部业务。

## 开发

```sh
cd packages/bizagent
npm test
npm run typecheck
npm run build
npm run biz -- --help
```

部分 web / HTTP 测试会监听本地端口。在受限 sandbox 里可能报 `listen EPERM`；
filesystem、governance、runtime-sdk、session、prompt、module、remote 纯逻辑测试不需要监听端口。

## 发布

```sh
scripts/release.sh --dry-run
scripts/release.sh --publish
```

发布脚本从 `packages/bizagent/package.json` 读取版本号，构建并 typecheck，执行
`npm pack --dry-run`。在 `--publish` 模式下，它会提交当前改动，创建
`bizagent-v<version>` tag，推送 `main` 和 tag，然后执行 `npm publish --access public`。

发布前先确认 `npm whoami` 正常。如果受限 sandbox 里本地端口测试失败，应在正常开发机发布，
或明确传 `--skip-tests`。

## 文档

- [packages/bizagent/README.md](./packages/bizagent/README.md)：包级使用说明。
- [packages/bizagent/docs/design.zh-CN.md](./packages/bizagent/docs/design.zh-CN.md)：
  与实现同步维护的设计文档。

## 许可

基于 [Apache-2.0](./LICENSE) 授权。
