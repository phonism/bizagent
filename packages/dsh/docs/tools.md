# Agent 工具参考

以下名称是 DSH 中注册的工具，不是 shell 命令。JSON 示例是对应工具的参数对象。工具只能在 live DSH Agent
Session 中执行；本地教学脚本使用同一 Service 的方法，见 [Learning Lab](../examples/README.md)。

所有 `asset_id`、`proposal_id`、`checkpoint_id` 都应来自实际返回结果。工具用 snake_case 参数，内部 TypeScript
Service 使用 camelCase。这里的“必填”之外均为可选字段。

## 查询与读取

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_home_status` | 无 | 无 | `binding`、`home`、资产/提案/未结 Work 数、`episodes`、`worklogs`、`persistenceErrors` |
| `bizagent_episodes` | 无 | `before_session_id`；`limit` 默认 20，范围 1–100 | 当前 Home 的 Session ID、绑定时间、可选最新 Worklog 摘要、下一页游标 |
| `bizagent_episode_read` | `session_id` | `after_seq`；`limit` 默认 24，范围 1–24 | 原始事件页、下一页序号游标 |
| `bizagent_memory_search` | 无 | `query`；`kind`；`status` 默认 active；`limit` 默认 20，范围 1–100 | `homeAddress`、`count`、`assets` 索引，不含正文 |
| `bizagent_memory_read` | `asset_id` | 无 | `asset` 正文、revision、`sourceRefs`；同时记录 retrieved |
| `bizagent_memory_use_outcomes` | `asset_id` | `before_work_id` 翻页；`limit` 默认 20，范围 1–100 | 同 Home 已完成正式 Work 中的读取/自报使用回执、来源状态与冻结交付结果、下一页游标；不作收益评分 |
| `bizagent_evidence_read` | `asset_id` | `source_index` 默认 0 | 引用范围、来源 Session、有限事件列表与 `omittedEvents` |

Search 的 kind 可为 memory / insight / knowledge / method / identity；Identity 正文实际作为独立配置存储，
不是由 remember 创建的普通资产。Status 可为 candidate / active / superseded / retired。
检索是当前 Home 内的文本子串匹配，详见[架构](architecture.md)。

`episodes` 只列已绑定到当前 Home 的 DSH Session；`episode_read` 会再次核对该归属，按 `seq` 分页回读
原始日志，单个文本事件最多返回 4000 字符。仅列出普通 Session 不会生成 Worklog、候选或已验证知识。拿到
`nextBeforeSessionId` 或 `nextAfterSeq` 时，用它继续翻页；无游标表示已到末尾。Session 不在当前
DSH 存储中时，读取会失败，不能据此推断那次工作没有发生。

## Session Worklog

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_worklog_record` | `description`、`body`、`status`、`idempotency_key` | `files` 最多 10 个；`work_id`；`project_id` | 当前 Session 的不可变新修订、来源指纹和文件版本快照 |
| `bizagent_worklogs` | 无 | `query`；`status`；`before_session_id`；`limit` 默认 20、最大 100 | 当前 Home 每个 Session 的最新摘要和游标，不返回正文 |
| `bizagent_worklog_read` | `session_id` | `revision` 默认最新 | 正文、修订索引、来源、当前文件与保留快照的核验状态 |
| `bizagent_worklog_file_read` | `session_id`、`path` | `revision` 默认最新；`offset` 默认 0；`limit` 默认 8192、最大 65536 字节 | 该修订保留的文件字节片段，Base64 编码及下一页偏移 |

Worklog 明确按当前 DSH Session 记录；同一 Session 可以用新幂等键写多版，相同键和内容重试只返回原版。
`status` 为 ongoing / completed / blocked / failed。写入需要 Session 事件；账本只保存当时事件范围与 SHA-256
指纹，不复制 transcript。`worklog_read` 通过 `sessionQuery` 重读范围，返回 verified / changed / unavailable。
它也会重算相对 Workspace 路径的文件哈希，返回 current / changed / unavailable；记录时拒绝绝对路径、
路径穿越、符号链接及超过 8 MiB 的文件。新修订在 Home 根目录保留内容寻址的原始字节，
`worklog_read` 对其另报 retained / unavailable；`worklog_file_read` 可在源文件改变或丢失后按字节分页回读。
旧修订仅有文件哈希时标为 legacy，不能据此声称已有快照。Base64 响应可包含二进制内容，调用方自行解码。

Worklog 可关联本 Session 已认领的 Work，或作为请求方的 return-to Session 关联 Work；Project 关联须由
当前 Home 领导，或经已关联 Work 可见。检索仅限当前 Home 的最新修订；可用 `worklog_read` 读取旧版。
正式 Work 完成后，插件等待 `bizagent_work_complete` 的工具调用、结果和 `turn/end` 都进入持久 Session，
再从冻结的 Work 结果创建一版 `origin=work-result` 的 Worklog。文件字节从 Work 快照核验后复制到 Worklog 快照；
如果 Agent 已为同一 Work 写过 completed Worklog，则不重复生成。启动、Session flush 和 30 秒恢复扫描会重试缺失记录，
每批最多处理 20 项；没有完整 Session 证据时延后，不编造来源。
普通 Session 有持久完成的工具活动 turn 时，插件也会按任务文本、工具结果状态和最终回复创建
`origin=session-activity` 的递增 Worklog 修订；纯对话 turn 不触发。活动正文来自事件，不能代替 Agent
写的业务结论。Agent 已显式写 Worklog 的 Session 不再由此路径补录；正式 Work worker 仍走上述冻结结果路径。
Session flush、启动和周期扫描会幂等补录，读取时可用原事件范围核验。
Worklog 是可查的工作经过和结果说明，既不自动发布 Memory，也不证明模型叙述或外部结果正确。

