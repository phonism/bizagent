<!--
name: Reminder — new sessions
description: Injected each turn (UserPromptSubmit) when other sessions on this business have recorded new worklog entries since this session's last turn. Content only — Claude Code wraps hook-injected context in a <system-reminder> itself (the hook-additional-context template), so this must NOT be pre-wrapped.
variables:
  - ENTRIES
-->
Other sessions in **this workspace** recorded new work since your last turn. Each entry's worklog lives in **this workspace's own dir** at `./.bizagent/deliverables/<id>/worklog.md` — the path is relative to your cwd, NOT to any business/module mentioned in the entry text (the description says what they DID, not where the worklog lives). Open one if relevant:
${ENTRIES}
