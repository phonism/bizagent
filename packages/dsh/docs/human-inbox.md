# 真人 Inbox 与升级

DSH 的 `personal:` 是 Agent Home；真人地址使用独立的 `user:<id>`。Agent 用 `bizagent_inbox_send`
发送 `kind: "escalation"` 时，`to` 必须主送至少一个 `user:` 地址，并提供 ISO `due` 与
`human_action: {request, reason}`。`cc` 中有真人不能代替主送。升级信继承当前机器话题并将其关闭；
它不会唤醒 Agent。第 6 跳或第 12 封普通信之后仍可升级。

真人信箱保存在同一个 Inbox 账本，逐地址回执的 `delivered` 只表示持久入箱。核心包没有真人登录、
用户目录或外部推送凭据，不会声称通知已送达。已知的规范 `user:<id>` 可直接发信；宿主需要提供
认证与信箱入口，必要时从本账本构建站内待办。自动升级扫描器与通知运行器均由宿主选择接入；
核心包没有默认定时器或实际通知渠道凭据。

宿主批准的 App Event 订阅也可通过 App Event→真人 Inbox 目标投递
`kind: "app-event"` 的信息信。收件人从可信目录决定，正文只包含 App 与事件标识，不复制 Event 数据；
外部推送仍走下述通知运行器。本人可在 Inbox 中退订外部通知，宿主可再提供静默时段和打扰预算策略。

## 宿主挂载

核心包导出 `registerHumanInboxRoute` 和 `createHumanInboxHttpHandler`，不会自行暴露真人路由。
宿主必须从已验证的会话或凭据取得 `userId`，并为写请求验证 CSRF 防护或非 Cookie 凭据：

```ts
import { registerHumanInboxRoute } from '@bizagent/dsh'

registerHumanInboxRoute(ctx.webServer, ctx.bizagent, {
  authenticateUser: request => hostAuth.verifiedUser(request),
  authorizeMutation: (request, principal) => hostAuth.canWrite(request, principal),
})
```

`GET /api/bizagent/human-inbox` 返回当前用户的收件信头；可用 `direction`、`pendingOnly`、
`beforeMessageId`、`limit` 分页筛选。`GET ?messageId=<id>` 读取该用户可见的完整信。
`POST` JSON 支持 `{"action":"handle","messageId":"..."}`、
`{"action":"reply","messageId":"...","subject":"...","body":"...","idempotencyKey":"..."}`，
以及 `{"action":"notification-preference","enabled":false,"expectedRevision":0}`。
列表返回本人 `notificationPreference`；默认启用且 revision 为 0，写入使用 revision 条件更新。
请求体与查询参数均不能指定代办用户，所有读写使用宿主认证得到的 `userId`。

挂载路由后，`bizagent-ui` 的「我的收件箱」可查看本人收到/发出的信，按待处理筛选、分页打开详情、
标记已处理、开关外部通知，并对已送达的 Agent 信件回复。页面在回复请求失败后保留同一个幂等键，用户重试不会
创建第二封回复。宿主未挂载路由或未授权时显示不可用；页面本身不建立真人登录。

真人回信保留原信的处理状态，直到本人显式 `handle`；回信作为新机器话题的起点，原始话题预算归零。
它主送原发件 Agent Home，插件的 return-to 恢复器会优先向原发件 Session 注入正文；原 Session
确实不可恢复时，才按该 Home 的 Workspace 与 owner 条件尝试新 Session。写入回执、注入回执和
Agent 实际处理仍是不同事实。宿主应展示信箱，不能只依赖外部通知。

## 超时话题自动升级

宿主可定期调用 `InboxStalledEscalationRunner.recoverBatch()`。扫描器只考虑普通信达到 6 跳或
12 封、最后一封普通信后静置至少 24 小时、且没有结论信或升级信关闭的话题。正式 Work 通知
不计入普通信数量。每批最多检查指定数量的话题；没有责任人的候选会跳过，下批继续检查其他话题。

```ts
import { InboxStalledEscalationRunner } from '@bizagent/dsh'

const escalation = new InboxStalledEscalationRunner(ctx.bizagent, async topic => {
  const owner = await hostIdentity.verifiedExecutionOwner(topic)
  return owner === null ? null : {
    userId: owner.userId,
    authorityRef: owner.durableGrantRef,
  }
})
await escalation.recoverBatch()
```

