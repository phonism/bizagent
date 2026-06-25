# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Pre-1.0, minor versions may break APIs.

## [Unreleased]

### Added

- **Business-scoped memory**: root/line/business scaffolding (`biz init` / `biz line new` / `biz new`), layered
  memory (common / domain / business) with frontmatter records, write governance enforced
  through hooks, and `promote` distillation from worklogs.
- **Worklog protocol**: one session = one worklog under `.bizagent/deliverables/<runId>/`,
  Stop-hook enforcement, a shared index, and per-turn cross-session delta injection.
- **Dual runtime, one core**: the CLI (`biz run`) and the Agent SDK
  (`buildSdkOptions` + `SessionManager`) call the same governance decisions and assemble the
  same launch context.
- **SessionManager**: multi-turn streaming sessions, resume/fork, background jobs
  (`JobRegistry` + `expect_result`), source-tagged injection (`formatInbound`), usage capture,
  and a session registry that converges reconnects and wakeups onto one live query.
- **Scheduling (wakeups)**: the `defer_continue` tool, pure tick decisions
  (`clampDelay` / `chainExhausted` / `dueWakeups`), the `SchedulerStore` SPI, and a reference
  JSONL store + 60s tick in `biz web`. Recurring/cron "subscriptions" are deliberately left to
  the host (an application concern built from this primitive), not shipped as a contract.
- **Web platform**: `biz web` (framework-agnostic `Request → Response` handler + SSE), the
  headless browser client (`bizagent/client`: `createBizClient` + pure `reduceSession`),
  and a read-only live viewer for TUI runs.
- **Requirements**: a multi-session task container built for CONTEXT, not ticketing. A
  requirement is a directory (`requirements/<req>/`) whose `requirement.md` is the living
  state document shared by every session on it; runs link via a machine-written `.req`
  marker, the reverse direction is derived. Sessions launched under a requirement
  (`biz run --req`, `start({req})`, `/api/start?req=`) get the state doc + recent sibling
  worklogs injected at launch, and module dev branches become `req/<req-id>` so later
  sessions continue the same branch.
- **Chat-history replay**: runs persist their transcript path; `runHistory` +
  `GET …/runs/:runId/history` replay a conversation from the Claude Code transcript, and
  `client.resume({ runId })` seeds state with it (deduped against the live stream).
- **Remote sharing**: optional cross-user worklog/memory sync over a 5-method `Remote`
  contract with file / http / module tiers.
- **Hub (server side of remote sharing)**: `/api/businesses/:slug/hub/*` routes in the web
  handler serve the fixed http contract on the platform's live business data (pushed worklogs
  list immediately; pushed memory passes the same write governance), plus a read-only pull
  surface (`hub/manifest` with sha256 + `hub/file`) for a future `biz pull` bootstrap.
  `remote.url` now supports `${SLUG}` interpolation so one config block covers every business.
- **Modules**: shared code components (line-level, never cross lines), linked many-to-many into businesses,
  with a read-master / worktree-develop convention.
- **Hook visibility**: a `hook` SessionEvent (+ `TimelineItem` kind) surfaces a Stop-hook block —
  live via the wrapped SDK hook (`wrapStopHooks`), in replay via the transcript's
  "Stop hook feedback:" meta line — so a UI can show WHY the agent kept going after it seemed
  done instead of an unprompted continuation.
- **Skills (read-only)**: root-level Claude Code skill packages (`<root>/skills/<name>/SKILL.md`),
  linked into every business via one `.claude/skills` symlink (created at `biz new` and backfilled
  at session launch) so both runtimes discover them. Read-only surface by design — files are the
  SOT: `biz skills`, `GET /api/skills[/:id[/file]]`, client `listSkills`/`skillDetail`/`skillFile`.

[Unreleased]: https://github.com/phonism/bizagent/commits/main
