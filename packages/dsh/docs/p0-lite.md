# P0 Lite：明确纠正的自动学习

## 目标

P0 Lite 只证明一条纵向闭环：

```text
明确纠正 → Learning Checkpoint → Memory → Home Revision
         → 新 Session 持久复用 → 结果反馈
```

它不自动总结所有工作，也不引入 Episode、Insight 晋升、Frame、Inbox 或 Project。

## 运行协议

1. `ExplicitCorrectionTrigger` 只检查当前 Turn 中直接来自用户的强信号；
2. 如果当前 Turn 已调用 `bizagent_memory_remember`，不再创建 Checkpoint；
3. `agent/turn-stopping` 为同一个 `Session + Turn` 至多创建一次 Checkpoint；
4. Agent 必须调用 `bizagent_learning_checkpoint`，选择 `remember` 或 `skip`；
5. `remember` 生成当前 Home 的 active Memory，证据精确指向原始用户消息；
6. Tool 使用 `concludeTurn()` 结束学习 Step；没有结算的 Checkpoint 在 `turn/end` 后标记 failed；
7. Memory 写入与 Checkpoint 结算之间发生崩溃时，启动对账通过确定性 asset id 恢复 remembered 状态。

Checkpoint 保存到现有 Storage Domain 的 `metadata` 表。这样 alpha.2 不增加表、不修改 domain descriptor，也不要求
迁移 alpha.1 的运行账本。

## Durable Home Context

稳定 Learning Policy 仍属于 `systemPrompt.section`。动态 Home Context 不再使用请求期
`systemPrompt.context`，而是在 `agent/session-start` 时通过 `agent.inject()` 进入 DSH Session Log。

Snapshot 明确包含：

- Home address；
- Home revision；
- context digest；
- 有界 Identity；
- active asset index；
- 当前所有权与检索规则。

插件使用 DSH 的 canonical surface fold 检查当前模型表层；相同 address、revision、digest 已存在时不重复注入。
Home 更新后恢复旧 Session，或新建 Session 时，会注入新的完整 Snapshot。

## Evidence

P0 Lite 的 `bizagent_evidence_read` 只解析资产 `sourceRefs` 中的 `session-events`：

- 通过 `ctx.sessionQuery.readSession()` 读取 live-preferred 日志；
- 校验 seq 范围完整；
- 最多返回 24 个有界事件；
- 不返回 Tool arguments，不复制整份 Transcript；
- Artifact、Document 和其他 Evidence Provider 后置。

## Fitness

```text
retrieved     0
applied       0
confirmed    +0.2
contradicted -0.3
failed       -0.3
```

读取和使用都不能自证正确。累计两条 contradicted/failed Receipt 时，反馈结果返回 `reviewRequired: true`；P0 Lite
不自动删除或退休资产。

## 插件边界

Learning Kernel 不依赖 UI。显式纠正检测实现 `LearningTrigger` 接口，默认只有
`ExplicitCorrectionTrigger`。未来 Tool recovery、QA 验收或业务指标插件可以贡献新的检测实现，而不改变
Checkpoint、Evidence、Memory 和 Fitness 的核心协议。

## 验收

- 普通 Turn 不产生 Checkpoint；
- 明确纠正每 Turn 至多触发一次；
- 已主动 remember 的 Turn 不重复学习；
- Checkpoint 重放不产生第二份 Memory；
- Memory Evidence 能回读到原始纠正；
- DSH 重启后的新 Session 获得新 Home Revision；
- 同 Revision 不重复注入；
- applied 不提高 Fitness；
- 两次负向结果进入人工复查提示。