## 同会话 Agent Frame

`bizagent_agent_search` 按名称、类型或地址片段检索当前组织内 active 的共享 Home 和本 Session 的主 Personal Home；
可传 `query` 与 `limit`（默认 20，最多 50），只返回地址、类型和显示名。其他 Personal Home 与归档 Home 不出现在结果中。
Inbox、Work、Project 仍需使用返回的规范地址。

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_frame_status` | 无 | 无 | 主 Home、已打开 Frame、当前 focus |
| `bizagent_frame_open` | `address`（规范地址或唯一显示名） | `mode` 默认 lead，可为 lead / contribute / reference；`refresh` 默认 false | 首次/变化/刷新时的只读上下文，或未变化的轻量回执；参与状态与 context epoch |
| `bizagent_frame_search` | 无 | `address` 默认 focus；`query`、`kind`、`limit` 默认 20 | 已打开 Frame 的 active 资产索引 |
| `bizagent_frame_read` | `asset_id` | `address` 默认 focus | active 资产正文与来源；记录 retrieved 回执 |
| `bizagent_frame_close` | 无 | `address` 默认 focus | 剩余 Frame 与新的 focus |

Frame 需显式打开，只能引用当前 Home root 内 active 的 Business、Role、Capability Home，最多同时打开 8 个。
显示名不唯一时返回可选的规范地址，调用者必须明确选择；不可访问目标与不存在目标返回同样的错误。
本地单用户 alpha 没有跨用户授权，因此拒绝跨 Home Personal 读取；主 Home 已在上下文中，也不能再打开为 Frame。
打开多个 Frame 后最近打开的为检索默认目标；新 lead 会把旧 lead 降为 reference。同一 context epoch 内重复打开且
Home 修订和摘要未变时返回 `unchanged`，不重复输出 Identity 和索引；首次返回 `opened`，Home 变化或显式
`refresh=true` 返回 `delta` 和新版上下文。刷新会推进 Session 的 context epoch，其他 Frame 再打开时也会重新注入。
可在上下文压缩后显式刷新。旧版 Frame 状态首次重开按需注入。目标候选或退休资产不能通过 Frame 检索/读取。

Frame 的 `mode` 表示本 Session 中使用资料的参与意图，不会更换实际模型身份、工具授权、Session owner 或学习归属，
也不代表目标 Agent 独立给出意见。写入工具仍只写主 Home；想把新经验交给目标 Home，使用 proposal。
关闭 Frame 后，历史工具结果仍保存在 DSH transcript 中，但不再属于当前活跃参与状态。

## 异步 Inbox

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_inbox_send` | `to`、`subject`、`body` | `kind` 默认 ordinary，可选 conclusion / escalation；`cc`、`priority` 默认 normal、ISO `due`、`context_refs`、`human_action`、`reply_to`、`project_id`、`idempotency_key` | 不可变 `message` 与各收件地址的 `deliveries` |
| `bizagent_inbox` | 无 | `direction` 默认 incoming；`pending_only`；`before_message_id`；`limit` 默认 20，最大 100 | 有界信头、当前 Home 的投递/处理状态、下一页游标 |
| `bizagent_inbox_read` | `message_id` | 无 | 当前 Home 可见的完整正文；发件方可见逐收件人投递结果 |
| `bizagent_inbox_handle` | `message_id` | 无 | 当前 Home 的处理回执；重放返回原回执 |

