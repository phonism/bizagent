// Assembles the launch context that biz injects via --append-system-prompt.
// Everything important lives here (business memory, block protocol, memory rules,
// past sessions, worklog) — not in CLAUDE.md, which is an editable file. This module
// reads the editable sources (memory/ records, the worklog index, *.custom.md overrides)
// and fills the locked prompts/system.md template.
import path from "node:path";
import { worklogIndexPath, remoteMemoryDir, parseModuleWorkspaceId, parseAssistantWorkspaceId, businessDir } from "./paths";
import { readFileOr, listFiles } from "./fsutil";
import { readBusinessMeta } from "./meta";
import { readAssistantMeta } from "./assistant";
import { workspaceKnowledgeLayers, KnowledgeLayer } from "./knowledge";
import { readAllMemory, readMemoryDir, MemoryRecord, LEGACY_POINTER_MARKER } from "./memory";
import { readModuleMeta, ModuleMeta, SEED_MARKER } from "./module";
import { listRuns, readWorklog } from "./governance";
import { readRequirementDoc } from "./requirement";
import { loadPrompt, renderPrompt, resolveCustom, buildWorklogPrompt } from "./prompts";

/** A record's one-line hook for the index: its frontmatter `description`, else the first
 *  non-empty body line, truncated. The index must stay one line per record. */
function indexHook(r: MemoryRecord): string {
  const desc = r.description?.trim();
  if (desc) return desc;
  for (const raw of r.body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.length > 120 ? line.slice(0, 117) + "..." : line;
  }
  return "(empty record)";
}

/** Render business memory as an INDEX, not full content (CC MEMORY.md style): one line per
 *  record — the readable file path plus its description hook. Bodies stay on disk; the agent
 *  Reads a record's file before relying on it. `remoteIds` marks records living in the
 *  `.bizagent/remote-memory/` cache so the index line points at the right path. */
export function renderBusinessMemory(business: MemoryRecord[], remoteIds?: ReadonlySet<string>): string {
  if (business.length === 0) {
    return "_No business memory yet. Record reusable findings as `memory/<kebab-slug>.md` (scope: business)._";
  }
  const lines: string[] = [];
  for (const r of business) {
    const file = remoteIds?.has(r.id) ? `.bizagent/remote-memory/${r.id}.md` : `memory/${r.id}.md`;
    lines.push(`- \`${file}\`${r.type ? ` _(${r.type})_` : ""} — ${indexHook(r)}`);
  }
  return lines.join("\n");
}

function readIndex(root: string, slug: string): string {
  return readFileOr(worklogIndexPath(root, slug)).trim();
}

/** Render the linked modules as an index line each: type, source and deploy info (knowledge
 *  only), plus where the module's distilled knowledge lives. Content is NOT inlined — the
 *  agent Reads `modules/<name>/CLAUDE.md` when the work actually touches the module. */
function renderModules(mods: ModuleMeta[]): string {
  return mods
    .map(
      (meta) =>
        `- **${meta.slug}** — ${meta.type}.` +
        `${meta.source ? ` Source: ${meta.source}` : ""}` +
        `${meta.deploy ? ` Deploy: ${meta.deploy}` : ""}` +
        ` Knowledge: \`modules/${meta.slug}/CLAUDE.md\`.`,
    )
    .join("\n");
}

/** Build the modules section: the business's linked modules (read-only master mounted under
 *  `modules/<name>/`, develop via a per-requirement worktree). Empty when none are linked.
 *  The dev branch is named after the requirement when the session runs under one — so a later
 *  session on the same requirement continues the same branch — else after this run. */
export function buildModulesPrompt(o: { root: string; slug: string; runId: string; req?: string }): string {
  const meta = readBusinessMeta(o.root, o.slug);
  const slugs = meta.modules ?? [];
  if (!slugs.length) return "";
  // Modules live in the business's own line (they never cross lines).
  const mods = slugs.map((m) => readModuleMeta(o.root, meta.line, m));
  return renderPrompt(loadPrompt("modules"), { MODULES_LIST: renderModules(mods), RUN_ID: o.runId, REQ_REF: o.req ?? o.runId });
}

// How many sibling sessions' worklogs are injected in FULL. The requirement doc's "current
// state" carries the distilled history, so older sessions stay reachable through the index and
// grep without bloating every launch context.
const SIBLING_WORKLOGS_FULL = 5;

/** Build the requirement section: the requirement's living state doc in full, plus the most
 *  recent sibling sessions' worklogs (this requirement only). Empty when the session has no
 *  requirement. */
