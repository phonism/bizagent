# BizAgent v0.1-alpha.2 本地快速上手

## 前置条件

- Node.js `^22.19.0` 或 `>=24.0.0`；
- pnpm `>=11.8.0`（DSH 的 profile 插件管理器会调用它）；
- DeepSeek Harness `0.1.1-rc.2`；
- DSH `web` profile。alpha 依赖该 profile 已挂载的 `ctx.storageDomain`；
- 本地单用户环境。

## 1. 构建与测试

```sh
git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci
npm test
npm run typecheck
npm run smoke
```

最后一条命令会在隔离临时目录里真实运行 `init → home create → home list → doctor`。成功时输出：

```text
BizAgent DSH smoke test passed: 2 Homes, doctor ok.
```

## 2. 创建两个 Agent Home

下面使用隔离目录；正式使用时省略 `--root`，默认写入 `$DSH_HOME/bizagent`。

```sh
node lib/cli.js --root /tmp/bizagent-demo init --default-home personal:alice
node lib/cli.js --root /tmp/bizagent-demo home create role:growth-strategy
node lib/cli.js --root /tmp/bizagent-demo home list
node lib/cli.js --root /tmp/bizagent-demo doctor
```

生成的数据结构：

```text
/tmp/bizagent-demo/
├── directory.yaml
└── homes/
    ├── personal--alice-.../
    │   ├── home.yaml
    │   ├── identity.md
    │   ├── memory/
    │   ├── insights/
    │   ├── knowledge/
    │   └── methods/
    └── role--growth-strategy-.../
```

## 3. 打包并安装进 DSH

```sh
npm run build
npm pack
dsh plugin --profile web add ./bizagent-dsh-0.1.0-alpha.2.tgz
dsh --profile web --dump-config
dsh --profile web --no-open
```

`--dump-config` 中应出现：

```yaml
- id: bizagent
  name: '@bizagent/dsh'
- id: bizagent-ui
  name: '@bizagent/dsh/ui-host'
```

Bundle 默认创建并绑定 `personal:default`。若要使用前面创建的目录，在 profile 的 `cordis.patch.yml` 中覆盖整行
配置。DSH patch 替换完整 `config`，因此要重述需要保留的字段：

```yaml
- id: bizagent
  config:
    homeRoot: /tmp/bizagent-demo
    defaultHome: personal:alice
    autoCreateDefaultHome: false
    workspaceHomes:
      /absolute/path/to/role-workspace: role:growth-strategy
    identityMaxBytes: 6144
    indexMaxBytes: 16384
    learningCheckpointEnabled: true
```

首次 Home Context 注入后，Session 的 Home binding 不再改变。`workspaceHomes` 使用最长路径前缀匹配；没有匹配时
使用 `defaultHome`。

## 4. 单 Agent 学习

在 `personal:alice` 的 Session 中完成真实任务并给出明确纠正，例如：

```text
记住：以后修改配置之前必须先创建备份。
```

如果当前 Turn 尚未主动写入 Memory，BizAgent 会在 Turn 结束前追加一次有界 Learning Checkpoint。Agent 只能选择
`remember` 或 `skip`；同一个 Session/Turn 最多结算一次。Agent 也仍可在正常工作中主动调用：

```text
bizagent_memory_remember
```

Checkpoint Memory 引用明确纠正所在的原始 `user/message`；主动 remember 则引用当前 DSH turn。两者都不要求模型
手填事件序号。之后开启一个新的 Personal Session：

1. Home Revision 已递增；
2. 新 Context 只包含 Memory 一行索引；
3. Agent 使用 `bizagent_memory_search` 和 `bizagent_memory_read` 读取正文；
4. `bizagent_evidence_read` 可以回读资产引用的有界原始事件；
5. 使用结果通过 `bizagent_memory_feedback` 记录为 applied、confirmed、contradicted 或 failed。

`retrieved` 和 `applied` 不改变 Fitness；只有 confirmed、contradicted 和 failed 改变分数。累计两次负向结果会返回
`reviewRequired: true`，但不会自动删除资产。

## 5. 跨 Agent 学习

Personal Agent 发现经验属于 `role:growth-strategy` 时调用：

```text
bizagent_memory_propose
```

Role Session 使用：

```text
bizagent_proposals
bizagent_proposal_accept
# 或 bizagent_proposal_reject
```

发送方不能调用 accept 越权发布；只有主 Home 与 proposal 目标一致的 Session 能结算。接受操作以 proposal id
生成确定性 asset id，重复调用不会创建第二份资产。

## 6. 当前工具

```text
bizagent_home_status
bizagent_memory_search
bizagent_memory_read
bizagent_evidence_read
bizagent_memory_remember
bizagent_memory_update
bizagent_memory_propose
bizagent_proposals
bizagent_proposal_accept
bizagent_proposal_reject
bizagent_learning_checkpoint
bizagent_memory_feedback
```

## 7. 组织记忆台

启动 DSH Web 后，点击左侧栏底部的 **BizAgent memory**：

1. 在 Home directory 中选择一个 Home；
2. 通过 Memory strata 查看 Episode、Memory、Insight、Knowledge 和 Method 的数量与成熟方向；
3. 在 Learning ledger 中搜索、筛选并展开资产，检查正文、fitness 和 evidence；
4. 在 Proposal inbox 中以目标 Home owner 的身份留下裁决说明，再接受或拒绝；
5. 需要新的所有权边界时，使用 Create Home。UI 不提供无证据的直接 Memory 编辑入口。

UI 作为 DSH Client 插件加载。Host adapter 是独立 Cordis row `bizagent-ui`，通过同源、无缓存、64 KiB
上限的 `/api/bizagent/v1/*` 接口读写；跨源 mutation 会被拒绝。

## 8. Alpha 限制

- 只支持单进程、单用户 owner 语义；
- 只有当前主 Home 可读写，尚未实现 Frame；
- DSH headless profile 默认不提供 `storageDomain`，需要额外组合存储插件；
- 不做 embedding、自动 Insight 生成或 Identity 自动修改；
- Home 文件应位于普通 Session workspace 之外，并配合 DSH sandbox；
- 自动 Checkpoint 只识别保守的明确纠正，不总结普通 Turn，也不自动生成 Insight 或修改 Identity；
- `pnpm` 在独立 profile 中可能报告 DSH peer 缺失；DSH 通过 host/profile 双锚点解析这些 peer。只要
  `--dump-config` 与实际启动均通过，该安装就是有效的。
