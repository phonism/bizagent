// Knowledge — the business's curated docs, READ-ONLY for the platform (the skills stance:
// agents and curators write the files, the platform only displays them; deliberately no write
// API). A business sees one flat knowledge/ tree assembled from three layers — its own
// knowledge/business/ plus symlinks to the line's and the root's common layer. The browse
// surface lists them PER LAYER, addressed at their real locations, so a UI can label ownership
// (business-owned vs shared/curator-only) instead of flattening it away.
import fs from "node:fs";
import path from "node:path";
import { KNOWLEDGE, COMMON, businessDir, businessLine, commonKnowledge, lineKnowledge, linesDir, listLineSlugs, parseModuleWorkspaceId, parseAssistantWorkspaceId, assistantDir } from "./paths";
import { exists, symlinkRel } from "./fsutil";
import * as fm from "./frontmatter";

export type KnowledgeLayerKind = "business" | "line" | "common";

export interface KnowledgeFileEntry {
  /** Path relative to the layer dir, posix separators. */
  path: string;
  size: number;
  /** The doc's frontmatter `description:` when present (markdown files only) — what the launch
   *  context's knowledge index shows next to the filename. */
  description?: string;
  /** When this entry is a directory's `_index.md` standing in for the whole subdirectory,
   *  the number of files (recursively) it represents. Lets the launch index show `(N files)`
   *  so the agent knows how much it's folding away before deciding to Glob. */
  foldedCount?: number;
}

export interface KnowledgeLayer {
  layer: KnowledgeLayerKind;
  /** Display label: the business slug / line slug / "common". */
  name: string;
  files: KnowledgeFileEntry[];
}

/** Recursively count files (for foldedCount on `_index.md` rollups). Mirrors walkFiles's
 *  filters (skip dotfiles + symlinks) so the count matches what an un-folded walk would see. */
function countFiles(dir: string): number {
  if (!exists(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) n += countFiles(p);
    else if (e.isFile()) n += 1;
  }
  return n;
}

/** Walk a knowledge layer dir; ANY subdirectory containing `_index.md` is folded down to
 *  just that one file (the `_index.md` stands in for the whole subtree, so the launch index
 *  doesn't enumerate dictionaries like `caliber/<table>.md` — the curator writes one
 *  `_index.md` that says how to query, and the agent Globs on demand). The top-level layer
 *  dir is never folded — `_index.md` at the root degrades to a regular file.
 *
 *  `expand: true` disables the fold — every file is enumerated. The launch index keeps the
 *  default (folded; saves agent prompt tokens), but the UI passes expand=true so a curator
 *  browsing in the web UI can actually see each `caliber/<table>.md` rather than just the
 *  index stand-in. */
