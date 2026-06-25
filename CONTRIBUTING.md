# Contributing

Thanks for your interest in BizAgent. The library lives in `packages/bizagent`; everything
below happens in that directory unless noted.

## Setup

```bash
cd packages/bizagent
npm install
npm test            # node:test suite, no network, no agent spawn
npm run typecheck   # tsc --noEmit
npm run build       # esbuild -> dist/ (CLI bin + library + browser client)
```

Tests never call a model and never require the Agent SDK to be installed — keep it that way.
Anything that needs a real agent run is verified manually with a throwaway smoke script and
deleted afterwards.

## Design rules

These are the conventions the codebase is built around; PRs that break them will be asked
to rework:

- **The harness holds no state.** Session content lives in Claude Code's transcripts, business
  state lives in the host app's DB behind a narrow SPI (e.g. `SchedulerStore`), and bizagent
  itself ships pure logic + contracts only — no bundled database, no resident timer.
- **An SPI only exists if bizagent has a pure function consuming its data.** Pure pass-throughs
  don't get an interface; hosts inject tools via `makeTools` instead.
- **CLI ≡ SDK.** Both runtimes call the same decision functions (`hooks.ts`, `governance.ts`).
  A capability added to one path needs a story for the other (or an explicit note that it is
  host-side only).
- **All model-facing prose lives in `prompts/*.md`**, never inline in TypeScript. Code loads
  and interpolates; users override via `*.custom.md`.
- **`fsutil.ts` is the only module that imports `node:fs`.** Every disk touch goes through it.
- **Degrade, don't crash** when reading surfaces we don't own (Claude Code's transcript JSONL,
  remote hubs): skip bad lines, time-box network calls, fall back to empty.
- **Code, comments, and CLI output are English.** Design docs may be Chinese
  (`docs/design.zh-CN.md` is kept in sync with the code).

## Pull requests

- Keep changes small and focused; include tests for new pure logic.
- `npm test && npm run typecheck && npm run build` must pass.
- Update `CHANGELOG.md` under `[Unreleased]` for anything user-visible.
