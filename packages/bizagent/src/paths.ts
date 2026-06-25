// Directory layout = the cross-runtime contract. Both CLI and SDK cd into the same
// tree and read the same files. Centralize every path constant here — never hardcode
// these strings elsewhere.
import path from "node:path";
import { exists, listDirs } from "./fsutil";

export const CONFIG_FILE = "bizagent.config.json";
export const KNOWLEDGE = "knowledge";
export const LINES = "lines";
export const BUSINESSES = "businesses";
export const MODULES = "modules";
export const ASSISTANTS = "assistants";
export const COMMON = "common";

export const rootConfigPath = (root: string) => path.join(root, CONFIG_FILE);
export const commonKnowledge = (root: string) => path.join(root, KNOWLEDGE, COMMON);

// Product lines are real directories: <root>/lines/<line>/ holds the line's knowledge layer,
// its modules, and its businesses. A business always belongs to exactly one line; modules
// never cross lines.
export const linesDir = (root: string) => path.join(root, LINES);
export const lineDir = (root: string, line: string) => path.join(linesDir(root), line);
export const lineKnowledge = (root: string, line: string) => path.join(lineDir(root, line), KNOWLEDGE);
export const lineModulesDir = (root: string, line: string) => path.join(lineDir(root, line), MODULES);
export const lineBusinessesDir = (root: string, line: string) => path.join(lineDir(root, line), BUSINESSES);
/** A line's display metadata (optional — a line without one reads as just its slug). */
export const lineMetaPath = (root: string, line: string) => path.join(lineDir(root, line), "line.json");

export const listLineSlugs = (root: string) => listDirs(linesDir(root)).map((d) => path.basename(d));

/** A business's directory inside a known line (used at creation, before the scan can find it). */
export const businessDirIn = (root: string, line: string, slug: string) =>
  path.join(lineBusinessesDir(root, line), slug);

// ── module workspaces ──
// A module hosts sessions just like a business (its setup / maintenance conversations live in
// the module's OWN directory — modules are many-to-many with businesses, so no business may own
// them). Module slugs are only unique within their line (business slugs are root-global), so a
// module workspace is addressed by a composite id: `mod:<line>:<mod>`. businessDir() (the
// central workspace resolver) recognizes the id, which makes every (root, slug)-keyed path
// helper — deliverables, worklog index, memory/ — land inside the module directory with no
// further special-casing. The `:` separator cannot appear in a business slug, so the two
// namespaces never collide.
export const MODULE_WS_PREFIX = "mod:";
const WS_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** The composite workspace id addressing a module: `mod:<line>:<mod>`. */
export const moduleWorkspaceId = (line: string, mod: string) => `${MODULE_WS_PREFIX}${line}:${mod}`;

/** Parse a module workspace id, or null when `slug` is a plain business slug. Segments are
 *  validated against the slug charset — which also blocks path traversal through a crafted id. */
export function parseModuleWorkspaceId(slug: string): { line: string; mod: string } | null {
  if (!slug.startsWith(MODULE_WS_PREFIX)) return null;
  const parts = slug.slice(MODULE_WS_PREFIX.length).split(":");
  if (parts.length !== 2) return null;
  const [line, mod] = parts;
  if (!WS_SEGMENT.test(line) || !WS_SEGMENT.test(mod)) return null;
  return { line, mod };
}

// ── assistant workspaces ──
// Assistants connect to IM channels (infoflow / slack / wecom / ...). Each assistant is an IM
// channel adapter that hosts inbound chats, addressed by a workspace id `assistant:<im>` —
// flat one-segment, channel slug only. Assistants don't belong to any product line (they cut
// across the platform), so they live in `<root>/assistants/<im>/`, parallel to `lines/`. As
// with module workspaces, businessDir() recognizes the prefix and every (root, slug)-keyed
// helper (deliverables, worklog index, memory/) lands inside the assistant directory with no
// further special-casing.
export const ASSISTANT_WS_PREFIX = "assistant:";

/** The workspace id addressing an IM-channel assistant: `assistant:<im>`. */
export const assistantWorkspaceId = (im: string) => `${ASSISTANT_WS_PREFIX}${im}`;

/** Parse an assistant workspace id, or null when `slug` is a plain business slug. The segment is
 *  validated against the slug charset — which also blocks path traversal through a crafted id. */
export function parseAssistantWorkspaceId(slug: string): { im: string } | null {
  if (!slug.startsWith(ASSISTANT_WS_PREFIX)) return null;
  const im = slug.slice(ASSISTANT_WS_PREFIX.length);
  if (!WS_SEGMENT.test(im)) return null;
  return { im };
}

export const assistantsDir = (root: string) => path.join(root, ASSISTANTS);
export const assistantDir = (root: string, im: string) => path.join(assistantsDir(root), im);
export const assistantConfigPath = (root: string, im: string) => path.join(assistantDir(root, im), "assistant.json");
export const listAssistantSlugs = (root: string) => listDirs(assistantsDir(root)).map((d) => path.basename(d));

/** Resolve a workspace by slug: an assistant or module workspace id maps to its own directory;
 *  a plain business slug is globally unique, so scan every line. When the business doesn't
 *  exist, return a path under a line name no valid slug can collide with (`.missing`), so
 *  callers' exists() probes stay false instead of throwing. */
