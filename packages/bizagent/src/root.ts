// root / business scaffolding — core pure functions.
// Both the CLI (`biz init` / `biz new`) and the programmatic API call these two
// functions, so feature parity is structural rather than separately maintained.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  COMMON,
  BUSINESSES,
  rootConfigPath,
  commonKnowledge,
  linesDir,
  lineDir,
  lineKnowledge,
  lineModulesDir,
  lineBusinessesDir,
  lineMetaPath,
  listLineSlugs,
  businessDir,
  businessDirIn,
  moduleDir,
  moduleConfigPath,
  moduleCodeDir,
  moduleWorkspaceId,
  businessModulesDir,
  assistantDir,
  assistantConfigPath,
  assistantWorkspaceId,
} from "./paths";
import { mkdirp, exists, writeFile, readFileOr, symlinkRel, listDirs } from "./fsutil";
import { writeBusinessMeta, readBusinessMeta, BusinessMeta } from "./meta";
import { writeModuleMeta } from "./module";
import { writeAssistantMeta, AssistantMeta } from "./assistant";
import { assemble } from "./memory";
import { ensureSkillsLink } from "./skill";
import { nowIso } from "./time";

function defaultNow(): string {
  return nowIso();
}

// ─────────────────────────── init root ───────────────────────────

export interface InitRootOptions {
  root: string;
  /** Web platform settings — written so `biz web` serves the root out of the box. */
  web?: { port?: number; host?: string };
  /** Optional sharing config (the `remote` block, see remote.ts) — init a root that's a
   *  multi-user platform from the start. Written verbatim. */
  remote?: Record<string, unknown>;
  now?: () => string;
}

export interface InitRootResult {
  root: string;
  configPath: string;
  created: string[];
}

export function initRoot(o: InitRootOptions): InitRootResult {
  const now = o.now ?? defaultNow;
  const root = path.resolve(o.root);
  if (exists(rootConfigPath(root))) {
    throw new Error(`already a bizagent root (found ${CONFIG_FILE}): ${root}`);
  }
  const created: string[] = [];

  mkdirp(commonKnowledge(root));
  created.push("knowledge/common/");
  mkdirp(linesDir(root));
  created.push("lines/");

  const config: Record<string, unknown> = {
    version: 1,
    store: "filesystem",
    createdAt: now(),
  };
  if (o.web) config.web = { port: o.web.port ?? 4317, host: o.web.host ?? "127.0.0.1" };
  if (o.remote) config.remote = o.remote;

  writeFile(rootConfigPath(root), JSON.stringify(config, null, 2) + "\n");
  created.push(CONFIG_FILE);

  return { root, configPath: rootConfigPath(root), created };
}

// ─────────────────────────── lines ───────────────────────────

/** A line's display metadata, lines/<line>/line.json. The file is OPTIONAL — a line is
 *  fundamentally just a directory, and one without (or with malformed) meta reads as its slug. */
export interface LineMeta {
  slug: string;
  /** Display name (e.g. the Chinese product-line name); the slug stays the dir/URL identity. */
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Create a product line: a real directory holding the line's knowledge layer, its modules,
 *  and its businesses. Idempotent — `created: false` when the line already exists (so lazy
 *  creation from `newBusiness` / `newModule` and an explicit `biz line new` share this).
 *  Passing `name` (re)writes line.json — re-running create with a name is also how a
 *  pre-existing slug-only line gets its display name. */
export function newLine(o: { root: string; line: string; name?: string }): { line: string; dir: string; created: boolean } {
  const root = path.resolve(o.root);
  if (!exists(rootConfigPath(root))) {
    throw new Error(`not a bizagent root (no ${CONFIG_FILE}): ${root}. Run \`biz init\` first.`);
  }
  assertSlug("line", o.line);
  const dir = lineDir(root, o.line);
  const created = !exists(dir);
  mkdirp(lineKnowledge(root, o.line));
  mkdirp(lineModulesDir(root, o.line));
  mkdirp(lineBusinessesDir(root, o.line));
  const name = o.name?.trim();
  if (name) {
    const prior = readLineMeta(root, o.line);
    const now = defaultNow();
    const meta: LineMeta = { slug: o.line, name, createdAt: prior?.createdAt ?? now, updatedAt: now };
    writeFile(lineMetaPath(root, o.line), JSON.stringify(meta, null, 2) + "\n");
  }
  return { line: o.line, dir, created };
}

/** line.json parsed, or undefined when absent/malformed (both read as "no display name"). */
function readLineMeta(root: string, line: string): Partial<LineMeta> | undefined {
  const raw = readFileOr(lineMetaPath(root, line), "");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Partial<LineMeta>;
  } catch {
    return undefined;
  }
}

