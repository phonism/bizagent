// Business metadata. A business always lives inside a product line (lines/<line>/businesses/);
// `line` is recorded here too so readers don't have to derive it from the path.
import path from "node:path";
import { businessDir } from "./paths";
import { readFile, writeFile } from "./fsutil";
import { nowIso } from "./time";

export interface BusinessMeta {
  name: string;
  slug: string;
  /** The product line this business belongs to (matches its on-disk location). */
  line: string;
  domain?: string;
  /** Modules this business uses (many-to-many). Each is symlinked into the business for
   *  read/analysis; see module.ts. */
  modules?: string[];
  /** An OPAQUE extension bag for embedding apps. The harness stores and returns it verbatim and
   *  NEVER interprets its contents — it's the seam an app uses to attach its own per-business data
   *  (e.g. web-display metadata) without forking this schema. Namespace your keys (e.g. `ext.<app>`)
   *  so two embedders don't collide. The day the harness needs to ACT on a field, that field should
   *  graduate to a native field (or the app's own DB) instead of living here. */
  ext?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A patch for `updateBusinessMeta` — any native field except the immutables: slug, timestamps,
 *  and `line` (the line is where the business physically lives; moving lines is not a patch). */
export type BusinessMetaPatch = Partial<Omit<BusinessMeta, "slug" | "line" | "createdAt" | "updatedAt">>;

export const metaPath = (root: string, slug: string) =>
  path.join(businessDir(root, slug), "business.json");

export function readBusinessMeta(root: string, slug: string): BusinessMeta {
  return JSON.parse(readFile(metaPath(root, slug))) as BusinessMeta;
}

export function writeBusinessMeta(root: string, slug: string, meta: BusinessMeta): void {
  writeFile(metaPath(root, slug), JSON.stringify(meta, null, 2) + "\n");
}

/** Merge a patch into a business's meta and persist it — the single write path for editing meta
 *  (name/domain/…) or the opaque `ext` bag after creation. Reads the raw JSON (so any
 *  fields this version doesn't type, including a prior `ext`, are preserved), shallow-merges the
 *  patch, and deep-merges `ext` ONE level so `{ ext: { app: {...} } }` updates that app's sub-bag
 *  without clobbering another app's. `slug`/`line`/`createdAt` are immutable; `updatedAt` is
 *  bumped. `line` is pinned at runtime too (not just in the type) — a JSON patch from the web
 *  route must not desync the recorded line from where the business physically lives. */
export function updateBusinessMeta(
  root: string,
  slug: string,
  patch: BusinessMetaPatch,
  now: () => string = nowIso,
): BusinessMeta {
  const current = JSON.parse(readFile(metaPath(root, slug))) as Record<string, unknown>;
  const ext = patch.ext
    ? { ...((current.ext as Record<string, unknown> | undefined) ?? {}), ...patch.ext }
    : (current.ext as Record<string, unknown> | undefined);
  const next = { ...current, ...patch, ext, slug, line: current.line, updatedAt: now() };
  writeFile(metaPath(root, slug), JSON.stringify(next, null, 2) + "\n");
  return next as unknown as BusinessMeta;
}
