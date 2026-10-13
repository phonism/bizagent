# Changelog

## Unreleased (1.0.0)

Everything since `0.1.0-alpha.2`, toward the first stable release.

### Runs on DSH 0.2

- Targets DSH `0.2.0-rc.2`, the current `latest` on npm. DSH 0.2 skips plugins whose DSH peers
  name another line, so 0.1 builds no longer load.
- Sessions that BizAgent starts (Principals, Project Mains, Work workers, Inbox wake-ups, learning
  reviews) join DSH's default agent preset and use the host's default model. Without the model,
  resumed sessions failed every turn on DSH 0.2.
- Chats opened from the panel are attached to a workspace named after their Home and appear in the
  DSH sidebar.

### Works out of the box

- **Create sample team** in first-time setup builds *Sample Shop* (a growth lead, a data analyst,
  a metric capability, and a small `orders.csv`) with a five-minute guide on the Organization page.
- The local person owns the Homes BizAgent creates (`owner` option; defaults to
  `BIZAGENT_LOCAL_HUMAN_ID` or the OS user name). Before, the default Home had no owner and
  onboarding organizations were owned by member ids, so nobody could accept their results.
- In DSH Web the person signed in to DSH is the reviewer: accepting a Project, deciding proposals,
  and reading My Inbox need no BizAgent token. A Bearer token file remains for scripts.
- Formal Work and Inbox wake-ups start in the assignee Home's own folder when no `workspaceHomes`
  mapping exists, so teammates created in the UI pick up handed-off work.
- `timeZone` option for cron schedules and daily limits (default: the host time zone) instead of
  fixed Asia/Shanghai time.
- A Work result or reply that reaches a Session still working is read at its next step. Before, it
  waited for the next turn, so a Project chat that had already handled the result ran one more turn.

### Safer

- Every BizAgent HTTP route requires DSH Web's login when DSH provides it, in addition to the
  loopback, cross-site, and same-origin checks. Cross-owner Work never starts on its own.
- Text from other Homes reaches the model fenced as data. Evidence reads stay within the
  session's own Home. Snapshots of files are read without following symlinks.
- Session and record ids are scoped to the session and its tool call, so parallel and replayed
  calls cannot collide. One damaged record or Home file is isolated instead of stopping startup.

### Smaller and clearer

- The package keeps the learning core, Inbox, formal Work, and a narrowed Project loop (create,
  invite, join, submit, rework, human acceptance). Internal integrations from earlier development
  were removed; 59 Agent tools remain.
- The main entry exports only the DSH plugin and its types. Building blocks for hosts with their
  own login moved to `@bizagent/dsh/host`.
- Tool results are compact JSON, and Project and Work reads return summaries.
- English documentation: quick start, concepts, configuration, architecture, and a tool
  reference generated from the code. License changed to MIT.

## 0.1.0-alpha.2

- 新增首次组织设置：使命、团队模板、成员/角色与共享能力可在一个流程中确认并批量创建；
- 新增 `organization.yaml` 关系清单和组织图，Organization 作为四类 Home 之上的容器，而不是第五类 Home；
- UI 重构为“组织 / 学习”双视图，组织图可直接进入各责任主体的学习账本；
- Home 创建改为临时目录完整写入后原子 rename；组织清单只在全部引用 Home 存在后提交，失败可幂等重试；
- Home Context 改为 `agent.inject()` 持久 Snapshot，同一 Session/Revision 不重复注入，支持重启与 replay；
- 新增只针对明确纠正的有界 Learning Checkpoint，普通 Turn 不增加模型调用；
- Checkpoint 以 `Session + Turn` 确定性编号并幂等结算，复用现有 metadata 表而不改变 Storage Domain 版本；
- 新增 `bizagent_evidence_read`，可以回读资产引用的有界 DSH Session 事件；
- 调整 Fitness：retrieved/applied 不自证有效，两次 contradicted/failed 后提示人工复查；
- 保持 Learning Trigger 接口独立，后续业务插件可增加自己的强信号检测器。

## 0.1.0-alpha.1

- 新增 DSH 原生 Web Client 插件，通过 sidebar 与 shell overlay slot 挂载组织记忆台；
- 新增 Home directory、Memory strata、Learning ledger、证据详情和 Proposal inbox；
- 新增创建 Home 与目标 owner proposal 裁决交互，不开放无 evidence 的直接 Memory 写入；
- UI Host adapter 作为独立 Cordis row，通过有 body 上限、no-store 和同源 mutation 检查的 HTTP API 提供数据；
- Client bundle 与 learning kernel 完全分离，核心代码不依赖 React；
- 在 DSH `0.1.1-rc.2` 中验证 Client 启动图、bundle serving、API 读取、同源写入和跨源拒绝。

## 0.1.0-alpha.0

首个可运行版本：

- 作为 DSH Cordis Bundle 安装，不 fork DSH、不另起 daemon；
- 实现 Personal、Business、Role、Capability 四类 Agent Home；
- 实现有界 Home Context、多级学习资产与跨 Session 持久化；
- 实现带当前 DSH turn 证据的 Memory 写入、更新、检索和 fitness feedback；
- 实现跨 Home proposal、owner 审批、幂等接受/拒绝和恢复对账；
- 提供 10 个 DSH tools 以及 `init`、`home`、`doctor`、`reindex` CLI；
- 通过单元、插件集成、tarball 安装及 DSH `0.1.1-rc.2` Web profile 启动验证。
