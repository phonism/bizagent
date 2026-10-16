# BizAgent

Long-term memory and teamwork for agents on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

**Languages**: [English](./README.md) | [中文](./README.zh-CN.md)

BizAgent is a DSH plugin. DSH runs the agents; BizAgent gives each long-running agent a Home that
outlives any single chat, and lets a small team of agents learn and work together:

- **Homes.** Each agent keeps its identity, memories, knowledge, and methods in a Home: plain
  Markdown and YAML files you can read. Every new chat with that agent starts from what its Home
  already knows.
- **Lessons with evidence.** When you correct an agent or teach it a rule, it saves the lesson with
  a link back to the conversation it came from. Lessons it still needs to check stay candidates
  until it confirms them.
- **Sharing with consent.** An agent can propose a lesson to another agent's Home, but only that
  Home's owner can accept it.
- **Work between agents.** Agents send each other Inbox messages, hand off formal Work with one
  accountable result, and run Projects whose result a person accepts.

![The BizAgent panel in DSH, showing the Sample Shop team and its five-minute guide](./assets/screenshots/sample-team.png)

## Quick start

You need Node.js 22.19+ or 24+, [pnpm](https://pnpm.io), and a model: a DeepSeek API key, or any
OpenAI-compatible endpoint.

```sh
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm

git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci && npm run build && npm pack
dsh plugin --profile web add "$PWD"/bizagent-dsh-*.tgz

export DEEPSEEK_API_KEY=sk-...   # or add another model in DSH Settings
dsh --profile web
```

DSH opens your browser. Click **BizAgent organization** at the bottom left, then
**Create sample team**. The sample team comes with a small orders file and a five-minute guide:
teach the analyst a rule, start a Project, let the analyst do the work in its own session, accept
the result, and share the rule with the team.

The [quick start guide](./packages/dsh/docs/quickstart.md) covers other models, your own
organization, and troubleshooting.

## The sample team, step by step

These screenshots come from one run of the guide with an open model (Qwen3.8 27B).

**1. Teach a rule.** Tell the data analyst that GMV excludes cancelled and refunded orders. It
saves the rule in its Home, linked to the conversation it came from, and every later chat with the
analyst starts with it.

![The data analyst's Learning page with the saved GMV rule and its evidence](./assets/screenshots/learning.png)

**2–3. Run a Project and accept the result.** The growth lead starts a Project. Its chat hands
formal Work to the analyst, who computes GMV from `orders.csv` in its own session; the lead checks
the number and submits it. Only you can accept it.

![A Project result waiting for acceptance: GMV 400.50 with its evidence](./assets/screenshots/project-review.png)

**4. Share with the team.** The analyst proposes the rule to the Sample Shop Home. It changes
nothing there until the Home's owner accepts it.

![A proposal from the data analyst waiting in the Sample Shop Home's inbox](./assets/screenshots/proposal.png)

## Try it without a model

The Learning Lab runs three scripted cases against the real BizAgent services, with temporary data
and no model or DSH process:

```sh
cd packages/dsh
npm ci
npm run examples
```

## Documentation

- [Quick start](./packages/dsh/docs/quickstart.md)
- [Concepts](./packages/dsh/docs/concepts.md): Homes, memory, proposals, Inbox, Work, Projects
- [Configuration](./packages/dsh/docs/configuration.md)
- [Architecture and trust model](./packages/dsh/docs/architecture.md)
- [Agent tools](./packages/dsh/docs/tools.md) (generated from the code)
- [Learning Lab](./packages/dsh/examples/README.md)
- [Changelog](./packages/dsh/CHANGELOG.md)

## Status

BizAgent 1.0 targets DSH `0.2.0-rc.2`, the current DSH release (DSH has no stable release yet).
It runs as a single-person local setup: one person owns the organization and reviews its results
in the DSH web app. Releases follow semantic versioning: within 1.x, the public API
(`@bizagent/dsh` and `@bizagent/dsh/host`), the Agent tool names, and the files BizAgent writes
do not change incompatibly.

Earlier versions of this repository also contained a Claude Code / Agent SDK runtime. It is no
longer developed here; DSH is the only supported runtime.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security reports: [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