function walkFiles(dir: string, opts: { expand: boolean }, out: string[] = [], isRoot = true): string[] {
  if (!exists(dir)) return out;
  if (!isRoot && !opts.expand) {
    const idx = path.join(dir, "_index.md");
    if (fs.existsSync(idx) && fs.statSync(idx).isFile()) {
      out.push(idx);
      return out;
    }
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(p, opts, out, false);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** A layer's directory at its REAL location (never through a business's symlinks). Scope by
 *  `slug` (business view) or `line` (line view); undefined when the layer doesn't apply. */
function resolveLayerDir(root: string, layer: KnowledgeLayerKind, scope: { slug?: string; line?: string }): string | undefined {
  if (layer === "common") return commonKnowledge(root);
  if (layer === "business") return scope.slug ? path.join(businessDir(root, scope.slug), "knowledge", "business") : undefined;
  const line = scope.line ?? (scope.slug ? businessLine(root, scope.slug) : undefined);
  return line ? lineKnowledge(root, line) : undefined;
}

// Description extraction stays bounded: oversized files are listed without one rather than
// read in full just to render an index line.
const DESCRIPTION_READ_CAP = 64 * 1024;

function fileDescription(p: string, size: number): string | undefined {
  if (!p.endsWith(".md") || size > DESCRIPTION_READ_CAP) return undefined;
  try {
    const { data } = fm.parse(fs.readFileSync(p, "utf8"));
    return typeof data.description === "string" && data.description ? data.description : undefined;
  } catch {
    return undefined;
  }
}

function listLayer(layer: KnowledgeLayerKind, name: string, dir: string, opts: { expand: boolean } = { expand: false }): KnowledgeLayer {
  return {
    layer,
    name,
    files: walkFiles(dir, opts)
      .map((f) => {
        const size = fs.statSync(f).size;
        const entry: KnowledgeFileEntry = {
          path: path.relative(dir, f).split(path.sep).join("/"),
          size,
          description: fileDescription(f, size),
        };
        // A subdirectory `_index.md` represents that whole subtree — surface its rollup count
        // so the launch index can show `(N files)` next to the folded line. Skip when expanded:
        // every file is already enumerated, so `(N files)` would just be noise.
        if (!opts.expand && path.basename(f) === "_index.md" && path.dirname(f) !== dir) {
          entry.foldedCount = countFiles(path.dirname(f)) - 1; // minus _index.md itself
        }
        return entry;
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** The three knowledge layers a business sees (business / line / common), each listed at its
 *  real location. Layers that don't exist yet list as empty — the UI decides what to show.
 *  `expand: true` (the UI default at the HTTP boundary) enumerates `_index.md`-folded
 *  subtrees so a curator can browse each file; the launch context keeps the fold to save tokens. */
export function listKnowledge(root: string, slug: string, opts: { expand?: boolean } = {}): KnowledgeLayer[] {
  const o = { expand: !!opts.expand };
  return (["business", "line", "common"] as const)
    .map((l) => {
      const dir = resolveLayerDir(root, l, { slug });
      if (!dir) return null;
      const name = l === "business" ? slug : l === "common" ? "common" : (businessLine(root, slug) as string);
      return listLayer(l, name, dir, o);
    })
    .filter((l): l is KnowledgeLayer => l !== null);
}

/** The SHARED layers at line scope (line + common) — the platform's "知识库" tab, no business
 *  in sight. A business's own docs stay on the business surface (listKnowledge). */
export function listLineKnowledge(root: string, line: string, opts: { expand?: boolean } = {}): KnowledgeLayer[] {
  const o = { expand: !!opts.expand };
  return (["line", "common"] as const).map((l) =>
    listLayer(l, l === "common" ? "common" : line, resolveLayerDir(root, l, { line }) as string, o),
  );
}

/** The line a workspace belongs to: parsed straight out of a module workspace id, located
 *  on disk for a business slug. Undefined when the workspace doesn't resolve. */
function workspaceLine(root: string, slug: string): string | undefined {
  const mw = parseModuleWorkspaceId(slug);
  return mw ? mw.line : businessLine(root, slug);
}

/** The knowledge layers ANY workspace sees — business: business + line + common; module
 *  workspace (`mod:<line>:<mod>`): line + common (modules have no layer of their own; their
 *  technical knowledge lives in module memory); assistant workspace (`assistant:<im>`): common
 *  + EVERY product line — assistants cut across lines, so the platform's whole curated
 *  knowledge is in scope. Feeds the launch context's knowledge index. */
export function workspaceKnowledgeLayers(root: string, slug: string): KnowledgeLayer[] {
  const aw = parseAssistantWorkspaceId(slug);
  if (aw) {
    return [
      listLayer("common", "common", commonKnowledge(root)),
      ...listLineSlugs(root).map((line) => listLayer("line", line, lineKnowledge(root, line))),
    ];
  }
  const mw = parseModuleWorkspaceId(slug);
  if (!mw) return listKnowledge(root, slug);
  return (["line", "common"] as const).map((l) =>
    listLayer(l, l === "common" ? "common" : mw.line, resolveLayerDir(root, l, { line: mw.line }) as string),
  );
}

/** Idempotent: make sure a workspace's `knowledge/common` and `knowledge/<line>` symlinks
 *  exist. Businesses get them at creation (newBusiness); module workspaces predate the
 *  convention entirely — session launch calls this so every conversation, business or module,
 *  sees the shared knowledge tree. Assistants cut across lines — they get common + a symlink
 *  per product line, so a new line added later is picked up on the next session start. No-op
 *  when the workspace's line can't be resolved. */
export function ensureKnowledgeLinks(root: string, slug: string): void {
  const aw = parseAssistantWorkspaceId(slug);
  if (aw) {
    const dir = assistantDir(root, aw.im);
    symlinkRel(path.join(dir, KNOWLEDGE, COMMON), commonKnowledge(root));
    for (const line of listLineSlugs(root)) {
      symlinkRel(path.join(dir, KNOWLEDGE, line), lineKnowledge(root, line));
    }
    return;
  }
  const line = workspaceLine(root, slug);
  if (!line) return;
  const dir = businessDir(root, slug); // resolves module workspace ids too
  symlinkRel(path.join(dir, KNOWLEDGE, COMMON), commonKnowledge(root));
  symlinkRel(path.join(dir, KNOWLEDGE, line), lineKnowledge(root, line));
}

/** The shared layers' REAL dirs (symlink targets sit outside the workspace cwd) — granted as
 *  additionalDirectories so reads through the workspace's `knowledge/` mounts stay in-scope
 *  for the sandbox. Writes are still denied by the guard hook (curator-only layers).
 *  Assistants get the whole `lines/` tree too: pulse metric definitions live at
 *  `lines/<line>/businesses/<slug>/pulse/metrics/`, business memory/knowledge sit under those
 *  directories, and an IM assistant routinely needs to read across that space to answer. */
export function knowledgeLayerDirs(root: string, slug: string): string[] {
  const aw = parseAssistantWorkspaceId(slug);
  if (aw) return [commonKnowledge(root), linesDir(root)];
  const line = workspaceLine(root, slug);
  return [commonKnowledge(root), ...(line ? [lineKnowledge(root, line)] : [])];
}

/** Safe single-file read against one layer dir (the hub/skills defense). */
function readLayerFile(dir: string, relPath: string): string | null {
  const rel = relPath.replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`invalid path "${relPath}"`);
  }
  const abs = path.join(dir, ...rel.split("/"));
  if (!exists(abs)) return null;
  if (fs.lstatSync(abs).isSymbolicLink() || !fs.statSync(abs).isFile()) throw new Error(`not a file: "${rel}"`);
  if (!fs.realpathSync(abs).startsWith(fs.realpathSync(dir) + path.sep)) {
    throw new Error(`path escapes knowledge layer: "${rel}"`);
  }
  return fs.readFileSync(abs, "utf8");
}

/** One knowledge file of a business's tree, raw. Returns null when absent; throws on traversal
 *  or anything whose real location escapes the layer dir. */
export function readKnowledgeFile(root: string, slug: string, layer: KnowledgeLayerKind, relPath: string): string | null {
  const dir = resolveLayerDir(root, layer, { slug });
  return dir ? readLayerFile(dir, relPath) : null;
}

/** One shared-layer file at line scope (the 知识库 tab's read path). */
export function readLineKnowledgeFile(root: string, line: string, layer: Exclude<KnowledgeLayerKind, "business">, relPath: string): string | null {
  const dir = resolveLayerDir(root, layer, { line });
  return dir ? readLayerFile(dir, relPath) : null;
}
