# 安装与首次成功

[文档导航](README.md) · 中文 | [English](quickstart.md)

已经能打开 BizAgent？直接进入[用户指南](user-guide.zh-CN.md)。这一页只带你完成安装并确认一条记忆真正保存成功。

## 安装

准备 Node.js 24 及以上，或 22.19 及以上的 22.x，以及 pnpm 11。
已有 DSH 时先运行 `dsh --version`，跳过全局安装命令，保留正在工作的环境。

```sh
# 仅在未安装 DSH / pnpm 时执行：
npm install --global @deepseek-ai/dsh@0.2.1-rc.2 pnpm@11

git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci
npm run build
BIZAGENT_PACKAGE=$(npm pack --silent)
dsh plugin --profile web add "$PWD/$BIZAGENT_PACKAGE"
```

安装、开发依赖和 CI 统一使用 DSH `0.2.1-rc.2`，与真实浏览器验收版本一致。
验证范围见[兼容与验证](verification.md)。
安装和启动需要使用同一个 profile、同一个 `DSH_HOME`；默认是 `web` 和 `~/.dsh`。

## 连接模型并启动

新启动的 DSH 默认使用 DeepSeek；先设置自己的 Key，再启动：

```sh
export DEEPSEEK_API_KEY=sk-...
dsh --profile web
```

已经运行的 DSH 请在模型/凭据设置中配置；在新终端 `export` 不会改变已有进程的环境。
模型需要支持工具调用，并能容纳 DSH 自带工具及 BizAgent 的 59 个工具。
其他 OpenAI 兼容模型的配置见[配置参考](configuration.md#model-connection)。

打开终端打印的登录链接。侧边栏应出现 **BizAgent 组织**。
给运行中的 profile 安装插件后，等待 DSH 应用变更并刷新页面；入口未出现时先看终端的插件加载错误。

## 第一次成功：存下一条规则

不用先建组织，也不用先理解所有概念。

1. 点 **BizAgent 组织 → 学习 → 我的个人 Home → 对话**。
2. 发送：

   > 请在当前 Home 记住一条仅用于上手练习的规则：虚构订单的 GMV 只计 paid，排除 cancelled 和 refunded。
   > 请实际保存，并告诉我资产编号和状态。不要把它当成真实业务规则。

3. 点会话顶部的 Home，回到「学习」，展开这条资产，检查**正文、证据来源和状态**。
   Agent 口头说“记住了”不足以证明保存成功。
4. 若状态为 `active`，在**同一个 Home 工作区**中新建 DSH 会话，请它读取刚保存的规则。
   核对新会话顶部的 Home；再点「对话」会重新打开原来的主会话，不算新会话验证。

**成功标志**：学习页有这条规则及来源，新会话实际读取了它。
若是 `candidate`，先让 Agent 核对证据再发布；候选内容不会进入默认生效索引。
新会话默认拿到索引，需要使用规则时再读取正文。

## 下一步怎么走

| 当前情况 | 建议下一步 |
| --- | --- |
| 只需要个人记忆 | 继续在自己的 Home 工作，按需查看、修订经验 |
| 首次设置，想体验团队 | 在「组织」点「创建示例团队」，跟随页面向导；内置订单结果为 400.50 元 |
| 已有组织，想试协作 | 按[用户指南](user-guide.zh-CN.md)创建两个练习 Home，完成 300 元订单练习 |
| 想直接建自己的团队 | 在首次组织向导填写使命、成员和共享能力，再从各 Home 的「对话」进入 |

已有组织时保留它，不必删除目录来重跑向导。

## 遇到问题时

| 现象 | 先检查 |
| --- | --- |
| 找不到 pnpm | pnpm 11 是否在 DSH 进程的 PATH 中 |
| 侧边栏没有 BizAgent | profile、`DSH_HOME`、终端加载错误，以及[已验证版本](verification.md) |
| 提示 writer 已占用 | 确认数据由哪个进程使用；独立试用同时设置新的 `DSH_HOME` 和 `BIZAGENT_HOME`，不要结束不明进程 |
| 看不到新记忆 | 是否选对 Home、是否被筛选隐藏、是否为 candidate；检查保存工具结果 |
| 分析师没有运行 | 「工作与经验」的 Work 状态与启动错误；自动执行要求双方 owner 相同；`@` 引用只提供上下文 |
| 找不到项目或验收按钮 | 返回负责人/项目会话，或从「我的审核待办」查找；确认已登录、具备权限、有待验收提交，并填了理由 |
| GMV 与教程不一致 | 内置示例为 400.50 元；独立的四笔订单练习为 300 元，不能混用口径 |

下一页：[用户指南](user-guide.zh-CN.md)，按界面完成独立派工、查看交付和人工验收。