function buildRequirementPrompt(o: { root: string; slug: string; runId: string; req?: string }): string {
  if (!o.req) return "";
  const doc = readRequirementDoc(o.root, o.slug, o.req) ?? "_(state document missing — create requirement.md first thing)_";
  const sibs = listRuns(o.root, o.slug).filter((r) => r.req === o.req && r.runId !== o.runId);
  const recent = sibs.slice(0, SIBLING_WORKLOGS_FULL).reverse(); // newest-first list -> render oldest-first
  const blocks = recent.map((r) => {
    const wl = readWorklog(o.root, o.slug, r.runId);
    return `### ${r.runId}\n\n${wl ?? "_(no worklog)_"}`;
  });
  const skipped = sibs.length - recent.length;
  if (skipped > 0) blocks.unshift(`_(${skipped} earlier session(s) omitted — see the index / their worklog files.)_`);
  return renderPrompt(loadPrompt("requirement-context"), {
    REQ_ID: o.req,
    REQUIREMENT_DOC: doc,
    SIBLING_WORKLOGS: blocks.length ? blocks.join("\n\n") : "_None yet — this is the first session on this requirement._",
  });
}

/** One layer's index block: the path the WORKSPACE sees (through its knowledge/ mounts), the
 *  layer's scope label, and each file with its frontmatter description. */
function renderKnowledgeLayer(l: KnowledgeLayer): string {
  const dir = l.layer === "business" ? "knowledge/business/" : l.layer === "common" ? "knowledge/common/" : `knowledge/${l.name}/`;
  const scope = l.layer === "business" ? "this business only" : l.layer === "common" ? "platform-wide" : `the \`${l.name}\` product line`;
  const files = l.files.map((f) => {
    const rollup = f.foldedCount != null ? ` (${f.foldedCount} files folded — Glob the dir to enumerate)` : "";
    return `- \`${dir}${f.path}\`${rollup}${f.description ? ` — ${f.description}` : ""}`;
  });
  return [`**${dir}** (${scope}):`, ...(files.length ? files : ["- _(empty)_"])].join("\n");
}

/** Build the knowledge section injected into EVERY session's launch context — the curated
 *  layers' file index (content stays on disk, read on demand). Both the business and the module
 *  flavor of the system prompt splice this in. Empty when no layer has any file yet, so roots
 *  without curated knowledge pay no prompt tax. */
export function buildKnowledgePrompt(o: { root: string; slug: string }): string {
  const layers = workspaceKnowledgeLayers(o.root, o.slug);
  if (layers.every((l) => l.files.length === 0)) return "";
  return renderPrompt(loadPrompt("knowledge"), { KNOWLEDGE_INDEX: layers.map(renderKnowledgeLayer).join("\n\n") });
}

/** Block protocol = the locked default (prompts/fence.md) + optional team override
 *  (fence.custom.md, business > root > user). Assembled into the system prompt — no
 *  physical fence.md file. */
function buildBlockProtocol(o: { root: string; slug: string }): string {
  const custom = resolveCustom("fence", o);
  return renderPrompt(loadPrompt("fence"), {
    CUSTOM: custom ? `\n# Business-specific blocks\n\n${custom}\n` : "",
  });
}

/** Business memory in the launch context = the business's own `memory/` plus the cache of
 *  other users' shared records (`.bizagent/remote-memory/`, filled by the inject hook's
 *  pullRemoteMemory). Local ids win on conflict. With no remote configured the cache is empty
 *  and this is exactly the local list. */
function businessMemory(root: string, slug: string): { records: MemoryRecord[]; remoteIds: Set<string> } {
  const local = readAllMemory(root, slug).filter((r) => r.scope === "business");
  const seen = new Set(local.map((r) => r.id));
  const shared = readMemoryDir(remoteMemoryDir(root, slug)).filter((r) => r.scope === "business" && !seen.has(r.id));
  return { records: [...local, ...shared], remoteIds: new Set(shared.map((r) => r.id)) };
}

/** The in-process tools' usage guidance, appended to the SDK launch prompt by SessionManager.
 *  SDK-only: the CLI path gets these capabilities from Claude Code itself, so this is NOT part of
 *  buildSystemPrompt (which both runtimes share). Always describes the background-result tool; the
 *  self-wakeup section is included only when a scheduler is wired, so the agent is never told
 *  about a tool it can't call. */
export function buildCapabilitiesPrompt(o: { scheduler: boolean }): string {
  const scheduling = o.scheduler ? loadPrompt("scheduling") : "";
  return renderPrompt(loadPrompt("capabilities"), { SCHEDULING_SECTION: scheduling });
}

/** The module's living knowledge doc, spliced into its sessions' launch context. The SDK
 *  runtime never loads CLAUDE.md natively (settingSources stays off — see runtime-sdk), so the
 *  file is the STORAGE and this read is the injection. Missing file / legacy pointer → a
 *  first-task instruction to write it (folding any retired `memory/` records in). */
function moduleClaudeMd(root: string, slug: string): string {
  const dir = businessDir(root, slug);
  const raw = readFileOr(path.join(dir, "CLAUDE.md")).trim();
  const leftovers = listFiles(path.join(dir, "memory"), ".md").length;
  const fold = leftovers
    ? `\n\n_${leftovers} retired record(s) remain under \`memory/\` — fold them into CLAUDE.md, then delete those files and the directory._`
    : "";
  if (!raw || raw.includes(LEGACY_POINTER_MARKER)) {
    return (
      "_CLAUDE.md has no real content yet. FIRST TASK: write it — distill this module's operational " +
      "knowledge (how to build / start / deploy, code structure, sharp edges) into `CLAUDE.md`._" + fold
    );
  }
  // Still the generated seed: inject it (it carries its own fill-me instructions) plus the
  // legacy-records migration nudge.
  return raw + (raw.includes(SEED_MARKER) ? fold : "");
}