/** Every product line with its display name (line.json's, else the slug) — the web picker's
 *  read model, the line analog of `listBusinesses`. */
export function listLines(root: string): { slug: string; name: string }[] {
  return listLineSlugs(root).map((slug) => {
    const name = readLineMeta(root, slug)?.name;
    return { slug, name: typeof name === "string" && name ? name : slug };
  });
}

/** Every business in the root (slug + line + display name + the opaque `ext` bag) —
 *  for the web picker and any "list the businesses" view. Scans every line; slugs are globally
 *  unique. `ext` rides along so a list/card UI can show an app's per-business display data
 *  without an extra round-trip per card. */
export function listBusinesses(
  root: string,
): { slug: string; line: string; name: string; domain?: string; modules: string[]; updatedAt?: string; ext?: Record<string, unknown> }[] {
  return listLineSlugs(root).flatMap((line) =>
    listDirs(lineBusinessesDir(root, line))
      .map((d) => path.basename(d))
      .filter((slug) => exists(path.join(businessDirIn(root, line, slug), "business.json")))
      .map((slug) => {
        const m = readBusinessMeta(root, slug);
        // `modules` rides along so a UI can resolve a module's host businesses (which businesses link
        // it) without an extra round-trip per business. `domain`/`updatedAt` let a card render its
        // subtitle + relative time without fetching each business's full meta.
        return { slug, line, name: m.name, domain: m.domain, modules: m.modules ?? [], updatedAt: m.updatedAt, ext: m.ext };
      }),
  );
}

/** Delete a business: remove its whole directory (meta, memory, knowledge, deliverables). Guards
 *  against path traversal — the resolved target must sit exactly at lines/<line>/businesses/<slug>
 *  and hold a business.json, so a crafted slug can't escape the root tree. Throws if the business
 *  doesn't exist. The session content in Claude Code's jsonl is the host's to clean up. */
export function deleteBusiness(root: string, slug: string): void {
  assertSlug("business slug", slug);
  const resolved = path.resolve(businessDir(root, slug));
  const okShape =
    path.basename(resolved) === slug &&
    path.basename(path.dirname(resolved)) === BUSINESSES &&
    path.dirname(path.dirname(path.dirname(resolved))) === path.resolve(linesDir(root));
  if (!okShape || !exists(path.join(resolved, "business.json"))) throw new Error(`no such business: ${slug}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

// ─────────────────────────── root overview ───────────────────────────

/** This package's version, read from package.json (one level up from both src/ and dist/, so it
 *  resolves the same whether running via tsx in dev or the bundled dist). */
export function bizVersion(): string {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileOr(pkg) || "{}") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface RootSummary {
  root: string;
  version: string;
  businesses: number;
}

/** A one-glance root overview: where it is, which biz version, how many businesses. Powers
 *  `biz status` and the web `GET /api/health`. */
export function rootSummary(root: string): RootSummary {
  return { root: path.resolve(root), version: bizVersion(), businesses: listBusinesses(root).length };
}

// ─────────────────────────── new business ───────────────────────────

export interface NewBusinessOptions {
  root: string;
  slug: string;
  /** The product line this business belongs to — required; a business always lives inside a
   *  line (`lines/<line>/businesses/<slug>/`). The line is lazily created on first use. */
  line: string;
  name?: string;
  domain?: string;
  /** Modules to link (must already exist in the SAME line via newModule). Each is symlinked
   *  in for analysis. */
  modules?: string[];
  now?: () => string;
}

export interface NewBusinessResult {
  slug: string;
  dir: string;
  created: string[];
  symlinks: string[];
  lineCreatedLazily: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertSlug(kind: string, slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid ${kind} "${slug}" (lowercase letters/digits/hyphens, must start alnum).`);
  }
}

