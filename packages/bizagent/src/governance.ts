// Governance + the Stop/UserPromptSubmit harness steps. Pure decision functions so both
// the CLI hooks (`biz hook ...`) and (later) the SDK hook callbacks call the same logic.
//   - validateMemoryWrite : the write choke point (schema + writability rules)
//   - worklogWritten      : did this run write a worklog? (Stop enforcement)
//   - updateIndex         : lift finished worklogs' summaries into the shared index
//   - freshIndexSince     : the per-turn delta to inject (other sessions' new work)
//   - promote             : (optional) worklog `## Conclusions` -> business memory
import fs from "node:fs";
import path from "node:path";
import { KNOWLEDGE, LINES, BUSINESSES, MODULES, bizagentDir, deliverablesDir, worklogIndexPath, memoryDir, remoteMemoryDir, moduleWorkspaceId } from "./paths";
import { exists, readFileOr, writeFile, appendLine, claim, listDirs, realpathDeep, mkdirp, rmrf } from "./fsutil";
import * as fm from "./frontmatter";
import { writeMemory, assemble, readAllMemory, MemoryRecord } from "./memory";
import { runModel, runReq, runRequester, runSessionId, runTask } from "./requirement";
import { Remote } from "./remote";
import { nowIso } from "./time";

const WORKLOG = "worklog.md";
const INDEXED_MARKER = ".indexed";
const SEEN_CURSOR = ".seen-index";
const PROMOTED_MARKER = ".promoted";

/** Absolute path of a session's worklog file. */
function worklogPath(root: string, slug: string, runId: string): string {
  return path.join(deliverablesDir(root, slug), runId, WORKLOG);
}

/** Session dirs to process: a single one if sessionId is given, else all (chronological). */
function sessionDirs(root: string, slug: string, sessionId?: string): string[] {
  const base = deliverablesDir(root, slug);
  if (sessionId) {
    const one = path.join(base, sessionId);
    return exists(one) ? [one] : [];
  }
  return listDirs(base);
}

// ─────────────────────────── write governance ───────────────────────────

