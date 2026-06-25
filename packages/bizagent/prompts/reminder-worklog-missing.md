<!--
name: Reminder — worklog missing
description: Fed back to the model when the session tries to end without a worklog (Stop hook, exit 2). Claude Code wraps Stop-hook stderr in a <system-reminder> itself (the hook-stopped-continuation template), so this is content only — not pre-wrapped.
variables:
  - WORKLOG_PATH
-->
You haven't written this session's worklog. Create it at `${WORKLOG_PATH}` — frontmatter (`title`, one-line `description`: what the task was -> the outcome, `createdAt`/`updatedAt` in UTC+8 `YYYY-MM-DD HH:mm`), then a ```tasks fence (`[status] text`, status ∈ done/run/wait/fail/skip) showing where the work stands, then Findings / Log as needed. The session isn't done until it exists.