发件方由当前 Session 的持久 Home binding 确定，`returnToSessionId` 由 DSH Session ID 确定；工具参数不能伪造。
普通收件地址是规范 Agent Home 或 `user:<id>`，可同时投给最多 8 个不同地址。指定 `project_id` 时，
发件 Home 须是该项目 lead 或活跃 Seat；项目内已加入的 Home 地址会规范化为本项目 Seat 地址，
也可直接指定活跃 Seat 地址。未加入的共享 Home 须先用 `project_invite`，不能向其他项目的 Seat 发信。
项目回复继承原信的 Project ID；回复原发件地址时，即使席位已释放也保留历史 Seat 地址与回执关系。
旧 Home 地址信仍按原 Home 地址回复。席位释放后不能发新项目消息，但对应 Home 仍可审阅已投递的历史信。
不存在的 Home 会得到 `bounced` 回执；
`delivered` 只表示信和回执存入 DSH 账本，**不保证自动唤醒成功、对方已读、正式 Work 已接受或任务已完成**。
普通信对 `to` 中已映射 Workspace、双方 Home 都活跃且有同一显式 owner 的收件 Home 或活跃 Seat 自动唤醒：urgent 立即检查，
normal 按收件 Home 的作息；扫描每 30 秒进行一次，每批最多启动 4 个 Session。`cc` 只入箱。
在 `<homeRoot>/homes/<Home.id>/inbox.json` 可配置 `{"policy":"immediate"}`、
`{"policy":"batch","batchMinutes":15}`、`{"policy":"scheduled","cron":"0 9 * * *"}` 或
`{"policy":"carried"}`。scheduled 使用上海时间五字段 cron；缺文件、坏配置或坏 cron 退回 15 分钟批处理
（坏 cron 可用有效的 `batchMinutes` 指定退回时长）。投递时逐主收件人冻结生效策略与 `wakeAt` 到回执；
后续修改配置不追改已投递信件。`carried` 只入箱，但 urgent 和原 Session 不可恢复的回信兜底立即唤醒。
带 `reply_to` 且主送原发件 Home 或 Seat 的普通回信优先直接投到原信冻结的 return-to Session；在线则入队，
已结束但有持久记录则恢复后入队。确定无法恢复时记录兜底回执，立即考虑新 Session。
回信提示含正文，稳定 ID 和持久回执用于重启重试；回执只证明提示入队，不证明已读或已处理。
收件方可在 `bizagent_inbox` 与 `bizagent_inbox_read` 的 `returnRoute` 中查看 `queued` 或 `fallback` 回执；
发件方可查看 `returnRoutes`。
普通作息唤醒把同一 owner 发给同一 Home 或 Seat 地址的待处理主送信合成最多 20 封的批次；紧急信和回信兜底按话题唤醒。
唤醒计划持久冻结信件 ID、收件地址、对应 Home Workspace 与稳定 Session ID；同一收件地址的上一批 Inbox Session 未空闲前不启动下一批。
发信时冻结当前 Agent 可用的模型设置，唤醒器在创建或恢复独立 Session 时沿用；真人回信沿用原 Agent 信件的设置。
失败后保留计划并延迟重试。
`due` 是可选的回复期限，不改变初次投递作息。主送的普通信到期仍未处理时会安排一次按话题催办；
无 `due` 的信入箱 24 小时后仍未处理会催办，已投进原 Session 的回信则从入队起等待 2 小时。
催办在启动时及此后每 5 分钟有界扫描，持久化独立唤醒计划和逐收件人 `nudgedAt`/`nudgeReason`；
已处理的信、`cc` 与正式 Work 通知不参加普通 Inbox 催办。催办只让 Agent 再检查信，既不标记处理，
也不修改正式 Work。未映射或无法满足同 owner 唤醒条件的收件 Home 仍保留原信待现有 Session 读取。
新启动的收件 Home Session 只看到本次唤醒范围内最多 20 封待处理信的索引摘要；正文需按 ID 调用 `inbox_read`，
随后在确实处理后调用 `inbox_handle`。读取本身不会改变处理状态。

`idempotency_key` 默认使用 DSH 工具调用 ID，同一发件 Home 和 key 的相同内容可安全重试；改变内容会冲突。
回复使用 `reply_to`，只允许原线程参与者，最多连续 6 跳、同一回复线程 12 封。普通信另外保存独立的
`topicId` 与机器接力 `hop`；可信宿主给收件 Session 记录 `InboxWakeOrigin` 后，它后续发的信即使不带
`reply_to`，也继承唤醒它的话题，受 6 跳与 12 封上限约束。带 `reply_to` 时沿用原信的话题，
跳数取回复链和当前 Session 唤醒来源中更深的一档。
从第 4 跳或第 9 封普通信起，自动唤醒提示和新 Session 的待处理摘要会标出临近上限的话题，
提醒本轮形成文件结论；触顶拒发也会直接提示结论信的调用方式。
触顶后可发送 `kind: "conclusion"`：`context_refs` 至少包含一个发送时确实存在的当前绑定 Workspace 内相对文件路径；
绝对路径、越界路径和符号链接不算有效文件。信件保存通过核验的 `conclusionArtifact` 路径，但文件本身不是冻结快照。
结论信继承回复或唤醒来源的话题，允许作为第 7 跳或第 13 封终态信；它关闭话题，不安排新的普通唤醒或催办，
已冻结但尚未启动的同话题唤醒计划会跳过，之后的普通信和第二封结论信会被拒绝。幂等重放仍返回原结论，
即使文件后来被移动。`kind: "escalation"` 则必须主送 `user:<id>`、提供 ISO `due`，并用
`human_action.request` 和 `.reason` 说明需要人决定什么及为何需要；它也关闭话题。真人信箱的认证读取、
回信与宿主挂载要求见[真人 Inbox](human-inbox.md)。自动推送与 24 小时超时升级均有可选宿主运行器；
核心包不自带真人登录、实际通知凭据或扫描调度。
正式 Work 的 worker Session 已绑定请求话题。当前自动唤醒仅覆盖同 owner 且映射 Workspace 的普通信；
未映射、无显式 owner、跨 owner 和 `cc` 消息保留在 Inbox，等待已有绑定 Session 读取。普通信件不修改
Memory、proposal 或正式 Work 的责任状态。

## 运维事件