export interface WriteCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a pending memory-related write. Returns ok for anything we don't govern
 * (code, worklog, business docs). Governed:
 *   - curator layers: root knowledge/ (common) and lines/<line>/knowledge/ (the line layer)
 *     -> agents may not write
 *   - module memory (lines/<line>/modules/<mod>/memory/) -> RETIRED, all writes denied
 *     (module knowledge lives in the module's CLAUDE.md)
 *   - business memory records (lines/<line>/businesses/<slug>/memory/*.md) -> require
 *     frontmatter: scope: business + description (the index line) + a body
 * Paths are symlink-resolved, so a write through a business's `knowledge/common` or
 * `knowledge/<line>` symlink is judged against the real (curator) target. Business memory
 * needs full post-write content so edits cannot bypass the schema.
 */
export function validateMemoryWrite(o: { root: string; filePath: string; content?: string }): WriteCheck {
  const root = realpathDeep(o.root);
  const fp = realpathDeep(o.filePath);
  const rel = path.relative(root, fp);
  if (rel.startsWith("..")) return { ok: true }; // outside this root — not ours
  const segs = rel.split(path.sep);

  const curatorDenied = (layer: string) => ({
    ok: false,
    reason:
      `${layer} is a curator-only knowledge layer, shared across businesses. ` +
      `Agents must not write here. Record reusable findings as business memory instead: ` +
      `write a file under your business 'memory/'.`,
  });

  // Curator-only: the root knowledge/ tree (the common layer).
  if (segs[0] === KNOWLEDGE) return curatorDenied(`knowledge/${segs[1] ?? ""}/ (common)`);

  // Curator-only: a line's knowledge layer (lines/<line>/knowledge/) — what a business sees
  // through its `knowledge/<line>` symlink.
  if (segs[0] === LINES && segs[2] === KNOWLEDGE) return curatorDenied(`the '${segs[1]}' line layer`);

  // Module memory is RETIRED: a module's knowledge lives in its CLAUDE.md (maintained from the
  // module's own sessions), not in memory records. Deny new writes; leftover legacy records are
  // read-only migration fodder (fold into CLAUDE.md, then delete — deletion is not a Write).
  if (segs[0] === LINES && segs[2] === MODULES && segs[4] === "memory") {
    return {
      ok: false,
      reason:
        `module memory is retired — modules keep no memory records. Record module knowledge in the ` +
        `module's CLAUDE.md (writable from the module's own sessions); business-specific facts go in ` +
        `that business's own memory/.`,
    };
  }

  // Business memory records: lines/<line>/businesses/<slug>/memory/*.md
  if (segs[0] === LINES && segs[2] === BUSINESSES && segs[4] === "memory") {
    if (!fp.endsWith(".md")) return { ok: false, reason: `memory records must be .md files.` };
    if (o.content === undefined)
      return {
        ok: false,
        reason: `memory writes require full post-write content so frontmatter can be validated.`,
      };
    const { data, body } = fm.parse(o.content);
    const problems: string[] = [];
    if (!data.scope) problems.push(`missing 'scope' (use scope: business)`);
    else if (data.scope !== "business")
      problems.push(`agent-written records must be scope: business (got '${String(data.scope)}')`);
    // The launch context injects ONLY the description line (memory is an index, bodies are read
    // on demand) — a record without one is invisible, so the description is part of the schema.
    if (typeof data.description !== "string" || !data.description.trim())
      problems.push(`missing 'description' (one-line summary — it is the record's ONLY line in the injected memory index)`);
    if (!body.trim()) problems.push(`empty body`);
    if (problems.length)
      return {
        ok: false,
        reason: `invalid business memory: ${problems.join("; ")}. Required frontmatter: scope: business, description: <one-line summary>, plus a body.`,
      };
    return { ok: true };
  }

  return { ok: true }; // code, worklog, anything else — not governed in v0
}

/**
 * A module's directory is writable ONLY from its own workspace (`mod:<line>:<mod>` sessions).
 * Business sessions get READ access through their `modules/<name>` mounts (additionalDirectories)
 * — analysis is theirs to do in place, but changes are not: code changes go through a clone under
 * the session's deliverables (branch `req/<id>`, merged outside), and module knowledge is
 * maintained in module conversations. Paths are symlink-resolved, so a write through a mount is
 * judged against the real module target. `wsSlug` is the writing session's workspace (from cwd).
 */
export function validateModuleDirWrite(o: { root: string; wsSlug: string; filePath: string }): WriteCheck {
  const root = realpathDeep(o.root);
  const fp = realpathDeep(o.filePath);
  const rel = path.relative(root, fp);
  if (rel.startsWith("..")) return { ok: true }; // outside this root — not ours
  const segs = rel.split(path.sep);
  if (segs[0] === LINES && segs[2] === MODULES && segs[3] && segs.length > 4) {
    const owner = moduleWorkspaceId(segs[1], segs[3]);
    if (o.wsSlug !== owner) {
      return {
        ok: false,
        reason:
          `modules/${segs[3]}/ is read-only from this session: it is the module's shared workspace. ` +
          `To change its code, clone per the module's Source into .bizagent/deliverables/<runId>/dev/${segs[3]}/ ` +
          `and work on the requirement branch there. To record module knowledge, use a module conversation.`,
      };
    }
  }
  return { ok: true };
}

// ─────────────────────────── worklog enforcement + index (Stop) ───────────────────────────

/** Pull the worklog's one-line summary. Primary source is the frontmatter `description`
 *  (Claude-memory/skill style); falls back to a legacy `summary:` line, then first line. */
function extractSummary(markdown: string): string {
  const { data, body } = fm.parse(markdown);
  if (typeof data.description === "string" && data.description.trim()) return data.description.trim();
  const legacy = body.match(/^>?\s*summary\s*:\s*(.+)$/im);
  if (legacy) return legacy[1].trim();
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line;
  }
  return "(no summary)";
}

/** runId starts with YYYYMMDD -> a readable date for the index line. */
function dateFromRunId(runId: string): string {
  const m = runId.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : runId;
}

/** Frontmatter `description` from a run's live worklog.md — empty when missing or unset.
 *  Read fresh per call: the shared `worklog-index.md` row is written by the Stop hook only on
 *  first index (`.indexed` is one-shot), so its description freezes at the first-turn version
 *  even when the agent rewrites the frontmatter on later turns. Read sites that show this
 *  description to humans must come through here, not through the index row. */
function liveWorklogDescription(root: string, slug: string, runId: string): string {
  const p = worklogPath(root, slug, runId);
  if (!exists(p)) return "";
  const { data } = fm.parse(readFileOr(p));
  return typeof data.description === "string" ? data.description.trim() : "";
}

/** The one shared index line for a run: `- <date> · <summary> · <runId>`. Same shape used
 *  for the local index and for publishing to a remote (so its runId can be parsed back out). */
export function worklogLine(root: string, slug: string, runId: string): string {
  return `- ${dateFromRunId(runId)} · ${extractSummary(readFileOr(worklogPath(root, slug, runId)))} · ${runId}`;
}

/** Did this run write a (non-empty) worklog? Used by the Stop hook to force it before done. */
export function worklogWritten(o: { root: string; slug: string; runId: string }): boolean {
  return readFileOr(worklogPath(o.root, o.slug, o.runId)).trim().length > 0;
}

export interface IndexResult {
  added: { runId: string; line: string }[];
}

/** Stop-time: for each finished session not yet indexed, lift its worklog summary into the
 *  shared `.bizagent/worklog-index.md` so other sessions can browse it. Concurrency-safe:
 *  `claim` (atomic create) gives each worklog to exactly one hook; `appendLine` (O_APPEND)
 *  keeps concurrent appends intact. Idempotent via the `.indexed` marker. */
export function updateIndex(o: { root: string; slug: string; now?: () => string }): IndexResult {
  const now = o.now ?? nowIso;
  const idxPath = worklogIndexPath(o.root, o.slug);
  const added: IndexResult["added"] = [];

  for (const sd of sessionDirs(o.root, o.slug)) {
    const worklog = path.join(sd, WORKLOG);
    if (!exists(worklog)) continue; // session wrote no worklog
    if (!claim(path.join(sd, INDEXED_MARKER), now() + "\n")) continue; // lost the race / already indexed
    const runId = path.basename(sd);
    const line = worklogLine(o.root, o.slug, runId);
    appendLine(idxPath, line);
    added.push({ runId, line });
  }
  return { added };
}

/** New worklog-index lines this session hasn't seen yet (excluding its own), advancing a
 *  per-session cursor. The UserPromptSubmit hook injects only this delta — so a running
 *  session stays current with other sessions without a restart. */
export function freshIndexSince(o: { root: string; slug: string; runId: string }): string[] {
  const lines = readFileOr(worklogIndexPath(o.root, o.slug))
    .split("\n")
    .filter((l) => l.trim().length > 0);

  const cursorPath = path.join(deliverablesDir(o.root, o.slug), o.runId, SEEN_CURSOR);
  const seen = parseInt(readFileOr(cursorPath).trim(), 10) || 0;

  const fresh = lines.slice(seen).filter((l) => !l.includes(o.runId)); // skip own line
  writeFile(cursorPath, String(lines.length) + "\n"); // advance regardless of filtering
  return fresh;
}

// ─────────────────────────── worklog read model (web / CLI / SDK consumers) ───────────────────────────
//
// The write side above (updateIndex / worklogLine) lifts each finished session's summary into
// the shared index. These are the matching READ functions — one implementation that the web
// layer, the CLI (`biz worklog`), and any embedder all call, so the index-line format is parsed
// in a single place, right next to the writer that produced it.

export interface WorklogIndexEntry {
  date: string;
  description: string;
  runId: string;
}

/** Parse `.bizagent/worklog-index.md` back into structured entries. Each line is
 *  `- <date> · <description> · <runId>` (see worklogLine). The description may itself contain
 *  ` · `, so we split on it but anchor on the first field (date) and last field (runId). */
export function readWorklogIndex(root: string, slug: string): WorklogIndexEntry[] {
  return readFileOr(worklogIndexPath(root, slug))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => {
      const parts = l.slice(2).split(" · ");
      return {
        date: parts[0] ?? "",
        runId: parts.length > 1 ? parts[parts.length - 1] : "",
        description: parts.slice(1, -1).join(" · "),
      };
    });
}

