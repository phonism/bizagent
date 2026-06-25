// The sharing seam. Each agent's own source of truth is always its LOCAL files; a Remote
// is an optional shared hub that lets several users on the SAME business see each other's
// worklogs and memory. The SDK knows ONLY this interface — a platform implements it (an
// httpRemote against a small REST contract, to come); `fileRemote` is the reference impl
// over a shared folder, enough to simulate two users and to back the tests.
//
// Turning sharing on is purely a config decision: add a `remote` block to
// bizagent.config.json. No runtime adapter (CLI / SDK) changes — the hooks resolve the
// remote from config and publish on Stop / pull on UserPromptSubmit transparently.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileOr, writeFile, appendLine, appendText, claim, listFiles, exists } from "./fsutil";
import { rootConfigPath } from "./paths";

/** One worklog-index line plus the runId it belongs to (the dedup key). */
export interface IndexEntry {
  runId: string;
  line: string;
}

/** A published blob (worklog body / memory record), addressed by id. */
export interface Blob {
  id: string;
  content: string;
}

/**
 * The whole contract a platform must satisfy. Deliberately dumb: it moves index lines and
 * markdown blobs, and knows nothing about bizagent's domain types — the merge side parses.
 * A Remote instance is scoped to ONE business (the hub namespaces by slug at construction).
 */
export interface Remote {
  /** This session's worklog is done/updated — publish it (idempotent by runId, latest wins). */
  publishWorklog(o: { runId: string; line: string; content: string }): Promise<void>;
  /** Every shared index line, so the caller can merge in entries it doesn't have yet. */
  fetchIndex(): Promise<IndexEntry[]>;
  /** Full body of one shared worklog, or null if the hub doesn't have it. */
  fetchWorklog(runId: string): Promise<string | null>;
  /** A distilled business-memory record — publish it for the business. */
  publishMemory(o: Blob): Promise<void>;
  /** Every shared memory record (raw markdown), for the caller to merge. */
  fetchMemory(): Promise<Blob[]>;
  /** Mirror this session's new transcript lines to the hub (the read-only web view's source).
   *  `offset` is the char position in the LOCAL transcript where `content` starts; the hub
   *  drops any overlap it already has, so re-pushing after a lost ack is safe. offset 0 means
   *  "from the top" and overwrites (the rotation/reset path). A push that would leave a hole
   *  (offset beyond what the hub has) rejects with an Error carrying `have` — the hub's current
   *  watermark — so the pusher can resync and retry. OPTIONAL: raw transcripts carry much more
   *  than a worklog (file contents, command output), so sharing them is a separate opt-in
   *  (`transcripts: true` in the remote config); a Remote without this method shares none. */
  publishTranscript?(o: { runId: string; offset: number; content: string }): Promise<void>;
}

/** Apply one pushed transcript chunk to a mirror file — the shared server-side semantics
 *  (fileRemote and the hub both use it). The mirror's own char length IS the watermark (no
 *  side marker to drift from the file), so a crash between writes can't desync the two.
 *  Single writer per runId (one live session owns a run), offsets in JS string chars. */
export function applyTranscriptChunk(file: string, o: { offset: number; content: string }): { have: number; applied: boolean } {
  const have = readFileOr(file).length;
  if (o.offset === 0) {
    // From-the-top push: a rotation reset or a first-chunk retry. Either way the content spans
    // [0, end) of the source, so overwrite is exact — never an append that could duplicate.
    writeFile(file, o.content);
    return { have: o.content.length, applied: true };
  }
  if (o.offset > have) return { have, applied: false }; // would leave a hole — caller resyncs
  const delta = o.content.slice(have - o.offset); // drop the overlap we already have
  if (delta) appendText(file, delta);
  return { have: Math.max(have, o.offset + o.content.length), applied: true };
}

/** Throw the gap rejection `applyTranscriptChunk` reports, shaped so the pusher can read the
 *  hub's watermark off the error (`have`) and resync. */
function throwTranscriptGap(have: number, offset: number): never {
  throw Object.assign(new Error(`transcript gap: remote has ${have} chars, push starts at ${offset}`), { have });
}

