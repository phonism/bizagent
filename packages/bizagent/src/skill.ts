// Skills: Claude Code's native capability packages (.claude/skills/<name>/SKILL.md + scripts),
// managed as READ-ONLY files. The root's skills/ dir is the single source of truth, maintained
// outside the platform (edit files, redeploy/sync); every business gets ONE symlink
// (.claude/skills -> root skills/) so both runtimes discover them in the session cwd. The
// platform only displays them — there is deliberately no write API.
//
// Why files, not a DB: skills must be
// filesystem artifacts anyway — the SDK has no programmatic skill registration — so a DB copy
// would just be a second source of truth to keep honest. Same call as the run-mapping markers.
import fs from "node:fs";
import path from "node:path";
import { businessDir } from "./paths";
import { exists, mkdirp, symlinkRel, listDirs, readFileOr } from "./fsutil";
import * as fm from "./frontmatter";

export const rootSkillsDir = (root: string) => path.join(root, "skills");

const SKILL_MD = "SKILL.md";

/** One skill as the list/display sees it. `id` is the DIRECTORY name — the addressing key for
 *  routes/files; `name` is the SKILL.md frontmatter display name (may differ from the dir). */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** Number of files in the skill dir (SKILL.md included) — a cheap size hint for list UIs. */
  fileCount: number;
}

export interface SkillFileEntry {
  /** Path relative to the skill dir, posix separators. */
  path: string;
  size: number;
}

/** Idempotent: make sure the root skills dir exists and the business's .claude/skills points at
 *  it. Called at business creation AND at session launch, so businesses created before skills
 *  existed get wired on their next run. */
export function ensureSkillsLink(root: string, slug: string): void {
  mkdirp(rootSkillsDir(root));
  symlinkRel(path.join(businessDir(root, slug), ".claude", "skills"), rootSkillsDir(root));
}

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

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** SKILL.md descriptions in the wild use YAML block scalars (`description: >` + indented
 *  continuation lines) and quoted strings — forms the minimal generic frontmatter parser
 *  (built for the memory records IT writes) doesn't model. Extract just the description,
 *  faithfully enough for display. */
function skillDescription(raw: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return "";
  const lines = m[1].split("\n");
  const at = lines.findIndex((l) => l.startsWith("description:"));
  if (at === -1) return "";
  const inline = lines[at].slice("description:".length).trim();
  if (inline && !/^[>|][+-]?$/.test(inline)) return unquote(inline);
  const out: string[] = [];
  for (let j = at + 1; j < lines.length && /^(\s|$)/.test(lines[j]); j++) out.push(lines[j].trim());
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** Every skill under the root's skills/ — a dir counts when it holds a SKILL.md. */
export function listSkills(root: string): SkillInfo[] {
  return listDirs(rootSkillsDir(root))
    .filter((d) => exists(path.join(d, SKILL_MD)))
    .map((d) => {
      const raw = readFileOr(path.join(d, SKILL_MD));
      const { data } = fm.parse(raw);
      return {
        id: path.basename(d),
        name: typeof data.name === "string" && data.name ? unquote(data.name) : path.basename(d),
        description: skillDescription(raw),
        fileCount: walkFiles(d).length,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The skill's directory must be addressed by its DIR name (one safe path segment). */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function skillDir(root: string, name: string): string {
  if (!SAFE_SEGMENT.test(name)) throw new Error(`invalid skill name "${name}"`);
  return path.join(rootSkillsDir(root), name);
}

/** All files of one skill (relative paths + sizes), or null when the skill doesn't exist. */
export function skillFiles(root: string, name: string): SkillFileEntry[] | null {
  const dir = skillDir(root, name);
  if (!exists(path.join(dir, SKILL_MD))) return null;
  return walkFiles(dir)
    .map((f) => ({ path: path.relative(dir, f).split(path.sep).join("/"), size: fs.statSync(f).size }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One file of one skill, raw. Returns null when absent; throws on traversal or anything whose
 *  real location escapes the skill dir (same defense as the hub's file surface). */
export function readSkillFile(root: string, name: string, relPath: string): string | null {
  const dir = skillDir(root, name);
  const rel = relPath.replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`invalid path "${relPath}"`);
  }
  const abs = path.join(dir, ...rel.split("/"));
  if (!exists(abs)) return null;
  if (fs.lstatSync(abs).isSymbolicLink() || !fs.statSync(abs).isFile()) throw new Error(`not a file: "${rel}"`);
  if (!fs.realpathSync(abs).startsWith(fs.realpathSync(dir) + path.sep)) {
    throw new Error(`path escapes skill dir: "${rel}"`);
  }
  return fs.readFileSync(abs, "utf8");
}
