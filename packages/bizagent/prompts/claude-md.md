<!--
name: CLAUDE.md
description: Intentionally minimal. All important context (business memory, output block protocol, memory rules, past sessions, worklog) is injected at launch by `biz run` via the system prompt — not stored here — because CLAUDE.md is an editable file and the injected system prompt is authoritative.
variables:
  - BUSINESS_NAME
  - SLUG
-->
# ${BUSINESS_NAME} (${SLUG})

This business is managed by **bizagent**. The working context — business memory, the output block protocol, memory rules, and past sessions — is injected at launch by `biz run` via the system prompt, not stored in this file.

Start sessions with `biz` (not `claude` directly) so that context loads. Knowledge lives in `memory/` and `knowledge/`; do not put important instructions in this file.
