// The PLATFORM side of remote sharing. remote.ts defines what a local agent calls (the
// Remote interface + httpRemote's fixed REST contract); this module is the matching server
// half, mounted by web.ts under /api/businesses/:slug/hub/*. Per the live-data decision,
// the hub IS the platform business directory — no separate transfer store: a pushed worklog
// lists immediately (listRuns sees worklog.md on disk), a pushed memory record serves the
// platform's own sessions.
//
// It also exposes the read-only FILE surface a future `biz pull` bootstraps from: a manifest
// (path + size + mtime + sha256 over whitelisted subtrees) and a single-file read. Knowledge
// stays one-way by construction — the manifest only lists real files, never the common/line
// symlink layers, so curator content flows platform → local and is never pushed back.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { businessDir, memoryDir, deliverablesDir, worklogIndexPath, transcriptMirrorPath } from "./paths";
import { readFileOr, writeFile, exists, appendLine, claim, listFiles, listDirs } from "./fsutil";
import { readWorklog, readWorklogIndex, validateMemoryWrite } from "./governance";
import { applyTranscriptChunk, type IndexEntry, type Blob } from "./remote";
import { nowIso, toIso } from "./time";

// On-disk facts shared with governance.ts (worklogPath / INDEXED_MARKER there): each run's
// worklog file name, and the marker that tells updateIndex "already indexed — skip". A pushed
// worklog claims the marker so the platform's own Stop hook doesn't re-index it under a
// regenerated line (same runId twice in the index).
const WORKLOG = "worklog.md";
const INDEXED_MARKER = ".indexed";

/** runId / memory id must be a single safe path segment — it becomes a directory/file name. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSegment(kind: string, v: string): void {
  if (!SAFE_SEGMENT.test(v)) throw new Error(`invalid ${kind} "${v}"`);
}

// ─────────────────────────── the httpRemote contract, served ───────────────────────────

/** GET /hub/index — every worklog-index line with its runId, raw (the puller merges lines
 *  verbatim, dedup by runId). Same line anatomy as readWorklogIndex: `- date · desc · runId`. */
export function hubIndex(root: string, slug: string): IndexEntry[] {
  return readFileOr(worklogIndexPath(root, slug))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((line) => {
      const parts = line.slice(2).split(" · ");
      return { runId: parts.length > 1 ? parts[parts.length - 1] : "", line };
    });
}

/** GET /hub/worklog/:runId — one pushed/local worklog body, or null. */
export function hubFetchWorklog(root: string, slug: string, runId: string): string | null {
  assertSegment("runId", runId);
  return readWorklog(root, slug, runId);
}

/** POST /hub/worklog — accept a pushed worklog: body overwrites (latest wins), the index line
 *  is appended once per runId (idempotent re-push), and the run is marked indexed so the
 *  platform's own Stop-hook indexer leaves it alone. */
export function hubPublishWorklog(root: string, slug: string, o: { runId: string; line: string; content: string }): void {
  assertSegment("runId", o.runId);
  const dir = path.join(deliverablesDir(root, slug), o.runId);
  writeFile(path.join(dir, WORKLOG), o.content);
  claim(path.join(dir, INDEXED_MARKER), nowIso() + "\n");
  const have = new Set(readWorklogIndex(root, slug).map((e) => e.runId));
  if (!have.has(o.runId)) appendLine(worklogIndexPath(root, slug), o.line);
}

/** GET /hub/memory — the business's memory records, raw (id = filename sans .md). Pushed
 *  records land in the same dir, so this is automatically the union every spoke pulls. */
export function hubFetchMemory(root: string, slug: string): Blob[] {
  return listFiles(memoryDir(root, slug)).map((f) => ({
    id: path.basename(f, ".md"),
    content: readFileOr(f),
  }));
}

/** POST /hub/memory — accept a pushed memory record into the business's own memory/, after
 *  the SAME governance the write hook enforces (the hub must not be a backdoor). Same id
 *  re-push overwrites: latest wins, matching fileRemote. Throws on a malformed id (caller:
 *  400); returns the governance verdict (caller: 422 when rejected). */
export function hubPublishMemory(root: string, slug: string, o: Blob): { ok: boolean; reason?: string } {
  assertSegment("memory id", o.id);
  const file = path.join(memoryDir(root, slug), `${o.id}.md`);
  const check = validateMemoryWrite({ root, filePath: file, content: o.content });
  if (!check.ok) return check;
  writeFile(file, o.content);
  return { ok: true };
}