export function newBusiness(o: NewBusinessOptions): NewBusinessResult {
  const now = o.now ?? defaultNow;
  const root = path.resolve(o.root);
  if (!exists(rootConfigPath(root))) {
    throw new Error(`not a bizagent root (no ${CONFIG_FILE}): ${root}. Run \`biz init\` first.`);
  }
  assertSlug("slug", o.slug);
  if (!o.line) throw new Error(`a business must belong to a product line (pass line / --line).`);
  assertSlug("line", o.line);
  // Slugs are globally unique across lines — the scan checks every line.
  if (exists(businessDir(root, o.slug))) throw new Error(`business already exists: ${o.slug}`);

  // Lazily create the line (its knowledge/modules/businesses skeleton).
  const lineCreatedLazily = newLine({ root, line: o.line }).created;

  const dir = businessDirIn(root, o.line, o.slug);
  const created: string[] = [];
  const symlinks: string[] = [];

  for (const sub of ["knowledge/business", "memory", ".bizagent/deliverables", ".claude"]) {
    mkdirp(path.join(dir, sub));
    created.push(sub + "/");
  }

  // Symlink shared layers in, so the agent sees one flat knowledge/ tree.
  symlinkRel(path.join(dir, "knowledge", COMMON), commonKnowledge(root));
  symlinks.push("knowledge/common");
  symlinkRel(path.join(dir, "knowledge", o.line), lineKnowledge(root, o.line));
  symlinks.push(`knowledge/${o.line}`);

  const meta: BusinessMeta = {
    name: o.name ?? o.slug,
    slug: o.slug,
    line: o.line,
    domain: o.domain,
    createdAt: now(),
    updatedAt: now(),
  };
  writeBusinessMeta(root, o.slug, meta);
  created.push("business.json");

  // Materialize the cross-runtime contract files.
  writeFile(path.join(dir, ".claude", "settings.json"), SETTINGS_JSON);
  created.push(".claude/settings.json");
  // Root-level skills (read-only capability packages), discovered by both runtimes via cwd.
  ensureSkillsLink(root, o.slug);
  symlinks.push(".claude/skills");
  assemble({ root, slug: o.slug }); // writes CLAUDE.md (passive-injection baseline)
  created.push("CLAUDE.md");

  // Link the requested modules (must already exist). Each is symlinked in for analysis.
  for (const m of o.modules ?? []) {
    linkModule({ root, biz: o.slug, module: m, now });
    symlinks.push(`modules/${m}`);
  }

  return { slug: o.slug, dir, created, symlinks, lineCreatedLazily };
}

// ─────────────────────────── modules ───────────────────────────

export interface NewModuleOptions {
  root: string;
  slug: string;
  /** The product line this module belongs to — required; modules live inside a line
   *  (`lines/<line>/modules/<slug>/`) and never cross lines. Lazily created. */
  line: string;
  /** Free-form type: strategy / backend / frontend / data / ... */
  type: string;
  /** Where the code lives and how to obtain it — free text, knowledge only (see ModuleMeta). */
  source?: string;
  /** Deployment info — surfaced as knowledge; the agent does not execute it. */
  deploy?: string;
  now?: () => string;
}

export interface NewModuleResult {
  slug: string;
  line: string;
  dir: string;
  created: string[];
}

/** Create a line-level module: code/ (vendored git repo goes here), module.json, and the seed
 *  CLAUDE.md — the module's living knowledge doc, filled in by the module's own sessions. */
export function newModule(o: NewModuleOptions): NewModuleResult {
  const now = o.now ?? defaultNow;
  const root = path.resolve(o.root);
  if (!exists(rootConfigPath(root))) {
    throw new Error(`not a bizagent root (no ${CONFIG_FILE}): ${root}. Run \`biz init\` first.`);
  }
  assertSlug("module slug", o.slug);
  if (!o.line) throw new Error(`a module must belong to a product line (pass line / --line).`);
  assertSlug("line", o.line);
  newLine({ root, line: o.line });
  if (exists(moduleDir(root, o.line, o.slug))) throw new Error(`module already exists in line ${o.line}: ${o.slug}`);

  const created: string[] = [];
  mkdirp(moduleCodeDir(root, o.line, o.slug));
  created.push("code/");
  writeModuleMeta(root, o.line, o.slug, {
    slug: o.slug,
    type: o.type,
    source: o.source,
    deploy: o.deploy,
    createdAt: now(),
    updatedAt: now(),
  });
  created.push("module.json");
  assemble({ root, slug: moduleWorkspaceId(o.line, o.slug) }); // seed CLAUDE.md (living knowledge doc)
  created.push("CLAUDE.md");

  return { slug: o.slug, line: o.line, dir: moduleDir(root, o.line, o.slug), created };
}

/** Link a module to a business (many-to-many, same line only): record it in business.json and
 *  symlink the module in for read/analysis. The module is resolved in the BUSINESS's line —
 *  modules never link across lines. Idempotent. */
export function linkModule(o: { root: string; biz: string; module: string; now?: () => string }): { symlinked: boolean } {
  const root = path.resolve(o.root);
  assertSlug("business slug", o.biz);
  assertSlug("module slug", o.module);
  if (!exists(businessDir(root, o.biz))) throw new Error(`no such business: ${o.biz}`);

  const meta = readBusinessMeta(root, o.biz);
  const line = meta.line;
  if (!exists(moduleConfigPath(root, line, o.module)))
    throw new Error(
      `no such module in line ${line}: ${o.module} (create it with \`biz module new ${o.module} --line ${line}\`; modules never cross lines)`,
    );

  const mods = meta.modules ?? [];
  if (!mods.includes(o.module)) {
    meta.modules = [...mods, o.module];
    meta.updatedAt = (o.now ?? defaultNow)();
    writeBusinessMeta(root, o.biz, meta);
  }
  mkdirp(businessModulesDir(root, o.biz));
  const symlinked = symlinkRel(path.join(businessModulesDir(root, o.biz), o.module), moduleDir(root, line, o.module));
  return { symlinked };
}

