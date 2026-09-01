# BizAgent v0.1：Learning Kernel

状态：实施设计
完整路线：[BizAgent 完整计划](plan.md)

## 1. 目标

v0.1 要证明的不是 BizAgent 能承载多少业务流程，而是它能否在 DSH 上建立最小、可信的组织学习闭环：

1. 一个长期 Agent 能从真实工作中学习，并在新的 Session 中使用新的经验；
2. 经验可以从一个 Agent 流向另一个 Agent，但所有权、证据和审核不会丢失。

## 2. 产品边界

BizAgent 是一个 DSH Bundle/Cordis 插件，不是外置 Python 服务，不代理模型请求，也不实现 Agent Loop。

DSH 继续负责 Session、Turn、Transcript、模型、工具执行、沙箱、权限和恢复。BizAgent 只增加：

- Agent Home 与 Session 绑定；
- Identity 和多级 Memory；
- 有界 Home Context 注入；
- EvidenceRef、Home Revision 和 Fitness Receipt；
- 跨 Home proposal 与 owner 审核。

## 3. v0.1 范围

### 包含

- 一个可安装的 `@bizagent/dsh` Bundle；
- `Personal` 与 `Role` 两类可运行 Home；
- 协议层支持 `Business` 与 `Capability` 地址；
- file-first Home Store；
- Home 到 DSH Session 的 Episode Index，不复制 transcript；
- DSH `storageDomain` 中的绑定、索引、proposal、revision 和 receipt；
- Memory 的 search/read/remember/update/retire；
- 明确纠正触发的有界 Learning Checkpoint；
- 可回读原始 Session event 的 evidence 工具；
- 跨 Home propose/list/accept/reject；
- 持久、可 replay 的 Context Bundle；
- CLI 初始化、doctor 和 reindex；
- 单 Agent 学习与跨 Agent 学习两条 E2E。

### 不包含

- 向量数据库；
- 自动生成完整 Insights；
- Frame、Inbox、Work、Project 和 Pulse；
- 多租户或远程控制面；
- 自动修改 Identity；
- 每 Turn 固定追加一次反思模型调用。

## 4. 最小对象

```ts
interface AgentHome {
  id: string
  address: `${'personal' | 'business' | 'role' | 'capability'}:${string}`
  type: 'personal' | 'business' | 'role' | 'capability'
  displayName: string
  revision: number
  contextDigest: string
  status: 'active' | 'archived'
}

interface LearningAsset {
  id: string
  ownerAddress: string
  kind: 'memory' | 'insight' | 'knowledge' | 'method' | 'identity'
  description: string
  bodyPath: string
  sourceRefs: EvidenceRef[]
  confidence: number
  fitness: number
  status: 'candidate' | 'active' | 'superseded' | 'retired'
  revision: number
}

interface MemoryProposal {
  id: string
  fromAddress: string
  toAddress: string
  proposedKind: LearningAsset['kind']
  description: string
  body: string
  sourceRefs: EvidenceRef[]
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn'
  targetAssetId?: string
  decision?: string
}
```

## 5. Home Context

首次请求前，BizAgent 为当前 Session 解析唯一主 Home，组合：

- Home address、revision 和 digest；
- 有界 Identity；
- 最近 Episode/Worklog 的一行索引；
- Memory、Insight、Knowledge/Method 的一行索引；
- 检索方式与写入权限说明。

这份 Context 必须作为持久 `user/message` 写进 DSH Session Log。相同 revision 在同一 context epoch 不重复注入；
revision 变化时追加 replacement；compaction 遮蔽后恢复当前完整版本。资产正文只有在模型调用读取工具后才进入
transcript。

## 6. 两条验收链路

### A. 单 Agent 自进化

`personal:alice` 在 Session A 中收到一次明确纠正，主动写入带 Session evidence 的 Memory。DSH 重启后，
Session B 自动得到新 Home Revision 的索引，Agent 读取并在相似任务中应用它，随后记录 confirmed/applied
receipt。

### B. 组织级学习

`personal:alice` 从工作中得到一条属于 `role:growth-strategy` 的专业经验，只能创建 proposal。Role 在独立
Session 中检查证据并接受，生成目标资产和新 Revision。新的 Role Session 能看到并使用它。任何直接写 Role
Home 的尝试都被拒绝。

## 7. 工具

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

## 8. 完成定义

- Bundle 可通过 checkout 和 packed tarball 安装到 DSH profile；
- 不修改 DSH 源码，不依赖具体 Agent Loop；
- Home/Session 绑定确定且不可在已注入 Session 中切换；
- Context 有界、持久、可 replay；
- Memory 跨 Session 和进程重启存在；
- 通过学习流程新增的 active 资产 evidence coverage 为 100%；
- 通过 BizAgent API 的跨 Home 直接写入为零；
- proposal 接受幂等、可恢复、可审计；
- retire/supersede 后的新 Session 不再看到旧资产；
- unit、Cordis integration、Session replay、recovery 和两条 E2E 全部通过。
