<!--
name: Module setup
description: Opening task for a module workspace's setup session (web: ?task=setup on a module workspace; CLI: `biz module setup`) — the session runs in the module's OWN directory. Make sure the code is cloned, read it, correct the recorded facts, and cold-start the module's CLAUDE.md (shared technical knowledge for every business on the line that links it).
variables:
  - MOD
  - LINE
  - CUSTOM
-->
# Set up the module `${MOD}`

You are running inside the module's own directory (line `${LINE}`): its code checkout is
`code/`, its knowledge is `CLAUDE.md`. Your job is to give this module a working start. That
file is SHARED technical knowledge: every business on this line that links `${MOD}` will
read what you write.

The module's recorded facts (type, source, deploy) are in the Module facts section of your
context. Work through the phases below; ask the user what you can't read or infer.

## Phase 1 — get the code

If `code/` is empty, clone the code into it following the module's Source fact (credentials
and tooling come from this machine's environment). If it exists, `git -C code pull` so you
read current master. If you can't get access, record the gap and continue with what the user
can tell you.

## Phase 2 — correct the record

While reading, check the module's recorded facts against reality. Ask the user about how it
ships if Deploy is missing. Fix anything wrong or missing by editing `module.json` — the
`type` / `source` / `deploy` fields only (leave `slug` and the timestamps alone).

## Phase 3 — fill in the module's CLAUDE.md

Replace the seed skeleton in `CLAUDE.md` (drop its seed-marker comment line) with the
technical knowledge a session needs before touching this module:

- code structure: entry points, key directories, where the important logic lives;
- conventions: how to build, run tests, what a change typically touches;
- sharp edges: config that must not drift, known coupling, gotchas;
- the WHY behind operational procedures — the runnable HOW becomes a script in Phase 4;
  CLAUDE.md points at the script rather than restating its commands.

Ground every claim in code you actually read — never invent. Keep it DISTILLED — the whole
file is loaded into every session on this module and read by linking businesses. This is
module knowledge (true for every business using it); business-specific facts belong in the
business's own `memory/`, not here.

## Phase 4 — co-build the operational scripts

Turn how this module is operated into runnable scripts under `scripts/` — executable
knowledge: unlike a command list in memory, a script can be re-run any day to prove it
still works. Build them WITH the user: draft from the code you read, then walk through
each step together and ask about what you can't verify (credentials, internal tooling,
release gates).

- `scripts/bootstrap.sh` — cold start: clone per the Source fact, install dependencies.
- `scripts/update.sh` — refresh `code/` to current master (pull; refresh deps when
  needed) and END by printing a short change summary (e.g. commits since the previous
  HEAD). "Nothing new" must be obvious from the output — later automation will read it
  to decide whether anything needs attention, so keep it honest and quiet on no-op.
- `scripts/deploy.sh` — only when the user confirms shipping is scriptable from here.
  Deployment stays EXTERNAL to sessions (a session's output is a branch): this script is
  executable documentation for the HUMAN — write it together and verify the steps with
  the user, but never run it yourself.
- more when the module calls for them (`test.sh`, `build.sh`, ...) — same rules.

Run `bootstrap.sh` / `update.sh` once to prove they work. Keep every script idempotent —
safe to re-run any day. What can't be scripted (manual approvals, web consoles), record
in `CLAUDE.md` as the gap it is instead of faking a step.

Once `update.sh` works, enroll the module in the platform's daily self-refresh (where
the platform supports scheduled subscriptions): create `subscriptions/self-update.md` —
a daily cron that runs `scripts/update.sh` and only digests further when it reports
changes — so `code/` keeps tracking master without anyone remembering to ask.

## Before you finish

Write your worklog (you'll be reminded). List what's still unknown — code you couldn't
access, deploy steps unconfirmed, scripts that couldn't be verified — in its
**Open questions** section.
${CUSTOM}