绑定 Business Home 的 Agent 可用 `bizagent_ops_event_list` 查看本 Home 未结束事件，或按 ID 分页读取复发证据；
`bizagent_ops_event_raise` 使用 `request_id`、`title`、`detail` 与稳定的 `fingerprint` 上报，
可选 `kind`、`severity`、`await_resolution` 和 `confirm_new`。`await_resolution` 指明此报出 Session 需要真人结论；事件解决后运行器向各个仍可恢复的原 Session 入列结论，回执只表示已入列，不表示 Agent 已处理。
相同指纹的未结束事件追加证据；疑似重复先回提候选，
只有判断为不同问题时才用 `confirm_new` 登记新事件。新事件向有 owner 的 Business Home 真人 Inbox 投递一次紧急通知，失败后补投。

## 正式 Project

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_project_create` | `title`、`goal`、`done_when`、`idempotency_key` | 无 | 当前 Home 作为 lead 的 durable Project；Host 可用时同时准备 Project 主对话 |
| `bizagent_projects` | 无 | `status`；`before_project_id`；`limit` 默认 20、最大 100 | 当前 lead 或活跃 Seat Home 可见的 Project 列表和下一页游标 |
| `bizagent_project_read` | `project_id` | 无 | Project、Seat 与事件、历次结果声明与审阅、关联 Work |
| `bizagent_project_turn_join` | `project_id` | 无 | 将当前普通 Home Session 的本轮执行记为项目参与；不扩大 Project 权限 |
| `bizagent_project_invite` | `project_id`、`home_address`、`responsibility` | 无 | lead 邀请活跃共享 Home，返回稳定 Seat 地址和 Project 修订；重复邀请幂等 |
| `bizagent_project_seat_release` | `project_id`、`seat_address` | 无 | lead 释放没有未结关联 Work 的 Seat，撤销项目读取权限 |
| `bizagent_project_submit` | `project_id`、`summary`、`body`、`done_when_assessment` | `artifact_refs`：最多 10 个当前 Session Workspace 中 `artifacts/` 下的文件 | 一版不可变结果声明、文件快照与提交时的 Work 状态快照 |
| `bizagent_project_artifact_read` | `project_id`、`claim_id`、`path` | `offset` 默认 0；`limit` 默认 8192、最大 65536 字节 | 该结果声明保留的文件字节片段，Base64 编码及下一页偏移 |
| `bizagent_project_review` | `project_id`、`claim_id`、`decision`、`reason` | Agent 只可选择 rework | 对精确声明的返工记录；最终接受走宿主认证的真人审核路由 |

基本流程：lead 创建 Project → 邀请 Seat → 用 `work_dispatch` 的 `project_id` 派正式 Work → 执行方完成 Work →
lead 提交结果声明 → 真人经认证路由接受，或由 lead / 真人退回返工。

Project 保存在独立 `bizagent_project` domain。创建时固定 lead Home、目标与完成标准；相同幂等键和内容重试只会得到
原 Project。lead 可为其他活跃共享 Home 邀请 Seat，记录责任和稳定的 `seat:<projectId>:<seatId>` 地址；
活跃 Seat Home 可读取项目全文、关联 Work 和保留的结果产物，释放后立即失去这些读取权限。
责任变更、释放和重新加入都会增加 Project 修订并留下事件；同内容重复邀请、重复释放不会增加修订。
邀请仅建立项目参与和读取权限，不代表接受正式 Work，也不启动 worker。执行 Home 仍有未结关联 Work 时不能释放其 Seat。
关联正式 Work、提交结果和返工审阅只对 lead Home 开放。

普通 Home Session 可在每个执行轮次开始时调用 `project_turn_join`；账本冻结 Project、Home、Session 和 turn，
正式 Work 的 accept/complete 也会记录当轮。之后无关的轮次不受影响。

已提交或已接受的 Project 不能增加新 Work；对已有 Work 用原幂等键重试仍返回原责任。提交结果时拒绝未结
Work，并记录当时已完成或取消 Work 的状态与结果消息 ID。
结果声明还须有至少一个可核验的产物快照，或一封已投递的正式 Work 结果信。产物路径必须是
`artifacts/` 下的规范相对路径，从 lead 当前绑定的 Session Workspace 读取；每个文件最多 8 MiB，不接受符号链接。
提交时将原始字节保留在 Home 根目录，并在声明中冻结路径、长度和 SHA-256；`project_artifact_read` 可在
源文件改变后按字节分页回读。接受前会再次校验快照，恢复包也校验声明与归档文件的一致性。
返工保留旧声明和审阅，重新提交产生新版声明；接受时固定声明 ID。

Agent 只能用 `project_review` 退回当前待验收声明；接受只能由真人经宿主认证的
[Project 审核路由](project-review.md)完成。结果被退回时，以 Project 和 claim 为稳定键通知 lead Home 核对完成标准
并重新提交；验收通过不发继续工作的通知。返工审核已保存但入箱失败时，启动和周期入箱扫描会补投。
lead Home 的退回记录不能证明真人已查看，也不能证明运行中的 Agent 已停止。

项目普通 Inbox 用 Seat 地址路由和记录回执；Seat 唤醒 Session 的提示会注入项目目标、完成标准、
Seat 职责与地址，并要求读取最新 Project。实际执行仍绑定对应 Home；正式 Work 通知经 Home Inbox 投递并附 Project ID。
普通 Home Session 没有专属 Project 绑定，也没有多用户认证；Project 状态不应替代 DSH 运行状态。

## 正式 Work

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_work_dispatch` | `to_address`、`goal`、`acceptance_criteria`、`idempotency_key` | `project_id` 引用当前 Home 的 open Project；`output_contract` 冻结指标报告来源 | 正式 `work`、请求 Inbox 通知与 worker 启动结果 |
| `bizagent_work` | 无 | `direction` 默认 assigned；`status`；`before_work_id`；`limit` 默认 20、最大 100 | 当前 Home 可见的责任记录和下一页游标 |
| `bizagent_work_start` | `work_id` | 无 | 请求方重试启动/恢复已预留的 DSH worker Session |
| `bizagent_work_accept` | `work_id` | 无 | 把指定 Work 独占绑定到当前目标 Home 的 DSH Session |
| `bizagent_work_read` | `work_id` | 无 | Work 状态、请求/结果/取消通知的投递结果 |
| `bizagent_work_complete` | `work_id`、`subject`、`body` | `artifact_refs`：最多 10 个当前 worker Workspace 的 `artifacts/` 下文件 | 先预留的唯一结果、冻结的文件快照、回给请求方的通知、completed Work |
| `bizagent_work_artifact_read` | `work_id`、`path` | `offset` 默认 0；`limit` 默认 8192、最大 65536 字节 | 完成结果的文件快照字节片段，Base64 编码及下一页偏移 |
| `bizagent_work_output_eval` | `work_id` | 无 | 对冻结的交付文件逐个做空文本、占位符断言；无文件时检查结果正文；有委托方冻结的指标报告 `output_contract` 时，另按指定快照或提交正文检查来源存在和数字，返回来源哈希与逐项 pass/fail/skip |
| `bizagent_work_cancel` | `work_id`、`reason` | 无 | 仅请求方可取消 open Work，通知执行方 |