/** POST /hub/transcript — accept one chunk of a remote session's Claude Code transcript into
 *  the run's mirror (`.transcript.jsonl`). The web replay/live view reads the mirror where no
 *  local `.transcript-path` exists, so a session running on another machine renders here
 *  read-only (the mirror never comes with a `.session-id`, so it is never resumable). Overlap
 *  is dropped (idempotent re-push); a chunk that would leave a hole is refused with the current
 *  watermark (caller: 409 + { have }) so the pusher resyncs. Deliberately writes NOTHING else:
 *  a run whose worklog hasn't arrived yet stays out of listRuns until it does. */
export function hubPublishTranscript(
  root: string,
  slug: string,
  o: { runId: string; offset: number; content: string },
): { have: number; applied: boolean } {
  assertSegment("runId", o.runId);
  return applyTranscriptChunk(transcriptMirrorPath(root, slug, o.runId), { offset: o.offset, content: o.content });
}

// ─────────────────────────── manifest + file (read-only pull surface) ───────────────────────────

export interface ManifestEntry {
  /** Path relative to the business directory, posix separators. */
  path: string;
  size: number;
  /** mtime as ISO-8601 — a cheap freshness hint; sha256 is the real change detector. */
  mtime: string;
  sha256: string;
}

/** The pull whitelist. A path is served only if it falls in one of these subtrees; everything
 *  else in the business dir (run markers, caches, .claude/, module symlinks) stays private. */
function allowedHubPath(rel: string): boolean {
  if (rel === "business.json") return true;
  if (rel === ".bizagent/worklog-index.md") return true;
  if (rel.startsWith("memory/")) return true;
  if (rel.startsWith("knowledge/business/")) return true;
  if (rel.startsWith("requirements/")) return true;
  return /^\.bizagent\/deliverables\/[^/]+\/worklog\.md$/.test(rel);
}

/** Walk a real directory tree, NEVER following symlinks — this is what keeps the shared
 *  knowledge layers (common/line, symlinked into every business) out of the manifest. */
function walkFiles(dir: string, out: string[] = []): string[] {
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function entryFor(bizDir: string, abs: string): ManifestEntry {
  const st = fs.statSync(abs);
  const buf = fs.readFileSync(abs);
  return {
    path: path.relative(bizDir, abs).split(path.sep).join("/"),
    size: st.size,
    mtime: toIso(st.mtime),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}

/** GET /hub/manifest — every pullable file with size/mtime/sha256, so a local `biz pull` can
 *  fetch only what changed. Covers meta, memory, the business's OWN knowledge, requirements,
 *  the worklog index and each run's worklog — exactly the allowedHubPath whitelist. */
export function hubManifest(root: string, slug: string): ManifestEntry[] {
  const biz = businessDir(root, slug);
  const files: string[] = [];

  const meta = path.join(biz, "business.json");
  if (exists(meta)) files.push(meta);
  const idx = worklogIndexPath(root, slug);
  if (exists(idx)) files.push(idx);
  walkFiles(memoryDir(root, slug), files);
  walkFiles(path.join(biz, "knowledge", "business"), files);
  walkFiles(path.join(biz, "requirements"), files);
  for (const runDir of listDirs(deliverablesDir(root, slug))) {
    const wl = path.join(runDir, WORKLOG);
    if (exists(wl)) files.push(wl);
  }

  return files.map((f) => entryFor(biz, f));
}

/** GET /hub/file?path= — one whitelisted file, raw. Returns null when absent; throws on a
 *  path outside the whitelist, a traversal attempt, or anything whose real location escapes
 *  the business directory (symlink defense in depth — the whitelist already excludes them). */
export function readHubFile(root: string, slug: string, relPath: string): string | null {
  const rel = relPath.replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`invalid path "${relPath}"`);
  }
  if (!allowedHubPath(rel)) throw new Error(`path not shared: "${rel}"`);

  const biz = businessDir(root, slug);
  const abs = path.join(biz, ...rel.split("/"));
  if (!exists(abs)) return null;
  if (fs.lstatSync(abs).isSymbolicLink() || !fs.statSync(abs).isFile()) throw new Error(`not a file: "${rel}"`);
  if (!fs.realpathSync(abs).startsWith(fs.realpathSync(biz) + path.sep)) {
    throw new Error(`path escapes business dir: "${rel}"`);
  }
  return fs.readFileSync(abs, "utf8");
}
