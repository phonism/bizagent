# bizagent (reference implementation)

Business-scoped memory harness, shared by **both** runtimes — the Claude Code CLI
and the Agent SDK — from a single codebase.

> Claude Code's memory is scoped to the **repo**. BizAgent's memory is scoped to the
> **business**: product-line × layered knowledge. Same core, two runtimes.

## The one rule that makes CLI ≡ SDK

The CLI and the programmatic API are both thin wrappers over the same core pure
functions. There is no logic in the CLI. Feature parity is structural.

```ts
import { initRoot, newBusiness, writeMemory } from "bizagent";

const r = initRoot({ root: "./acme" });
newBusiness({ root: r.root, slug: "webstore", line: "commerce" });
writeMemory({ root: r.root, slug: "webstore", body: "GMV excludes cancelled orders" });
```

is exactly equivalent to:

```sh
biz init ./acme
biz new webstore --line commerce
biz mem add webstore "GMV excludes cancelled orders"
```

## Directory layout = the cross-runtime contract

Both runtimes `cd` into the same business directory and read the same files. A root holds
product lines (real directories); a line holds its knowledge layer, its modules, and its
businesses. Business slugs are globally unique; modules never cross lines.

```
acme/
├── bizagent.config.json
├── prompts/                      # optional: root-level overrides (worklog.custom.md / fence.custom.md)
├── knowledge/
│   └── common/                   # common layer (curator, shared across lines)
└── lines/
    └── commerce/                 # a product line (biz line new, or lazily created)
        ├── knowledge/            # line layer (curator)
        ├── modules/              # the line's shared modules (code + CLAUDE.md)
        └── businesses/
            └── webstore/
                ├── business.json         # name, slug, line, domain, modules
                ├── CLAUDE.md             # minimal pointer — real context is injected at launch
                ├── .claude/settings.json # hook wiring (UserPromptSubmit=inject / PreToolUse=guard / Stop=stop)
                ├── knowledge/
                │   ├── business/         # business layer (this business)
                │   ├── common   -> root knowledge/common
                │   └── commerce -> ../../knowledge
                ├── memory/               # business-memory records (frontmatter)
                └── .bizagent/deliverables/<runId>/worklog.md   # session: worklog + artifacts
```

The block protocol (`fence`), business memory, memory rules, past sessions, and the
worklog instruction are **not** files in the business — `biz run` assembles them into the
system prompt it injects (see `biz context <slug>` to preview). The only editable sources
are `memory/` records, `knowledge/`, and optional `*.custom.md` overrides.

The four memory layers map to writability and to disk:

| Layer | Who writes | On disk |
|---|---|---|
| common | curator | root `knowledge/common`, symlinked into each business |
| domain (line) | curator | `lines/<line>/knowledge/`, symlinked into the line's businesses |
| business | agent + human | business `memory/` + `knowledge/business/` |
| session | agent (append) | business `.bizagent/deliverables/<runId>/worklog.md` |

## Status (v0)

Implemented and verified: `init`, `line new/list`, `new`, `setup`, `module new/list`, `link`, `mem add/list`,
`context`, filesystem Store, symlinked shared layers, module links, `biz run`, `biz web`,
Agent SDK wiring, Remote sharing, and the **hook layer**:

- `biz hook guard` (PreToolUse memory write governance)
- `biz hook inject` (UserPromptSubmit cross-session / cross-user updates)
- `biz hook stop` (Stop-time worklog enforcement + indexing)
- `biz hook promote` (optional distillation of worklog `## Conclusions` → business memory)

Memory's active read/write face uses the agent's built-in file tools over `memory/`
(not MCP). MCP is deferred until it earns its keep — smart retrieval beyond grep, or
external agents consuming memory without this runtime.

Design doc (kept in sync with the code): [`docs/design.zh-CN.md`](docs/design.zh-CN.md).

## Install the `biz` command

```sh
npm install
npm run build       # bundles dist/biz.mjs (bin) + dist/index.mjs (lib)
npm link            # puts `biz` on your PATH
biz                 # help
```

Then use it anywhere:

```sh
biz init ./acme
cd acme
biz new webstore --line commerce         # the commerce line is created lazily
biz setup webstore                       # guided setup, in conversation
biz mem add webstore "GMV excludes cancelled orders" --confidence 0.9
biz mem list webstore

cd lines/commerce/businesses/webstore && biz   # bare `biz` in a business launches the agent
# or from anywhere in the root:  biz run webstore [-- <agent args>]
```

`biz run` re-materializes the minimal CLAUDE.md, assembles the full working context with
`buildSystemPrompt`, then spawns the agent (claude by default; `--agent <name>` or
`CLAUDE_PATH`/`BIZ_AGENT_BIN` to override) with cwd = the business. It
inherits CLAUDE.md and `.claude/settings.json`; the materialized hooks call bare
`biz hook guard|inject|stop`, which work once `biz` is on PATH. Use `biz hook promote`
manually when you want to distill completed worklog conclusions into business memory.

## Dev & test

```sh
npm test            # automated suite (node:test, isolated tmp roots)
npm run typecheck   # tsc --noEmit
npm run sandbox     # build examples/sandbox/ to poke at by hand
npm run biz -- ...  # run the CLI from live source (tsx, no rebuild)
```

After editing source, `npm run build` to refresh the linked `biz` (or use `npm run biz`
for live source). `npm run sandbox` then `cd examples/sandbox/lines/commerce/businesses/webstore && claude`
verifies the hooks fire under the real CLI runtime.
