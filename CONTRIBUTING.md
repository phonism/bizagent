# Contributing to BizAgent

Contributions to code, documentation, examples, and reproducible bug reports are welcome.
Issues and documentation may be written in English or Chinese.

## Development setup

The plugin lives in `packages/dsh`. Use the Node version range declared in its
`package.json`:

```sh
cd packages/dsh
npm ci
npm run typecheck
npm test
npm run smoke
npm run pack:check
```

Runtime smokes start isolated DSH profiles against a local fake model. They need the DSH CLI the
package targets on `PATH`:

```sh
npm install --global @deepseek-ai/dsh@0.2.0-rc.2
npm run smoke:plugin-add   # install the packed tarball with `dsh plugin add`
npm run smoke:local-human  # web profile: Principals, Project Main, Work, human acceptance
npm run smoke:agent && npm run smoke:work && npm run smoke:project && npm run smoke:learning
```

After changing an Agent tool, regenerate the [tool reference](packages/dsh/docs/tools.md) with
`npm run docs:tools`; CI fails when it is out of date.

`npm test` builds the package before testing. Automated tests must not call paid models or
depend on private infrastructure. Tests that open local HTTP listeners may need a normal
development environment; report `listen EPERM` as an environment limitation rather than
silently skipping failures.

For documentation-only changes, run from the repository root:

```sh
node scripts/check-docs.mjs
git diff --check
```

The link checker validates local inline Markdown file targets; it does not check external
URLs or heading anchors.

## Design rules

- Reuse the DSH Agent Loop, Session, storageDomain, and Web host.
- Keep learning rules in the service/store layers; the React client consumes a bounded API.
- Same-Home writes stay in the current Home; cross-Home writes require a target-owned proposal.
- Candidates stay out of default retrieval until explicit publication. Preserve asset status on
  revise and check the reviewed revision when publishing.
- Treat Home files, the DSH ledger, and Session evidence as separate persistence surfaces.
  Explain recovery behavior whenever a change spans more than one surface.
- Add failure-path coverage for ownership, stale revisions, or recovery changes.
- Keep model-independent decisions testable without running a model.
- Distinguish current behavior from proposed behavior in docs and PRs.
- Keep code, code comments, and CLI output in English. User-facing UI uses locale strings.
- Never include credentials, real conversation transcripts, or machine-specific runtime data
  in an example, test fixture, or bug report.

## Issues and pull requests

Search existing [issues](https://github.com/phonism/bizagent/issues) before filing a new one.
A useful bug report includes the version or commit, minimal steps, expected and actual results,
and sanitized logs. For a proposal, explain the user's task, the current workaround, the
ownership/persistence impact, and how success could be checked.

Keep each PR focused. Describe the trigger and resulting behavior, relevant validation, and
remaining limitations. Update `packages/dsh/CHANGELOG.md` for user-visible changes.
