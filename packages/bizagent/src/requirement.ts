// Requirements — the multi-session task container. One requirement = one task that takes N
// sessions (stories) to finish; one session works on at most one requirement. It exists for
// CONTEXT, not for ticketing: a requirement is a plain directory whose requirement.md is the
// living state document every session reads at launch and updates before it ends — so work
// continues across many short sessions instead of one ever-growing conversation.
//
// The run -> requirement link is a machine-written marker (`.req` in the run's deliverables
// dir, written at launch like `.session-id`). The reverse direction (a requirement's sessions)
// is DERIVED by scanning runs, never stored — a stored list would drift. No DB, no status
// engine: "done" is just frontmatter `status:` flipped in the doc.
import fs from "node:fs";
import path from "node:path";
import { deliverablesDir, requirementDir, requirementDocPath, requirementsDir } from "./paths";
import { exists, listDirs, mkdirp, readFileOr, rmrf, writeFile } from "./fsutil";
import * as fm from "./frontmatter";
import { loadPrompt, renderPrompt } from "./prompts";

const REQ_MARKER = ".req";
// What pre-seeded task (if any) launched this run — e.g. "setup" or "module-setup:<mod>". Written
// at launch like `.req`, so a UI can find "the run that ran this task" and re-enter it instead of
// spawning a duplicate. Generic launch metadata, not requirement-specific.
const TASK_MARKER = ".task";
// Which model this run's conversation is pinned to (the gateway model id passed at launch). Written
// on a FRESH start like `.session-id`, so a later resume re-binds the SAME model without the caller
// re-passing it — one conversation stays on one model across reopens / host restarts.
const MODEL_MARKER = ".model";
// Who started this conversation (the asker's identity, e.g. a username). Written on a FRESH start
// like `.model`, so a UI labelling "who asked" reads from disk — not from a derived stats table.
// Resume must not overwrite: one conversation has one originator across its lifetime.
const REQUESTER_MARKER = ".requester";
// The id becomes a directory name, a git branch suffix (req/<id>), and a UI label — keep it
// readable and path/branch-safe.
const REQ_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function validReqId(req: string): boolean {
  return REQ_ID_RE.test(req);
}

/** Ensure a requirement exists (lazy creation): its directory plus a skeleton requirement.md
 *  on first use. Idempotent — an existing doc is never touched. Throws on a malformed id.
 *  Optional `title` seeds the doc's `# heading` (UI display name); a creator that already has
 *  a human label hands it in here so the list shows it without a follow-up edit. Omitted →
 *  heading falls back to the id (the legacy shape). */
export function ensureRequirement(o: { root: string; slug: string; req: string; title?: string }): void {
  if (!validReqId(o.req)) throw new Error(`invalid requirement id '${o.req}' (letters/digits/.-_ only, must start alphanumeric)`);
  mkdirp(requirementDir(o.root, o.slug, o.req));
  const doc = requirementDocPath(o.root, o.slug, o.req);
  if (!exists(doc)) {
    const heading = (o.title ?? "").trim() || o.req;
    writeFile(doc, renderPrompt(loadPrompt("requirement"), { REQ_ID: o.req, REQ_TITLE: heading }));
  }
}

/** Allocate the next auto-increment requirement id for a business. Scans existing requirement
 *  dirs, picks the max purely-numeric one, returns `max + 1` (or `1` when none). String-named
 *  reqs (`retention-funnel`) coexist — they just don't participate in the sequence. Single-host
 *  bizagent has no concurrent allocation, so a simple scan suffices. Deleted ids don't recycle
 *  (their git branches `req/<n>` would otherwise collide with a fresh requirement). */
export function nextRequirementId(root: string, slug: string): string {
  let max = 0;
  for (const d of listDirs(requirementsDir(root, slug))) {
    const name = path.basename(d);
    if (/^\d+$/.test(name)) {
      const n = parseInt(name, 10);
      if (n > max) max = n;
    }
  }
  return String(max + 1);
}

/** The requirement's living state document, or null when it has none (or doesn't exist). */
export function readRequirementDoc(root: string, slug: string, req: string): string | null {
  return readFileOr(requirementDocPath(root, slug, req)) || null;
}

