# 本机单用户真人审核入口

DSH Web profile 不提供内置登录。BizAgent 的 `local-human-host` 是一个 DSH / Cordis 插件，
在同时设置 `BIZAGENT_LOCAL_HUMAN_ID` 和 `BIZAGENT_LOCAL_HUMAN_TOKEN_FILE` 时挂载
Project 最终验收、Agent Home 与共享知识提案裁决、真人 Inbox 路由。未设置两者时不挂载这些路由。

令牌文件必须由当前进程用户持有、权限为 `0600`，内容为 32–512 个非空白字符。把令牌放在
DSH 配置文件之外，启动时只读取一次；轮换后重启 DSH。请求使用
`Authorization: Bearer <token>`，请求体不能声明审核人。此模式只适合本机单用户 DSH；
Web 服务保持绑定 `127.0.0.1`。

Project 审核按当前 `project.lead` Home 的 `owner` 字段授权；知识提案按目标 Home 的 `owner`
字段授权。审核人 ID 与 `owner` 必须精确相同，空 owner 不获得权限。返工和接受仍由服务层检查
当前修订、当前 claim、正式 Work 与冻结产物。真人 Inbox 只能读写令牌对应的 `user:<id>` 信箱。

共享知识从 Agent 工具 `bizagent_knowledge_propose` 提案，完整正文进入审计账本。产品线提案仅由
对应 `line:<line>` Home 的 owner 审核，发布到 `lines/<line>/knowledge/`；平台提案需要显式设置
`BIZAGENT_LOCAL_PLATFORM_ADMIN=1`，由本机令牌身份审核，发布到 `knowledge/common/`。该开关只给
本机单用户宿主的令牌身份平台管理员权限，不改变 Agent 的工具权限。两层共享源目录都不挂接到
Agent Home；Agent 用 `bizagent_knowledge_search` 和 `bizagent_knowledge_read` 检索。工作台的提案栏
展示当前令牌有权审核的共享提案，审核路由为 `/api/bizagent/shared-knowledge/decision`。

示例：

```sh
mkdir -p ~/.config/bizagent
openssl rand -hex 32 > ~/.config/bizagent/human.token
chmod 600 ~/.config/bizagent/human.token
BIZAGENT_LOCAL_HUMAN_ID=alice \
  BIZAGENT_LOCAL_HUMAN_TOKEN_FILE="$HOME/.config/bizagent/human.token" \
  dsh --profile web
```

在组织中创建 `owner: alice` 的 lead Home，并将 Project 交给该 Home。审核请求使用当前
Project 修订和 claim ID：

```sh
curl -H "Authorization: Bearer <token>" \
  'http://127.0.0.1:<port>/api/bizagent/project-review?inbox=1'
curl -X POST -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"<id>","claimId":"<claim>","expectedRevision":2,"decision":"accept","reason":"结果符合完成标准"}' \
  'http://127.0.0.1:<port>/api/bizagent/project-review'
```

浏览器工作台会在本机审核入口启用时显示令牌输入框。验证成功后，令牌仅保存在当前页面内存，
发往真人 Inbox、Project 最终验收与两类知识提案路由；刷新页面后需重新输入。令牌不会进入 URL、
浏览器存储或 Agent 上下文。点击“清除令牌”会退出本页的本机真人身份。

`npm run smoke:local-human` 用隔离 DSH Web profile 验证令牌认证、重启和故障恢复。
`local-human-host.test.mjs` 验证私有令牌文件、错误令牌、Home owner 授权与卸载清理。
