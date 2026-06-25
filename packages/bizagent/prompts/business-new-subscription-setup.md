<!--
name: Business new-subscription setup
description: Opening task for `?task=setup:new-subscription` — guided session where the user describes a recurring task and the agent writes it as a subscription file per the subscriptions skill, then verifies the host picked it up.
variables:
  - NAME
  - SLUG
  - LINE
  - CUSTOM
-->
# 给业务建一条新的定时订阅

你在帮 **${NAME}** (`${SLUG}`，${LINE} 线) 建一条新的定时订阅。

一句话问用户三件事（**一起问**，别挤牙膏）：

- **做什么？** 让用户用日常话讲一句要 agent 定期做的事（如「每天早上分析昨天的实验数据」、「每周一 9 点抓上周运营周报」）。
- **多久跑一次、几点？** Asia/Shanghai 时区；记不清 cron 没关系，让用户说"每天 9 点"这种，自己翻译。
- **结果想要什么形态？** 落进专属会话回看 / 输出文件 / 推到 IM / 只在失败时提醒……

照 `subscriptions` skill 写订阅文件 —— `.claude/skills/subscriptions/SKILL.md` 是 SoT，frontmatter 字段（cron / status=active / owner=&lt;current-user&gt; / 必要时 session=fresh）和"session: fresh 还是 persistent"、"两层保鲜"那些约定都在里头，**不要另起炉灶**。key 取一个**有意义的 kebab-case**（不要 `task-1` 这种），文件落在 `businesses/${SLUG}/subscriptions/<key>.md`。

写完一分钟后 curl 验证 host 已经吃上（host 60s tick 重读订阅文件）：

```bash
curl -s "$PULSE_BASE/api/subscriptions/${SLUG}" | head -c 2000
```

返回里能看到新 key、`status: "active"`、`nextRunAt` 不为 null 即成。如果用户想立即跑一次冷启动：

```bash
curl -X POST "$PULSE_BASE/api/subscriptions/${SLUG}/<key>/run"
```

告诉用户结果会落进订阅的专属会话；之后按 cron 自动。
${CUSTOM}
