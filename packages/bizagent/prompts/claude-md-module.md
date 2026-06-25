<!--
name: CLAUDE.md (module seed)
description: The seed skeleton for a module's CLAUDE.md — the module's LIVING KNOWLEDGE DOC, the opposite of the business pointer. A module is a code repo, and a repo's persistent facts live in its CLAUDE.md (Claude Code's native idiom). Module sessions maintain it; linking businesses Read it on demand through their modules/<name> mount. assemble() writes this only when the file is missing or still the legacy pointer — real content is never clobbered. The seed marker comment below is how moduleStatus tells "still the seed" from "knowledge landed"; sessions remove it when they fill the file in.
variables:
  - MOD
  - LINE
-->
<!-- bizagent:module-claude-md-seed — this file is still the empty skeleton; remove this comment line when real knowledge lands. -->
# Module: ${MOD} (line: ${LINE})

This file is the module's living knowledge base, maintained by the module's own sessions. Record here what every session — this module's and linking businesses' — needs to know; keep it distilled, it is loaded whole. Basics (type / source / deploy) live in `module.json`, not here.

## Operations

_(not recorded yet — how to build / start / update / deploy, pointing at `scripts/` where scripts exist)_

## Code structure

_(not recorded yet — the layout and where things live in `code/`)_

## Sharp edges

_(none recorded yet — non-obvious constraints a session would rediscover the hard way)_
