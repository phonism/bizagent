# BizAgent

Business-scoped memory and runtime harness for Claude Code CLI and Agent SDK.

> Claude Code is scoped to a repo. BizAgent is scoped to a business: product lines,
> shared modules, persistent worklogs, and reusable business memory.

**Languages**: [English](./README.md) | [中文](./README.zh-CN.md)

## What This Is

BizAgent wraps an agent runtime with the pieces a business team needs for repeated
work on the same business area:

- Product lines as real directories; each line holds its businesses and shared modules.
- Business memory stored as frontmatter Markdown records under `memory/`.
- Session worklogs under `.bizagent/deliverables/<runId>/worklog.md`.
- Hook-based governance for memory writes and worklog enforcement.
- Cross-session and optional cross-user context sharing.
- One core implementation shared by CLI, Agent SDK, and the built-in web server.

This repository contains the working BizAgent implementation.

## Current Capabilities

- `biz init` creates a root; `biz line new` creates a product line (also lazily created).
- `biz new <slug> --line <line>` creates a business with shared knowledge symlinks and hook wiring.
- `biz module new --line` and `biz link` model shared technical modules (line-scoped, never cross lines).
- `biz setup <slug>` runs a guided, conversational setup: profile, modules, knowledge base.
- `biz mem add/list` writes and retrieves business memory with governance.
- `biz run` launches the agent in a business with an injected system prompt.
- `biz run --view` opens a read-only browser mirror of the terminal conversation.
- `biz web` starts the built-in HTTP/SSE web platform.
- Agent SDK helpers wire the same context and hooks in-process.
- Remote sharing supports `file`, fixed-contract `http`, or custom `module` remotes.

Not implemented in this package: metric anomaly monitoring, SQLite source of truth,
MCP retrieval, embeddings, or a production-grade multi-tenant platform server.

## Install

```sh
cd packages/bizagent
npm install
npm run build
npm link
biz --help
```

The CLI launches `claude` by default. You can override the executable with:

```sh
CLAUDE_PATH=/path/to/claude
BIZ_AGENT_BIN=/path/to/custom-agent
```

## Quick Start

```sh
biz init ./acme --web
cd acme

biz new webstore --line commerce         # the commerce line is created lazily
biz setup webstore                       # guided setup, in conversation
biz mem add webstore "GMV excludes cancelled orders" --confidence 0.9
biz mem list webstore

biz run webstore
# or:
cd lines/commerce/businesses/webstore && biz
```

To start the web platform:

```sh
biz web
```

To preview the full context injected into an agent run:

```sh
biz context webstore
```

## Directory Model

A root holds product lines; a line holds its knowledge layer, its modules, and its
businesses. Business slugs are globally unique, so commands and routes take just the slug.
Modules never link across lines.

```text
acme/
├── bizagent.config.json
├── prompts/
├── knowledge/
│   └── common/
└── lines/
    └── commerce/
        ├── knowledge/
        ├── modules/
        │   └── backend/
        │       ├── module.json
        │       ├── code/
        │       └── memory/
        └── businesses/
            └── webstore/
                ├── business.json
                ├── CLAUDE.md
                ├── .claude/settings.json
                ├── knowledge/
                │   ├── business/
                │   ├── common   -> root knowledge/common
                │   └── commerce -> ../../knowledge
                ├── modules/
                │   └── backend -> ../../modules/backend
                ├── memory/
                └── .bizagent/
                    ├── deliverables/<runId>/worklog.md
                    ├── worklog-index.md
                    └── remote-memory/
```

The editable sources are `memory/`, `knowledge/business/`, linked module memory,
and optional prompt overrides. The important operating rules, business memory,
past sessions, output block protocol, module context, and worklog instruction are
assembled at launch by `buildSystemPrompt`, not stored in `CLAUDE.md`.

## Memory and Governance

Business memory records are Markdown files:

```markdown
---
scope: business
confidence: 0.9
writable_by: agent+human
updated_at: 2026-06-05T00:00:00.000Z
---

GMV excludes cancelled orders.
```

The hook layer enforces:

- Agents cannot write curator layers: root `knowledge/common` or a line's `knowledge/`.
- Business memory must be `.md`, `scope: business`, and have a non-empty body.
- `Write` and `Edit` operations are both validated against the full post-write content.
- Stop is blocked once if the current run has not written its worklog.
- Finished worklogs are indexed into `.bizagent/worklog-index.md`.

`biz mem add` and the web memory API use the same validation as the hooks.

## Remote Sharing

Remote sharing is optional. Each local business remains the source of truth; a remote
is a best-effort shared layer for worklog summaries, worklog bodies, and business memory.

```sh
biz init ./acme --remote file:../hub
```

Supported remote tiers:

- `file`: shared local folder, useful for tests or simple shared storage.
- `http`: fixed REST contract with configurable base URL and headers.
- `module`: user-supplied JavaScript factory returning a custom Remote implementation.

Remote calls are timeout-bounded and fail open: a slow or unavailable remote does not
break the local agent run.

Raw session transcripts are a separate opt-in (`"transcripts": true` in the remote block,
they carry file contents and command output): each Stop mirrors the session's new
transcript lines to the hub, where the platform web renders the conversation read-only —
a remote session is viewable there but never resumable.

A `biz web` deployment (or any host mounting `createBizHandler`) doubles as the server
side of the `http` contract: `/api/businesses/:slug/hub/*` serves index/worklog/memory/
transcript on the platform's live business data, plus a read-only `manifest` + `file`
surface for future cold-start pulls. `remote.url` supports `${SLUG}` interpolation, so one
config block covers every business.

## Development

```sh
cd packages/bizagent
npm test
npm run typecheck
npm run build
npm run biz -- --help
```

Some web and HTTP tests open a local listener. In restricted sandboxes they may fail with
`listen EPERM`; the core filesystem, governance, runtime-sdk, session, prompt, module, and
remote pure-function tests do not require listening sockets.

## Release

```sh
scripts/release.sh --dry-run
scripts/release.sh --publish
```

The release script reads the version from `packages/bizagent/package.json`, builds and
typechecks the package, runs `npm pack --dry-run`, then in `--publish` mode commits current
changes, creates tag `bizagent-v<version>`, pushes `main` and the tag, and runs
`npm publish --access public`.

Before publishing, make sure `npm whoami` works. If local listener tests fail in a restricted
sandbox, publish from a normal development machine or pass `--skip-tests` deliberately.

## Documentation

- [packages/bizagent/README.md](./packages/bizagent/README.md): package-level usage notes.
- [packages/bizagent/docs/design.zh-CN.md](./packages/bizagent/docs/design.zh-CN.md):
  design document kept in sync with the implementation.

## License

Licensed under [Apache-2.0](./LICENSE).
