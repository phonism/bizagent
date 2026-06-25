// Workspace snapshot — a git time machine for the root's file SoT, built in because files ARE
// the database here: knowledge, requirement docs, worklogs, memory all live as plain files that
// agents edit with full write access. One bad Write/rm in one turn can silently destroy months
// of accumulated knowledge; a per-turn commit makes every change attributable (`git log -- file`
// names the session) and surgically reversible (`git checkout <sha> -- file`).
//
// Shape: the git dir lives OUTSIDE the root (XDG state dir by default) and the root itself
// stays pristine — no .git, no .gitignore. Agents working inside their workspaces can neither
// see nor damage the history; nested git repos vendored into workspaces (module code/) are
// recorded as gitlink pointers, never absorbed. Exclude patterns live in $GIT_DIR/info/exclude.
//
// Trigger: stopHook calls snapshotOnStop after every finished turn (both runtimes — the SDK
// in-process callback and the `biz hook stop` CLI subprocess). Concurrency is therefore both
// in-process (many sessions, one host) and cross-process (CLI hooks): an in-process chain
// serializes the former, an atomic lockfile (fsutil.claim) the latter. Whoever commits first
// takes every dirty file with it; later stops find a clean tree and no-op — natural coalescing,
// with attribution preserved by file paths regardless of which commit a change landed in.
//
// Failure policy: NOTHING here may break a conversation. Every entry point catches everything;
// a machine without git logs one warning and disables itself for the process lifetime.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootConfigPath } from "./paths";
import { exists, mkdirp, readFileOr, writeFile, claim } from "./fsutil";

const run = promisify(execFile);

export interface SnapshotConfig {
  enabled: boolean;
  /** Repo metadata location — outside the root so agents can't see or touch it. */
  gitDir: string;
  /** info/exclude patterns (gitignore syntax). Defaults + root config + env extras. */
  exclude: string[];
}

// Caches and DBs are runtime state, not SoT — and DB files mutate every tick, which would
// bloat history with meaningless binary deltas. Hosts add their own patterns via config/env.
const DEFAULT_EXCLUDE = ["node_modules/", ".DS_Store", "*.db", "*.db-wal", "*.db-shm", "*.sqlite", "*.sqlite-wal", "*.sqlite-shm"];

const GIT_TIMEOUT_MS = 60_000;
const LOCK_WAIT_MS = 8_000; // give up (skip this snapshot) rather than stall a hook
const LOCK_STALE_MS = 30_000; // a holder gone this long crashed mid-commit; steal the lock

function debug(msg: string, e?: unknown): void {
  if (process.env.BIZ_DEBUG) console.error(`[biz snapshot] ${msg}`, e instanceof Error ? e.message : (e ?? ""));
}

/** Resolve the effective config: defaults ← root config `snapshot` block ← env overrides.
 *  Env wins so a platform can configure snapshots in code/deploy scripts without writing into
 *  the (data) root: BIZ_SNAPSHOT=0 disables, BIZ_SNAPSHOT_GIT_DIR relocates the repo,
 *  BIZ_SNAPSHOT_EXCLUDE appends comma-separated patterns. */
