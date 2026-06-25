// Assistant = a platform-level IM-channel adapter (infoflow / slack / wecom / ...). Hosts the
// inbound chats from one IM channel, with a workspace id `assistant:<im>`. Each assistant lives
// in `<root>/assistants/<im>/` (parallel to `lines/`, not inside any product line — assistants
// cut across the platform). Sidecar metadata: assistant.json (the IM channel + display name)
// and CLAUDE.md (the assistant's persona, owned by the host that mounted the channel).
import path from "node:path";
import { assistantConfigPath, assistantDir, listAssistantSlugs } from "./paths";
import { readFile, writeFile, exists } from "./fsutil";
import { nowIso } from "./time";

export interface AssistantMeta {
  slug: string;
  /** Free-form IM channel kind, e.g. infoflow / slack / wecom. Mirrors the slug today (the slug
   *  IS the channel kind), but kept distinct so a future multi-instance scheme (e.g.
   *  `assistant:slack-eng`) can pin the channel kind separately. */
  im: string;
  /** Display name (e.g. "Slack Bot"); the slug stays the dir/URL identity. */
  name?: string;
  createdAt: string;
  updatedAt: string;
}

export function readAssistantMeta(root: string, im: string): AssistantMeta {
  return JSON.parse(readFile(assistantConfigPath(root, im))) as AssistantMeta;
}

export function writeAssistantMeta(root: string, im: string, meta: AssistantMeta): void {
  writeFile(assistantConfigPath(root, im), JSON.stringify(meta, null, 2) + "\n");
}

/** Slugs of all assistants in the root (those with an assistant.json). */
export function listAssistantConfigured(root: string): string[] {
  return listAssistantSlugs(root).filter((s) => exists(assistantConfigPath(root, s)));
}

/** Every assistant with its display name (assistant.json's, else the slug) — the web picker's
 *  read model, the assistant analog of `listBusinesses`. */
export function listAssistants(root: string): { slug: string; im: string; name: string; updatedAt?: string }[] {
  return listAssistantConfigured(root).map((slug) => {
    try {
      const m = readAssistantMeta(root, slug);
      return { slug, im: m.im, name: m.name ?? slug, updatedAt: m.updatedAt };
    } catch {
      return { slug, im: slug, name: slug };
    }
  });
}

/** Patch for `updateAssistantMeta` — the editable display field. `slug` / `im` / timestamps
 *  are immutable; the workspace dir IS the channel. */
export type AssistantMetaPatch = Partial<Pick<AssistantMeta, "name">>;

export function updateAssistantMeta(
  root: string,
  im: string,
  patch: AssistantMetaPatch,
  now: () => string = nowIso,
): AssistantMeta {
  const current = readAssistantMeta(root, im);
  const next = { ...current, updatedAt: now() };
  if (patch.name !== undefined) next.name = patch.name;
  writeAssistantMeta(root, im, next);
  return next;
}

/** Path helper for the assistant's living persona doc — CLAUDE.md, sitting next to assistant.json. */
export const assistantClaudeMdPath = (root: string, im: string) =>
  path.join(assistantDir(root, im), "CLAUDE.md");
