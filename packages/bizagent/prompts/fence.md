<!--
name: Block protocol
description: The output block protocol (chart / breakdown / table blocks), injected into the launch system prompt. The default lives here; a team overrides or extends it via a fence.custom.md (resolved business > root > user). No physical fence.md is materialized anywhere — like everything important, it is assembled into the system prompt, not left as an editable file.
variables:
  - CUSTOM
-->
# 平台可视化 Fence 规约

前端支持自动渲染以下代码块。**fence 是工具不是义务**：

- ✅ 用它的时机：数据/结论用结构化呈现比纯文字明显更易读时（多个 KPI 横向对比、真实漏斗递减、cohort 矩阵、关键告警结论…）
- ❌ 不用它的时机：能用一句话讲清楚的结论、单个数字、3-4 条琐碎信息、流程过程的中间步骤——这些 fence 反而是噪声
- 判断标准：**移除这个 fence、改成普通文字，读者是否更难抓住要点？** 答案是"否"就不要用

## 图表类

- ` ```chart ` — ECharts 图表，支持原生 ECharts option（含 line/bar/pie/funnel/heatmap/scatter/radar/sankey/gauge/boxplot/dataZoom/markLine 等），也支持内部封装 ChartSpec（type: line/bar/pie/funnel/dual-axis/heatmap）。数据趋势、占比、漏斗首选
- ` ```mermaid ` — Mermaid 图（flowchart/sequenceDiagram/quadrantChart/journey/mindmap/timeline/gantt/erDiagram 等），适合流程图、架构图、时间轴
  - **quadrantChart 数据点标签只能用英文/数字/下划线**（mermaid 词法层 `\w+` 不支持中文）

## 运营分析类

- ` ```metric ` — 指标卡网格，展示一组 KPI
  - schema: `{ columns?: 2|3|4, items: [{ label, value, delta?, trend?: "up"|"down"|"flat", mood?: "positive"|"negative"|"neutral", hint?, highlight?: bool }] }`
  - `trend` 决定箭头方向，`mood` 决定颜色语义（两者独立 —— "成本下降"是 down+positive）
- ` ```retention ` — 留存矩阵（cohort × periods 热力表）
  - schema: `{ title?, periods: ["D1","D3","D7",...], cohorts: [{ date, size?, retention: [v1,v2,...] }] }`
  - retention 值可以是小数（0.45）或百分比（45），渲染自动识别
- ` ```abtest ` — AB 实验对比卡
  - schema: `{ metric, control: {name, value, n?}, treatment: {name, value, n?}, lift?, pValue?, ci?, higherIsBetter?: bool }`
  - lift 不传时按 (treatment-control)/control 自动算；pValue 自动判定显著性（<0.05 显著, <0.1 趋势性）
- ` ```funnel-rate ` — 带转化率的漏斗（自动算 step% 和总体%，最大流失环节高亮）
  - schema: `{ title?, stages: [{ name, value, note? }], mode?: "step"|"overall"|"both" }`
  - 用途：每步**人数/计数递减**的真实漏斗（曝光→点击→注册→激活→留存、加购→下单→支付 等）
  - ❌ 不要用：执行计划 / TODO 清单 / 规划步骤 / 阶段任务（value 不是真实计数、转化率没有归一化语义时硬填 100 只会得到 4 个等宽矩形）。这类用 ` ```tasks ` 或普通 markdown 有序列表
- ` ```breakdown ` — 瀑布归因图（展示"起点 → 各项增减 → 终点"的分解，用于指标环比归因）
  - schema: `{ title?, total: { start, end?, unit? }, items: [{ label, delta, note? }] }`
  - `end` 可省略（自动算 start + sum(delta)）；正 delta 绿色、负 delta 红色、起终点紫色
  - 用途：DAU 环比归因、GMV 拆解、成本变化分析等
