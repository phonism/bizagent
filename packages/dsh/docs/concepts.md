# Concepts

DSH runs sessions: one conversation with one model, tools, and a working directory. BizAgent adds
what lasts across sessions: who an agent is, what it has learned, and the work it shares with other
agents. This page explains each piece and where you see it in the DSH web app.

## Homes

A **Home** is one long-running agent's identity and memory. It is a folder:

```text
homes/personal--data-analyst-b3a9d31a/
  home.yaml          address, display name, owner, revision
  identity.md        who this agent is and what it is responsible for
  memory/ insight/ knowledge/ method/   one Markdown file per learned asset
  orders.csv         files the agent works on (the folder is its working directory)
```

Every Home has an **address** of the form `type:id`:

| Type | Use |
| --- | --- |
| `personal` | One member of the team: a person's own agent |
| `role` | A role several members can fill, such as Analytics |
| `capability` | A reusable skill or body of knowledge shared across roles |
| `business` | The organization's own Home: shared goals and decisions |
| `line` | The organization's product line, which coordinates its Projects |

Each Home has an **owner**, the person allowed to change it from outside: accept proposals into
it, accept the Projects it leads, and let other Homes start work in it. In the local setup you own
every Home BizAgent creates.

An **organization** is a set of Homes created together in one DSH workspace, under
`<workspace>/bizagent/<organization-id>/`. Outside an organization, sessions use the default Home
`personal:default`.

## Sessions and Homes

Each DSH session is bound to exactly one Home, once, when it starts. The binding follows the
session's working directory: a session in a Home's folder belongs to that Home. Any other session
belongs to `personal:default` before you create an organization, and to the organization's
business Home after. **Chat** on a Home in the BizAgent panel opens that Home's long-term chat,
its *Principal*.

At the start of a session the agent receives:

- BizAgent's working rules, as part of the system prompt;
- a **Home snapshot**: the identity and a short index of active assets (descriptions only; the
  agent reads full bodies on demand);
- a digest of unhandled Inbox messages, if any.

## What a Home learns

The agent saves learning with `bizagent_memory_remember`. Each saved item is an **asset** of one
kind:

| Kind | Holds |
| --- | --- |
| `memory` | An observation in its context ("the March export had duplicate rows") |
| `insight` | An inference supported by observations |
| `knowledge` | An established fact or rule ("GMV excludes cancelled and refunded orders") |
| `method` | A repeatable procedure |

Every asset records its **evidence**: references to the session events it came from, which the
agent (and you) can read back. An asset has a status:

- `active`: in the Home's index; future sessions see it.
- `candidate`: saved but not yet trusted. The agent uses candidates when it still needs to check
  something, then publishes the exact revision it reviewed.
- `superseded`, `retired`: kept for history, no longer used.

Edits create new revisions and refuse to overwrite a revision someone else changed in the
meantime.

When a later task uses an asset, the agent records whether it was **confirmed**, **contradicted**,
or **failed**. These receipts are the asset's track record (its *fitness*) and flag assets that
need review.

### Corrections stick

When you explicitly correct an agent ("that's wrong, retention cohorts use first-active date"),
BizAgent notices at the end of the turn and asks the agent, once, to decide whether the
correction is worth keeping. Ordinary turns cost no extra model call.

### Looking back

- **Worklogs** are short, searchable summaries tied to a session: BizAgent writes one for turns
  that used tools, and agents write their own for results worth finding later. A Worklog can keep
  exact copies of the files it mentions.
- **Learning reviews** let an agent go through earlier sessions and Worklogs it has not reviewed
  yet, decide what (if anything) to keep, and record that each item was reviewed. A host can run
  these reviews on a schedule in a separate session.

You see all of this under **Learning**: the memory strata, Worklogs, and the asset ledger with
each asset's revisions, evidence, and receipts.

## Sharing between Homes

A session writes only to its own Home. Other Homes are reached in three governed ways:

- **Frames.** An agent can open a read-only Frame on another shared Home (not a personal one) to
  search and read its active assets for the current conversation. Typing `@` in the DSH composer
  offers Homes to mention. A Frame never changes who the agent is or what it may write.
- **Proposals.** An agent proposes a new or revised asset to another Home, with its evidence. The
  target Home's owner accepts or rejects it under **Learning → (Home) → Proposal inbox**. An
  accepted proposal becomes a new revision of the target Home.
- **Shared Knowledge.** For rules that belong to a whole product line or platform, agents propose
  documents to a shared Knowledge store that every Home can search. The line Home's owner reviews
  them in the BizAgent panel.

## Working together

### Inbox

Homes send each other **Inbox messages**: to and cc recipients, an optional deadline, normal or
urgent priority. The recipient handles a message from its own session; replies go back to the
session that asked when it is still around. Messages do not create obligations: a reply or a
"handled" mark is not completed work.

When the recipient Home has the same owner, BizAgent can start a session in it to read new mail.
Each Home's `inbox.json` sets when: `immediate`, `batch` (every 15 minutes, the default),
`scheduled` (a cron expression), or `carried` (only shown at the start of its next session).
Urgent messages always start one. Unanswered messages are nudged once. A conversation that reaches
6 hops or 12 messages has to be closed with a conclusion message.

People have an Inbox too: messages to `user:<id>` appear under **My Inbox**.

### Formal Work

When another Home must own a deliverable, an agent dispatches **formal Work**: a goal, acceptance
criteria, and an idempotency key. If both Homes have the same owner, BizAgent starts a worker
session in the assignee Home right away. The worker accepts the Work in that session and completes
it with one result, optionally freezing files from its `artifacts/` folder so the requester reads
exactly the delivered bytes. The result returns to the session that dispatched the Work. The
requester can cancel Work until a result is reserved.

Work statuses: `open` → `accepted` → `completing` → `completed`, or `cancelled`.

### Projects

A **Project** is a longer goal with a written "done when" standard. Its lead Home creates it; the
Project gets its own chat (the *Project Main*), separate from the lead's Principal.

1. The lead invites other Homes as **Seats**, each with a responsibility.
2. It dispatches formal Work with the Project id; Seats work in their own Homes.
3. When the linked Work is finished, it **submits** a result claim, with frozen files or a
   delivered Work result as evidence.
4. A person accepts the claim under **Projects**, or the lead or the person sends it back for
   rework. An agent can never accept a Project result.

Project statuses: `open` → `awaiting_acceptance` → `accepted`.

## You, the owner

BizAgent treats the person signed in to the DSH web app as the local owner. That person reviews
proposals, accepts Project results, and reads **My Inbox**. Agents cannot do any of these, even for
Homes they belong to. See [Architecture](architecture.md#trust-model) for what this protects
against and what it does not.
