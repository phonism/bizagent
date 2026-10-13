# @bizagent/dsh

Long-term memory and teamwork for agents on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

BizAgent gives each long-running DSH agent a **Home**: its identity, memories, knowledge, and
methods, kept as plain files and loaded into every new session. Agents save lessons with links to
the conversations they came from, propose lessons to each other's Homes, send each other mail,
hand off formal Work, and run Projects that a person accepts.

## Install

Requires Node.js 22.19+ or 24+, [pnpm](https://pnpm.io), and DSH `0.2.0-rc.2`.

```sh
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
# from a checkout of https://github.com/phonism/bizagent
cd packages/dsh && npm ci && npm run build && npm pack
dsh plugin --profile web add "$PWD"/bizagent-dsh-*.tgz
dsh --profile web
```

In DSH, open **BizAgent organization** at the bottom left and choose **Create sample team** for a
guided tour. The [quick start](docs/quickstart.md) covers models and troubleshooting.

## What you get

- **Homes** for personal agents, roles, shared capabilities, and the organization itself, as
  Markdown and YAML under your DSH workspace.
- **59 Agent tools** ([reference](docs/tools.md)) to remember, search, and revise assets; read
  other Homes through read-only Frames; propose lessons; send Inbox mail; dispatch and complete
  formal Work; and run Projects.
- **A panel in the DSH web app**: organization map, each Home's learning and Worklogs, Projects
  with human acceptance, proposal review, and your own Inbox.
- **Sessions BizAgent starts on its own**: a worker for handed-off Work, a reader for new mail,
  and optional scheduled learning reviews, each in the right Home.

## Documentation

- [Quick start](docs/quickstart.md)
- [Concepts](docs/concepts.md)
- [Configuration](docs/configuration.md)
- [Architecture and trust model](docs/architecture.md)
- [Agent tools](docs/tools.md)
- [Learning Lab examples](examples/README.md)
- [Changelog](CHANGELOG.md)

## Package entry points

| Import | Use |
| --- | --- |
| `@bizagent/dsh` | The core DSH plugin (`name`, `inject`, `Config`, `apply`) and its types. |
| `@bizagent/dsh/ui-host` | DSH plugin serving the panel's HTTP routes. |
| `@bizagent/dsh/local-human-host` | DSH plugin serving review routes for the local owner. |
| `@bizagent/dsh/client` | The browser bundle DSH Web loads. |
| `@bizagent/dsh/host` | Building blocks for hosts with their own login: review route handlers, notification runners, Home archives. |

The package also installs a `bizagent` command for Home folders: `init`, `home create|list`,
`doctor`, `reindex`, and `archive export|verify|import`. Run `bizagent --help` for usage.

## Development

```sh
npm ci
npm test              # build and unit tests
npm run typecheck
npm run examples      # Learning Lab, no model needed
npm run smoke         # CLI smoke
npm run smoke:plugin-add   # needs a dsh 0.2.0-rc.2 CLI on PATH
```

The `smoke:*` scripts start isolated DSH profiles against a local fake model; see
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

[MIT](LICENSE)
