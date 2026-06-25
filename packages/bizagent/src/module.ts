// Module = a line-level, shared technical component (strategy / backend / frontend / data ...).
// Many-to-many with the line's businesses: one business uses several modules; one module serves
// several businesses — but never across lines. A module vendors its code as a git repo under
// code/, plus bizagent sidecar metadata: module.json (type + source + deploy info) and CLAUDE.md
// (the module's living knowledge doc, maintained by its own sessions).
//
// Code access model (see the injected modules prompt): a business symlinks each linked module
// in for READ/analysis (master, shared — read never conflicts). To DEVELOP, the agent creates a
// per-requirement git worktree on a branch — never editing the shared master checkout in place.
import path from "node:path";
import { moduleConfigPath, moduleCodeDir, lineModulesDir, moduleDir, parseModuleWorkspaceId, parseAssistantWorkspaceId } from "./paths";
import { readFile, readFileOr, writeFile, exists, listDirs, listFiles } from "./fsutil";
import { LEGACY_POINTER_MARKER } from "./memory";
import { readBusinessMeta } from "./meta";
import { nowIso } from "./time";

export interface ModuleMeta {
  slug: string;
  /** Free-form component type, e.g. strategy / backend / frontend / data. */
  type: string;
  /** Where the code lives and how to obtain/update it, in free text (an internal forge, a
   *  GitHub URL + clone instructions, whatever). Surfaced as knowledge; the harness never
   *  parses or executes it — the agent clones/pulls per this description, with auth coming
   *  from the user's environment. */
  source?: string;
  /** Deployment info — surfaced as knowledge so the agent knows how the module ships. The
   *  agent does NOT execute deployment; its output is a branch, deployment is external. */
  deploy?: string;
  createdAt: string;
  updatedAt: string;
}

export function readModuleMeta(root: string, line: string, slug: string): ModuleMeta {
  return JSON.parse(readFile(moduleConfigPath(root, line, slug))) as ModuleMeta;
}

export function writeModuleMeta(root: string, line: string, slug: string, meta: ModuleMeta): void {
  writeFile(moduleConfigPath(root, line, slug), JSON.stringify(meta, null, 2) + "\n");
}

/** Slugs of all modules defined in a line (those with a module.json). */
export function listModuleSlugs(root: string, line: string): string[] {
  return listDirs(lineModulesDir(root, line))
    .map((d) => path.basename(d))
    .filter((s) => exists(moduleConfigPath(root, line, s)));
}

/** A patch for `updateModuleMeta` — the editable knowledge fields. `slug` and timestamps are
 *  immutable; the line is where the module physically lives, so it's not patchable either. */
export type ModuleMetaPatch = Partial<Pick<ModuleMeta, "type" | "source" | "deploy">>;

/** Merge a patch into a module's meta and persist it — the write path for correcting type /
 *  source / deploy after creation (e.g. the module-setup interview discovers better info).
 *  Only the knowledge fields are taken from the patch (also enforced at runtime — a JSON
 *  patch from the web route must not touch slug or timestamps). */
export function updateModuleMeta(
  root: string,
  line: string,
  slug: string,
  patch: ModuleMetaPatch,
  now: () => string = nowIso,
): ModuleMeta {
  const current = readModuleMeta(root, line, slug);
  const next = { ...current, updatedAt: now() };
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.deploy !== undefined) next.deploy = patch.deploy;
  writeModuleMeta(root, line, slug, next);
  return next;
}

/** Does the module's CLAUDE.md carry real, agent-written knowledge (vs missing / still the
 *  generated seed or legacy pointer)? The seed marks itself with an HTML comment that a real
 *  knowledge pass removes; the legacy pointer has its own marker. */
export function moduleClaudeMdReady(root: string, line: string, slug: string): boolean {
  const raw = readFileOr(path.join(moduleDir(root, line, slug), "CLAUDE.md")).trim();
  return !!raw && !raw.includes(LEGACY_POINTER_MARKER) && !raw.includes(SEED_MARKER);
}

/** Text the claude-md-module seed template contains — its presence means no session has
 *  distilled real knowledge into the file yet. */
export const SEED_MARKER = "bizagent:module-claude-md-seed";

/** Derived workspace status for list/card UIs — read straight off the module dir, nothing
 *  stored: did the setup conversation deliver its artifacts? `codeReady` = code/ holds a git
 *  checkout (setup phase 1), `claudeMd` = CLAUDE.md carries distilled knowledge (phase 3),
 *  `scriptCount` = operational scripts (phase 4). "Set up" is the UI's judgment; these are
 *  the facts. */
export interface ModuleStatus {
  codeReady: boolean;
  claudeMd: boolean;
  scriptCount: number;
}

export function moduleStatus(root: string, line: string, slug: string): ModuleStatus {
  return {
    // .git is a dir in a normal clone and a file in a worktree — exists() covers both.
    codeReady: exists(path.join(moduleCodeDir(root, line, slug), ".git")),
    claudeMd: moduleClaudeMdReady(root, line, slug),
    scriptCount: listFiles(path.join(moduleDir(root, line, slug), "scripts"), ".sh").length,
  };
}

/** The REAL directories of a business's linked modules — what a business session needs added to
 *  its sandbox (SDK `additionalDirectories` / CLI `--add-dir`) so it can READ module code and
 *  memory through the `modules/<name>` symlinks (whose targets sit outside the business cwd).
 *  Writes there are still denied by the guard hook (validateModuleDirWrite): read yes, change no.
 *  Module workspaces need nothing extra (cwd IS the module dir); a workspace with no meta (fresh
 *  trees, tests) just gets none. */
export function linkedModuleDirs(root: string, slug: string): string[] {
  if (parseModuleWorkspaceId(slug) || parseAssistantWorkspaceId(slug)) return [];
  try {
    const meta = readBusinessMeta(root, slug);
    return (meta.modules ?? []).map((m) => moduleDir(root, meta.line, m));
  } catch {
    return [];
  }
}

/** Businesses that link a module (any line) — derived by scanning business.json files, never
 *  stored. Used to resolve where a `biz module setup` session should run. */
export function businessesLinking(
  businesses: { slug: string; line: string }[],
  readMeta: (slug: string) => { modules?: string[] },
  mod: string,
): { slug: string; line: string }[] {
  return businesses.filter((b) => (readMeta(b.slug).modules ?? []).includes(mod));
}