Work 使用独立的 DSH `bizagent_work` 域。创建时先持久化责任，再经 Inbox 发请求通知；如果目标 Home
配置了 `workspaceHomes` 映射，Work 会冻结 `autoStart: true`；插件在通知送达后用 DSH Agent 工厂创建独立 worker Session，将确定的
Session ID 与工作目录预留在 Work，并投递正式工作提示。已经存在的持久 Session 会用 DSH `resume()` 恢复；
启动失败会在派发结果中单独报告，责任仍可由请求方用 `work_start` 重试。没有映射目录时，目标 Home 在
将执行的普通 Session 中调用 `work_accept`，从 `open` 进入 `accepted` 并冻结 worker Session ID。其他
Session 不能替它完成或抢走责任；结果提交时先把
唯一结果正文和消息 ID 预留为 `completing`，成功入箱后转 `completed`。并发提交或失败重试只能采用已预留的
结果。可选 `artifact_refs` 在预留结果前从绑定 Workspace 核验并冻结；即使结果通知失败，恢复时也不会
重新读取可能已变化的源文件。请求方和执行 Home 可按范围读取快照；
结果信附上路径引用，文件最多 8 MiB，不接受路径穿越或符号链接。
`cancelled` 和 `completed` 是终态；请求方可在 `open` 或 `accepted` 时取消。请求/结果/取消通知都带单独的
Inbox 投递回执，普通回复或标记已处理不会改变 Work 状态。

worker 的模型路由从发起 Session 固定在 Work 中；插件持有创建句柄，完成后待 Agent 空闲再释放。
插件卸载也会释放自身创建的句柄。重启时先用 Work 的持久发送方 Session 与稳定消息 ID 补投缺失的
请求、结果或取消通知；`completing` Work 的结果送达后再结算为 `completed`。逐项失败记入运行错误，不阻断插件启动。
随后插件先恢复已经预留了确定 worker Session ID 和工作目录的 `open`/`accepted` Work，
再顺序启动冻结了 `autoStart: true`、请求已送达但还没有预留 Session 的 `open` Work。
两类恢复共用每批最多 4 项的预算，启动后每 30 秒处理下一批；失败项至少间隔 5 分钟再试。
逐项失败会记入运行错误，不阻断其他 Work 或插件启动。恢复沿用稳定 Session 和提示 ID，已投递的提示不会再投。
无映射或旧记录未冻结自动启动意图时不会因重启自动启动；请求方可显式调用 `work_start`。
若宿主没有持久 Session，已结束的 worker 无法冷恢复。没有 Workspace 映射时只能由目标 Home 已有 Session
认领；启动失败后已预留了 worker Session ID 时，其他 Session 不能抢认，须重试启动或取消后重新派发。
当前认领只证明请求已交给一个 Session，**不证明它已经实际执行或交付已验收**。
取消已认领 Work 会阻止后续正式完成，但当前不会主动停止那个 DSH Session 已在运行的其他操作。
Project 关联通过 lead Home 和 open 状态校验，并在同进程内与 Project 提交串行。单进程内串行预留与故障重试已覆盖，跨进程事务、
真实 DSH 配置下的执行测试仍待补齐；通知补投目前只覆盖正式 Work，实时派发还没有统一唤醒限流，
不能用 `open` 或 `accepted` 状态推断 Agent 此刻正在运行。