/** One session/run in a business, for a "conversation history" list. `claudeSessionId` is what the
 *  host passes to `resume` to re-open it; `date`/`description` come from the worklog if the run wrote
 *  one (a fresh chat with no worklog yet still lists, just without a description). `req` is the
 *  requirement the run was launched under, when any — what a UI groups sessions by. */
export interface RunEntry {
  runId: string;
  date: string;
  description: string;
  claudeSessionId?: string;
  req?: string;
  /** The pre-seeded task this run was launched with (e.g. "module-setup:<mod>"), if any — lets a
   *  UI find and re-enter the run that ran a task instead of starting a duplicate. */
  task?: string;
  /** The gateway model id this conversation is pinned to (from the run's `.model`), if recorded —
   *  lets a UI show which model a resumed session is locked to. Absent on pre-feature runs. */
  model?: string;
  /** Who started this conversation (the asker's identity, e.g. a username or email) — recorded on the FRESH
   *  start in `.requester`. Lets a UI label every user bubble with the actual asker instead of the
   *  current viewer. Absent on pre-feature runs (back-fillable from stats.db). */
  requester?: string;
}

/** Record a run's Claude Code transcript path (hooks hand it in as `transcript_path`). It is the
 *  link that lets the live view tail the session and history replay re-read it. Best-effort and
 *  refreshed every turn the inject hook fires — losing it only costs replay, never the session. */
