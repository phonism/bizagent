// runtime-cli adapter — `biz run` launches the agent binary in a
// business directory. The business dir is the contract: the agent inherits its
// CLAUDE.md (baseline memory) and .claude/settings.json (hooks). The worklog instruction
// is injected at launch via --append-system-prompt — not left as an editable file.
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { businessDir, deliverablesDir } from "./paths";
import { mkdirp, exists, findOnPath } from "./fsutil";
import { assemble } from "./memory";
import { buildSystemPrompt } from "./context";
import { linkedModuleDirs } from "./module";
import { ensureKnowledgeLinks, knowledgeLayerDirs } from "./knowledge";
import { ensureRequirement, recordRunReq } from "./requirement";
import { ensureSkillsLink } from "./skill";
import { inUtc8 } from "./time";

/** Resolve the agent executable. Env overrides let you point at a custom binary
 *  (and make `biz run` testable without a real agent installed). */
export function resolveAgentBin(agent: string): string {
  if (process.env.BIZ_AGENT_BIN) return process.env.BIZ_AGENT_BIN;
  if (agent === "claude") return process.env.CLAUDE_PATH || "claude";
  return agent; // treat anything else as a binary name / path
}

/**
 * Resolve the ABSOLUTE path to the Claude Code binary for the Agent SDK. The SDK must be handed
 * a real executable — a bare name or a shell alias makes it spawn the wrong thing (EBADMACHO).
 * Layered so it works across machines, with an env escape hatch for anything unusual:
 *   1. explicit override  (BIZ_AGENT_BIN / CLAUDE_PATH) — always wins
 *   2. on $PATH           (covers normal installs run from a shell)
 *   3. known install dirs (PATH can be stripped under a service/daemon launch)
 * Returns undefined if not found — the caller should tell the user to set CLAUDE_PATH.
 */
export function resolveClaudeExecutable(): string | undefined {
  const override = process.env.BIZ_AGENT_BIN || process.env.CLAUDE_PATH;
  if (override) return override;

  const onPath = findOnPath("claude");
  if (onPath) return onPath;

  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", "claude"), // native installer
    path.join(home, ".claude", "local", "claude"), // alt native location
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((p) => exists(p));
}

/** A run id = this session's worklog folder name (1 session = 1 task = 1 worklog).
 *  Timestamp (readable + sortable) + a short random suffix (so two runs in the same
 *  second can't collide). e.g. 20260604-112552-a3f29c1b */
