// Business-memory core — pure functions, zero runtime knowledge.
// Verbs: write / recall / assemble (+ internal readAll), plus promote in governance.
//   - write   : write with provenance (governance: source / confidence / writability)
//   - recall  : active retrieval (will become the MCP-tool face)
//   - assemble: materialize the workspace CLAUDE.md — a minimal pointer for a business
//               (its real context is injected at launch), the living knowledge doc SEED
//               for a module (whose CLAUDE.md carries real content, agent-maintained).
// Memory is BUSINESS-only: the launch context injects an index (id + description) and the
// agent Reads records on demand. Modules keep no records — their knowledge is CLAUDE.md.
import path from "node:path";
import { memoryDir, businessDir, parseModuleWorkspaceId, parseAssistantWorkspaceId } from "./paths";
import { exists, listFiles, readFile, readFileOr, writeFile } from "./fsutil";
import * as fm from "./frontmatter";
import { readBusinessMeta } from "./meta";
import { loadPrompt, renderPrompt } from "./prompts";
import { nowIso } from "./time";

/** Organizational layer: lifecycle + who may write. `module` is RETIRED for writes (a module's
 *  knowledge lives in its CLAUDE.md now) but stays in the union so legacy records still parse. */
export type Layer = "common" | "domain" | "business" | "module" | "session";

/** Text the legacy pointer CLAUDE.md template contains — used to tell "still the generated
 *  pointer" from "an agent put real content here" before seeding/overwriting. */
export const LEGACY_POINTER_MARKER = "injected at launch by `biz run`";

export interface MemoryRecord {
  id: string;
  scope: Layer;
  /** One-line summary (CC-memory style frontmatter `description`) — surfaced by list UIs. */
  description?: string;
  /** Record kind: fact | feedback | project | reference (frontmatter `type`). */
  type?: string;
  source_session?: string;
  confidence?: number;
  writable_by?: string;
  updated_at?: string;
  body: string;
}

function defaultNow(): string {
  return nowIso();
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertBusiness(root: string, slug: string): void {
  // A module workspace id (`mod:<line>:<mod>`) is a valid memory host too — its memory/ is the
  // module's own. parseModuleWorkspaceId validates the segments, so it skips the slug regex.
  if (!parseModuleWorkspaceId(slug) && !SLUG_RE.test(slug)) {
    throw new Error(`invalid business slug "${slug}" (lowercase letters/digits/hyphens, must start alnum).`);
  }
  if (!exists(businessDir(root, slug))) throw new Error(`no such workspace: ${slug}`);
}

function idFromBody(body: string, now: string): string {
  const slug = body
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = now.replace(/[^0-9]/g, "").slice(0, 14);
  return `${stamp}-${slug || "note"}`;
}

export interface WriteMemoryOptions {
  root: string;
  slug: string;
  body: string;
  /** One-line summary for the memory index (the launch context injects ONLY this line —
   *  the body is read on demand). Falls back to the body's first line when omitted. */
  description?: string;
  scope?: Layer;
  source_session?: string;
  confidence?: number;
  writable_by?: string;
  id?: string;
  now?: () => string;
}

/** First non-empty line of a body, truncated — the description fallback. */
function deriveDescription(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.length > 120 ? line.slice(0, 117) + "..." : line;
  }
  return "(empty record)";
}

export function writeMemory(o: WriteMemoryOptions): MemoryRecord {
  assertBusiness(o.root, o.slug);
  if (parseModuleWorkspaceId(o.slug)) {
    throw new Error(`module workspaces keep no memory records — maintain the module's CLAUDE.md instead.`);
  }
  const now = o.now ?? defaultNow;
  const stamp = now();
  const rec: MemoryRecord = {
    id: o.id ?? idFromBody(o.body, stamp),
    scope: o.scope ?? "business",
    description: o.description?.trim() || deriveDescription(o.body),
    source_session: o.source_session,
    confidence: o.confidence,
    writable_by: o.writable_by ?? "agent+human",
    updated_at: stamp,
    body: o.body.trim(),
  };
  const file = path.join(memoryDir(o.root, o.slug), `${rec.id}.md`);
  writeFile(
    file,
    fm.stringify(
      {
        scope: rec.scope,
        description: rec.description,
        source_session: rec.source_session,
        confidence: rec.confidence,
        writable_by: rec.writable_by,
        updated_at: rec.updated_at,
      },
      rec.body,
    ),
  );
  return rec;
}

