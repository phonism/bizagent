<!--
name: Business knowledge-refresh setup
description: Opening task for `?task=setup:knowledge-refresh` — guided session that writes the business's `subscriptions/knowledge-refresh.md` per the platform's two-layer freshness convention, verifies the host picked it up, and offers a cold-start run.
variables:
  - NAME
  - SLUG
  - LINE
  - CUSTOM
-->
# 给业务建一个 knowledge-refresh 订阅

你在帮 **${NAME}** (`${SLUG}`，${LINE} 线) 建一个**每天自动**的知识保鲜订阅 ——
让业务知识跟着运营节奏走，不要等问题暴露才人工补。

## 工作流

1. **跟用户确认两个细节**（一句话问完，别长篇）：
   - **几点跑？** 默认 `cron: 15 9 * * *`（每天 09:15）——平台两层保鲜约定的时序里
     module self-update 08:30 起、knowledge-refresh 09:15、日报 09:45；除非这个业务的"主源"
     （如 ops 配置）推得晚，否则用默认即可。
   - **要不要现在立即跑一次冷启动？** 写完文件后可以 curl 触发，喂第一份增量。

2. **照 subscriptions skill 写**（`.claude/skills/subscriptions/SKILL.md` 的"两层保鲜约定"节
   是 SoT）—— knowledge-refresh 的 frontmatter / 主源约定（ops `history_op_log` 为主、模块
   `git log` 为辅）/ 水位线 `.bizagent/knowledge-refresh.json` / "知识是稳定态不是流水账" 这些
   铁律都在那。**别另起炉灶**，按模板写。owner 填当前用户标识，`session: fresh`。

3. **curl 验证 host 已经吃上**（host 60s tick 重读订阅文件，写完一分钟后查）：
   ```bash
   curl -s "$PULSE_BASE/api/subscriptions/${SLUG}" | head -c 2000
   ```
   确认返回里出现 `knowledge-refresh` 且 `status: "active"`、`nextRunAt` 不为 null。

4. **如果用户选了立即跑一次**：
   ```bash
   curl -X POST "$PULSE_BASE/api/subscriptions/${SLUG}/knowledge-refresh/run"
   ```
   告诉用户结果会落进订阅的专属会话；明天到点开始走 cron 自动。
${CUSTOM}
