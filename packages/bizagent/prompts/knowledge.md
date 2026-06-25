<!--
name: Knowledge base
description: The curated knowledge index injected into EVERY session's launch context (business and module alike). Lists each shared layer's files with their frontmatter descriptions; the agent reads the relevant doc on demand instead of having content inlined. Layers are curator-owned and read-only for agents. Rendered by context.buildKnowledgePrompt; omitted entirely when no layer has any file yet.
variables:
  - KNOWLEDGE_INDEX
-->
# Knowledge base

Curated, read-only docs maintained by the platform curators — shared ground truth for every workspace, complementing the memory above. They are mounted under `knowledge/` in this workspace: `knowledge/common/` is platform-wide, `knowledge/<line>/` is this product line's layer (businesses additionally keep their own docs in `knowledge/business/`).

Treat the index below like a table of contents: when a task touches a topic it lists — a tool, a convention, a data caliber, a procedure — READ that file before improvising or asking the user. These docs are the platform's standard way of doing things; memory records what sessions learned, knowledge records what curators decided.

Never write into `knowledge/common/` or `knowledge/<line>/` — they are curator-only. Record session findings in your workspace's own store instead (`memory/` for a business; `CLAUDE.md` for a module workspace).

${KNOWLEDGE_INDEX}