export function businessDir(root: string, slug: string): string {
  const aw = parseAssistantWorkspaceId(slug);
  if (aw) return assistantDir(root, aw.im);
  const mw = parseModuleWorkspaceId(slug);
  if (mw) return moduleDir(root, mw.line, mw.mod);
  for (const line of listLineSlugs(root)) {
    const cand = businessDirIn(root, line, slug);
    if (exists(path.join(cand, "business.json")) || exists(cand)) return cand;
  }
  return businessDirIn(root, ".missing", slug);
}

/** Which line a business lives in (from its on-disk location), or undefined when absent. */
export function businessLine(root: string, slug: string): string | undefined {
  for (const line of listLineSlugs(root)) {
    if (exists(businessDirIn(root, line, slug))) return line;
  }
  return undefined;
}

export const memoryDir = (root: string, slug: string) => path.join(businessDir(root, slug), "memory");

// Modules are line-level shared components (many-to-many with the line's businesses; never
// linked across lines). A module is a vendored code repo plus bizagent sidecar metadata:
// module.json (type + source + deploy info) and CLAUDE.md (its living knowledge doc). A
// business links the modules it uses and symlinks each in for read/analysis.
export const moduleDir = (root: string, line: string, mod: string) => path.join(lineModulesDir(root, line), mod);
export const moduleConfigPath = (root: string, line: string, mod: string) =>
  path.join(moduleDir(root, line, mod), "module.json");
export const moduleCodeDir = (root: string, line: string, mod: string) => path.join(moduleDir(root, line, mod), "code");
export const businessModulesDir = (root: string, slug: string) => path.join(businessDir(root, slug), MODULES);

// Requirements: a business's multi-session task containers. Each requirement is a plain
// directory holding requirement.md (the living state document shared by every session that
// works on it) plus any requirement-level artifacts. Visible (not under .bizagent/) because
// the agent and the user both read and edit the state doc.
export const requirementsDir = (root: string, slug: string) => path.join(businessDir(root, slug), "requirements");
export const requirementDir = (root: string, slug: string, req: string) => path.join(requirementsDir(root, slug), req);
export const requirementDocPath = (root: string, slug: string, req: string) =>
  path.join(requirementDir(root, slug, req), "requirement.md");

// bizagent's own per-business state, hidden under .bizagent/. Each session gets a
// folder under deliverables/<runId>/ holding its worklog.md plus any intermediate
// artifacts the worklog references — all kept as reference for later sessions.
export const bizagentDir = (root: string, slug: string) => path.join(businessDir(root, slug), ".bizagent");
export const deliverablesDir = (root: string, slug: string) =>
  path.join(bizagentDir(root, slug), "deliverables");
export const worklogIndexPath = (root: string, slug: string) =>
  path.join(bizagentDir(root, slug), "worklog-index.md");
// A hub-side mirror of a remote user's Claude Code transcript (pushed in chunks by their Stop
// hook). Dot-prefixed like the other run markers so it never lists as a deliverable. Where the
// local `.transcript-path` pointer is absent (the session ran on another machine), the web
// replay/live view falls back to this file — read-only by construction (no `.session-id`, so
// the run is never resumable here).
export const transcriptMirrorPath = (root: string, slug: string, runId: string) =>
  path.join(deliverablesDir(root, slug), runId, ".transcript.jsonl");
// Cache of other users' shared business memory (pulled from a Remote). Kept OUT of the
// business's own `memory/` so it doesn't pollute what the user authored / git-tracks, and so
// publishing never re-publishes what we pulled (publish reads memory/, pull writes here).
export const remoteMemoryDir = (root: string, slug: string) =>
  path.join(bizagentDir(root, slug), "remote-memory");

// Root-level bizagent state (not per-business). The reference file SchedulerStore for `biz web`
// lives here; a platform uses its own DB instead and never touches this path.
export const rootBizagentDir = (root: string) => path.join(root, ".bizagent");
export const wakeupStorePath = (root: string) => path.join(rootBizagentDir(root), "wakeups.jsonl");
export const activeTurnsPath = (root: string) => path.join(rootBizagentDir(root), "active-turns.json");

/** Walk up from `start` looking for bizagent.config.json to locate the root. */
export function findRoot(start: string): string | null {
  let cur = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (exists(path.join(cur, CONFIG_FILE))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Walk up from `start` to the enclosing workspace: a business (dir holding business.json), a
 *  module (dir holding module.json — its slug is the composite `mod:<line>:<mod>` id, derived
 *  from the dir's place in the tree), or an assistant (dir holding assistant.json — slug is
 *  `assistant:<im>`). Hooks resolve their workspace from cwd through this, so worklog
 *  enforcement / transcript recording work identically for every workspace type. */
export function findBusiness(start: string): { root: string; slug: string; dir: string } | null {
  let cur = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (exists(path.join(cur, "business.json"))) {
      const root = findRoot(cur);
      if (root) return { root, slug: path.basename(cur), dir: cur };
    }
    if (exists(path.join(cur, "module.json"))) {
      const root = findRoot(cur);
      // Verify the on-disk shape (lines/<line>/modules/<mod>) before trusting the derived id.
      const line = path.basename(path.dirname(path.dirname(cur)));
      if (root && cur === moduleDir(root, line, path.basename(cur))) {
        return { root, slug: moduleWorkspaceId(line, path.basename(cur)), dir: cur };
      }
    }
    if (exists(path.join(cur, "assistant.json"))) {
      const root = findRoot(cur);
      const im = path.basename(cur);
      // Verify the on-disk shape (assistants/<im>) before trusting the derived id.
      if (root && cur === assistantDir(root, im)) {
        return { root, slug: assistantWorkspaceId(im), dir: cur };
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
