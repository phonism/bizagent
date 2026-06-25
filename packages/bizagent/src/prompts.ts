// Prompt management. Skeleton prompts live as files under prompts/ (centrally owned,
// like Claude Code's own system-prompt files). biz loads a skeleton, interpolates
// ${VARS}, and splices in a user/business custom snippet. The result is injected at
// launch via --append-system-prompt — never written as an editable file in the project,
// so users can't break the locked parts (e.g. the required index line).
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { businessDir } from "./paths";
import { exists, readFile } from "./fsutil";

// prompts/ sits next to src/ (dev) and next to dist/ (built) — both are one level up.
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

/** Load a skeleton prompt file (without rendering). Must exist — it's a bundled template. */
export function loadPrompt(name: string): string {
  return readFile(path.join(PROMPTS_DIR, `${name}.md`));
}

/** Strip the leading <!-- frontmatter --> and interpolate ${VARS}. Missing vars -> "". */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  const body = template.replace(/^<!--[\s\S]*?-->\s*/, "");
  return body.replace(/\$\{(\w+)\}/g, (_, k: string) => vars[k] ?? "").trimEnd() + "\n";
}

/**
 * Resolve a business/user custom snippet for a prompt. First found wins:
 *   business  businesses/<slug>/<name>.custom.md   (this business line)
 *   root       <root>/prompts/<name>.custom.md      (all businesses in the root)
 *   user       ~/.bizagent/prompts/<name>.custom.md (this person, anywhere)
 * Returns "" when none exists. This is the ONLY part users are meant to edit.
 */
export function resolveCustom(name: string, o: { root: string; slug: string }): string {
  const candidates = [
    path.join(businessDir(o.root, o.slug), `${name}.custom.md`),
    path.join(o.root, "prompts", `${name}.custom.md`),
    path.join(os.homedir(), ".bizagent", "prompts", `${name}.custom.md`),
  ];
  for (const c of candidates) {
    if (exists(c)) return readFile(c).trim();
  }
  return "";
}

/** Build the worklog section: locked skeleton + resolved custom snippet. Spliced into
 *  the launch system prompt by context.buildSystemPrompt. */
export function buildWorklogPrompt(o: { root: string; slug: string; runId: string }): string {
  const custom = resolveCustom("worklog", o);
  return renderPrompt(loadPrompt("worklog"), {
    WORKLOG_PATH: `.bizagent/deliverables/${o.runId}/worklog.md`,
    CUSTOM: custom ? `\n# Business-specific additions\n\n${custom}\n` : "",
  });
}

/** Build the opening task message for `biz setup` (web: ?task=setup): locked skeleton +
 *  resolved custom snippet. The guided session interviews the user to fill the business's
 *  profile, register/link modules, and seed the knowledge base. */
export function buildBusinessSetupPrompt(o: { root: string; slug: string; name: string; line: string }): string {
  const custom = resolveCustom("business-setup", o);
  return renderPrompt(loadPrompt("business-setup"), {
    NAME: o.name,
    SLUG: o.slug,
    LINE: o.line,
    CUSTOM: custom ? `\n## Business-specific additions\n\n${custom}\n` : "",
  });
}

/** Build the opening task message for `?task=setup:knowledge-refresh` — a guided session that
 *  writes the business's `subscriptions/knowledge-refresh.md` per the subscriptions skill's
 *  two-layer freshness convention, verifies the host picked it up, and offers a cold-start run.
 *  The conversational part is intentionally thin (two confirms) — the SoT for what to write is
 *  the subscriptions skill, not this prompt. */
export function buildKnowledgeRefreshSetupPrompt(o: { root: string; slug: string; name: string; line: string }): string {
  const custom = resolveCustom("business-knowledge-refresh-setup", o);
  return renderPrompt(loadPrompt("business-knowledge-refresh-setup"), {
    NAME: o.name,
    SLUG: o.slug,
    LINE: o.line,
    CUSTOM: custom ? `\n## Business-specific additions\n\n${custom}\n` : "",
  });
}

/** Build the opening task message for `?task=setup:new-subscription` — a guided session that
 *  interviews the user on what to schedule (做什么 / 多久跑 / 产出形态), writes the subscription
 *  file per the subscriptions skill, and verifies host pickup. Skill SKILL.md is the SoT for what
 *  to write; this prompt is the conversational on-ramp. */
export function buildNewSubscriptionSetupPrompt(o: { root: string; slug: string; name: string; line: string }): string {
  const custom = resolveCustom("business-new-subscription-setup", o);
  return renderPrompt(loadPrompt("business-new-subscription-setup"), {
    NAME: o.name,
    SLUG: o.slug,
    LINE: o.line,
    CUSTOM: custom ? `\n## Business-specific additions\n\n${custom}\n` : "",
  });
}

/** Build the opening task message for a module workspace's setup session (web: ?task=setup on a
 *  `mod:<line>:<mod>` workspace; CLI: `biz module setup`): clone the code per source, correct the
 *  recorded facts, and cold-start the module's shared memory — all inside the module's own
 *  directory. `slug` is the module workspace id (resolveCustom finds `module-setup.custom.md`
 *  in the module dir through it). */
export function buildModuleSetupPrompt(o: { root: string; slug: string; mod: string; line: string }): string {
  const custom = resolveCustom("module-setup", o);
  return renderPrompt(loadPrompt("module-setup"), {
    MOD: o.mod,
    LINE: o.line,
    CUSTOM: custom ? `\n## Module-specific additions\n\n${custom}\n` : "",
  });
}