/** The launch context for a MODULE workspace session (slug = `mod:<line>:<mod>`): the module's
 *  recorded facts, its CLAUDE.md (the module's living knowledge doc), the block protocol, and
 *  this workspace's past sessions + worklog rules. No business memory, no requirements, no
 *  linked-modules section — modules are many-to-many with businesses, so nothing
 *  business-specific belongs here. */
export function buildModuleSystemPrompt(o: { root: string; slug: string; line: string; mod: string; runId: string }): string {
  const meta = readModuleMeta(o.root, o.line, o.mod);
  const facts = [
    `- **Type**: ${meta.type}`,
    meta.source ? `- **Source**: ${meta.source}` : "",
    meta.deploy ? `- **Deploy**: ${meta.deploy}` : "- **Deploy**: _(not recorded yet — ask the user how this module ships)_",
  ]
    .filter(Boolean)
    .join("\n");
  return renderPrompt(loadPrompt("system-module"), {
    MODULE_NAME: meta.slug,
    LINE: o.line,
    MODULE_FACTS: facts,
    MODULE_CLAUDE_MD: moduleClaudeMd(o.root, o.slug),
    KNOWLEDGE: buildKnowledgePrompt(o),
    BLOCK_PROTOCOL: buildBlockProtocol(o),
    PAST_SESSIONS: readIndex(o.root, o.slug) || "_No earlier sessions yet._",
    WORKLOG: buildWorklogPrompt({ root: o.root, slug: o.slug, runId: o.runId }),
  });
}

/** The launch context for an ASSISTANT workspace session (slug = `assistant:<im>`): just the
 *  assistant's CLAUDE.md (its persona, owned by the host that mounted the channel) plus
 *  knowledge / block protocol / past sessions / worklog. No business memory, no requirements,
 *  no linked modules — assistants cut across product lines, so nothing line-specific applies. */
export function buildAssistantSystemPrompt(o: { root: string; slug: string; im: string; runId: string }): string {
  const meta = readAssistantMeta(o.root, o.im);
  return renderPrompt(loadPrompt("system-assistant"), {
    ASSISTANT_NAME: meta.name ?? meta.slug,
    IM: meta.im,
    ASSISTANT_CLAUDE_MD: moduleClaudeMd(o.root, o.slug), // reads <workspace>/CLAUDE.md; works for any workspace
    KNOWLEDGE: buildKnowledgePrompt(o),
    BLOCK_PROTOCOL: buildBlockProtocol(o),
    // Host-specific data map & secret list (e.g. a host's metric/ops/SQL surfaces) — kept OUT of
    // the bundled prompt so the library stays platform-neutral. The host drops it in via
    // <root>/prompts/system-assistant.custom.md; "" when none exists.
    PLATFORM_NOTES: resolveCustom("system-assistant", { root: o.root, slug: o.slug }),
    PAST_SESSIONS: readIndex(o.root, o.slug) || "_No earlier sessions yet._",
    WORKLOG: buildWorklogPrompt({ root: o.root, slug: o.slug, runId: o.runId }),
  });
}

/** The full working context injected at launch via --append-system-prompt. `req` scopes the
 *  session to a requirement: its state doc + sibling worklogs join the context. A module or
 *  assistant workspace slug routes to its own flavor of the context instead. */
export function buildSystemPrompt(o: { root: string; slug: string; runId: string; req?: string }): string {
  const aw = parseAssistantWorkspaceId(o.slug);
  if (aw) return buildAssistantSystemPrompt({ root: o.root, slug: o.slug, im: aw.im, runId: o.runId });
  const mw = parseModuleWorkspaceId(o.slug);
  if (mw) return buildModuleSystemPrompt({ root: o.root, slug: o.slug, line: mw.line, mod: mw.mod, runId: o.runId });
  const meta = readBusinessMeta(o.root, o.slug);
  const { records, remoteIds } = businessMemory(o.root, o.slug);
  return renderPrompt(loadPrompt("system"), {
    BUSINESS_NAME: meta.name,
    BUSINESS_MEMORY: renderBusinessMemory(records, remoteIds),
    KNOWLEDGE: buildKnowledgePrompt(o),
    MODULES: buildModulesPrompt(o),
    REQUIREMENT: buildRequirementPrompt(o),
    BLOCK_PROTOCOL: buildBlockProtocol(o),
    PAST_SESSIONS: readIndex(o.root, o.slug) || "_No earlier sessions yet._",
    WORKLOG: buildWorklogPrompt({ root: o.root, slug: o.slug, runId: o.runId }),
  });
}