/** Unlink a module from a business: drop it from business.json's modules[] and remove the symlink.
 *  Idempotent — a no-op if it wasn't linked. The module itself (lines/<line>/modules/<slug>) is
 *  left intact; only THIS business's link to it is removed. */
export function unlinkModule(o: { root: string; biz: string; module: string; now?: () => string }): { unlinked: boolean } {
  const root = path.resolve(o.root);
  assertSlug("business slug", o.biz);
  assertSlug("module slug", o.module);
  if (!exists(businessDir(root, o.biz))) throw new Error(`no such business: ${o.biz}`);

  const meta = readBusinessMeta(root, o.biz);
  const mods = meta.modules ?? [];
  const had = mods.includes(o.module);
  if (had) {
    meta.modules = mods.filter((m) => m !== o.module);
    meta.updatedAt = (o.now ?? defaultNow)();
    writeBusinessMeta(root, o.biz, meta);
  }
  // Remove just the symlink (force: a no-op when absent); the module's own dir is never touched.
  fs.rmSync(path.join(businessModulesDir(root, o.biz), o.module), { force: true });
  return { unlinked: had };
}

// ─────────────────────────── assistants ───────────────────────────

export interface NewAssistantOptions {
  root: string;
  /** Channel slug, e.g. "infoflow" / "slack" / "wecom". Becomes the directory name and the
   *  trailing segment of the workspace id (`assistant:<im>`). */
  im: string;
  /** Display name; defaults to the slug. */
  name?: string;
  now?: () => string;
}

export interface NewAssistantResult {
  slug: string;
  /** The workspace id `assistant:<im>`. */
  ws: string;
  dir: string;
  created: string[];
  symlinks: string[];
}

/** Create a platform-level IM-channel assistant workspace: `<root>/assistants/<im>/` holding
 *  assistant.json (channel meta), the .claude/ hook wiring (so Stop hooks index worklogs and
 *  the guard hook enforces memory governance — same contract as business / module), a
 *  symlinked skills/ for capability packs, and the seed CLAUDE.md (the host that mounts the
 *  channel overwrites it with the channel's persona). Throws when the assistant already
 *  exists — callers detect first vs subsequent through the assistant.json existence check. */
export function newAssistant(o: NewAssistantOptions): NewAssistantResult {
  const now = o.now ?? defaultNow;
  const root = path.resolve(o.root);
  if (!exists(rootConfigPath(root))) {
    throw new Error(`not a bizagent root (no ${CONFIG_FILE}): ${root}. Run \`biz init\` first.`);
  }
  assertSlug("assistant im", o.im);
  if (exists(assistantConfigPath(root, o.im))) throw new Error(`assistant already exists: ${o.im}`);

  const ws = assistantWorkspaceId(o.im);
  const dir = assistantDir(root, o.im);
  const created: string[] = [];
  const symlinks: string[] = [];

  for (const sub of [".bizagent/deliverables", ".claude"]) {
    mkdirp(path.join(dir, sub));
    created.push(sub + "/");
  }

  const meta: AssistantMeta = {
    slug: o.im,
    im: o.im,
    name: o.name,
    createdAt: now(),
    updatedAt: now(),
  };
  writeAssistantMeta(root, o.im, meta);
  created.push("assistant.json");

  writeFile(path.join(dir, ".claude", "settings.json"), SETTINGS_JSON);
  created.push(".claude/settings.json");
  ensureSkillsLink(root, ws);
  symlinks.push(".claude/skills");
  assemble({ root, slug: ws }); // seed CLAUDE.md (the host overwrites with the channel's persona)
  created.push("CLAUDE.md");

  return { slug: o.im, ws, dir, created, symlinks };
}

// ─────────────────────────── materialization templates ───────────────────────────

// Hook wiring (implemented in src/governance.ts, invoked via `biz hook ...`):
//   - UserPromptSubmit       -> inject: surface other sessions' new work each turn
//   - PreToolUse(Write|Edit) -> guard:  enforce memory write governance
//   - Stop                   -> stop:   require the worklog (block once if missing),
//                                        then index the finished session
// The SDK runtime wires the same logic via its hook callbacks calling core directly.
const SETTINGS_JSON =
  JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "biz hook inject --business ." }] }],
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "biz hook guard --business ." }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "biz hook stop --business ." }] }],
      },
    },
    null,
    2,
  ) + "\n";
