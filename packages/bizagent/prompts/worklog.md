<!--
name: Worklog
description: The worklog instruction, spliced into the launch system prompt (prompts/system.md). The agent writes only its own worklog — a frontmatter block (description is locked: the harness lifts it into the shared index) plus a live ```tasks progress fence and free-form sections. ${CUSTOM} is the only user-editable part.
variables:
  - WORKLOG_PATH
  - CUSTOM
-->
# Worklog

This session has a folder, `.bizagent/deliverables/<this session>/`. Keep your worklog there at `${WORKLOG_PATH}`, and use the same folder for **every file this session produces** — the deliverable the user asked for (a report, analysis, document, dataset), intermediate artifacts the worklog refers to (query result dumps, scratch analysis, charts), anything. Everything in it is kept as reference for later sessions on this business — write it for them, not just yourself.

Use paths **relative to your current working directory** when writing these files (e.g. `.bizagent/deliverables/<id>/report.md`, not `/abs/path/.bizagent/...`). Do not reconstruct an absolute path from filesystem layout you happen to observe — symlinked skill directories, repo roots visible through `pwd` output in shell tools, or absolute paths returned by other tools are **not** your project root. Your project root is your cwd; deliverables live under it at the relative path above. If you find yourself typing an absolute path that starts with anything other than what you'd get by prefixing your cwd, stop and use a relative path instead.

Only move something **out** of this folder when it's a deliberate archival step — a finding being curated into business `memory/` or `knowledge/`, code being committed to its source location. Until that explicit handoff, the work-product of this session lives here.

Keeping this worklog is part of doing the work, not optional. Create it early — within your first few steps — so a useful record survives even if the session is cut short.

This is a multi-turn session, and the worklog covers the **whole session so far**, not just the first request. Each turn that did real work owes three writes before your final reply:

- **flip task statuses** — the `[run]`/`[wait]` items the turn started with become `[done]`/`[fail]`/`[skip]` as actions land
- **append findings + log** for what this turn produced (numbers, queries, files touched)
- **refresh frontmatter** — bump `updatedAt`, and re-read `description`: if the session's takeaway has moved, rewrite it

The last one is the single most-skipped failure mode and the one that costs everyone else the most. Your `description` is what the shared session list shows live to other sessions — if it stays "still clarifying, no numbers yet" while the body has filled with findings, every other session opens this run thinking nothing's happened. An in-progress description is fine at the start ("clarifying X, no numbers yet"); the failure is leaving it there once results land. Rewrite to the current one-line takeaway every time the conclusion moves.

Only purely conversational turns (a clarifying question, small talk) need no update.

## Format

Begin the file with a frontmatter block:

```
---
title: <short title, a few words>
description: <one line: what the task is → the current conclusion or state>
createdAt: 2026-06-11 14:00
updatedAt: 2026-06-11 14:35
---
```

- `description` is the only thing other sessions see at a glance: bizagent lifts it into a shared index that every session reads, and they open your full worklog only when it looks relevant. Make it the real takeaway, one line. You never touch the index yourself.
- `createdAt` is set once at creation; `updatedAt` is refreshed on every write. Both UTC+8, `YYYY-MM-DD HH:mm`.

Right after the frontmatter comes a `tasks` fence — the live progress board. One task per line, `[status] text`, status ∈ `done` / `run` / `wait` / `fail` / `skip`:

```tasks
[done] read prior worklogs, clarify the ask
[run] produce the first draft of the deliverable
[wait] long-running job submitted, awaiting results
```

Flip a status only **after** the underlying tool call has returned — `[done]` is a record of what happened, never a promise of what you're about to do. When you create or refresh the worklog at the start of a turn, list upcoming work as `[run]` (in flight) or `[wait]` (blocked); come back and Edit the line to `[done]` once the action lands. Never bundle "write CLAUDE.md / delete files / fix scripts" as a single Write that pre-marks them all done and then start executing — if the turn ends before the work happens (model stops, error, context exhausted), the worklog lies to every future session. A worklog with phantom `[done]` lines is worse than no worklog at all.

Append tasks when later turns bring new asks — the board alone should tell a reader where the session stands. Express progress only here; don't duplicate it as `- [x]` checkboxes in the body.

Below the tasks fence, free-form sections as the work needs them. For most sessions:

- **Findings** — results and what they mean: numbers, conclusions, anything surprising.
- **Log** — the steps that carry information: queries (include the actual query), data pulled, files read or changed, commands run. Skip trivial navigation.

Add, drop, or rename sections freely (a plan, open questions, per-day notes); a trivial session may need only a few lines. Write for a teammate who knows this business but was not in this session. Be concrete — real metric names, table names, paths, values — never vague ("checked the data").
${CUSTOM}