/** Overwrite the `## Goal` section's body. The Goal is the HUMAN's section of the state doc —
 *  set at creation or edited from a UI — and the session prompt tells the agent to leave a
 *  filled goal alone (see prompts/requirement-context.md), so this is the goal's write path.
 *  Creates the requirement when missing; appends the section when a hand-rolled doc lacks it. */
export function setRequirementGoal(o: { root: string; slug: string; req: string; goal: string }): void {
  const goal = o.goal.trim();
  if (!goal) throw new Error("goal must be non-empty");
  ensureRequirement(o);
  const docPath = requirementDocPath(o.root, o.slug, o.req);
  const lines = readFileOr(docPath).split("\n");
  const start = lines.findIndex((l) => /^##\s+Goal\s*$/.test(l));
  if (start === -1) {
    writeFile(docPath, `${lines.join("\n").replace(/\s*$/, "\n")}\n## Goal\n\n${goal}\n`);
    return;
  }
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  writeFile(docPath, [...lines.slice(0, start + 1), "", goal, "", ...(end === -1 ? [] : lines.slice(end))].join("\n"));
}

/** Record which requirement a run works on. Machine-written at launch (like `.session-id`),
 *  so the link can't drift; one run belongs to at most one requirement. */
export function recordRunReq(o: { root: string; slug: string; runId: string; req: string }): void {
  const dir = path.join(deliverablesDir(o.root, o.slug), o.runId);
  mkdirp(dir);
  writeFile(path.join(dir, REQ_MARKER), o.req);
}

/** Which requirement a run was launched under, if any. */
export function runReq(root: string, slug: string, runId: string): string | undefined {
  return readFileOr(path.join(deliverablesDir(root, slug), runId, REQ_MARKER)).trim() || undefined;
}

/** Record the pre-seeded task that launched a run (e.g. "module-setup:<mod>"). Machine-written at
 *  launch, so a UI can find and re-enter that run instead of starting a duplicate. */
export function recordRunTask(o: { root: string; slug: string; runId: string; task: string }): void {
  const dir = path.join(deliverablesDir(o.root, o.slug), o.runId);
  mkdirp(dir);
  writeFile(path.join(dir, TASK_MARKER), o.task);
}

/** The task a run was launched with, if any. */
export function runTask(root: string, slug: string, runId: string): string | undefined {
  return readFileOr(path.join(deliverablesDir(root, slug), runId, TASK_MARKER)).trim() || undefined;
}

/** Pin a run's conversation to a model. Machine-written at launch (like `.session-id`), FRESH starts
 *  only — a resume must not overwrite it, so one conversation keeps one model across reopens. */
export function recordRunModel(o: { root: string; slug: string; runId: string; model: string }): void {
  const dir = path.join(deliverablesDir(o.root, o.slug), o.runId);
  mkdirp(dir);
  writeFile(path.join(dir, MODEL_MARKER), o.model);
}

/** The model a run was pinned to at launch, if recorded — lets a resume re-bind the same one. */
export function runModel(root: string, slug: string, runId: string): string | undefined {
  return readFileOr(path.join(deliverablesDir(root, slug), runId, MODEL_MARKER)).trim() || undefined;
}

/** Record the originator (asker's identity) for a run. Machine-written at launch
 *  on a FRESH start — a resume must not overwrite it, so the conversation keeps the same recorded
 *  originator across reopens. Empty `requester` is treated as "skip" (no marker written), so the
 *  caller doesn't have to guard. */
export function recordRunRequester(o: { root: string; slug: string; runId: string; requester: string }): void {
  if (!o.requester) return;
  const dir = path.join(deliverablesDir(o.root, o.slug), o.runId);
  mkdirp(dir);
  writeFile(path.join(dir, REQUESTER_MARKER), o.requester);
}

/** The originator a run was launched by, if recorded. Undefined when the run predates this marker
 *  (back-fill from stats.db with the migration script that ships with the change). */
export function runRequester(root: string, slug: string, runId: string): string | undefined {
  return readFileOr(path.join(deliverablesDir(root, slug), runId, REQUESTER_MARKER)).trim() || undefined;
}

/** The Claude Code session id for a run, however it was recorded. SDK sessions write `.session-id`
 *  directly; CLI runs record `.transcript-path` via the inject hook (whose basename is the
 *  session id), so both paths are resumable from a `listRuns` entry. */
export function runSessionId(root: string, slug: string, runId: string): string | undefined {
  const dir = path.join(deliverablesDir(root, slug), runId);
  const direct = readFileOr(path.join(dir, ".session-id")).trim();
  if (direct) return direct;
  const tp = readFileOr(path.join(dir, ".transcript-path")).trim();
  if (tp) return path.basename(tp, ".jsonl") || undefined;
  return undefined;
}

/** The run a Claude session id belongs to — the reverse of `runSessionId`. The OLDEST match wins:
 *  one conversation must keep converging on its original run (one rail entry, one worklog), so
 *  any duplicate runs a pre-convergence resume minted are never picked up again. */
export function runForSessionId(root: string, slug: string, sid: string): string | undefined {
  const matches = listDirs(deliverablesDir(root, slug))
    .map((d) => path.basename(d))
    .filter((runId) => runSessionId(root, slug, runId) === sid)
    .sort(); // runIds are timestamp-prefixed — lexicographic ascending = oldest first
  return matches[0];
}

/** Delete a requirement: its directory (state doc and all) plus every run's `.req` marker that
 *  points at it. The runs themselves SURVIVE — they become req-less conversations (the UI's
 *  "随手聊" bucket), so deleting a requirement never deletes conversation history. */
export function deleteRequirement(o: { root: string; slug: string; req: string }): void {
  if (!exists(requirementDir(o.root, o.slug, o.req))) throw new Error(`unknown requirement '${o.req}'`);
  rmrf(requirementDir(o.root, o.slug, o.req));
  for (const d of listDirs(deliverablesDir(o.root, o.slug))) {
    const marker = path.join(d, REQ_MARKER);
    if (readFileOr(marker).trim() === o.req) rmrf(marker);
  }
}

/** Rename a requirement: move its directory and rewrite every linked run's `.req` marker so the
 *  link follows. Old per-run git branches keep the old `req/<id>` suffix — names, not links, so
 *  that's harmless. Throws on a malformed/colliding target id. */
export function renameRequirement(o: { root: string; slug: string; from: string; to: string }): void {
  if (!validReqId(o.to)) throw new Error(`invalid requirement id '${o.to}' (letters/digits/.-_ only, must start alphanumeric)`);
  const fromDir = requirementDir(o.root, o.slug, o.from);
  const toDir = requirementDir(o.root, o.slug, o.to);
  if (!exists(fromDir)) throw new Error(`unknown requirement '${o.from}'`);
  if (exists(toDir)) throw new Error(`requirement '${o.to}' already exists`);
  fs.renameSync(fromDir, toDir);
  for (const d of listDirs(deliverablesDir(o.root, o.slug))) {
    const marker = path.join(d, REQ_MARKER);
    if (readFileOr(marker).trim() === o.from) writeFile(marker, o.to);
  }
}

export interface RequirementEntry {
  id: string;
  /** Frontmatter `status:` of the state doc; "active" when unset. Free-form by design —
   *  bizagent never automates transitions, it only surfaces the label. */
  status: string;
  /** Display title: the doc body's first `# ` heading, when it says more than the id does.
   *  Lets an id constrained to [a-z0-9._-] (it's a dir + branch name) carry a human title
   *  in any language; absent when the heading just repeats the id. */
  title?: string;
  /** The state doc's mtime (ISO) — when the requirement last changed. A UI's recency key for
   *  reqs with no sessions yet; with sessions, the newest run usually supersedes it. */
  updatedAt?: string;
}

/** List a business's requirements (directory scan + each doc's status/title/mtime). */
export function listRequirements(root: string, slug: string): RequirementEntry[] {
  return listDirs(requirementsDir(root, slug)).map((d) => {
    const id = path.basename(d);
    const docPath = requirementDocPath(root, slug, id);
    const { data, body } = fm.parse(readFileOr(docPath));
    const heading = body.match(/^#\s+(.+)$/m)?.[1].trim();
    let updatedAt: string | undefined;
    try {
      updatedAt = fs.statSync(docPath).mtime.toISOString();
    } catch {
      /* doc absent (bare dir) — recency just falls back to the UI's default order */
    }
    return {
      id,
      status: typeof data.status === "string" && data.status ? data.status : "active",
      ...(heading && heading !== id ? { title: heading } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  });
}