/** The index line ends with the runId (`- <date> · <summary> · <runId>`). */
function runIdOfLine(line: string): string {
  const parts = line.split("·");
  return (parts.length ? parts[parts.length - 1] : line).trim();
}

/**
 * Reference Remote over a shared folder. `base` is the business-scoped hub directory
 * (resolveRemote appends the slug). Layout:
 *   <base>/index.md            append-only union of index lines
 *   <base>/worklogs/<runId>.md published worklog bodies
 *   <base>/memory/<id>.md      published memory records
 *   <base>/.published/<runId>  claim markers — append each index line exactly once
 * Concurrency rides the same atomic primitives as the local store (claim + O_APPEND), so
 * several users pointing biz at one shared folder don't clobber the index. A real platform
 * uses httpRemote instead; this exists for local setups and tests.
 */
export function fileRemote(base: string): Remote {
  const indexFile = path.join(base, "index.md");
  const worklogDir = path.join(base, "worklogs");
  const memDir = path.join(base, "memory");
  const claimedDir = path.join(base, ".published");
  const transcriptDir = path.join(base, "transcripts");

  return {
    async publishWorklog({ runId, line, content }) {
      writeFile(path.join(worklogDir, `${runId}.md`), content); // overwrite: latest wins
      if (claim(path.join(claimedDir, runId))) appendLine(indexFile, line); // once per runId
    },
    async fetchIndex() {
      return readFileOr(indexFile)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => ({ runId: runIdOfLine(line), line }));
    },
    async fetchWorklog(runId) {
      const f = path.join(worklogDir, `${runId}.md`);
      return exists(f) ? readFileOr(f) : null;
    },
    async publishMemory({ id, content }) {
      writeFile(path.join(memDir, `${id}.md`), content);
    },
    async fetchMemory() {
      return listFiles(memDir).map((f) => ({ id: path.basename(f, ".md"), content: readFileOr(f) }));
    },
    async publishTranscript({ runId, offset, content }) {
      const r = applyTranscriptChunk(path.join(transcriptDir, `${runId}.jsonl`), { offset, content });
      if (!r.applied) throwTranscriptGap(r.have, offset);
    },
  };
}

/**
 * Generic HTTP Remote against the fixed contract every platform implements server-side
 * (method + path + body are fixed here; the platform only provides the base URL and auth):
 *   GET  {base}/index            -> 200 [{ runId, line }]
 *   GET  {base}/worklog/:runId   -> 200 text body | 404
 *   POST {base}/worklog          <- { runId, line, content }
 *   GET  {base}/memory           -> 200 [{ id, content }]
 *   POST {base}/memory           <- { id, content }
 *   POST {base}/transcript       <- { runId, offset, content } -> 200 { have } | 409 { have }
 * Auth and any extra routing are just headers (resolveRemote interpolates ${ENV} into them,
 * so secrets stay in the environment, not in the config file). Anything that needs a
 * different method/path/body shape belongs in a `module` Remote, not here. Zero deps — uses
 * the global fetch; every request is time-bounded so a hung server can't stall a turn. */
export function httpRemote(o: { url: string; headers?: Record<string, string>; timeoutMs?: number }): Remote {
  const base = o.url.replace(/\/+$/, "");
  const headers = o.headers ?? {};
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  const timeoutMs = o.timeoutMs ?? 5000;
  const signal = () => AbortSignal.timeout(timeoutMs);

  return {
    async publishWorklog(b) {
      const r = await fetch(`${base}/worklog`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(b), signal: signal() });
      if (!r.ok) throw new Error(`remote publishWorklog failed: HTTP ${r.status}`);
    },
    async fetchIndex() {
      const r = await fetch(`${base}/index`, { headers, signal: signal() });
      return r.ok ? ((await r.json()) as IndexEntry[]) : [];
    },
    async fetchWorklog(runId) {
      const r = await fetch(`${base}/worklog/${encodeURIComponent(runId)}`, { headers, signal: signal() });
      return r.ok ? await r.text() : null;
    },
    async publishMemory(b) {
      const r = await fetch(`${base}/memory`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(b), signal: signal() });
      if (!r.ok) throw new Error(`remote publishMemory failed: HTTP ${r.status}`);
    },
    async fetchMemory() {
      const r = await fetch(`${base}/memory`, { headers, signal: signal() });
      return r.ok ? ((await r.json()) as Blob[]) : [];
    },
    async publishTranscript(b) {
      const r = await fetch(`${base}/transcript`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(b), signal: signal() });
      if (r.status === 409) {
        const body = (await r.json().catch(() => ({}))) as { have?: unknown };
        if (typeof body.have === "number") throwTranscriptGap(body.have, b.offset);
      }
      if (!r.ok) throw new Error(`remote publishTranscript failed: HTTP ${r.status}`);
    },
  };
}