export function makeRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const t = inUtc8(now); // UTC+8 wall clock regardless of host timezone
  const ts =
    `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `-${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

export interface RunAgentOptions {
  root: string;
  slug: string;
  /** "claude" (default) or a binary name/path. Falls back to $BIZ_AGENT. */
  agent?: string;
  /** Extra args passed through to the agent binary. */
  args?: string[];
  /** Re-materialize CLAUDE.md before launch (default true) so memory is fresh. */
  assemble?: boolean;
  /** Override the session/worklog id (default: timestamp). */
  runId?: string;
  /** An opening task message. Passed as the agent's positional prompt so the session starts
   *  already working on it — still interactive, so the agent can pause to ask the user.
   *  Used by `biz setup` for the guided business setup. */
  initialPrompt?: string;
  /** Run this session under a requirement (multi-session task). Lazily creates
   *  `requirements/<req>/` + its state doc, links the run (`.req` marker), and injects the
   *  requirement's context (state doc + sibling worklogs) at launch. */
  req?: string;
  /** Open a browser live-view of the conversation (renders ```chart / ```mermaid / tables) by
   *  starting a local viewer server alongside the TUI. The terminal still drives Claude Code. */
  view?: boolean;
  /** Port for the --view server (default 4319, kept off the platform's default 4317). */
  viewPort?: number;
}

/** Launch the agent in the business (blocking, stdio inherited). Returns its exit code. */
export function runAgent(o: RunAgentOptions): number {
  if (o.assemble !== false) assemble({ root: o.root, slug: o.slug });

  // Mint this session's worklog id and pre-create its folder.
  const runId = o.runId ?? makeRunId();
  mkdirp(path.join(deliverablesDir(o.root, o.slug), runId));
  ensureSkillsLink(o.root, o.slug); // backfill: businesses created before skills existed wire up here
  ensureKnowledgeLinks(o.root, o.slug); // backfill: module workspaces (and pre-knowledge businesses) get their knowledge/ mounts here

  // Under a requirement: lazily create it and link this run before the context is built,
  // so the launch prompt below already carries the requirement's state doc.
  if (o.req) {
    ensureRequirement({ root: o.root, slug: o.slug, req: o.req });
    recordRunReq({ root: o.root, slug: o.slug, runId, req: o.req });
  }

  // The full working context (business memory, block protocol, memory rules, past
  // sessions, worklog) is injected here — not left in the editable CLAUDE.md.
  const systemPrompt = buildSystemPrompt({ root: o.root, slug: o.slug, runId, req: o.req });

  const agent = o.agent || process.env.BIZ_AGENT || "claude";
  const bin = resolveAgentBin(agent);
  const dir = businessDir(o.root, o.slug);
  // An initial task prompt is the positional arg, so the agent opens the session already
  // working on it (interactive mode — it can still pause to ask the user). --add-dir mirrors the
  // SDK's additionalDirectories: read access to linked modules + shared knowledge layers through
  // their symlink mounts.
  const addDirs = [...linkedModuleDirs(o.root, o.slug), ...knowledgeLayerDirs(o.root, o.slug)].flatMap((d) => ["--add-dir", d]);
  const args = [...addDirs, "--append-system-prompt", systemPrompt, ...(o.args ?? []), ...(o.initialPrompt ? [o.initialPrompt] : [])];

  process.stderr.write(`bizagent: worklog -> .bizagent/deliverables/${runId}/worklog.md\n`);

  // Optional browser live-view: a sibling server renders this run's fences while you drive the
  // TUI here. It runs in its own process, so the blocking spawnSync below doesn't stall it.
  const viewer = o.view ? startLiveView(o.root, o.slug, runId, o.viewPort) : undefined;

  // BIZ_RUN_ID rides into the agent's env so its Stop hook knows which worklog to check.
  const r = spawnSync(bin, args, {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, BIZ_RUN_ID: runId },
  });
  viewer?.kill();
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      process.stderr.write(
        `x agent binary '${bin}' not found. Install it ` +
          `or override with CLAUDE_PATH / BIZ_AGENT_BIN.\n`,
      );
      return 127;
    }
    throw r.error;
  }
  return r.status ?? 0;
}

/** Start a local viewer server (a sibling `biz web`) and point the browser at this run's live
 *  view. Re-invokes THIS same `biz` (argv[1], with the active loader flags) so it works whether
 *  launched from the built bin or via tsx. Best-effort: any failure just means no live view — it
 *  never blocks the agent run. Returns the child process so the caller can kill it on exit. */
function startLiveView(root: string, slug: string, runId: string, port = 4319): ReturnType<typeof spawn> | undefined {
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1], "web", "--port", String(port), "--host", "127.0.0.1"],
      { cwd: root, stdio: "ignore", env: process.env },
    );
    child.on("error", () => {
      /* ignore — best-effort */
    });
    const url = `http://127.0.0.1:${port}/run/${encodeURIComponent(slug)}/${encodeURIComponent(runId)}`;
    process.stderr.write(`bizagent: live view -> ${url}\n`);
    // Give the server a moment to listen, then try to open a browser. If it fails, the URL above
    // is printed for the user to click.
    setTimeout(() => {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        spawn(opener, [url], { stdio: "ignore", shell: process.platform === "win32" }).on("error", () => {});
      } catch {
        /* ignore */
      }
    }, 800);
    return child;
  } catch {
    return undefined;
  }
}