## 周期订阅

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_subscription_propose` | `idempotency_key`、`title`、`goal`、`cron`、`executor_home`、`owner_kind` | `model`；`followers` | 待 UI 确认的提议；不创建有效排程 |
| `bizagent_subscriptions` | 无 | 无 | 当前 Home 拥有或关注的订阅约定 |
| `bizagent_subscription_read` | `subscription_id` | 无 | 约定、冻结的每期 Work 和显式结果；关注者看不到 Session ID |
| `bizagent_subscription_complete` | `work_id`、`result` | 无 | 当前预留 Session 的本期最终 Markdown 交付 |

`owner_kind` 是 person 或 home，`executor_home` 必须映射到 DSH Workspace。cron 为上海时间五字段。
提议由当前 Session 的 Home 发起；确认、暂停、手动运行和取消在 UI 的订阅页完成。完成工具再次核对
当前 Session ID 和绑定 Home，其他 Session 无法代交。

## Pulse 指标与日报

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_pulse_metric_define` | `key`、`name`、`brief`、`source_provider`、`source_resource` | `thresholds_json` 默认 `[]`；`response_json`；`cron`；`unit`；`higher_is_better`；`aggregation`；`enabled`；修改时须带 `expected_revision` | 当前 Home 的指标定义与修订号 |
| `bizagent_pulse_metrics` | 无 | 无 | 当前 Home 的指标定义列表 |
| `bizagent_pulse_metric_read` | `key` | 无 | 当前值、运行记录和读时异常 |
| `bizagent_pulse_metric_collect` | `key` | `date` 默认昨天 | 已注册 Provider 对过去业务日的立即取数运行；如提供 `ready` 则先检查上游到位 |
| `bizagent_pulse_dashboard_preview` | `definition_json` | 无 | 不写入文件，按当前可见 Pulse 数据预览卡片与缺数状态 |
| `bizagent_pulse_dashboard_save` | `definition_json` | 已有定义须带 `expected_revision` | 当前 Home 的 Markdown 看板定义与 SHA-256 修订号 |
| `bizagent_pulse_dashboards` | 无 | 无 | 当前 Home 的看板定义列表 |
| `bizagent_pulse_dashboard_read` | `key` | 无 | 当前 Home 的看板定义及服务端组装的 Pulse 卡片数据 |
| `bizagent_pulse_report_generate` | 无 | `date` 默认昨天；`guidance`；`regenerate` 默认 false | 昨日日报或指定日期的独立 Session 与状态 |
| `bizagent_pulse_reports` | 无 | `date` | 当前 Home 的日报尝试与已交付正文 |
| `bizagent_pulse_report_complete` | `report_id`、`body` | `summary` | 仅预留报告 Session 可提交最终 Markdown |
| `bizagent_pulse_report_cancel` | `report_id`、`reason` | 无 | 取消请求、停止回执或待核查状态 |
| `bizagent_pulse_report_inspect_cancel` | `report_id` | 无 | 只读检查状态不明的停止结果 |
| `bizagent_pulse_report_resume` | `report_id` | 无 | 核查后重附着预留 Session，不重发提示 |

指标 `source_provider` 必须由可信宿主注册，`source_resource` 由该 Provider 解释；Agent 不提交凭据或
任意请求 URL。定时取数默认关闭，只处理显式配置的 Business Home，失败或提交状态不明时不会盲重提。
日报由独立 Session 显式交付，普通聊天回复不改变报告状态。

## 业务机会检查

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_opportunities` | 无 | `id` 读取单条详情 | 当前 Business Home 的关注、近期检查、人类决定与效果约定 |
| `bizagent_opportunity_check_start` | `request_id` | 无 | 在当前 Session 冻结已完成 Pulse 数据和缺口，重复请求复用检查 |
| `bizagent_opportunity_check_complete` | `check_id`、`summary`、`candidates_json` | `candidates_json` 可为 `[]` | 仅开始该检查的 Session 可提交，证据 ID 限于检查快照 |

关注约定、人的决定、效果确认及生效时间由宿主认证的人侧接口处理，Agent 工具无权代替确认。

## 增量学习材料

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_learning_materials` | 无 | `before_session_id`；`limit` 默认 10，范围 1–20 | 当前 Home 旧 Session 事件和显式 Worklog 修订的待处理指纹、已审数量、不可读来源、下一页游标 |
| `bizagent_learning_review` | `material_id`、`summary` | 无 | 冻结材料与显式审阅回执；重复提交返回原回执 |
| `bizagent_learning_batch_start` | 无 | 无 | 当前 Home 最多 8 份未审材料的持久批次；同 Home 同时只能有一批 open |
| `bizagent_learning_batch_status` | `run_id` | 无 | 冻结材料、已审/待审 ID、批次状态及实际 Home 文件变化 |
| `bizagent_learning_batch_change_read` | `run_id`、`path`、`side=before|after` | `offset` 默认 0；`limit` 默认 8192、最大 65536 字节 | 按 Home 权限分页回读实际变化文件的保留原始字节，Base64 编码 |
| `bizagent_learning_batch_settle` | `run_id`、`material_id`、`summary` | `candidates` 最多 3 条，每条指定 kind、正文；Session 材料还需事件序号范围，Worklog 材料省略序号 | 原始证据绑定的 candidate 资产和逐材料回执；空候选表示有理由地不新增 |
| `bizagent_learning_batch_finish` | `run_id`、`action`、`summary` | `action=complete|abandon` | 全部审阅后由原 Session 完成，或由同 Home 明确放弃 |
| `bizagent_learning_launch` | `idempotency_key` | `model` 默认继承请求方 | 在当前 Home 的显式映射 Workspace 预留并启动独立学习 Session |
| `bizagent_learning_launch_read` | `launch_id` | 无 | 当前 Home 的启动预留、worker Session、批次、待核查状态和持久 Session 的已上报 token 用量 |
| `bizagent_learning_launch_abandon` | `launch_id`、`reason` | 无 | 核查后放弃无 live worker、无 open 批次的待核查启动 |
| `bizagent_output_eval_read` | `session_id`、`turn` | 无 | 同 Home 已结束 turn 的原事件复算、五条确定性断言及来源哈希；来源变化时拒绝覆盖 |
| `bizagent_output_eval_backfill` | 无 | `days` 7/14/30 默认 7；`limit` 默认 50 最大 200；`session_limit` 默认 50 最大 100；续页使用 `before_session_id`、`before_turn` | 显式有界回填历史 turn 的零模型调用断言；返回进度、失败和下一页游标 |
| `bizagent_output_evals` | 无 | `limit` 默认 20，范围 1–100 | 当前 Home 最近的持久输出断言；`skip` 不计通过 |

