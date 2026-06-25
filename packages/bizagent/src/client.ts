// The headless client — `biz web`'s frontend substrate, framework-agnostic. It is pure TS over
// `fetch` + SSE with NO DOM and NO framework: a React/Vue/Svelte binding is a thin wrapper that
// forwards `onState`. Two halves:
//   - `reduceSession` — a PURE reducer folding the SessionEvent stream into a render-ready state
//     (messages, the in-flight delta, tool calls, jobs, usage). Testable with zero network.
//   - `createBizClient` — thin fetch wrappers for the JSON API + `start`/`resume` returning a
//     `SessionHandle` that opens the SSE stream, runs the reducer, and lets a UI subscribe.
import type { SessionEvent, SessionUsage } from "./session";
import { parseInbound } from "./inbound";
import { nowIso } from "./time";

// ─────────────────────────── the pure reducer ───────────────────────────

/** One entry in the conversation timeline, in arrival order. The agent's turn interleaves text,
 *  thinking, and tool calls — keeping them as one ordered list (rather than separate buckets) is
 *  what lets the UI render them in the order they actually happened.
 *  `at` is the message's wall-clock ISO time when known (live emit time / transcript replay). */
export type TimelineItem =
  // `images` is a CLIENT-side optimistic preview (data: URLs the composer made via FileReader); the
  // server never echoes the base64 back, so a replayed transcript for an old image-bearing turn renders
  // without thumbnails — a deliberate trade for not stuffing the history with multi-MB payloads. The
  // agent still saw the images: they rode the SDK content blocks (session.ts) and the vision response
  // lives on in the assistant turn.
  | { kind: "user"; text: string; images?: string[]; at?: string }
  // A line the HARNESS injected out-of-band (a background result landing, a cron firing, a
  // teammate message) — recognized by its formatInbound envelope. In the transcript it is a
  // user turn like any other; classifying it here is what lets a UI render it as a system
  // event instead of pretending the human typed it. `text` is the body, envelope stripped.
  | { kind: "injected"; tag: string; from?: string; text: string; at?: string }
  | { kind: "text"; text: string; at?: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id?: string; name?: string; input?: unknown; result?: string; isError?: boolean; running: boolean }
  // A harness hook intervened (the Stop hook feeding the worklog reminder back). Rendered as a
  // system notice so the agent's continuation has visible cause, not as a chat bubble.
  | { kind: "hook"; hook: "stop"; text: string; at?: string };

export interface JobCard {
  ticket: string;
  status: "open" | "done" | "failed";
  label?: string;
  result?: string;
}

/** A render-ready view of a session, folded from its event stream. Immutable: `reduceSession`
 *  returns a new object so a framework can diff/memoize. */
export interface SessionState {
  /** The conversation so far, in order: user turns, assistant text, thinking, tool calls. */
  items: TimelineItem[];
  /** The assistant's in-flight response text (cleared into an item when the turn's text lands). */
  streaming: string;
  /** The assistant's in-flight thinking text (cleared into a thinking item when it's flushed). */
  thinking: string;
  /** Background-job cards by ticket. */
  jobs: Record<string, JobCard>;
  /** Latest cumulative usage/cost, once a turn has finished. */
  usage?: SessionUsage;
  /** Latest worklog content for the run, if any has streamed. */
  worklog?: string;
  /** The assistant has finished responding to the last turn. */
  idle: boolean;
  /** The session has ended. */
  closed: boolean;
  /** The last error message, if one was emitted. */
  error?: string;
  /** The Claude Code session id, once the server has captured it (undefined before then). THIS is
   *  the id to put in a URL / pass to `resume` — the handle's `id` is the in-process session id
   *  and is not resumable across server restarts. */
  claudeSessionId?: string;
  /** A send hit the host mid graceful-restart (drain 503): the turn is held client-side and
   *  auto-resent until the restart lands, so the UI can show a "restarting, please wait" hint
   *  instead of the message silently never being answered. */
  restarting?: boolean;
}

export function initialSessionState(): SessionState {
  return { items: [], streaming: "", thinking: "", jobs: {}, idle: false, closed: false };
}

/** Flush a pending thinking buffer into a timeline item (thinking precedes the text/tool it leads
 *  to, so we land it just before them). */
function flushThinking(items: TimelineItem[], thinking: string): TimelineItem[] {
  return thinking ? [...items, { kind: "thinking", text: thinking }] : items;
}

/** Stop the spinner on any tool call still marked running. A turn that ends without delivering
 *  the tool_result — the user hit stop (SDK interrupt), the run loop errored, the session
 *  closed — will never send a `tool end` for it, so the terminal events settle them here;
 *  without this an interrupted tool spins forever. */
function settleRunningTools(items: TimelineItem[]): TimelineItem[] {
  if (!items.some((it) => it.kind === "tool" && it.running)) return items;
  return items.map((it) => (it.kind === "tool" && it.running ? { ...it, running: false, result: it.result ?? "(interrupted)" } : it));
}

/** Fold one event into the state, returning a NEW state (pure). The single source of truth for
 *  "what does a session look like right now" — shared by every UI binding so they agree. */