- ` ```quadrant ` — 四象限散点图（中文 label 无限制，自动避让 + 象限标题贴角不撞点；首选用它，不要再用 mermaid quadrantChart）
  - schema: `{ title?, xAxis?: { low?, high? }, yAxis?: { low?, high? }, q1?: { name, mood? }, q2?: ..., q3?: ..., q4?: ..., points: [{ name, x, y, group?, note? }] }`
  - x/y 都是 0~1（自己归一化）；q1=右上 q2=左上 q3=左下 q4=右下；mood: positive/negative/warning/neutral 决定象限填充色
  - 用途：渠道效率四象限、产品矩阵、用户分群

## 结构与结论类

- ` ```tree ` — 文件/目录树（可折叠）
  - schema: `{ root?, items: [{ name, type?: "dir"|"file", size?, note?, children? }] }`
- ` ```finding ` — 关键发现/洞察 callout（类似 GitHub 的 Note/Warning）
  - schema: `{ kind?: "critical"|"warning"|"info"|"success", title, body?, actions?: [{ label, href? }] }`
  - `body` 支持完整 Markdown（粗体/列表/`---`分隔线/表格/链接），不要用 `\n` 拼接长字符串当一行
  - **JSON 引号硬约束**（所有 JSON fence 通用）：字符串值里**禁止嵌入未转义的半角 `"`**，否则解析必崩。中文文本里的引号一律用全角 `"` `"` 或 `「」`；如必须用半角，写成 `\"`

## 状态类

- ` ```tasks ` — 任务状态列表，每行 `[done]` / `[run]` / `[wait]` / `[fail]` / `[skip]` 开头
- ` ```decision ` — 多方案决策卡片（含投票）

## 交互应用类

- ` ```app ` — 可交互前端应用（iframe sandbox 渲染，用户在页面上直接玩/操作）
  - 用途：小游戏、可交互演示/模拟器、超出 chart 能力的自定义可视化、小工具
  - **文件引用（首选）**：fence 内容只写一行 deliverable 路径，渲染时自动取文件内容

    ```app
    deliverables/<runId>/snake.html
    ```

    工作流：先把**完整 HTML 单文档**（CSS 用 `<style>`、JS 用 `<script>` 全内联）`Write` 到 `.bizagent/deliverables/<runId>/snake.html` → 直接输出上面的 fence，渲染会通过 deliverable API 拉到最新文件内容。后续迭代直接 `Edit` 同一个文件，重发同一个 fence 即可（前端会重新拉取）
    - `<runId>` 是当前会话的 runId（在 worklog 段的 `WORKLOG_PATH` 里能看到）
    - 文件名必须是 deliverables 目录的**直接子文件**，不要放进 `apps/snake.html` 这种子目录（当前 readDeliverable 强制 direct-child，子目录会 404）
    - 文件名以 `.` 开头会被拒绝（视为隐藏 marker）
  - **inline（仅限小 widget）**：百行以内的小交互可以把完整 HTML 文档直接放 fence 里（以 `<!DOCTYPE html>` 或 `<` 开头）；超过这个体量一律写文件，别把几百行代码堆进对话
  - 运行环境约束：
    - 代码跑在 `sandbox="allow-scripts"`（无 `allow-same-origin`）的 iframe 里：读不到平台 cookie/token，**调不到外部 API**，不要尝试 fetch 外部接口
    - 可以引用公共 CDN 外链库（jsdelivr / unpkg 的 three.js、phaser 等），但外链挂掉就白屏——核心逻辑尽量自包含，CDN 只做增强
    - 画布/布局自适应容器宽度（容器约 520px 高），键盘操作的游戏记得让 canvas 可聚焦并提示操作方式

## 反模式参考（满足前面"该用"条件时才参考；不满足条件就用普通文字）

- markdown 表格展示真实漏斗转化率 → ` ```funnel-rate ` 更直观
- markdown 表格展示多个 KPI 环比 → ` ```metric ` 涨跌色更醒目
- ` ```json ` 包 ECharts option → 直接 ` ```chart ` 原生 option
- 重要结论仅用粗体凸显且需读者立即注意 → ` ```finding ` callout
- 手绘 `│ ├── file` 文件树 → ` ```tree `

注意：上面这些**不是命令**——如果信息量本就不大、用普通文字一句话能讲清，就直接用文字，不要为了"用上 fence"硬拼。
${CUSTOM}