`learning_materials` 读取当前 Home 的旧 Session，排除正在执行该工具的 Session 和已登记的批次整理 Session。它分别冻结原事件和最新 Agent 撰写或正式 Work 结果 Worklog 修订；由原事件生成的 `session-activity` Worklog 不重复入队。Worklog 材料返回 `sourceKind=worklog`、确切的 `worklogRevisionId` 和 `worklogRevision`，即使原 Session 暂不可读仍可审阅已留存的正文。每次扫描冻结所见来源的
SHA-256 指纹；缺失或损坏的 Session 放入 `unavailable`，不会被当成已审阅。扫描和 `episode_read` 都不会推进
水位。实际读过材料、决定保存候选或保持现状后，才调用 `learning_review` 并说明判断。回执只对应扫描时
那一版原始事件或 Worklog 修订；即使审阅期间有新事件或新修订，下一次扫描仍会返回新的指纹。回执本身不创建、发布或验证记忆，
也不启动模型或定时任务。`material_id` 只能来自当前 Home 的扫描结果。

批次路径应在专门的学习 Session 中启动。`batch_start` 最多扫描 100 个近期绑定 Session，冻结其中前 8 份
待审材料。逐条用 `episode_read` 核对原始事件，或用 `worklog_read` 指定确切修订核对 Worklog，再以 `batch_settle` 提交判断。创建的资产始终是 candidate，
证据指向原 Session 中最多 24 个连续事件或不可变 Worklog 修订；对应来源指纹变化时拒绝结算，需放弃批次后重扫。每条回执
和资产 ID 可在响应丢失后重取；`batch_status` 可在账本重开后恢复进度。单飞和显式 abandon 避免中断后
静默重试。批次中的未审材料不能绕过 `batch_settle` 用单条审阅工具结算。直接使用批次工具时由当前 Agent
整理；`learning_launch` 可由同 Home Agent 显式启动独立 DSH Session。启动前持久预留确定 Session ID、
Workspace、模型路由和提示 ID；重启只恢复已存在的同一个 Session。工厂结果不明或 Session 空闲却没有批次
完成回执时标为 `needs_review`，不会自动重建。启动请求方的 Session 不会混入该 worker 冻结的来源。空材料
可直接结算为完成。可选宿主定时器按 Home 的上海时间 cron 扫描待审材料，并限定模型与每日次数。
新批次开始时冻结当前 Home 受管理的 Identity、Memory、Insight、Knowledge、Method 文件原始字节；完成或放弃时再读文件并按内容 SHA-256 给出 created / updated / deleted。`libraryChanges` 保存前后快照引用，`learning_batch_change_read` 可分别分页读取；无变化时为空数组。每批最多 1000 个文件、总计 64 MiB，单文件最多 8 MiB。结束时若文件已不可读或超限，批次仍可终结，但 `libraryChangeError` 明示本次无法核对变化。此记录覆盖批次开放期间的同 Home 并发写入，不能单凭差异认定由学习 Session 造成；它不扫描任意 Workspace 文件。
`learning_launch_read.usage` 按 worker Session 的持久 `assistant/chunk` 用量累计，缺少分片时才使用
`assistant/message.usage`；`reported` 仅在有上报时存在，`unreportedSteps` 保留缺报，`costUsd=null`
表示没有可信定价。这个读取结果不是逐人额度账本；候选仍需按发布流程核验。

例如查待审核方法，调用 `bizagent_memory_search`：

```json
{
  "query": "cohort",
  "kind": "method",
  "status": "candidate",
  "limit": 10
}
```

使用返回的 ID 调用 `memory_read`，再用该资产的 `sourceRefs` 下标调用 `evidence_read`。不要从简述补写正文。

