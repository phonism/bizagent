# Verification and compatibility

[Documentation](README.md) · [中文上手](quickstart.zh-CN.md)

This page separates development baselines, manual acceptance, and reproducible checks.

## Version baselines

| Baseline | Version | Evidence |
| --- | --- | --- |
| Package | `@bizagent/dsh` 1.0.0 | Package manifest and [release notes](../CHANGELOG.md). |
| Installation / development / CI runtime | DSH `0.2.1-rc.2` | Installation guide, dev dependencies, and runtime CI use the same version. DSH peers declare `^0.2.1-rc.2`. |
| Manual browser acceptance, 2026-10-20 | DSH `0.2.1-rc.2` | The 1.0.0 implementation used in DSH Web with DeepSeek-V4.1-Flash / High. |

Keep an existing working installation unless an upgrade is needed; inspect DSH activation errors
when using a different version. Other DSH versions need their own compatibility checks.

Within BizAgent 1.x, semantic versioning covers public entry points (`@bizagent/dsh` and
`@bizagent/dsh/host`), Agent tool names, and persisted file formats. Internal `lib/` modules are
not a public API; DSH runtime compatibility still needs its own verification.

## What was checked

The 1.0.0 implementation passed **179 automated tests** and a real-model browser exercise with
**11 checks**:

| Area | Observed behavior |
| --- | --- |
| Selected `@Agent` | A logged Frame snapshot reached the model before tool execution. |
| Save learning | The rule appeared with its body, source, and status. |
| Recall in another session | The separate Project Main read the saved rule. |
| Independent formal Work | Another Home's worker accepted and completed the Work. |
| Result navigation | The result expanded; worker and requester sessions could be opened. |
| Human Project acceptance | A browser review changed the Project to `accepted`. |
| Artifact download | Downloaded bytes and SHA-256 matched the submitted snapshot. |
| Human Inbox reply | Replying in My Inbox resumed the original Project session. |
| Home creation dialog | Dialog semantics and initial focus were checked after the fix. |
| Markdown result | The Work result rendered an actual table. |
| Worker workspace | The worker appeared under its Home workspace without a new execution turn. |

The fictional four-order case is reproducible through the [user guide](user-guide.zh-CN.md).
Its expected GMV is **300**. The built-in Sample Shop's different dataset gives **400.50**.
The manual exercise also checked existing data, configuration, and process preservation.
Private transcripts, runtime identifiers, and credentials are intentionally not part of public examples.

## Repeat the checks

From the repository root, check documentation:

```sh
node scripts/check-docs.mjs
git diff --check
```

From `packages/dsh`, check implementation and isolated runtime integration:

```sh
npm ci
npm test
npm run smoke:local-human
npm run smoke:session-ui
```

The smoke scripts start real isolated DSH profiles but use a deterministic local model. They
test integration, not how a real model chooses tools. The Learning Lab checks service behavior
without starting DSH. The [user guide](user-guide.zh-CN.md) supplies the real-model manual route.

The browser run covered one complete delivery flow and the listed UI checks. Long-term stability,
every failure/recovery path, other model routes, and multi-user hosting were not established by it.
