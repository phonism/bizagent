# BizAgent

Organizational learning for long-running agents on [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

**Languages**: [English](./README.md) | [中文](./README.zh-CN.md)

BizAgent is a DSH plugin. DSH runs the agent; BizAgent helps agents and the organization
around them keep what they learn:

- **Agent Homes**: a stable identity for each long-running agent, separate from any single
  Session or Workspace.
- **Evidence-backed memory**: experience is saved as memory, insight, knowledge, or method,
  each linked to the events it came from. New lessons start as candidates and become active
  only after review.
- **Governed sharing**: one agent can propose a lesson to another agent's Home, but only the
  target's owner can accept it.

## Status

BizAgent is preparing its 1.0 release. The current published code is the
`0.1.0-alpha.2` local single-user alpha. Interfaces and storage formats may still change
before 1.0.

## Getting started

The plugin lives in [`packages/dsh`](./packages/dsh/README.md). See the
[quick start](./packages/dsh/docs/quickstart.md) to build it and install it into DSH.

```sh
cd packages/dsh
npm ci
npm test
```

## Repository history

Earlier versions of this repository also contained a Claude Code / Agent SDK runtime
(`packages/bizagent`). It is no longer developed here; DSH is the only supported runtime.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