## 同 Home 学习

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_memory_remember` | `description`、`body` | `kind` 默认 memory；`status` 默认 active；`tags` | `asset`、`home`、`homeAddress` |
| `bizagent_memory_update` | `asset_id`、`action` | `expected_revision`（publish 必填）；`description`、`body`、`tags` | 更新后的 `asset` 与 `home` |
| `bizagent_memory_feedback` | `asset_id`、`signal` | `outcome` | 固定资产版本的 `receipt`、`asset`、`reviewRequired`；同一调用重放标记 `idempotentReplay` |

Remember 的 kind 仅允许 memory / insight / knowledge / method，status 仅允许 candidate / active。
Description 是不超过 1000 字符的非空索引简述；body 必须有内容；tags 是短字符串数组，每个标签最多 80 字符。

调用 `bizagent_memory_remember` 保存一个尚需核验的方法：

```json
{
  "kind": "method",
  "status": "candidate",
  "description": "比较留存前，先对齐获客渠道与观察窗口。",
  "body": "演示场景：整体留存变化可能包含渠道占比变化。先核验渠道字段与 cohort 完整性，再比较相同渠道和窗口。不能据此单独推出因果结论。",
  "tags": ["retention", "cohort"]
}
```

Update 的 action 为 revise / retire / publish。Revise 保持状态；retire 退出默认检索；publish 只发布 candidate。
建议 revise 和 retire 也携带 `expected_revision`，让服务检查你审阅过的资产版本。

下面是 publish 参数形状；把示例 ID 与数字替换为刚刚审阅的 `memory_read` 返回值：

```json
{
  "asset_id": "method-example-id",
  "action": "publish",
  "expected_revision": 2
}
```

Feedback 的 signal 是 applied / confirmed / contradicted / failed。Retrieved 由 read 自动生成，不能作为
feedback 工具参数。Outcomes 应说明实际观察到的结果；计分与复核规则见[生命周期](learning-lifecycle.md)。

## 跨 Home 提案

| 工具 | 必填 | 可选与默认值 | 返回重点 |
| --- | --- | --- | --- |
| `bizagent_memory_propose` | `to_address`、`description`、`body` | `proposed_kind` 默认 memory；`target_asset_id` 用于替代现有资产；`tags` | pending `proposal` |
| `bizagent_proposals` | 无 | `id`；`direction` 默认 incoming，可为 outgoing / both；`status` | 单个 `proposal` 或 `count` 与 `proposals` |

目标 Home 必须已存在且不是当前 Home。Proposed kind 为 memory / insight / knowledge / method。
Proposal 的状态筛选可为 pending / accepted / rejected / withdrawn；当前工具没有 withdraw action。
指定 `id` 时直接读取该提案，不再按列表方向筛选，但仍检查是否属于自己的收发记录。
Agent 工具只能创建和读取提案；接受与拒绝须由宿主验证真人身份、CSRF 或非 Cookie 凭据，以及
对确切目标 Home、提案和动作的权限后，通过可选裁决路由完成。提案正文和类型在创建时冻结，修改需重新提案。

调用 `bizagent_memory_propose`：

```json
{
  "to_address": "role:growth-strategy",
  "proposed_kind": "method",
  "description": "比较留存前，先对齐获客渠道与观察窗口。",
  "body": "演示活动只比较渠道和观察窗口相同的 cohort，分别报告分组规模与总体结果；字段缺失时先停止归因并补齐数据。",
  "tags": ["retention", "cohort"]
}
```

目标 Role 的 Session 可列出 pending 提案供审阅。提案携带当前 turn 的证据；它不是把某个 `asset_id` 自动复制
到另一 Home 的快捷指令。真人裁决和授权来源保存在账本中，资产应用前先写批准记录。

## 插件发起的学习检查点

`bizagent_learning_checkpoint` 仅用于结算 BizAgent 已发出的检查点：

- 必填 `checkpoint_id`、`action`（remember / skip）。
- Remember 需要 `description` 与 `body`，可附 `tags`、`decision`。
- Skip 需要 `decision`；不要自行编造 checkpoint ID。
- 返回检查点结果；remember 还返回资产。工具调用会请求 DSH 结束当前 turn。

## 常见问题与下一步

| 现象 | 可能原因 | 检查方式 |
| --- | --- | --- |
| 搜不到刚写的内容 | 内容是 candidate、查询不匹配或当前 Home 不同 | 先看 home_status，再带 status / kind 搜索 |
| `asset revision conflict` | 读取后已有人修改或写入反馈 | 重新 read、核验差异，再决定更新 |
| `publishing requires expectedRevision` | 没提供已审阅的资产版本 | read 后传 `expected_revision` |
| `only a candidate can be published` | 当前状态已 active 或 retired 等 | 先 read 确认状态，不盲目重试 publish |
| `proposal publication requires a host-authenticated human review` | Agent 尝试直接发布跨 Home 提案 | 由宿主挂载认证裁决路由并授权目标 Home |
| `no Agent Home resolves` | 尚未创建组织或没有有效 Home 配置 | 按快速上手创建组织；已有 binding 不会自动改绑 |
| 原始证据不可读 | 来源 Session 不在当前存储、范围不完整或类型暂不支持 | 查 sourceRefs 与原始 DSH Session；不要伪造缺失事件 |
| 性能页不可用但学习工具可用 | 可选 metrics endpoint 未配置或不可达 | 看 UI 中的错误与[性能配置](ui.md)；与 Memory 存储分开排查 |

CLI 的 `doctor` 检查 Home 文件结构；`home_status.persistenceErrors` 报告运行时账本/恢复问题。两者都正常
不代表业务结论已经通过核验。工具实现对应 [tools.ts](../src/tools.ts) 与 [service.ts](../src/service.ts)。