export function recordTranscriptPath(o: { root: string; slug: string; runId: string; transcriptPath: unknown }): void {
  const tp = o.transcriptPath;
  if (!o.runId || typeof tp !== "string" || !tp) return;
  try {
    const dir = path.join(deliverablesDir(o.root, o.slug), o.runId);
    mkdirp(dir);
    writeFile(path.join(dir, ".transcript-path"), tp);
  } catch {
    /* best-effort: without it the viewer and history replay just have no source */
  }
}

// A human-set display title for a run (the UI's rename). A marker file like `.req`/`.task` — NEVER
// written into the worklog, which is the agent's own record and feeds the Stop-hook governance.
const TITLE_MARKER = ".title";

/** Set (or clear, with an empty string) a run's display title — the UI's "rename conversation". */
export function setRunTitle(o: { root: string; slug: string; runId: string; title: string }): void {
  const base = path.resolve(deliverablesDir(o.root, o.slug));
  const resolved = path.resolve(base, o.runId);
  if (path.dirname(resolved) !== base) throw new Error(`invalid runId: ${o.runId}`);
  if (!exists(resolved)) throw new Error(`no such run: ${o.runId}`);
  const title = o.title.trim();
  if (title) writeFile(path.join(resolved, TITLE_MARKER), title);
  else rmrf(path.join(resolved, TITLE_MARKER));
}

/** A run's human-set title, if any. */
export function runTitle(root: string, slug: string, runId: string): string | undefined {
  return readFileOr(path.join(deliverablesDir(root, slug), runId, TITLE_MARKER)).trim() || undefined;
}

/** List a business's runs (= sessions), newest first — usable by BOTH the CLI (`biz runs`) and the
 *  web/SDK host. Merges the worklog index (date/description) with each run's recorded session id;
 *  a human-set `.title` (rename) wins over the worklog summary as the description.
 *  The durable backing for a session-history UI — no DB, just the deliverables tree. Runs with
 *  neither a worklog nor a session id are skipped. */
