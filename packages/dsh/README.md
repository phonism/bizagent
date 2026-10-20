# @bizagent/dsh

Long-term memory and teamwork for agents on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

BizAgent adds lasting Homes, evidence-backed learning, governed sharing, Inbox messages, formal
Work, and Projects with human acceptance. DSH runs the models, tools, and sessions.

## Start here

- **Install:** [English quick start](docs/quickstart.md) / [中文安装指南](docs/quickstart.zh-CN.md).
- **Already installed:** [use BizAgent](docs/quickstart.md#use-bizagent) / [中文用户指南](docs/user-guide.zh-CN.md).
- **Look up a feature:** [documentation map](docs/README.md), [concepts](docs/concepts.md),
  [configuration](docs/configuration.md), [59 Agent tools](docs/tools.md).
- **Check versions and evidence:** [verification and compatibility](docs/verification.md).

Start with one saved rule in your personal Home. An organization is optional for that first step;
existing organizations can use separate practice Homes without resetting data.

## In DSH Web

| Surface | Use |
| --- | --- |
| BizAgent organization panel | Organize Homes; inspect learning; review proposals and Projects |
| Session Home button | Check which Home owns the conversation and open its learning |
| Work & learning tab | Inspect this session's Work, worker/result links, and related Projects |
| Turn receipts | Open the successful records saved in a completed turn |
| Composer `@` and Frame bar | Load shared Home context in the current session |
| My Inbox | Read agent messages and reply to the originating session |

Formal Work starts in an independent worker when both Homes share an owner. A Frame provides
read-only context in the current session. Only a person can accept a submitted Project result.

## Package entry points

| Import | Use |
| --- | --- |
| `@bizagent/dsh` | Core plugin and types (`name`, `inject`, `Config`, `apply`) |
| `@bizagent/dsh/ui-host` | Authenticated panel HTTP routes |
| `@bizagent/dsh/local-human-host` | Local owner's review and Inbox routes |
| `@bizagent/dsh/client` | Browser bundle loaded by DSH Web |
| `@bizagent/dsh/host` | Building blocks for hosts with their own authentication |

The package also installs `bizagent` for Home files: `init`, `home create|list`, `doctor`,
`reindex`, and `archive export|verify|import`. Run `bizagent --help` for usage.

## Development

```sh
npm ci
npm test                 # builds and runs automated tests
npm run typecheck
npm run examples         # service scenarios without a model
npm run smoke:local-human
npm run smoke:session-ui
npm run pack:check
```

Runtime smokes use isolated profiles and a local fake model. See [verification](docs/verification.md)
for the distinction between service tests, runtime integration, and real-model browser acceptance.
For user-visible changes, update the [changelog](CHANGELOG.md).

[MIT](LICENSE)