export function reduceSession(state: SessionState, ev: SessionEvent): SessionState {
  switch (ev.type) {
    case "session":
      return { ...state, claudeSessionId: ev.claudeSessionId };
    case "message": {
      if (ev.role === "user") {
        // A harness injection wears the formatInbound envelope — split it out so it renders as
        // a system event. Everything else is the user's own turn (optimistically injected by
        // the sender's client, or a transcript replay). A new turn also clears a stale error:
        // the user is moving on (often retrying), and nothing else ever clears it — without
        // this the error banner sticks forever.
        const inj = parseInbound(ev.text);
        if (inj) return { ...state, items: [...state.items, { kind: "injected", ...inj, ...(ev.at ? { at: ev.at } : {}) }], idle: false };
        // `ev.images` is set only by the LOCAL send() path (optimistic preview thumbnails); the
        // server never echoes images, so a replayed transcript event arrives without it.
        const imgs = (ev as { images?: string[] }).images;
        return {
          ...state,
          items: [
            ...state.items,
            { kind: "user", text: ev.text, ...(imgs && imgs.length ? { images: imgs } : {}), ...(ev.at ? { at: ev.at } : {}) },
          ],
          idle: false,
          error: undefined,
        };
      }
      // An assistant text block finalizes: land any pending thinking, then the text.
      const items = flushThinking(state.items, state.thinking);
      return { ...state, items: [...items, { kind: "text", text: ev.text, ...(ev.at ? { at: ev.at } : {}) }], streaming: "", thinking: "", idle: false };
    }
    case "hook": {
      // The Stop hook blocked the turn's end — the agent is about to continue. Surfacing it keeps
      // the continuation explainable; idle stays false because the turn is, in fact, not over.
      const items = flushThinking(state.items, state.thinking);
      return { ...state, items: [...items, { kind: "hook", hook: ev.hook, text: ev.text, ...(ev.at ? { at: ev.at } : {}) }], thinking: "", idle: false };
    }
    case "delta":
      return ev.thinking
        ? { ...state, thinking: state.thinking + ev.text, idle: false }
        : { ...state, streaming: state.streaming + ev.text, idle: false };
    case "tool": {
      if (ev.phase === "start") {
        const items = flushThinking(state.items, state.thinking);
        return {
          ...state,
          items: [...items, { kind: "tool", id: ev.id, name: ev.name, input: ev.input, running: true }],
          thinking: "",
          idle: false,
        };
      }
      // End: pair to its start by tool_use id; fall back to the oldest still-running tool (FIFO,
      // matching the order results come back in).
      const items = state.items.slice();
      let idx = ev.id ? items.findIndex((it) => it.kind === "tool" && it.id === ev.id && it.running) : -1;
      if (idx === -1) idx = items.findIndex((it) => it.kind === "tool" && it.running);
      if (idx >= 0) {
        const t = items[idx] as Extract<TimelineItem, { kind: "tool" }>;
        items[idx] = { ...t, result: ev.result, isError: ev.isError, running: false };
      } else {
        items.push({ kind: "tool", id: ev.id, name: ev.name, result: ev.result, isError: ev.isError, running: false });
      }
      return { ...state, items, idle: false };
    }
    case "usage": {
      // Merge, don't replace: per-call lastCallInputTokens rides on assistant messages
      // (one event per API round-trip); the cumulative input/output/cost ride on the result
      // message (one event per turn). Each event only fills the fields it owns — a plain
      // overwrite would let result-message events erase the per-call field every turn.
      const { type: _t, ...usage } = ev;
      return { ...state, usage: { ...state.usage, ...usage } };
    }
    case "worklog":
      return { ...state, worklog: ev.content };
    case "job":
      return { ...state, jobs: { ...state.jobs, [ev.ticket]: { ticket: ev.ticket, status: ev.status, label: ev.label, result: ev.result } } };
    case "idle": {
      // Land anything still buffered (normally already flushed by the final message event).
      let items = flushThinking(state.items, state.thinking);
      if (state.streaming) items = [...items, { kind: "text", text: state.streaming }];
      return { ...state, items: settleRunningTools(items), streaming: "", thinking: "", idle: true };
    }
    case "error":
      return { ...state, items: settleRunningTools(state.items), error: ev.message };
    case "closed":
      return { ...state, items: settleRunningTools(state.items), closed: true };
    default:
      return state;
  }
}

// ─────────────────────────── SSE parsing ───────────────────────────

/** Parse a `text/event-stream` Response body into SessionEvents. Yields each `data:` payload as a
 *  parsed object until the stream ends or `signal` aborts. Tolerates multi-line frames and the
 *  `: ping` keep-alive comments. */