export function listRuns(root: string, slug: string): RunEntry[] {
  const idx = new Map(readWorklogIndex(root, slug).map((e) => [e.runId, e]));
  const dir = deliverablesDir(root, slug);
  const runs: RunEntry[] = [];
  for (const d of listDirs(dir)) {
    const runId = path.basename(d);
    const wl = idx.get(runId);
    // Only list a run that actually DID something. An empty session — `start()` mkdir'd the dir and
    // SDK init wrote `.session-id`, but no turn ever ran — must not pollute the history list (and
    // its session id often isn't even resumable in Claude Code). Real content = an indexed worklog,
    // a worklog.md on disk, or a `.transcript-path` (the inject hook records it on the FIRST turn,
    // so its presence proves at least one real turn happened).
    const hasContent = !!wl || exists(path.join(d, WORKLOG)) || exists(path.join(d, ".transcript-path"));
    if (!hasContent) continue;
    const claudeSessionId = runSessionId(root, slug, runId);
    // Description is live from frontmatter (not the index row — see liveWorklogDescription);
    // the index row is the fallback for runs whose worklog is gone or has no frontmatter desc.
    const liveDesc = liveWorklogDescription(root, slug, runId);
    runs.push({
      runId,
      date: wl?.date ?? "",
      description: runTitle(root, slug, runId) ?? (liveDesc || wl?.description || ""),
      claudeSessionId,
      req: runReq(root, slug, runId),
      task: runTask(root, slug, runId),
      model: runModel(root, slug, runId),
      requester: runRequester(root, slug, runId),
    });
  }
  // runIds are timestamp-prefixed, so a plain reverse-lexicographic sort is newest-first.
  return runs.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}

/** Delete a run (= one conversation): hard-remove its deliverables directory (worklog, artifacts,
 *  the `.session-id`/`.transcript-path` pointers) and drop its line from the shared worklog index,
 *  so it leaves both `listRuns` and the worklog browser. It does NOT touch Claude Code's jsonl
 *  transcript — that lives under ~/.claude and is Claude Code's source of truth, not ours to
 *  destroy (so the conversation itself survives in CC even though its deliverables are gone).
 *  Guards against path traversal — the target must be a DIRECT child of the business's
 *  deliverables dir, so a crafted runId can't escape the tree. Throws if the run dir is absent. */
export function deleteRun(root: string, slug: string, runId: string): void {
  const base = path.resolve(deliverablesDir(root, slug));
  const resolved = path.resolve(base, runId);
  if (path.dirname(resolved) !== base) throw new Error(`invalid runId: ${runId}`);
  if (!exists(resolved)) throw new Error(`no such run: ${runId}`);
  rmrf(resolved);
  // Strip the run's line(s) from the index. The runId is a unique timestamp-hash that appears only
  // in its own line (as the trailing field), so a substring match removes exactly that line.
  const idxPath = worklogIndexPath(root, slug);
  if (exists(idxPath)) {
    const kept = readFileOr(idxPath).split("\n").filter((l) => !l.includes(runId));
    writeFile(idxPath, kept.join("\n"));
  }
}

/** Read one session's full worklog markdown, or null if that run wrote none. */
export function readWorklog(root: string, slug: string, runId: string): string | null {
  const file = worklogPath(root, slug, runId);
  return exists(file) ? readFileOr(file) : null;
}

/** List a run's deliverable files (worklog.md + any artifacts it references), excluding the
 *  hidden bizagent markers (.indexed / .seen-index / .promoted) and any subdirectory entries.
 *  目录跳过的原因：① `uploads/` 这种装用户输入附件的目录不该被当作"产出"显示成 chip；
 *  ② chips 行只展示浅层文件，agent 真产出的嵌套文件（apps/foo.html 这类）由 chat markdown
 *  链接走 `deliverable:open` 事件直接打开，`readDeliverable` 已支持子路径。 */
export function listDeliverables(root: string, slug: string, runId: string): string[] {
  const dir = path.join(deliverablesDir(root, slug), runId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name);
}

/** Read one of a run's deliverable files as raw bytes, or null if absent. Guards against path
 *  traversal (the resolved path must stay inside the run dir) and refuses any segment starting
 *  with `.` (catches both `../` escapes and hidden bizagent markers). Subdirectories ARE allowed:
 *  worklog skill pushes paths like `apps/foo.html` / `reports/bar.csv`, and migrated runs
 *  keep the same shape. Bytes (not text) so the web endpoint can serve images/csv/markdown alike. */
