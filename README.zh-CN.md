# BizAgent

给 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 上的 Agent 加上长期记忆和团队协作。

**语言**：[English](README.md) | 中文

DSH 负责运行对话、调用模型和工具。BizAgent 为 Agent 提供持续存在的 **Home**，保存身份、经验和工作记录，
让它能在新对话中复用经验，也能把工作交给其他 Agent，最后由你验收结果。

- **记得住**：经验保存为可查看的 Markdown/YAML，附带来源；新会话拿到身份和生效经验索引，按需读取正文。
- **分得清**：每段会话归属一个 Home；引用其他 Home 的知识使用只读 Frame，分享经验需要目标方审批。
- **交得出**：正式 Work 有接单、执行和交付记录；Project 汇总结果，等待你确认通过或退回返工。
- **找得到**：会话顶部显示 Home，「工作与经验」显示进度、产物和项目，收件箱保存通知与回复。

## 从这里开始

| 你现在的情况 | 下一步 | 完成标志 |
| --- | --- | --- |
| 第一次接触 DSH / 尚未装插件 | [安装与首次成功](packages/dsh/docs/quickstart.zh-CN.md) | 在「学习」里看到自己教的一条规则 |
| 已能打开 BizAgent | [用户指南](packages/dsh/docs/user-guide.zh-CN.md) | 完成一次独立派工并亲自验收 |
| 已有组织，想看进度或结果 | [入口与状态速查](packages/dsh/docs/user-guide.zh-CN.md#入口与状态速查) | 找到执行会话、交付内容和项目验收状态 |
| 想研究实现或接入自己的宿主 | [文档导航](packages/dsh/docs/README.md) | 按需查概念、配置、架构或工具 |

第一次使用不必先建组织。先在自己的 Home 验证记忆，再尝试团队协作。
已经有组织时继续使用现有组织；用户指南提供独立的练习 Home，不要求重置数据。

![BizAgent 组织页的示例团队与上手向导](assets/screenshots/sample-team.png)

## 一个完整例子

在[用户指南](packages/dsh/docs/user-guide.zh-CN.md)中，你会创建两个练习 Home，让负责人记住 GMV 口径，
把四笔虚构订单交给分析师在独立会话中核对。结果为 **300 元**；负责人复核并提交后，你在页面人工验收。
每一步都给出入口、可复制的需求和成功标志。

内置「示例商店」使用另一份 `orders.csv`，对应 GMV 为 **400.50 元**。
两组数据的口径和用途见[用户指南](packages/dsh/docs/user-guide.zh-CN.md#内置示例团队)。

## 不用模型先试试

Learning Lab 在临时目录运行三个固定案例，不需要模型或 DSH 进程：

```sh
git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci
npm run examples
```

它验证服务逻辑；真实模型与浏览器的验证范围见[兼容与验证](packages/dsh/docs/verification.md)。

## 适用范围

当前面向一个人在本机 DSH Web 中管理自己的 Agent 团队；DSH 是唯一支持的运行环境。
包的开发基线、已实测的 DSH 版本和已验证功能见[兼容与验证](packages/dsh/docs/verification.md)。
BizAgent 管理 Home 和交付记录的归属；机器上的文件与进程权限由 DSH 控制，详见[信任边界](packages/dsh/docs/architecture.md#trust-model)。

更多入口：[文档导航](packages/dsh/docs/README.md) · [参与贡献](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [MIT 许可证](LICENSE)