/** Replace ${VAR} in a string with process.env[VAR] (missing -> empty). Keeps secrets like
 *  tokens out of the committed config — the config holds ${BIZ_REMOTE_TOKEN}, the env holds
 *  the value. */
function interpolateEnv(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? "");
}

/** Factory a `module` Remote must export (as `createRemote` or default). The user writes
 *  whatever transport/auth they need and returns a Remote — the universal escape hatch. */
export type RemoteFactory = (ctx: {
  root: string;
  slug: string;
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}) => Remote | Promise<Remote>;

/** Shape of the optional `remote` block in bizagent.config.json. `transcripts: true` opts the
 *  raw session transcripts into sharing (worklog/memory always share once a remote is set;
 *  transcripts carry file contents and command output, so they need their own explicit yes). */
type RemoteConfig =
  | { type: "file"; dir: string; transcripts?: boolean }
  | { type: "http"; url: string; headers?: Record<string, string>; transcripts?: boolean }
  | ({ type: "module"; path: string } & Record<string, unknown>);

/**
 * Build the business-scoped Remote from the root config, or null when sharing is off (no
 * `remote` block). Three built-in tiers:
 *   - file   : a shared folder (dir resolved relative to the root, namespaced by slug)
 *   - http   : the fixed REST contract; config gives url + headers (${ENV}-interpolated)
 *   - module : load the user's own factory (createRemote) — any transport/auth, in code
 * Programmatic callers can skip all this and pass a Remote object straight to the hooks.
 */
export async function resolveRemote(root: string, slug: string): Promise<Remote | null> {
  const raw = readFileOr(rootConfigPath(root));
  if (!raw) return null;
  let cfg: { remote?: RemoteConfig };
  try {
    cfg = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = cfg.remote;
  if (!r) return null;

  // The opt-in gate for raw transcript sharing: file/http remotes are built with the method,
  // and it's stripped here unless the config says `transcripts: true`. Module remotes decide
  // for themselves (the factory returns whatever surface it wants to expose).
  const gateTranscripts = (remote: Remote, on: boolean | undefined): Remote => {
    if (!on) delete remote.publishTranscript;
    return remote;
  };

  if (r.type === "file" && r.dir) {
    // Hub created lazily on first publish (writeFile/claim mkdirp their parents).
    return gateTranscripts(fileRemote(path.join(path.resolve(root, r.dir), slug)), r.transcripts);
  }

  if (r.type === "http" && r.url) {
    // ${SLUG} → the business slug first (one config block covers every business — point url at
    // .../businesses/${SLUG}/hub), then ${ENV} (which would otherwise eat ${SLUG} as an
    // undefined env var). The file tier needs none of this: it namespaces by slug itself.
    const subst = (s: string) => interpolateEnv(s.replace(/\$\{SLUG\}/g, slug), process.env);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) headers[k] = subst(v);
    return gateTranscripts(httpRemote({ url: subst(r.url), headers }), r.transcripts);
  }

  if (r.type === "module" && r.path) {
    // Variable specifier so esbuild doesn't try to bundle the user's file at build time.
    const mod = (await import(pathToFileURL(path.resolve(root, r.path)).href)) as {
      createRemote?: RemoteFactory;
      default?: RemoteFactory;
    };
    const factory = mod.createRemote ?? mod.default;
    if (typeof factory !== "function") return null;
    return await factory({ root, slug, config: r, env: process.env });
  }

  return null;
}