export function readDeliverable(root: string, slug: string, runId: string, filename: string): Buffer | null {
  const dir = path.resolve(deliverablesDir(root, slug), runId);
  const resolved = path.resolve(dir, filename);
  const rel = path.relative(dir, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((s) => s.startsWith("."))) return null;
  if (!exists(resolved)) return null;
  // If filename points at a directory (caller passed only a subdir prefix), don't throw EISDIR —
  // treat it as "no such file" so the route returns a clean 404.
  if (fs.statSync(resolved).isDirectory()) return null;
  return fs.readFileSync(resolved);
}

// ─────────────────────────── remote sharing (publish on Stop, pull on inject) ───────────────────────────
//
// Each agent's source of truth stays its local files; a Remote (resolved from config) is a
// best-effort shared layer. publishWorklogs runs after the Stop hook indexes; pullRemoteIndex
// runs in the UserPromptSubmit hook before computing the inject delta. Both are best-effort:
// if the remote is slow or down, local behavior is untouched.

const PULL_MARKER = ".remote-pull";
const PULL_TTL_MS = 3000; // don't re-pull within this window (avoids hammering on rapid turns)
const REMOTE_TIMEOUT_MS = 2000; // never let a slow remote stall a turn

function nowMs(): number {
  return Date.now();
}

/** Resolve `p` to `fallback` if it doesn't settle within `ms` (or rejects). Best-effort: a
 *  remote that hangs or errors must never block the local hook. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
    p.then(finish, () => finish(fallback));
  });
}

/** Publish freshly-indexed worklogs to the remote so other users see them. `entries` is the
 *  IndexResult.added from updateIndex (runId + index line); the body is read from local disk.
 *  Idempotency is the remote's job (publish by runId, latest wins). Best-effort. */
export async function publishWorklogs(o: {
  root: string;
  slug: string;
  remote: Remote;
  entries: { runId: string; line: string }[];
}): Promise<{ published: number }> {
  let published = 0;
  for (const e of o.entries) {
    const content = readFileOr(worklogPath(o.root, o.slug, e.runId));
    if (!content.trim()) continue;
    const ok = await withTimeout(
      o.remote.publishWorklog({ runId: e.runId, line: e.line, content }).then(() => true),
      REMOTE_TIMEOUT_MS,
      false,
    );
    if (ok) published += 1;
  }
  return { published };
}

/** Pull the remote's index and merge any lines this business doesn't have yet into the local
 *  `.bizagent/worklog-index.md` (dedup by runId). After this, the existing machinery —
 *  freshIndexSince (inject), buildSystemPrompt (launch), the web read model — transparently
 *  sees other users' work; no parallel path. Throttled by a TTL marker and time-bounded.
 *  Returns how many lines were merged. */
export async function pullRemoteIndex(o: {
  root: string;
  slug: string;
  remote: Remote;
  ttlMs?: number;
  now?: () => number;
}): Promise<{ merged: number }> {
  const now = (o.now ?? nowMs)();
  const ttl = o.ttlMs ?? PULL_TTL_MS;
  const marker = path.join(bizagentDir(o.root, o.slug), PULL_MARKER);
  const last = parseInt(readFileOr(marker).trim(), 10) || 0;
  if (now - last < ttl) return { merged: 0 }; // pulled recently — skip
  writeFile(marker, String(now) + "\n");

  const remoteEntries = await withTimeout(o.remote.fetchIndex(), REMOTE_TIMEOUT_MS, []);
  if (!remoteEntries.length) return { merged: 0 };

  const idxPath = worklogIndexPath(o.root, o.slug);
  const localRunIds = new Set(readWorklogIndex(o.root, o.slug).map((e) => e.runId));
  let merged = 0;
  for (const e of remoteEntries) {
    if (localRunIds.has(e.runId)) continue; // already have it (own or previously pulled)
    appendLine(idxPath, e.line);
    localRunIds.add(e.runId);
    merged += 1;
  }
  return { merged };
}

const TRANSCRIPT_PUSHED = ".transcript-pushed"; // chars of the local transcript already on the hub
const TRANSCRIPT_CHUNK = 512 * 1024; // per-push cap, so one 2s-bounded call never carries a huge backlog