/** Parse every `*.md` record in a memory directory. Used for the business's own `memory/`
 *  and for the `.bizagent/remote-memory/` cache of other users' shared records. */
export function readMemoryDir(dir: string): MemoryRecord[] {
  return listFiles(dir).map((file) => {
    const { data, body } = fm.parse(readFile(file));
    return {
      id: path.basename(file, ".md"),
      scope: (data.scope as Layer) ?? "business",
      description: typeof data.description === "string" && data.description ? data.description : undefined,
      type: typeof data.type === "string" && data.type ? data.type : undefined,
      source_session: data.source_session != null ? String(data.source_session) : undefined,
      confidence: typeof data.confidence === "number" ? data.confidence : undefined,
      writable_by: data.writable_by as string | undefined,
      updated_at: data.updated_at as string | undefined,
      body,
    } satisfies MemoryRecord;
  });
}

export function readAllMemory(root: string, slug: string): MemoryRecord[] {
  assertBusiness(root, slug);
  return readMemoryDir(memoryDir(root, slug));
}

export interface RecallOptions {
  root: string;
  slug: string;
  scope?: Layer;
  query?: string;
}

/** Active retrieval: filter by scope + naive substring match.
 *  No embeddings in v0 — that's a pluggable Retriever concern for later. */
export function recall(o: RecallOptions): MemoryRecord[] {
  return readAllMemory(o.root, o.slug).filter((r) => {
    if (o.scope && r.scope !== o.scope) return false;
    if (o.query && !r.body.toLowerCase().includes(o.query.toLowerCase())) return false;
    return true;
  });
}

/** Materialize the workspace CLAUDE.md.
 *
 *  Business: the minimal pointer (real context is injected at launch) — always rewritten,
 *  important info must not live in this editable file.
 *
 *  Module: CLAUDE.md IS the module's living knowledge doc (Claude Code's native idiom for a
 *  code repo), maintained by the module's own sessions and read on demand by linking
 *  businesses. Real content is never clobbered — only a missing file or the legacy pointer
 *  gets the seed skeleton.
 *
 *  Assistant: CLAUDE.md IS the assistant's persona, owned by the host that mounted the IM
 *  channel (it overwrites the seed right after newAssistant returns). Real content is never
 *  clobbered. */
export function assemble(o: { root: string; slug: string; write?: boolean }): string {
  const file = path.join(businessDir(o.root, o.slug), "CLAUDE.md");
  const aw = parseAssistantWorkspaceId(o.slug);
  if (aw) {
    const existing = readFileOr(file).trim();
    if (existing && !existing.includes(LEGACY_POINTER_MARKER)) return existing;
    const md = renderPrompt(loadPrompt("claude-md-assistant"), { IM: aw.im });
    if (o.write !== false) writeFile(file, md);
    return md;
  }
  const mw = parseModuleWorkspaceId(o.slug);
  if (mw) {
    const existing = readFileOr(file).trim();
    if (existing && !existing.includes(LEGACY_POINTER_MARKER)) return existing;
    const md = renderPrompt(loadPrompt("claude-md-module"), { MOD: mw.mod, LINE: mw.line });
    if (o.write !== false) writeFile(file, md);
    return md;
  }
  const meta = readBusinessMeta(o.root, o.slug);
  const md = renderPrompt(loadPrompt("claude-md"), { BUSINESS_NAME: meta.name, SLUG: meta.slug });
  if (o.write !== false) writeFile(file, md);
  return md;
}