export async function* readSSE(res: Response, signal?: AbortSignal): AsyncGenerator<SessionEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue; // a comment-only frame (": ping")
        try {
          yield JSON.parse(data) as SessionEvent;
        } catch {
          /* skip a malformed frame rather than kill the stream */
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// ─────────────────────────── the client ───────────────────────────

type Fetch = typeof fetch;

export interface BusinessInfo {
  slug: string;
  /** The product line the business lives in (lines/<line>/businesses/<slug>/). */
  line: string;
  name?: string;
  /** Free-text domain tag (e.g. "ecommerce"), for a card subtitle. */
  domain?: string;
  /** The modules this business links (slugs) — lets a UI resolve a module's host businesses. */
  modules?: string[];
  /** ISO timestamp of the last metadata change, for a "updated N ago" line. */
  updatedAt?: string;
  /** The opaque per-business extension bag (app display data etc.) — passed through verbatim. */
  ext?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A module as the HTTP API returns it (= module.json + the derived workspace status). Modules
 *  are line-scoped. */
export interface ModuleInfo {
  slug: string;
  type: string;
  /** Where the code lives / how to clone, free text — knowledge only, never executed. */
  source?: string;
  /** How it ships, free text — knowledge only, the agent never deploys. */
  deploy?: string;
  /** Derived by the server off the module dir (nothing stored): did the setup conversation
   *  deliver its artifacts? Card UIs mark a module "set up" from these facts. `claudeMd` =
   *  the module's CLAUDE.md carries distilled knowledge (not missing / seed / legacy pointer). */
  status?: { codeReady: boolean; claudeMd: boolean; scriptCount: number };
  /** The module's CLAUDE.md content (its living knowledge doc) — single-module GET only. */
  claudeMdContent?: string;
  [k: string]: unknown;
}

/** An inline image attached to a user turn — base64 bytes (no `data:` prefix), its media type, and
 *  the data-url preview the composer made for the optimistic UI bubble. The preview is client-only
 *  (it never crosses the wire); only `data` + `mediaType` ride to the server. */
export interface OutgoingImage {
  data: string;
  mediaType: string;
  /** A data: URL of the bytes — the composer makes it for the optimistic bubble; the server
   *  never sees it (only data + mediaType ride the wire). */
  preview: string;
}

/** One file saved to a session's deliverables/<runId>/uploads/ by /api/upload — the agent reads it
 *  from `path` relative to its cwd (the business dir). The composer cites these paths in the next
 *  send() so the agent knows what to open. */
export interface UploadedFile {
  name: string;
  /** Relative to the agent's cwd (= the business dir): `.bizagent/deliverables/<runId>/uploads/<name>`. */
  path: string;
  size: number;
}

/** A live session over HTTP: send turns, settle jobs, and subscribe to either the raw event
 *  stream or the reduced state. The SSE connection opens immediately and feeds the reducer. */
export interface SessionHandle {
  /** The server's in-process session id — addresses send/stream/jobs while the session is live.
   *  NOT the Claude session id and NOT resumable: for URLs / resume use `state.claudeSessionId`. */
  id: string;
  runId: string;
  business: string;
  /** Push one user turn. Optional inline images ride along as vision input (base64 content blocks).
   *  Non-image files don't go here — upload them with `uploadFiles` first and cite the returned
   *  paths in the text. */
  send(text: string, images?: OutgoingImage[]): Promise<void>;
  /** Save non-image files into the session's deliverables/<runId>/uploads/ dir; returns each
   *  file's relative path (the agent reads it with the Read tool, relative to its cwd). Multiple
   *  files in one call land in a single multipart request. */
  uploadFiles(files: File[]): Promise<UploadedFile[]>;
  /** Stop the in-flight turn (the stop button). The session stays open for the next send. */
  interrupt(): Promise<void>;
  listJobs(): Promise<JobCard[]>;
  resolveJob(ticket: string, result: string): Promise<void>;
  /** Subscribe to raw events; the listener fires for every event. Returns an unsubscribe. */
  on(listener: (e: SessionEvent) => void): () => void;
  /** Subscribe to reduced state; fires once immediately with the current state, then on change.
   *  Returns an unsubscribe. */
  onState(listener: (s: SessionState) => void): () => void;
  getState(): SessionState;
  /** Close the SSE connection (does not end the server-side session). */
  close(): void;
}

/** One root-level skill (read-only: the platform displays, files are the SOT). `id` is the
 *  directory name (addressing key); `name` is the SKILL.md display name. */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  fileCount: number;
}

export interface SkillDetail {
  id: string;
  name: string;
  description: string;
  files: { path: string; size: number }[];
}

/** One knowledge layer of a business (read-only browse: files are the SOT, written by agents
 *  and curators — the platform only displays them). */
export interface KnowledgeLayerInfo {
  layer: "business" | "line" | "common";
  /** Display label: the business slug / line slug / "common". */
  name: string;
  files: { path: string; size: number }[];
}

/** A product line as the picker sees it: slug (dir name / URL identity) + display name
 *  (line.json's, falling back to the slug for lines that never set one). */
export interface LineInfo {
  slug: string;
  name: string;
}

export interface BizClient {
  health(): Promise<{ ok: boolean; [k: string]: unknown }>;
  /** Product lines (real directories: lines/<line>/). A business always belongs to one. */
  listLines(): Promise<LineInfo[]>;
  createLine(line: string, name?: string): Promise<unknown>;
  /** A line's modules, metas resolved (modules are line-scoped and never cross lines). */
  listModules(line: string): Promise<ModuleInfo[]>;
  createModule(input: { line: string; slug: string; type: string; source?: string; deploy?: string }): Promise<unknown>;
  moduleMeta(line: string, mod: string): Promise<ModuleInfo>;
  /** Correct a module's recorded facts — type / source / deploy only (= `biz module set`). */
  updateModule(line: string, mod: string, patch: { type?: string; source?: string; deploy?: string }): Promise<ModuleInfo>;
  /** Root-level skills, read-only. */
  listSkills(): Promise<SkillInfo[]>;
  skillDetail(id: string): Promise<SkillDetail>;
  skillFile(id: string, path: string): Promise<string>;
  listBusinesses(): Promise<BusinessInfo[]>;
  createBusiness(input: { slug: string; line: string; name?: string; domain?: string }): Promise<unknown>;
  deleteBusiness(slug: string): Promise<void>;
  /** The business's linked modules, metas resolved in its own line. */
  businessModules(slug: string): Promise<ModuleInfo[]>;
  /** The business's knowledge tree, listed per layer (business / line / common). Read-only. */
  knowledge(slug: string): Promise<KnowledgeLayerInfo[]>;
  /** One knowledge file's raw markdown. */
  knowledgeFile(slug: string, layer: KnowledgeLayerInfo["layer"], path: string): Promise<string>;
  /** The SHARED knowledge layers at line scope (line + common) — a 知识库 tab's data. */
  lineKnowledge(line: string): Promise<KnowledgeLayerInfo[]>;
  lineKnowledgeFile(line: string, layer: "line" | "common", path: string): Promise<string>;
  /** Link a module into a business (= `biz link`; same line only, many-to-many, idempotent). */
  linkModule(slug: string, mod: string): Promise<unknown>;
  /** Unlink a module from a business (drops it from modules[] + removes the symlink; the module
   *  itself stays). Idempotent. */
  unlinkModule(slug: string, mod: string): Promise<unknown>;
  businessMeta(slug: string): Promise<unknown>;
  /** Patch a business's metadata — native fields or the opaque `ext` bag (deep-merged one level).
   *  Returns the updated meta. The seam for app-specific per-business display data. */
  updateBusiness(slug: string, patch: Record<string, unknown>): Promise<unknown>;
  context(slug: string): Promise<string>;
  recall(slug: string, q?: { scope?: string; query?: string }): Promise<unknown[]>;
  writeMemory(slug: string, payload: { body: string; scope?: string; confidence?: number; source_session?: string }): Promise<unknown>;
  worklogIndex(slug: string): Promise<unknown[]>;
  /** A business's runs (= sessions), newest first, each with the claudeSessionId to resume it,
   *  the requirement it ran under (`req`), and the launching task (`task`), when any. */
  runs(slug: string): Promise<Array<{ runId: string; date: string; description: string; claudeSessionId?: string; req?: string; task?: string }>>;
  /** A business's requirements (multi-session tasks): id + the state doc's status. */
  requirements(slug: string): Promise<Array<{ id: string; status: string }>>;
  /** One requirement's living state document (markdown), or "" when it has none yet. */
  requirementDoc(slug: string, id: string): Promise<string>;
  /** Create a requirement up front (lazy dir + skeleton doc). Starting a session under a new `req`
   *  also creates it, so this is only for making one before any chat. Pass an empty `id` to get an
   *  auto-allocated numeric id (the UI's default — titles are what humans use to recognize one).
   *  `goal` seeds the doc's Goal section; `title` seeds the doc's `# heading` (UI display name). */
  createRequirement(slug: string, id: string, goal?: string, title?: string): Promise<{ id: string; status: string }>;
  /** Overwrite the requirement's Goal — the human-owned section of the state doc (the agent is
   *  told never to rewrite a filled goal, so UI edits land here). */
  setRequirementGoal(slug: string, id: string, goal: string): Promise<void>;
  /** Rename a requirement (the id IS the name): moves its directory and re-points every linked
   *  run's marker. Rejects a malformed or colliding target id. */
  renameRequirement(slug: string, id: string, newId: string): Promise<{ id: string }>;
  /** Delete a requirement: its directory plus the runs' links to it. The linked conversations
   *  survive as req-less ("随手聊") sessions — only the requirement container goes. */
  deleteRequirement(slug: string, id: string): Promise<void>;
  /** Delete one run (= conversation): hard-removes its deliverables + worklog-index line. Claude
   *  Code's jsonl transcript is left intact, so the underlying conversation survives in CC. */
  deleteRun(slug: string, runId: string): Promise<void>;
  /** Rename one run (= conversation): a human display title that wins over the worklog summary
   *  in `runs()`. An empty string clears it back to the worklog summary. */
  renameRun(slug: string, runId: string, description: string): Promise<void>;
  /** A run's conversation replayed from its transcript — the backlog `resume` seeds state with. */
  history(slug: string, runId: string): Promise<SessionEvent[]>;
  worklog(slug: string, runId: string): Promise<string>;
  deliverables(slug: string, runId: string): Promise<string[]>;
  /** The same-origin URL for one deliverable file's raw bytes — feed it to a viewer, `<img>`, or
   *  a download anchor. Synchronous (just builds the path); the GET returns the file with a
   *  content-type keyed off its extension. */
  deliverableFileUrl(slug: string, runId: string, filename: string): string;
  sessions(): Promise<unknown[]>;
  /** Start a session. `req` runs it under a requirement (multi-session task) — lazily created,
   *  its state doc + sibling worklogs join the launch context. `task` pre-seeds an opening prompt
   *  server-side (e.g. `"setup"` runs the guided business setup). */
  start(o: { business: string; model?: string; req?: string; task?: string }): Promise<SessionHandle>;
  /** Re-open a session. Pass `runId` (from `runs()`) to replay its conversation history into the
   *  handle's state before the live stream attaches — without it the resumed chat starts blank
   *  (the SDK's resume only emits NEW messages, never the prior transcript). Pass `req` (the
   *  original run's) so the fresh run stays linked to its requirement. */
  resume(o: { business: string; claudeSessionId: string; model?: string; runId?: string; req?: string }): Promise<SessionHandle>;
}

/** Build a headless client against a `biz web` backend. `baseUrl` is the server origin; `fetch`
 *  can be injected for SSR/testing. No DOM, no framework — a UI layer binds `onState`. */
export function createBizClient(o: { baseUrl: string; fetch?: Fetch }): BizClient {
  const base = o.baseUrl.replace(/\/$/, "");
  const doFetch: Fetch = o.fetch ?? fetch;

  // The web handler returns `{ error: "<message>" }` on 4xx/5xx — surface that message to the
  // caller (and ultimately the UI) instead of a bare status code, so users see WHY a request
  // failed (e.g. "invalid requirement id 'foo'") not just "POST /api/... -> 400".
  const failOf = (verb: string, p: string, r: Response) =>
    r
      .json()
      .catch(() => null as { error?: string } | null)
      .then((j) => new Error(j?.error ?? `${verb} ${p} -> ${r.status}`));

  const getJSON = async <T>(p: string): Promise<T> => {
    const r = await doFetch(`${base}${p}`);
    if (!r.ok) throw await failOf("GET", p, r);
    return (await r.json()) as T;
  };
  const getText = async (p: string): Promise<string> => {
    const r = await doFetch(`${base}${p}`);
    if (!r.ok) throw await failOf("GET", p, r);
    return await r.text();
  };
  const postJSON = async <T>(p: string, body?: unknown): Promise<T> => {
    const r = await doFetch(`${base}${p}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw await failOf("POST", p, r);
    const ct = r.headers.get("content-type") ?? "";
    return (ct.includes("application/json") ? await r.json() : await r.text()) as T;
  };
  const putJSON = async (p: string, body: unknown): Promise<void> => {
    const r = await doFetch(`${base}${p}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await failOf("PUT", p, r);
  };

  // `resumeSid` — the claudeSessionId this handle was opened with (resume path). Recovery needs an
  // id that exists BEFORE any event arrives: state.claudeSessionId is also fed by the server's
  // `session` event, but a send can race ahead of the stream attach.
  const openSession = (started: { id: string; runId: string; business: string }, history?: SessionEvent[], resumeSid?: string, busy?: boolean): SessionHandle => {
    const controller = new AbortController();
    let state = initialSessionState();
    const rawListeners = new Set<(e: SessionEvent) => void>();
    const stateListeners = new Set<(s: SessionState) => void>();
    // One flag for "lost touch with the host" — set both by a send that hits the drain (503) or a
    // restart (connection drop), and by the stream loop when its reconnect keeps failing; the UI
    // shows a "restarting / reconnecting" hint. Cleared the moment either path heals.
    const setRestarting = (v: boolean) => {
      if (!!state.restarting === v) return;
      state = { ...state, restarting: v };
      for (const l of stateListeners) l(state);
    };

    // Seed the state with the replayed history, remembering each message's uuid. The live stream
    // can overlap the transcript's tail (resuming a still-running session replays its recent
    // buffer), and one uuid = one transcript line = a message the history already folded whole —
    // so any live event carrying a seen uuid is a replay and is skipped, never a new message.
    const seen = new Set<string>();
    // Injected lines are the one user-role message the LIVE stream carries (emitted at inject
    // time, uuid-less — the transcript uuid doesn't exist yet), while the replayed transcript
    // carries the same line WITH a uuid. The uuid set can't pair those two, so dedupe them by
    // exact text: covers history+buffer overlap AND a reconnect re-delivering the same emit.
    const seenInjected = new Set<string>();
    // Hook events have the SAME history-vs-live overlap as injected lines, but they DO carry a
    // uuid on both sides — they just never match. Live mints `crypto.randomUUID()` at emit time
    // (so a reconnect's buffer replay can dedupe by uuid); transcript replay carries the
    // transcript line's own uuid. The two streams are independent, so the uuid set can't pair
    // them. Text-dedupe hooks like injected lines: the worklog-missing reminder is templated
    // with the run's own path, so the text already varies across runs, and within a run the
    // Stop hook's `stopActive` guard ensures the same block can't fire twice.
    const seenHookText = new Set<string>();
    if (history && history.length) {
      for (const ev of history) {
        state = reduceSession(state, ev);
        if ("uuid" in ev && typeof ev.uuid === "string") seen.add(ev.uuid);
        if (ev.type === "message" && ev.role === "user") seenInjected.add(ev.text);
        if (ev.type === "hook") seenHookText.add(ev.text);
      }
      // transcript 不带 idle 事件,所以 reopen 一个已结束会话默认要补 idle 才不显示 phantom 进行中。
      // 但 mid-turn 接入(server 告知 busy=true)不能补——会话本就在进行,补了 idle 会让 hint 消失到下一
      // 个 SSE 事件才回。busy=undefined(老 server / 兜底)按 finished 处理,保留原行为。
      if (busy !== true) state = reduceSession(state, { type: "idle" });
    }

    // The live stream, with reconnect. readSSE ends either when the server sends the terminal
    // `closed` event (a real end) or when the connection drops (network blip, server restart, a
    // laptop waking from sleep). Only the former is final: on a drop we reconnect and RESUME —
    // `lastSeq` is the last event sequence number we consumed (the SSE Last-Event-ID), and the
    // server replays only what came after it, so a reconnect re-delivers nothing. The uuid/text
    // dedup below still guards the one overlap resume can't see: replayed HISTORY (transcript)
    // vs the live buffer — two different sources with independent numbering. Mid-turn delta text
    // lost during the gap is reconciled by that turn's full `message` when it lands.
    let serverClosed = false;
    let lastSeq: number | undefined;
    void (async () => {
      let backoff = 1000;
      let reconnectFails = 0;
      while (!controller.signal.aborted && !serverClosed) {
        try {
          const res = await doFetch(`${base}/api/stream?id=${encodeURIComponent(started.id)}`, {
            signal: controller.signal,
            ...(lastSeq !== undefined ? { headers: { "last-event-id": String(lastSeq) } } : {}),
          });
          // 404 = the manager id is gone (the server restarted and lost its in-memory sessions).
          // Re-open the conversation by its durable claudeSessionId and retry with the new id —
          // without this only a user send() would heal the handle, and a viewer who is just
          // watching (e.g. waiting on a long turn) would silently never reattach.
          if (res.status === 404) {
            const sid = state.claudeSessionId ?? resumeSid;
            if (sid) {
              const sp = new URLSearchParams({ business: started.business, resume: sid });
              const next = await postJSON<{ id: string; runId: string }>(`/api/start?${sp.toString()}`);
              started.id = next.id;
              started.runId = next.runId;
              lastSeq = undefined; // a NEW server session numbers its events from scratch
              continue; // reconnect immediately with the new id
            }
          }
          if (!res.ok) throw new Error(`stream ${res.status}`);
          backoff = 1000; // connected — reset the backoff
          reconnectFails = 0;
          setRestarting(false); // a (re)connection healed — drop any "reconnecting" hint
          for await (const ev of readSSE(res, controller.signal)) {
            if (typeof ev.seq === "number") lastSeq = ev.seq;
            if ("uuid" in ev && typeof ev.uuid === "string") {
              if (seen.has(ev.uuid)) continue;
              seen.add(ev.uuid);
            } else if (ev.type === "message" && ev.role === "user") {
              // A live injected line (the only uuid-less user-role message) — text-dedupe it
              // against the folded history and against its own buffer re-delivery on reconnect.
              if (seenInjected.has(ev.text)) continue;
              seenInjected.add(ev.text);
            }
            // Hooks carry a uuid but it's a different uuid stream from transcript replay's, so
            // the uuid set alone leaks the history-vs-live overlap — apply the same text-dedup
            // as injected lines (see seenHookText). The uuid check above still guards
            // buffer-replay duplicates within the live stream.
            if (ev.type === "hook") {
              if (seenHookText.has(ev.text)) continue;
              seenHookText.add(ev.text);
            }
            if (ev.type === "closed") serverClosed = true;
            for (const l of rawListeners) l(ev);
            state = reduceSession(state, ev);
            for (const l of stateListeners) l(state);
          }
        } catch {
          // Network drop / host restart / abort. Two consecutive failures (the first retry still
          // failing) means it's not a one-off blip — surface "reconnecting" so a watcher who never
          // sent a turn still sees the host is down, not a frozen page. A single blip stays quiet.
          if (!controller.signal.aborted && ++reconnectFails >= 2) setRestarting(true);
        }
        if (controller.signal.aborted || serverClosed) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10000); // 10s 封顶——重启/掉线后最坏 10s 重连一次，恢复不拖尾
      }
    })();

    return {
      id: started.id,
      runId: started.runId,
      business: started.business,
      send: async (textBody, images) => {
        // Optimistically show the user's own turn. The SDK echoes a user message only as
        // tool_results, never as the typed text, so there's nothing to dedup against — without
        // this the sent message would never appear in the conversation. Inline image previews
        // ride on the user item (client-only, see TimelineItem.user.images).
        const previews = images?.map((i) => i.preview) ?? [];
        state = reduceSession(state, { type: "message", role: "user", text: textBody, at: nowIso(), ...(previews.length ? { images: previews } : {}) } as SessionEvent);
        for (const l of stateListeners) l(state);
        // Text-only stays the legacy BARE STRING (zero regression — that's the wire shape every
        // existing client sent). A turn with images wraps as JSON {text, images} the server picks
        // out (only those two fields ride the wire; the data: preview is client-only).
        const body = images && images.length > 0
          ? JSON.stringify({ text: textBody, images: images.map((i) => ({ data: i.data, mediaType: i.mediaType })) })
          : textBody;
        const headers = images && images.length > 0 ? { "content-type": "application/json" } : undefined;
        const post = () => doFetch(`${base}/api/send?id=${encodeURIComponent(started.id)}`, { method: "POST", body, ...(headers ? { headers } : {}) });
        // The manager id is per-process: a 404 (or refused connection) usually means the server
        // restarted and lost the in-memory session. Re-open the conversation by its durable
        // claudeSessionId, point this handle at the new manager id (the stream loop picks it up on
        // its next reconnect), and deliver the message there. Returns whether it was delivered.
        const viaResume = async (): Promise<boolean> => {
          const sid = state.claudeSessionId ?? resumeSid;
          if (!sid) return false; // a fresh session that never reached init — nothing durable to resume
          try {
            const sp = new URLSearchParams({ business: started.business, resume: sid });
            const next = await postJSON<{ id: string; runId: string; business: string }>(`/api/start?${sp.toString()}`);
            started.id = next.id;
            started.runId = next.runId;
            return !!(await post())?.ok;
          } catch {
            return false;
          }
        };
        let r = await post().catch(() => null);
        if (r?.ok) return;
        // A definite non-ok response that ISN'T a drain (e.g. 404 = host alive but lost our manager
        // id) — a single resume usually heals it without bothering the user.
        if (r && r.status !== 503 && (await viaResume())) return;
        // Still undelivered = the host is DRAINING (503) or unreachable (connection drop) — i.e. mid
        // graceful-restart, the moment a 503-only check would miss. Don't fail silently (the
        // optimistic turn would hang with no reply forever): flag the UI ("restarting, please wait")
        // and poll-resend until the host is back — a resend lands the moment drain lifts, or
        // viaResume re-homes onto the new process. Capped at 5min so a wedged host eventually drops
        // the banner and leaves the turn for a manual retry.
        setRestarting(true);
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline && !controller.signal.aborted) {
          await new Promise((res) => setTimeout(res, 3000));
          if (controller.signal.aborted) return;
          if ((await post().catch(() => null))?.ok) { setRestarting(false); return; }
          if (await viaResume()) { setRestarting(false); return; }
        }
        setRestarting(false); // gave up / aborted — the optimistic turn stays for a manual retry
      },
      uploadFiles: async (files) => {
        if (!files.length) return [];
        const form = new FormData();
        for (const f of files) form.append("file", f, f.name);
        const r = await doFetch(`${base}/api/upload?id=${encodeURIComponent(started.id)}`, { method: "POST", body: form });
        if (!r.ok) throw new Error(`POST /api/upload -> ${r.status}`);
        const j = (await r.json()) as { files: UploadedFile[] };
        return j.files;
      },
      interrupt: async () => {
        await doFetch(`${base}/api/interrupt?id=${encodeURIComponent(started.id)}`, { method: "POST" }).catch(() => null);
      },
      listJobs: () => getJSON<JobCard[]>(`/api/jobs?id=${encodeURIComponent(started.id)}`),
      resolveJob: async (ticket, result) => {
        await doFetch(`${base}/api/jobs/done?id=${encodeURIComponent(started.id)}&ticket=${encodeURIComponent(ticket)}`, {
          method: "POST",
          body: result,
        });
      },
      on: (listener) => {
        rawListeners.add(listener);
        return () => rawListeners.delete(listener);
      },
      onState: (listener) => {
        stateListeners.add(listener);
        listener(state); // fire immediately with the current snapshot
        return () => stateListeners.delete(listener);
      },
      getState: () => state,
      close: () => controller.abort(),
    };
  };

  return {
    health: () => getJSON("/api/health"),
    listLines: () => getJSON<LineInfo[]>("/api/lines"),
    createLine: (line, name) => postJSON("/api/lines", { line, name }),
    listModules: (line) => getJSON<ModuleInfo[]>(`/api/lines/${encodeURIComponent(line)}/modules`),
    createModule: ({ line, ...input }) => postJSON(`/api/lines/${encodeURIComponent(line)}/modules`, input),
    moduleMeta: (line, mod) => getJSON<ModuleInfo>(`/api/lines/${encodeURIComponent(line)}/modules/${encodeURIComponent(mod)}`),
    updateModule: async (line, mod, patch) => {
      const r = await doFetch(`${base}/api/lines/${encodeURIComponent(line)}/modules/${encodeURIComponent(mod)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`PATCH module -> ${r.status}`);
      return (await r.json()) as ModuleInfo;
    },
    listSkills: () => getJSON<SkillInfo[]>("/api/skills"),
    skillDetail: (id) => getJSON<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`),
    skillFile: (id, p) => getText(`/api/skills/${encodeURIComponent(id)}/file?path=${encodeURIComponent(p)}`),
    listBusinesses: () => getJSON<BusinessInfo[]>("/api/businesses"),
    createBusiness: (input) => postJSON("/api/businesses", input),
    businessModules: (slug) => getJSON<ModuleInfo[]>(`/api/businesses/${encodeURIComponent(slug)}/modules`),
    linkModule: (slug, mod) => postJSON(`/api/businesses/${encodeURIComponent(slug)}/modules`, { module: mod }),
    unlinkModule: async (slug, mod) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}/modules/${encodeURIComponent(mod)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`DELETE module ${mod} -> ${r.status}`);
      return (await r.json()) as unknown;
    },
    deleteBusiness: async (slug) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`DELETE business ${slug} -> ${r.status}`);
    },
    businessMeta: (slug) => getJSON(`/api/businesses/${encodeURIComponent(slug)}`),
    updateBusiness: async (slug, patch) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`PATCH business ${slug} -> ${r.status}`);
      return r.json();
    },
    context: (slug) => getText(`/api/businesses/${encodeURIComponent(slug)}/context`),
    recall: (slug, q) => {
      const sp = new URLSearchParams();
      if (q?.scope) sp.set("scope", q.scope);
      if (q?.query) sp.set("query", q.query);
      const qs = sp.toString();
      return getJSON<unknown[]>(`/api/businesses/${encodeURIComponent(slug)}/memory${qs ? `?${qs}` : ""}`);
    },
    writeMemory: (slug, payload) => postJSON(`/api/businesses/${encodeURIComponent(slug)}/memory`, payload),
    worklogIndex: (slug) => getJSON<unknown[]>(`/api/businesses/${encodeURIComponent(slug)}/worklog`),
    runs: (slug) => getJSON(`/api/businesses/${encodeURIComponent(slug)}/runs`),
    requirements: (slug) => getJSON(`/api/businesses/${encodeURIComponent(slug)}/requirements`),
    requirementDoc: (slug, id) => getText(`/api/businesses/${encodeURIComponent(slug)}/requirements/${encodeURIComponent(id)}`),
    knowledge: (slug) => getJSON<KnowledgeLayerInfo[]>(`/api/businesses/${encodeURIComponent(slug)}/knowledge`),
    knowledgeFile: (slug, layer, p) =>
      getText(`/api/businesses/${encodeURIComponent(slug)}/knowledge/file?layer=${encodeURIComponent(layer)}&path=${encodeURIComponent(p)}`),
    lineKnowledge: (line) => getJSON<KnowledgeLayerInfo[]>(`/api/lines/${encodeURIComponent(line)}/knowledge`),
    lineKnowledgeFile: (line, layer, p) =>
      getText(`/api/lines/${encodeURIComponent(line)}/knowledge/file?layer=${encodeURIComponent(layer)}&path=${encodeURIComponent(p)}`),
    createRequirement: (slug, id, goal, title) => postJSON(`/api/businesses/${encodeURIComponent(slug)}/requirements`, { id, goal, title }),
    setRequirementGoal: (slug, id, goal) =>
      putJSON(`/api/businesses/${encodeURIComponent(slug)}/requirements/${encodeURIComponent(id)}/goal`, { goal }),
    renameRequirement: async (slug, id, newId) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}/requirements/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: newId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `PATCH requirement ${id} -> ${r.status}`);
      return (await r.json()) as { id: string };
    },
    deleteRequirement: async (slug, id) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}/requirements/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`DELETE requirement ${id} -> ${r.status}`);
    },
    deleteRun: async (slug, runId) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`DELETE run ${runId} -> ${r.status}`);
    },
    renameRun: async (slug, runId, description) => {
      const r = await doFetch(`${base}/api/businesses/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `PATCH run ${runId} -> ${r.status}`);
    },
    history: (slug, runId) => getJSON<SessionEvent[]>(`/api/businesses/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/history`),
    worklog: (slug, runId) => getText(`/api/businesses/${encodeURIComponent(slug)}/worklog/${encodeURIComponent(runId)}`),
    deliverables: (slug, runId) => getJSON<string[]>(`/api/businesses/${encodeURIComponent(slug)}/deliverables/${encodeURIComponent(runId)}`),
    deliverableFileUrl: (slug, runId, filename) =>
      `${base}/api/businesses/${encodeURIComponent(slug)}/deliverables/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`,
    sessions: () => getJSON<unknown[]>("/api/sessions"),
    start: async ({ business, model, req, task }) => {
      const sp = new URLSearchParams({ business });
      if (model) sp.set("model", model);
      if (req) sp.set("req", req);
      if (task) sp.set("task", task);
      const started = await postJSON<{ id: string; runId: string; business: string }>(`/api/start?${sp.toString()}`);
      return openSession(started);
    },
    resume: async ({ business, claudeSessionId, model, runId, req }) => {
      const sp = new URLSearchParams({ business, resume: claudeSessionId });
      if (model) sp.set("model", model);
      if (req) sp.set("req", req);
      // History is fetched before the live stream opens so the seeded state is ready the moment
      // any listener subscribes. Best-effort: a run with no replayable transcript seeds empty.
      const history = runId
        ? await getJSON<SessionEvent[]>(`/api/businesses/${encodeURIComponent(business)}/runs/${encodeURIComponent(runId)}/history`).catch(() => [])
        : undefined;
      const started = await postJSON<{ id: string; runId: string; business: string; busy?: boolean }>(`/api/start?${sp.toString()}`);
      return openSession(started, history, claudeSessionId, started.busy);
    },
  };
}