/** Push this run's new Claude Code transcript lines to the remote (the hub's read-only web
 *  view). Reads the local jsonl via the `.transcript-path` pointer the inject hook records,
 *  pushes only complete lines past the `.transcript-pushed` watermark, in capped chunks (a
 *  backlog catches up over successive turns/chunks rather than one giant call). The marker
 *  advances only after the remote acks, so a lost ack re-pushes an overlap the remote drops.
 *  A gap rejection (the remote lost data / we got ahead) carries the remote's `have` — resync
 *  to it once and continue; offset 0 then overwrites remote-side. Best-effort like every
 *  publish: any failure stops this round, next Stop resumes from the marker. No-op unless the
 *  remote opted into transcripts (publishTranscript present). */
export async function publishTranscript(o: {
  root: string;
  slug: string;
  runId: string;
  remote: Remote;
  chunk?: number;
}): Promise<{ pushed: number }> {
  const publish = o.remote.publishTranscript?.bind(o.remote);
  if (!publish) return { pushed: 0 };
  const dir = path.join(deliverablesDir(o.root, o.slug), o.runId);
  const src = readFileOr(path.join(dir, ".transcript-path")).trim();
  if (!src) return { pushed: 0 };
  const text = readFileOr(src);
  const end = text.lastIndexOf("\n") + 1; // only complete lines; a half-written tail waits
  const cap = o.chunk ?? TRANSCRIPT_CHUNK;
  const marker = path.join(dir, TRANSCRIPT_PUSHED);
  let from = parseInt(readFileOr(marker).trim(), 10) || 0;
  if (from > text.length) from = 0; // transcript rotated/truncated — re-push from the top
  let pushed = 0;
  let resynced = false; // accept ONE gap resync; a second means something is broken — stop
  while (from < end) {
    let to = Math.min(end, from + cap);
    if (to < end) {
      // Cut at a line boundary — but never below one whole line (a single jsonl line larger
      // than the cap, e.g. a big tool result, still ships as its own oversized chunk).
      const nl = text.lastIndexOf("\n", to - 1);
      to = nl >= from ? nl + 1 : text.indexOf("\n", from) + 1;
    }
    const r = await withTimeout(
      publish({ runId: o.runId, offset: from, content: text.slice(from, to) }).then(
        () => ({ ok: true as const, have: undefined as number | undefined }),
        (e: unknown) => ({ ok: false as const, have: typeof (e as { have?: unknown })?.have === "number" ? ((e as { have: number }).have) : undefined }),
      ),
      REMOTE_TIMEOUT_MS,
      { ok: false as const, have: undefined },
    );
    if (!r.ok) {
      if (r.have !== undefined && r.have < from && !resynced) {
        resynced = true;
        from = r.have; // the remote has less than we thought — back up to its watermark
        continue;
      }
      break;
    }
    from = to;
    writeFile(marker, String(from) + "\n"); // persist progress per chunk, not per round
    pushed += 1;
  }
  return { pushed };
}

const MEM_PUBLISHED = ".memory-published"; // per-id content-fingerprint markers (skip re-publish)
const MEM_PULL_MARKER = ".remote-pull-memory";

/** A cheap content fingerprint (djb2) — enough to skip re-publishing a memory record whose
 *  body hasn't changed. Not crypto; just a "did this change since last publish" check. */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Publish this business's OWN business memory (the `memory/` dir) to the remote, skipping
 *  records unchanged since last publish (per-id fingerprint marker). Reads only `memory/`, so
 *  pulled records (cached under remote-memory/) are never re-published — no echo loop.
 *  Best-effort. Runs on Stop alongside worklog publishing. */
export async function publishMemories(o: { root: string; slug: string; remote: Remote }): Promise<{ published: number }> {
  const markerDir = path.join(bizagentDir(o.root, o.slug), MEM_PUBLISHED);
  let published = 0;
  for (const rec of readAllMemory(o.root, o.slug)) {
    if (rec.scope !== "business") continue;
    const content = readFileOr(path.join(memoryDir(o.root, o.slug), `${rec.id}.md`));
    if (!content.trim()) continue;
    const marker = path.join(markerDir, rec.id);
    const sig = fingerprint(content);
    if (readFileOr(marker).trim() === sig) continue; // unchanged since last publish
    const ok = await withTimeout(
      o.remote.publishMemory({ id: rec.id, content }).then(() => true),
      REMOTE_TIMEOUT_MS,
      false,
    );
    if (ok) {
      writeFile(marker, sig + "\n");
      published += 1;
    }
  }
  return { published };
}

