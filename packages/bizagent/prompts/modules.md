<!--
name: Modules
description: The modules (shared technical components) this business is built from, plus the read-the-mount / clone-to-change convention. A business session READS module code directly through its modules/<name> mounts (the sandbox grants read access to their targets); all CHANGES happen in a clone under the session's deliverables — a governance hook denies writes into the shared module directory. REQ_REF is the requirement id when the session runs under one (so sessions on the same requirement share one branch), else the run id.
variables:
  - MODULES_LIST
  - RUN_ID
  - REQ_REF
-->
# Modules

This business is built from the modules below — shared components, each with its own code and deployment. A module's master code is mounted under `modules/<name>/code/` for analysis; its distilled knowledge (operational commands, structure, sharp edges) lives in `modules/<name>/CLAUDE.md` — **Read that file before working with a module**, it is not inlined here.

${MODULES_LIST}

## Reading

- **Analysis / understanding**: read `modules/<name>/code/` directly — you have read access through the mount. It tracks the module's master branch and is shared: never edit, commit, or switch branches there (a governance hook denies writes into the module directory).
- If `modules/<name>/code/` is empty, the checkout hasn't been bootstrapped — that's module-workspace work (the module's own setup conversation), not yours. Clone your own copy (below) and continue.

## Developing (changing code)

All changes happen in YOUR clone, never in the shared mount:

- Clone per the module's Source description above into `.bizagent/deliverables/${RUN_ID}/dev/<name>/` (credentials and tooling come from this machine's environment).
- Work on branch `req/${REQ_REF}`:
  - An earlier session on this requirement may already hold the branch — check the sibling worklogs for their clone path (`.bizagent/deliverables/<their-run>/dev/<name>/` is reachable from here) and continue THERE; or, if the branch was pushed, clone fresh and `git checkout req/${REQ_REF}`. Otherwise create it: `git checkout -b req/${REQ_REF}`.
  - Commit on that branch and push it. The pushed branch is the deliverable — merging into master and deployment happen OUTSIDE this session: do not merge, do not deploy, and never touch the module's shared checkout.
  - After the branch merges, the module's own workspace catches its `code/` up with master in a module conversation — not this session's concern.
- **Module knowledge**: a finding that's true for EVERY business using the module (how to build / start / deploy it, code structure, gotchas) belongs in the module's `CLAUDE.md`, which is maintained in the module's own workspace — that file is read-only from here, so bring it up in a module conversation, or note it in your worklog for the curator. Business-specific facts stay in this business's own `memory/`.
- In your worklog, record which modules you changed, the clone path, and the branch name.