`resolveOwner` 必须从宿主已核验的执行责任或授权记录返回真人 ID 和可追溯的 `authorityRef`；
可编辑的 Home `owner` 字符串不能单独作为认证依据。扫描器在同一个本地 Inbox 写锁内再次核对
话题终态与超时条件，按话题幂等写入 `engine:inbox` 署名的升级信和 `user:` 投递回执。
信内保存原话题信件 ID、责任人证据引用及参与 Agent 的回信地址；真人回信仍优先送回该 Agent
的原 Session。升级信关闭机器话题，停止尚未启动的普通唤醒与催办。宿主应只运行一个账本写者，
并自行安排扫描频率；跨进程排他与责任人目录不由核心包提供。

## 外部推送

核心包导出 `HumanNotificationRunner`，由宿主传入具体通知渠道并在单个写者进程定期调用
`recoverBatch()`。它扫描已入箱但尚未推送的真人收件地址，每批默认最多尝试 4 个。调用渠道前先持久
记录一条 `unknown` 意图；宿主适配器只有取得可核验的成功回执才能返回 `sent` 与非空
`providerReceipt`，确定渠道拒收才返回 `rejected`，其余情况返回 `unknown` 或抛错。

```ts
import { HumanNotificationRunner, HumanNotificationWebhook } from '@bizagent/dsh'

const channel = new HumanNotificationWebhook({
  endpoint: 'https://notification.example/api/send',
  authorization: () => secretStore.notificationAuthorization(),
})
const runner = new HumanNotificationRunner(ctx.bizagent.ledger, channel, {
  decide: async (message, recipient) => hostAttentionPolicy.decide(message, recipient),
})
await runner.recoverBatch()
```

通用 webhook 只接受 HTTPS 或本机回环地址。它发送包含稳定通知 ID 和信件内容的 JSON；仅当成功 HTTP
响应返回 `{"status":"sent","receiptId":"..."}` 时确认发出，或返回
`{"status":"rejected","reason":"..."}` 时确认拒收。超时、网络失败、非成功 HTTP、空响应、
不完整或过大的响应均为 `unknown`。宿主必须保管授权凭据，并确保接收方遵守该回执契约。

本人退订只影响外部通知，站内 Inbox 信件和处理、回信仍保留。扫描时若已退订，账本记录一次永久
`suppressed`，`attempt=0` 且不调用渠道；日后重新启用也不补推旧信，新信按当时偏好处理。
宿主 `decide` 可返回 `send`、`defer` 或带原因的 `suppress`：`defer` 不建渠道回执，下轮重新评估；
`suppress` 持久关闭该信的外推。退订检查先于宿主静默策略，并在渠道预留时再核对一次。
已经预留、可能在途的请求无法由后续退订撤回；宿主应对实际发送渠道提供相应取消能力或告知用户。

`unknown` 表示渠道可能已受理，重启后也不会自动重发；`sent` 只表示渠道确认发出，不能证明已读。
明确 `rejected` 的地址可由宿主调用 `retryRejected(messageId, recipient)` 发起一次新的、保留前次拒收记录的
显式重试；`unknown` 和 `sent` 均不能这样重试。站内 `delivered` 与外部通知状态分别保留，
发件 Agent 和真人信箱都可读取后者。当前账本只在单个插件实例内串行，跨进程排他、真实凭据解析
及渠道适配仍由宿主负责。

## 用户轮次完成通知

宿主可接入 `HumanTurnCompletionNotifier`，把本人发起且已完成的 DSH Session 轮次写入同一真人 Inbox。
宿主须保存逐轮的可信提问人记录，按游标列出候选，并在发送时重新核对本人身份与该会话的访问权限；
`sessions.inspect` 必须读取已经 flush 的持久事件。通知器再次检查 Session ID、Workspace、Home 绑定、
原始 `source.kind = "user"` 消息、连续事件和 `turn/end` 的 `completed` 原因。插件或定时任务注入的轮次
不会产生完成通知。无需把问题正文复制到通知；宿主可提供最多 160 字的单行摘要和指向本人会话的站内路径。

```ts
import { HumanTurnCompletionNotifier } from '@bizagent/dsh'

const completed = new HumanTurnCompletionNotifier(ctx.bizagent.ledger, hostPersistedSessions, {
  listCandidates: (after, limit) => hostHumanTurns.list(after, limit),
  authorize: (candidate, binding) => hostHumanTurns.authorizeCurrentAsker(candidate, binding),
})
await completed.recoverBatch(undefined, 20)
```

同一 Session/轮次只有一个稳定消息 ID。入箱前中断可重试，已有消息会核对冻结来源并修复投递；
站内 `delivered` 不代表外部渠道已通知。外推仍由 `HumanNotificationRunner` 执行，遵守本人退订与宿主静默策略。
宿主需要持久保存分页游标或重复遍历已送达记录，且不得用可编辑的 Agent 内容推断提问人。