export function resolveSnapshotConfig(root: string): SnapshotConfig {
  const abs = path.resolve(root);
  let block: { enabled?: boolean; gitDir?: string; exclude?: string[] } = {};
  try {
    block = (JSON.parse(readFileOr(rootConfigPath(abs)) || "{}") as { snapshot?: typeof block }).snapshot ?? {};
  } catch {
    /* malformed config reads as defaults */
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  // One repo per root path (hashed — multiple roots on one machine must not share history).
  const defaultGitDir = path.join(stateHome, "bizagent", "snap", `${crypto.createHash("sha256").update(abs).digest("hex").slice(0, 12)}.git`);
  const envExtra = (process.env.BIZ_SNAPSHOT_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    enabled: process.env.BIZ_SNAPSHOT === "0" ? false : (block.enabled ?? true),
    gitDir: process.env.BIZ_SNAPSHOT_GIT_DIR || block.gitDir || defaultGitDir,
    exclude: [...DEFAULT_EXCLUDE, ...(block.exclude ?? []), ...envExtra],
  };
}

// `git --version` probed once per process; a git-less machine downgrades to a single warning.
let gitOk: Promise<boolean> | undefined;
function gitAvailable(): Promise<boolean> {
  gitOk ??= run("git", ["--version"], { timeout: GIT_TIMEOUT_MS }).then(
    () => true,
    () => {
      console.error("[biz snapshot] git not found — workspace snapshots disabled (history/rollback unavailable)");
      return false;
    },
  );
  return gitOk;
}

function git(cfg: SnapshotConfig, root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  // Explicit GIT_DIR + GIT_WORK_TREE is the whole linkage — nothing persisted in the root.
  // Strip inherited index/object overrides so a hook fired from inside someone else's git
  // operation can't cross-wire our repo.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: cfg.gitDir, GIT_WORK_TREE: root };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  return run("git", args, { cwd: root, env, timeout: GIT_TIMEOUT_MS });
}

async function ensureRepo(cfg: SnapshotConfig, root: string): Promise<void> {
  if (!exists(path.join(cfg.gitDir, "HEAD"))) {
    mkdirp(cfg.gitDir);
    await git(cfg, root, ["init", "-q"]);
  }
  // Rewritten every time (cheap) so config/env pattern changes apply without a migration step.
  writeFile(path.join(cfg.gitDir, "info", "exclude"), cfg.exclude.join("\n") + "\n");
}

/** Acquire the cross-process lock (atomic create-if-absent), waiting briefly; steals locks
 *  whose holder died mid-commit. Returns false to mean "skip this snapshot" — the next stop
 *  event will pick up whatever this one would have committed. */
async function acquireLock(lockPath: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (claim(lockPath, `${process.pid} ${new Date().toISOString()}`)) return true;
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockPath, { force: true });
    } catch {
      /* vanished between claim and stat — loop and re-claim */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function commitAll(cfg: SnapshotConfig, root: string, message: string): Promise<void> {
  await ensureRepo(cfg, root);
  await git(cfg, root, ["-c", "advice.addEmbeddedRepo=false", "add", "-A"]);
  // Clean tree (an earlier overlapping snapshot already took our changes) → no empty commits.
  const staged = await git(cfg, root, ["diff", "--cached", "--quiet"]).then(
    () => false,
    (e) => {
      if ((e as { code?: number }).code === 1) return true;
      throw e;
    },
  );
  if (!staged) return;
  await git(cfg, root, [
    "-c", "user.name=bizagent",
    "-c", "user.email=snapshot@bizagent.local",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", message,
  ]);
}

// In-process serialization, one chain per git dir (a host process runs many sessions; their
// stop hooks must queue, not race). The lockfile alone would work but would burn the wait
// budget on ordinary same-process bursts.
const chains = new Map<string, Promise<void>>();

/** Snapshot the root after a finished turn. Never throws, never blocks beyond the lock wait. */
export async function snapshotOnStop(o: { root: string; slug?: string; runId?: string }): Promise<void> {
  try {
    const cfg = resolveSnapshotConfig(o.root);
    if (!cfg.enabled || !(await gitAvailable())) return;
    const root = path.resolve(o.root);
    const message = `snap: ${o.slug ?? "?"}${o.runId ? ` (${o.runId})` : ""}`;
    const next = (chains.get(cfg.gitDir) ?? Promise.resolve()).then(async () => {
      const lockPath = cfg.gitDir + ".lock";
      if (!(await acquireLock(lockPath))) {
        debug("lock busy — skipped (next stop will cover it)");
        return;
      }
      try {
        await commitAll(cfg, root, message);
      } finally {
        fs.rmSync(lockPath, { force: true });
      }
    });
    // Keep the chain alive past failures; report them only through debug.
    chains.set(cfg.gitDir, next.catch((e) => debug("snapshot failed", e)));
    await next;
  } catch (e) {
    debug("snapshot failed", e);
  }
}
