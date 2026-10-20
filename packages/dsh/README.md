# @bizagent/dsh-plugin

**语言**：中文 | [English](README.en.md)

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 上的 Agent 加上长期记忆和团队协作。

BizAgent 用 Home 保存身份、经验和工作记录，支持共享知识、收件箱、独立派工和人工验收。
DSH 负责运行模型、工具和会话。

## 从这里开始

```sh
dsh plugin --profile web add @bizagent/dsh-plugin@1.0.1
```

- **尚未安装**：[中文安装指南](docs/quickstart.zh-CN.md)。
- **已经安装**：[用户指南](docs/user-guide.zh-CN.md)，完成记忆、派工和人工验收。
- **查询功能**：[文档导航](docs/README.md)，按需查概念、配置和工具参数。
- **核对版本与验收范围**：[兼容与验证](docs/verification.md)。

先在自己的 Home 保存一条规则，不必先建组织。已有组织时使用独立的练习 Home，无需重置数据。

## 在 DSH Web 中使用

| 入口 | 用途 |
| --- | --- |
| BizAgent 组织 | 管理 Home、查看经验、审核提案和项目 |
| 会话顶部的 Home | 确认会话归属，打开对应 Home 的经验 |
| 工作与经验 | 查看本会话的派工、执行会话、交付结果和项目 |
| 轮次回执 | 打开这一轮实际保存成功的记录 |
| 输入区 `@` 与 Frame 状态栏 | 在当前会话加载共享 Home 的只读上下文 |
| 我的收件箱 | 读取 Agent 消息，回复并唤回原会话 |

双方 Home 属于同一 owner 时，正式 Work 会在独立执行会话中运行。
Frame 在当前会话提供只读上下文；提交后的 Project 由人验收。

## 包入口

| 导入路径 | 用途 |
| --- | --- |
| `@bizagent/dsh-plugin` | 核心插件与类型（`name`、`inject`、`Config`、`apply`） |
| `@bizagent/dsh-plugin/ui-host` | 需要登录的面板 HTTP 接口 |
| `@bizagent/dsh-plugin/local-human-host` | 本机用户的审核与收件箱接口 |
| `@bizagent/dsh-plugin/client` | DSH Web 加载的浏览器模块 |
| `@bizagent/dsh-plugin/host` | 接入自有身份认证宿主的基础组件 |

包内还提供 `bizagent` 命令，支持 Home 初始化、创建与列表、健康检查、重建索引和归档导入导出。
运行 `bizagent --help` 查看用法。

## 开发

```sh
npm ci
npm test
npm run typecheck
npm run examples
npm run smoke:local-human
npm run smoke:session-ui
npm run pack:check
```

运行时冒烟使用隔离的 DSH profile 和本地模拟模型；服务测试、运行时集成与真实模型浏览器验收的区别见
[兼容与验证](docs/verification.md)。发布后可运行 `npm run smoke:registry` 验证公开 npm 包的安装流程。
用户可见的变更记录在 [CHANGELOG](CHANGELOG.md)。

[MIT 许可证](LICENSE)
