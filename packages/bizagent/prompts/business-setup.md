<!--
name: Business setup
description: Opening task for `biz setup` (web: ?task=setup) — a guided session that interviews the user to fill the business's profile, register and link its modules, and seed the business knowledge base. The structure lands via biz commands; the conversation does the rest.
variables:
  - NAME
  - SLUG
  - LINE
  - CUSTOM
-->
# Set up this business

You are running inside a **bizagent** business: **${NAME}** (`${SLUG}`), on the `${LINE}`
product line. It is freshly created (or still thin). Give it a working start: interview the
user, fill in the structure, and lay the first layer of business knowledge.

Work through the phases below in order. In each one, write down what you can read or safely
infer, and **ask the user** what you can't — a few questions at a time, not a long form. If
something is already filled in, skip it.

## Phase 1 — business profile

Find out what this business is: a display name and a one-line domain description.

Record it:

```
biz set ${SLUG} --name "..." --domain "..."
```

## Phase 2 — modules (where the code lives)

Ask which technical components the business is built from — strategy, backend, frontend,
data, ... For each one, ask:

- where its code lives and how to get it (an internal forge, a GitHub URL, clone
  instructions — free text is fine);
- how it ships (deploy command or pipeline), if the user knows.

Check `biz module list --line ${LINE}` first — a module may already exist on this line
(modules are shared across the line's businesses, never across lines); then just link it.
Otherwise register it, then link:

```
biz module new <mod> --line ${LINE} --type <t> --source "<where the code lives, how to clone>" --deploy "<how it ships>"
biz link ${SLUG} <mod>
```

After linking, bootstrap the code: clone it into `modules/<mod>/code/` following its source
description (credentials and tooling come from this machine's environment). If a clone needs
access you don't have, record it as a gap and move on.

## Phase 3 — seed the knowledge base

Now give `knowledge/business/` its first pass. This is a foundation, not a complete one — a
business's knowledge grows from everyday work.

Gather from whatever this business actually has: `business.json`, the modules you just
linked (read their `code/` and `CLAUDE.md` to understand mechanics, config fields, data flows,
key APIs), and anything the user gives you in chat (links — fetch them, docs, context).
Already-shared knowledge lives in `knowledge/common/` and `knowledge/<line>/` (read-only) —
read it so you reference instead of repeat.

- Write what you can actually read or safely infer — concrete field names, data flows,
  config, mechanics. Ground every claim in something you read; never invent business facts.
- When you can't infer a piece of business background — the rules of the business, a
  metric's definition, the goal, a term of art — **stop and ask the user.** A clearly-marked
  gap is more useful than a confident wrong answer.

Produce `knowledge/business/*.md`, split into sections however the material suggests. Cover
what's specific to this business, from the user's point of view ("what does the user do →
what do they see → what happens behind it"), including the kinds of work that recur here
(campaigns, analyses, reports, ...) — in prose, where the next session will read it.

Write it as **stable knowledge, not a changelog**: describe how the business works *now* —
mechanics, field calibers, config semantics, architecture — in the present tense, structured
for fast lookup. Time-stamped events ("on 6/5 someone added N tasks", "this round's biggest
change") belong in a worklog, never in a knowledge doc; a doc may carry at most a one-line
`cutoff / last-reviewed` note. For any volatile value, cite a *runnable* verification command,
never an invented one.

Give every file a frontmatter `description:` — a one-line summary of what the doc covers and
when to reach for it. That line is the ONLY thing the knowledge index shows next to the
filename, and it's how a later session decides which doc to open, so make it carry the hook
(e.g. `description: 报名活动的报名→审核→发放链路与各环节字段、状态机；排查报名异常前必读`).

Don't touch `knowledge/common/` or `knowledge/<line>/`.

## Before you finish

Write your worklog (you'll be reminded). In its **Open questions** section, list the gaps:
metadata you couldn't confirm, modules you couldn't clone, knowledge dimensions still
missing. That list is where the next session picks up.
${CUSTOM}