/** Pull other users' business memory into the local `.bizagent/remote-memory/` cache (by id,
 *  latest wins), skipping ids this business authored itself. buildSystemPrompt merges this
 *  cache with the local `memory/` — so other users' knowledge shows up in the launch context
 *  with no parallel path. Throttled by a TTL marker and time-bounded. Best-effort. */
export async function pullRemoteMemory(o: {
  root: string;
  slug: string;
  remote: Remote;
  ttlMs?: number;
  now?: () => number;
}): Promise<{ merged: number }> {
  const now = (o.now ?? nowMs)();
  const ttl = o.ttlMs ?? PULL_TTL_MS;
  const marker = path.join(bizagentDir(o.root, o.slug), MEM_PULL_MARKER);
  const last = parseInt(readFileOr(marker).trim(), 10) || 0;
  if (now - last < ttl) return { merged: 0 };
  writeFile(marker, String(now) + "\n");

  const records = await withTimeout(o.remote.fetchMemory(), REMOTE_TIMEOUT_MS, []);
  if (!records.length) return { merged: 0 };

  const ownIds = new Set(readAllMemory(o.root, o.slug).map((r) => r.id));
  const dir = remoteMemoryDir(o.root, o.slug);
  let merged = 0;
  for (const rec of records) {
    if (ownIds.has(rec.id)) continue; // we authored this — keep our own copy, don't shadow it
    writeFile(path.join(dir, `${rec.id}.md`), rec.content);
    merged += 1;
  }
  return { merged };
}

// ─────────────────────────── distillation (promote, optional) ───────────────────────────

const HEADING_RE = /^#{1,6}\s/;
// Tested only on heading lines (see extractConclusions), so a plain "contains" match
// is safe — and avoids the ASCII `\b` word-boundary that never fires after CJK chars.
const CONCLUSION_RE = /(conclusions?|takeaways?|findings?|结论|要点|发现)/i;

interface Conclusion {
  body: string;
}

/** Extract bullets under a `## Conclusions` (or Takeaways/Findings/结论/...) heading. */
export function extractConclusions(markdown: string): Conclusion[] {
  const out: Conclusion[] = [];
  let inSection = false;
  for (const line of markdown.split("\n")) {
    if (HEADING_RE.test(line)) {
      inSection = CONCLUSION_RE.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (!m) continue;
    const text = m[1].trim();
    if (text) out.push({ body: text });
  }
  return out;
}

export interface PromoteResult {
  promoted: MemoryRecord[];
  worklogs: string[];
}

/** Distill unpromoted worklogs into business memory. Idempotent + concurrency-safe via the
 *  `.promoted` claim. Pass sessionId to target one session; else scan all. */
export function promote(o: { root: string; slug: string; sessionId?: string; now?: () => string }): PromoteResult {
  const promoted: MemoryRecord[] = [];
  const worklogs: string[] = [];

  for (const sd of sessionDirs(o.root, o.slug, o.sessionId)) {
    const worklog = path.join(sd, WORKLOG);
    if (!exists(worklog)) continue;
    if (!claim(path.join(sd, PROMOTED_MARKER), (o.now ?? nowIso)() + "\n")) continue; // already distilled
    const sid = path.basename(sd);
    for (const c of extractConclusions(readFileOr(worklog))) {
      promoted.push(
        writeMemory({
          root: o.root,
          slug: o.slug,
          body: c.body,
          scope: "business",
          source_session: sid,
          confidence: 0.5, // pending review — promoted, not yet curated
          writable_by: "agent+human",
          now: o.now,
        }),
      );
    }
    worklogs.push(worklog);
  }

  if (promoted.length) assemble({ root: o.root, slug: o.slug });
  return { promoted, worklogs };
}
