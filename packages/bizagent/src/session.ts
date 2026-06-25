// SessionManager — the multi-turn, multi-session core the web layer builds on: one long-lived
// SDK query() per session (streaming-input mode), turned into a typed SessionEvent stream that
// many clients can subscribe to. Transport-agnostic — no HTTP here; an HTTP/SSE adapter wraps
// this later.
//
// Reuse: buildSdkOptions (runtime-sdk) supplies the same systemPrompt + in-process hooks as the
// CLI path, so worklog enforcement and remote sharing come along unchanged. The only additions
// are the duplex around query() (push input / map output), multi-subscriber fan-out, and resume.
//
// The pure pieces (input channel, broadcaster, message mapping, worklog projection) are
// exported and unit-tested WITHOUT the SDK installed; only start()/resume() import it.
import path from "node:path";
import { businessDir, deliverablesDir, parseModuleWorkspaceId } from "./paths";
import { mkdirp, readFileOr, writeFile } from "./fsutil";
import { buildSdkOptions, type SdkOptions } from "./runtime-sdk";
import { makeRunId, resolveClaudeExecutable } from "./runtime-cli";
import { ensureRequirement, recordRunReq, recordRunModel, recordRunRequester, recordRunTask, runForSessionId, runModel, runReq } from "./requirement";
import { ensureSkillsLink } from "./skill";
import { ensureKnowledgeLinks } from "./knowledge";
import { formatInbound, formatJobResult, type Inbound } from "./inbound";
import type { Scope } from "./scope";
import { scopeKey } from "./scope";
import type { ModelResolver } from "./model";
import type { SchedulerStore } from "./schedule";
import { clampDelay, chainExhausted } from "./schedule";
import { buildCapabilitiesPrompt } from "./context";
import { nowIso } from "./time";

// ─────────────────────────── public types ───────────────────────────

/** Who is driving a session — passed to resolveAuth (multi-user) and kept for attribution.
 *  Opaque to the manager beyond that. */
export interface Identity {
  userId?: string;
  [k: string]: unknown;
}

/** How the underlying claude authenticates for one session. Default ({}) rides the host's
 *  `claude login` subscription (no key). A platform can return a per-user key / executable. */
export interface AuthConfig {
  claudeExecutable?: string;
  env?: Record<string, string>;
}

/** Per-turn usage/cost, read off the SDK `result` message — the observability bizagent must
 *  surface itself (the CLI shows it in the terminal; the SDK only reports it here). Values are
 *  passed through as Claude Code reports them (total_cost_usd is the session's running total). */
export interface SessionUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  numTurns?: number;
  durationMs?: number;
  /** input_tokens from the latest assistant message — per single API call (not per-turn累加).
   *  This is what the model actually saw as its prompt on the last round-trip, so it's the right
   *  number for "context window occupancy" (how full the window is right now). One turn can fire
   *  many tool round-trips; we keep overwriting with the latest, which is the biggest and the
   *  one closest to the window ceiling. The per-turn累加 lives in inputTokens. */
  lastCallInputTokens?: number;
}

/** A typed projection of the SDK's raw message stream + harness file activity. This is what
 *  the web renders. `uuid` is the SDK message id, for client-side dedup across reconnects.
 *
 *  Streaming contract: with includePartialMessages on, a turn emits many `delta` events (live,
 *  incremental — not buffered individually; a fresh subscriber gets the in-flight message's
 *  accumulated prefix as one synthetic delta) followed by one full `message` (the canonical
 *  text, buffered). A delta-aware client renders deltas then reconciles to the `message`; a simple
 *  client ignores `delta` (unknown type) and renders `message` as before — so this stays backward
 *  compatible. `tool` start now carries the call `input`; `tool` end carries a truncated `result`.
 *  `at` is the event's wall-clock ISO time — stamped at emit on a live session, and from the
 *  transcript line's own timestamp on history replay — so a UI can render message timestamps.
 *
 *  `seq` is the per-session emit sequence number, stamped by the Broadcast on every buffered
 *  (non-delta) event. It is the SSE resume cursor: a reconnecting client sends the last seq it
 *  saw (Last-Event-ID) and the server replays only what came after — so a reconnect never
 *  re-delivers events, regardless of event type. Absent on deltas (live-only) and on transcript
 *  replays (history is a different source; uuid dedup covers that overlap). */
export type SessionEvent = (
  | { type: "session"; claudeSessionId: string } // the Claude Code session id, once the init message lands
  | { type: "message"; text: string; uuid?: string; role?: "user" | "assistant"; at?: string }
  // A harness hook intervened mid-conversation (today: the Stop hook blocking with the worklog
  // reminder). Surfaced so a UI can explain WHY the agent kept going after it seemed done —
  // without this the post-hook continuation reads as an unprompted new message. `text` is the
  // prompt fed back to the model. Old clients ignore unknown event types, so this is additive.
  | { type: "hook"; hook: "stop"; text: string; uuid?: string; at?: string }
  | { type: "delta"; text: string; thinking?: boolean; uuid?: string }
  | { type: "tool"; name?: string; phase: "start" | "end"; input?: unknown; result?: string; isError?: boolean; uuid?: string; id?: string; at?: string }
  | ({ type: "usage" } & SessionUsage)
  | { type: "worklog"; runId: string; content: string }
  | { type: "job"; ticket: string; status: "open" | "done" | "failed"; label?: string; result?: string }
  | { type: "idle" } // the assistant finished responding to the last turn
  | { type: "error"; message: string }
  | { type: "closed" } // session ended
) & { seq?: number };

export interface BizSession {
  id: string;
  business: string;
  runId: string;
  /** The isolation scope this session belongs to (passed at start/resume/fork). Opaque to the
   *  manager — surfaced so a platform can attribute / filter sessions; bizagent never stores it.
   *  Undefined for a single-tenant caller that doesn't pass one. */
  scope?: Scope;
  /** The identity this session was launched with (passed at start/resume/fork). Opaque to the
   *  manager — surfaced so a platform can attribute sessions / persist who launched a turn,
   *  which is what an auto-resume across a host restart needs to rebuild the same auth env.
   *  Undefined for headless launches (pulse reports, scheduler wakeups, no-identity callers). */
  identity?: Identity;
  /** The requirement this session runs under, when any (the durable link is the run's `.req`
   *  marker; this mirrors it for the live read model). */
  req?: string;
  /** The SDK/Claude Code session id. A platform stores this to correlate / resume across
   *  restarts. On a fresh session it's undefined until the init message lands (`ready`); a
   *  resumed session knows it from the start (pre-set to the id being resumed). */
  claudeSessionId?: string;
  /** Latest usage/cost reported by the SDK `result` message (cumulative cost for the session).
   *  Updated each turn; undefined until the first turn finishes. The `/api/sessions` read model
   *  surfaces it so a platform gets spend visibility without parsing the event stream. */
  usage?: SessionUsage;
  /** The session has unfinished work: input was pushed (send/inject) and the matching turn hasn't
   *  reached `idle` yet (or more input is queued behind it). The seam for a host's graceful
   *  shutdown — drain = wait until no live session is busy — and for snapshotting which sessions
   *  were mid-turn when a process died (auto-resume on the next boot). */
  busy: boolean;
  /** Resolves once the SDK init message is seen (claudeSessionId is then set). */
  ready: Promise<string>;
  /** Push one user turn. Optional inline images ride along as vision input. No-op once ended. */
  send(text: string, images?: ImageInput[]): void;
  /** Stop the in-flight turn (the UI's stop button → SDK interrupt). The session stays open and
   *  accepts the next send. No-op when nothing is running or the SDK hasn't launched yet. */
  interrupt(): Promise<void>;
  /** Deliver an out-of-band line into the running conversation as a new turn — the seam a
   *  background job's result comes back through. Marked text, not a user message. No-op once
   *  ended. */
  inject(text: string): void;
  /** Inject a marked out-of-band line. The host names the source (`from`) and picks the `kind`
   *  (another person in a room, a teammate agent, a cron firing, a system notice); bizagent only
   *  wraps it via `formatInbound` so the agent never mistakes it for the user's own turn. */
  injectFrom(m: Inbound): void;
  /** Settle an open background job by ticket (a human click / webhook). Returns false if the
   *  ticket is unknown or already settled. */
  resolveJob(ticket: string, result: string): boolean;
  /** Background jobs still waiting, for a UI to render pending task cards. */
  listJobs(): Array<{ ticket: string; label?: string }>;
  /** A fresh stream: the recent in-process buffer first (so a second tab catches up), then
   *  live events. Pass `afterSeq` (the last event `seq` the client consumed — its
   *  Last-Event-ID) to resume a broken stream without re-delivering what it already has.
   *  Durable cross-restart history is the platform's job (not core). */
  subscribe(opts?: { afterSeq?: number }): AsyncIterable<SessionEvent>;
  /** A synchronous snapshot of recently emitted events (deltas excluded) — for debug/introspection
   *  endpoints that want the event log without opening a stream. */
  recentEvents(): SessionEvent[];
  /** Close input, let the turn drain, broadcast `closed`, drop from the manager. */
  end(): Promise<void>;
}

export interface SessionManager {
  /** `req` runs the session under a requirement (multi-session task): lazily creates
   *  `requirements/<req>/`, links the run, and injects the requirement's context at launch. */
  start(o: { business: string; identity?: Identity; prompt?: string; model?: string; scope?: Scope; req?: string; task?: string }): BizSession;
  /** Re-open a conversation. Converges on its ORIGINAL run: unless `runId` overrides it, the
   *  manager reverse-looks-up which run recorded this claudeSessionId and reuses it (same
   *  deliverables dir, same worklog, one history entry), along with that run's recorded `req`
   *  when none is passed. Without a `prompt` the SDK launch is DEFERRED until the first
   *  send() — browsing history must not boot a Claude process (and a resume launched with no
   *  pending input makes Claude Code synthesize a junk "Continue from where you left off."
   *  turn). */
  resume(o: { business: string; claudeSessionId: string; identity?: Identity; prompt?: string; model?: string; scope?: Scope; wakeupChain?: number; req?: string; runId?: string }): BizSession;
  /** Branch a NEW session off an existing one's transcript. The SDK copies the transcript
   *  (forkSession) so the original is untouched; the fork gets its OWN claudeSessionId (captured
   *  from its init message via `ready`). Optionally fork from a specific past message
   *  (atMessageUuid) rather than the tip. The platform stores the new id — bizagent doesn't. */
  fork(o: {
    business: string;
    fromClaudeSessionId: string;
    atMessageUuid?: string;
    identity?: Identity;
    prompt?: string;
    model?: string;
    scope?: Scope;
  }): BizSession;
  get(id: string): BizSession | undefined;
  list(filter?: { business?: string }): BizSession[];
}

// ─────────────────────────── pure pieces (SDK-free, unit-tested) ───────────────────────────

/** Shape of the input messages the SDK consumes in streaming-input mode. */
/** An inline image attachment carried on a user turn: base64 bytes (NO `data:` URL prefix) plus
 *  its media type. Maps 1:1 to the Anthropic image content block — the SDK forwards it to Claude
 *  as vision input, exactly like a typed message. Text-only turns never allocate one. */
export interface ImageInput {
  data: string;
  mediaType: string;
}

/** A user turn's content: either a bare string (text-only, the common case) or an ordered list of
 *  text/image blocks when images ride along. The SDK accepts both — string is sugar for a single
 *  text block. */
type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface SdkUserMessage {
  type: "user";
  message: { role: "user"; content: string | UserContentBlock[] };
  parent_tool_use_id: null;
}

/** A push-able async input: `push(text)` enqueues a user turn the SDK pulls; `close()` ends
 *  the stream (the SDK then wraps up the session). The generator blocks when the queue is
 *  empty and resumes on push/close — this is what keeps one query() open across turns. */
export function makeInputChannel(): {
  gen: AsyncGenerator<SdkUserMessage>;
  push(text: string, images?: ImageInput[]): void;
  close(): void;
  /** Resolves on the first push (true) or on close-before-any-push (false). Lets a lazy
   *  consumer (a resumed session) delay launching the SDK until there's actually input. */
  first: Promise<boolean>;
  /** Turns still queued (not yet pulled by the SDK) — busy tracking needs it to tell "this idle
   *  ends the work" from "another queued turn follows". */
  size(): number;
} {
  const queue: SdkUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let settleFirst: ((has: boolean) => void) | null = null;
  const first = new Promise<boolean>((r) => (settleFirst = r));

  const debug = !!process.env.BIZ_DEBUG;
  async function* gen(): AsyncGenerator<SdkUserMessage> {
    while (true) {
      while (queue.length === 0) {
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
      }
      const next = queue.shift()!;
      if (debug) console.error(`[biz input] yield → SDK:`, typeof next.message.content === "string" ? next.message.content : `[content blocks ×${next.message.content.length}]`);
      yield next;
    }
  }
  const bump = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    gen: gen(),
    first,
    size: () => queue.length,
    push(text, images) {
      if (closed) return;
      // Text-only stays a bare string (zero overhead, the common path). With images, build the
      // ordered block list the Anthropic API wants: the caption first (if any), then each image.
      let content: string | UserContentBlock[];
      if (images && images.length > 0) {
        const blocks: UserContentBlock[] = [];
        if (text) blocks.push({ type: "text", text });
        for (const img of images) blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
        content = blocks;
      } else {
        content = text;
      }
      if (debug) console.error(`[biz input] queued:`, typeof content === "string" ? content : `[${images!.length} img] ${text || "(no caption)"}`);
      queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      settleFirst?.(true);
      settleFirst = null;
      bump();
    },
    close() {
      closed = true;
      settleFirst?.(false);
      settleFirst = null;
      bump();
    },
  };
}

/** Fan-out of SessionEvents to many subscribers, with a bounded recent buffer so a late
 *  subscriber (a second browser tab on a running session) catches up. NOT durable — the
 *  buffer is in-process and capped; cross-restart history is the platform's concern. */
export class Broadcast {
  private buffer: SessionEvent[] = [];
  private subs = new Set<(e: SessionEvent) => void>();
  private done = false;
  private seq = 0;
  // The in-flight message's accumulated partial text/thinking. Deltas are never buffered, but
  // dropping them entirely leaves a late joiner staring at a busy session with nothing on
  // screen until the message completes — minutes, for a long report. A fresh subscriber gets
  // this prefix as synthetic deltas instead, and live deltas continue from there.
  private partialText = "";
  private partialThinking = "";
  constructor(private readonly maxBuffer = 200) {}

  /** A synchronous snapshot of the buffered events (the same set a late subscriber replays —
   *  deltas excluded). For debugging / introspection: read what a session has emitted without
   *  opening a stream. */
  recent(): SessionEvent[] {
    return [...this.buffer];
  }

  emit(e: SessionEvent): void {
    // `delta`s are live-only incremental text — replaying them one by one to a late subscriber
    // would be a flood of stale fragments, so they don't enter the buffer; the accumulated
    // partial below catches a fresh subscriber up instead, and the full `message` reconciles.
    // Buffered events get the resume cursor (`seq`): a reconnect passes the last seq it saw and
    // replay starts AFTER it — deltas need none (a reconnect recovers their turn via `message`).
    if (e.type !== "delta") {
      e.seq = ++this.seq;
      this.buffer.push(e);
      if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    }
    // The partial snapshot. Clears mirror the client reducer's flush points (an assistant
    // `message` reconciles its deltas; `tool` start and `hook` fold thinking away) so the
    // synthetic catch-up never re-delivers text a buffered event already lands.
    if (e.type === "delta") {
      if (e.thinking) this.partialThinking += e.text;
      else this.partialText += e.text;
    } else if (e.type === "message" && e.role !== "user") {
      this.partialText = this.partialThinking = "";
    } else if ((e.type === "tool" && e.phase === "start") || e.type === "hook") {
      this.partialThinking = "";
    } else if (e.type === "idle" || e.type === "error" || e.type === "closed") {
      this.partialText = this.partialThinking = "";
    }
    if (e.type === "closed") this.done = true;
    for (const s of [...this.subs]) s(e);
  }

  /** `afterSeq` resumes a broken stream: replay only buffered events newer than the cursor the
   *  client already consumed (its Last-Event-ID). Without it, the full buffer replays — the
   *  fresh-subscriber (second tab) contract, unchanged. */
  subscribe(afterSeq?: number): AsyncIterable<SessionEvent> {
    const q: SessionEvent[] = afterSeq === undefined ? [...this.buffer] : this.buffer.filter((e) => (e.seq ?? 0) > afterSeq);
    // A fresh subscriber landing mid-message gets the in-flight prefix as synthetic deltas —
    // uuid-less (the client's uuid dedup must not drop them) and seq-less (not a resume point).
    // A reconnect (afterSeq) skips this on purpose: that client already rendered the prefix,
    // and appending it again would double it; its gap reconciles via the turn's full `message`.
    if (afterSeq === undefined) {
      if (this.partialThinking) q.push({ type: "delta", text: this.partialThinking, thinking: true });
      if (this.partialText) q.push({ type: "delta", text: this.partialText });
    }
    let wake: (() => void) | null = null;
    const listener = (e: SessionEvent) => {
      q.push(e);
      const w = wake;
      wake = null;
      w?.();
    };
    this.subs.add(listener);
    const subs = this.subs;
    const isDone = () => this.done;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            while (q.length === 0) {
              if (isDone()) return;
              await new Promise<void>((r) => (wake = r));
            }
            const e = q.shift()!;
            yield e;
            if (e.type === "closed") return;
          }
        } finally {
          subs.delete(listener);
        }
      },
    };
  }
}

/** Tool results can be huge (a 50k-row dump); cap what rides the event stream. */
const TOOL_RESULT_MAX = 2000;

/** Normalize a tool_result `content` (string, or array of text/json blocks) to one string. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const x = b as Record<string, unknown>;
        return typeof x.text === "string" ? x.text : JSON.stringify(x);
      })
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function truncate(s: string, max = TOOL_RESULT_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

/** Pull usage/cost off a `result` message into our neutral shape. Returns null if the message
 *  carries no usage fields (so a bare result still maps to just `idle`). Field names follow the
 *  SDK/Anthropic result message (snake_case); we read defensively as versions vary. */
export function extractUsage(msg: unknown): SessionUsage | null {
  const m = msg as { total_cost_usd?: unknown; num_turns?: unknown; duration_ms?: unknown; usage?: Record<string, unknown> };
  const u = m.usage ?? {};
  const out: SessionUsage = {};
  if (typeof m.total_cost_usd === "number") out.costUsd = m.total_cost_usd;
  if (typeof u.input_tokens === "number") out.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") out.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === "number") out.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === "number") out.cacheCreationTokens = u.cache_creation_input_tokens;
  if (typeof m.num_turns === "number") out.numTurns = m.num_turns;
  if (typeof m.duration_ms === "number") out.durationMs = m.duration_ms;
  return Object.keys(out).length ? out : null;
}

/** Map one raw SDK message to zero or more SessionEvents. Pure (no I/O): the session id and
 *  worklog projection are handled by the run loop, which has the fs + state.
 *  - assistant text -> `message`; assistant tool_use -> `tool start` (with its `input` args)
 *  - user tool_result -> `tool end` (with a truncated `result` + `isError`)
 *  - stream_event content_block_delta -> `delta` (text or thinking, when includePartialMessages on)
 *  - result -> `idle` (+ a `usage` event when the result carries usage/cost) */
export function mapMessage(msg: unknown): SessionEvent[] {
  const m = msg as {
    type?: string;
    subtype?: string;
    uuid?: string;
    message?: { content?: unknown; model?: string };
    event?: { type?: string; delta?: { type?: string; text?: unknown; thinking?: unknown } };
  };
  const out: SessionEvent[] = [];
  const uuid = m.uuid;

  if (m.type === "assistant") {
    // model "<synthetic>" marks a message Claude Code manufactured itself — no model call behind
    // it. The one every resume produces is CC answering its own injected isMeta "Continue from
    // where you left off." turn with "No response requested." — noise in a chat timeline, and any
    // real failure already reaches the UI via the `error` event, not a synthetic banner.
    if (m.message?.model === "<synthetic>") return out;
    // Per-call usage rides on the assistant message itself (the SDK passes message.usage on
    // every API round-trip). This is what the model actually saw as input on THIS call — the right
    // number for "window occupancy" (input_tokens accumulated turn-wide in the result message
    // overstates it N-fold when a turn fires N tool rounds). Emit a usage event with just the
    // per-call field; the cumulative one comes from the result message later.
    const msgUsage = (m.message as { usage?: { input_tokens?: unknown } } | undefined)?.usage;
    const lastCallInput = typeof msgUsage?.input_tokens === "number" ? msgUsage.input_tokens : undefined;
    if (lastCallInput !== undefined) out.push({ type: "usage", lastCallInputTokens: lastCallInput });
    const content = m.message?.content;
    if (typeof content === "string") {
      if (content) out.push({ type: "message", text: content, uuid });
      return out;
    }
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b.type === "text" && typeof b.text === "string") out.push({ type: "message", text: b.text, uuid });
      else if (b.type === "tool_use") {
        const ev: Extract<SessionEvent, { type: "tool" }> = { type: "tool", name: b.name as string | undefined, phase: "start", uuid };
        if (typeof b.id === "string") ev.id = b.id; // the tool_use id — pairs with the tool_result below
        if (b.input !== undefined) ev.input = b.input;
        out.push(ev);
      }
    }
    return out;
  }

  if (m.type === "user") {
    const content = m.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b.type === "tool_result") {
        const ev: Extract<SessionEvent, { type: "tool" }> = { type: "tool", phase: "end", uuid };
        if (typeof b.tool_use_id === "string") ev.id = b.tool_use_id; // pairs back to the tool_use start
        if (b.content !== undefined) ev.result = truncate(toolResultText(b.content));
        if (b.is_error === true) ev.isError = true;
        out.push(ev);
      }
    }
    return out;
  }

  // Token-level streaming (includePartialMessages): the raw Anthropic streaming event rides under
  // `event`. We surface text + thinking deltas; everything else (block start/stop, message_delta) is
  // structural and carries no UI event.
  if (m.type === "stream_event") {
    const d = m.event?.delta;
    if (m.event?.type === "content_block_delta" && d) {
      if (d.type === "text_delta" && typeof d.text === "string") return [{ type: "delta", text: d.text, uuid }];
      if (d.type === "thinking_delta" && typeof d.thinking === "string") return [{ type: "delta", text: d.thinking, thinking: true, uuid }];
    }
    return [];
  }

  if (m.type === "result") {
    const events: SessionEvent[] = [{ type: "idle" }];
    const usage = extractUsage(m);
    if (usage) events.push({ type: "usage", ...usage });
    return events;
  }
  return out; // system/init and anything else: no event (session id captured by the loop)
}

/** Wrap the Stop hook callbacks so a block (the worklog reminder fed back to the model) also
 *  reaches subscribers as a `hook` event. The SDK delivers hook feedback to the MODEL but not to
 *  the message stream the run loop reads, so the only place to observe it live is the hook
 *  callback itself. Other hook events pass through untouched. */
export function wrapStopHooks(hooks: SdkOptions["hooks"], onBlock: (reason: string) => void): SdkOptions["hooks"] {
  const stop = hooks.Stop;
  if (!stop) return hooks;
  return {
    ...hooks,
    Stop: stop.map((group) => ({
      ...group,
      hooks: group.hooks.map(
        (cb) =>
          async (input: Parameters<typeof cb>[0]) => {
            const out = await cb(input);
            if (out && out.decision === "block" && typeof out.reason === "string") onBlock(out.reason);
            return out;
          },
      ),
    })),
  };
}

/** Read the session id off a system-init or result message, if present. */
export function sessionIdOf(msg: unknown): string | undefined {
  const m = msg as { type?: string; subtype?: string; session_id?: string };
  if ((m.type === "system" && m.subtype === "init") || m.type === "result") return m.session_id;
  return undefined;
}

/** Watch one run's worklog file and emit a `worklog` event when it changes. The agent writes
 *  the worklog with its normal file tools (Stop hook enforces it); this turns that file write
 *  into a stream event — no special agent API. State (last content) lives in the closure. */
export function makeWorklogWatcher(root: string, slug: string, runId: string): () => SessionEvent | null {
  const file = path.join(deliverablesDir(root, slug), runId, "worklog.md");
  let last = "";
  return () => {
    const content = readFileOr(file);
    if (content === last || !content.trim()) return null;
    last = content;
    return { type: "worklog", runId, content };
  };
}

// ─────────────────────────── background jobs ───────────────────────────

/** What a host-supplied in-process tool gets, to drive background work that outlives the agent's
 *  turn (the seam for e.g. an external-query tool): inject a line back into the chat, or register a job
 *  whose result is injected when it settles. `openJob` is settled later by an external trigger;
 *  `runJob` settles when the given fn resolves (an in-process poll / await). */
export interface JobContext {
  inject(text: string): void;
  /** Inject a marked out-of-band line (room message, teammate reply, cron prompt). Same channel
   *  as `inject`, but the source tag is applied via `formatInbound` so the agent reads it right. */
  injectFrom(m: Inbound): void;
  openJob(label?: string): string;
  runJob(label: string, fn: () => Promise<string>): string;
  /** The Claude Code session id, once the init message has arrived (undefined before then). A
   *  scheduling tool needs it to record WHICH session the host should resume on wake. */
  sessionId(): string | undefined;
  /** The business this session runs under, and its run id. A host tool that persists work to
   *  resume later (a long-running poller surviving a restart) needs the business to call manager.resume. */
  business: string;
  runId: string;
}

/** Per-session registry of background jobs — work that outlives the agent's turn. The agent (or
 *  a host tool) starts a job and gets a ticket immediately, never blocking; when the job settles
 *  the result is injected back into the conversation as a new turn AND a `job` event is emitted
 *  for the UI. SDK-free (inject/emit are supplied by the session), so it's unit-tested directly. */
export class JobRegistry {
  private pending = new Map<string, { label?: string }>();
  private seq = 0;
  constructor(private readonly io: { inject: (text: string) => void; emit: (e: SessionEvent) => void; newTicket?: () => string }) {}

  private mint(): string {
    return this.io.newTicket ? this.io.newTicket() : `job-${++this.seq}`;
  }

  /** Open a job settled later by `resolve(ticket, …)` — a human click, a webhook, an external
   *  poller. Emits `job: open`; returns the ticket. */
  open(label?: string): string {
    const ticket = this.mint();
    this.pending.set(ticket, { label });
    this.io.emit({ type: "job", ticket, status: "open", label });
    return ticket;
  }

  /** Open a job that settles when `fn()` resolves; the resolved string is the result injected
   *  into the chat. `fn` runs in the background (NOT awaited) — returns the ticket at once. */
  run(label: string, fn: () => Promise<string>): string {
    const ticket = this.open(label);
    void (async () => {
      try {
        this.settle(ticket, await fn(), "done");
      } catch (e) {
        this.settle(ticket, e instanceof Error ? e.message : String(e), "failed");
      }
    })();
    return ticket;
  }

  /** Externally settle an open job. No-op (false) if the ticket is unknown or already settled. */
  resolve(ticket: string, result: string): boolean {
    if (!this.pending.has(ticket)) return false;
    this.settle(ticket, result, "done");
    return true;
  }

  list(): Array<{ ticket: string; label?: string }> {
    return [...this.pending.entries()].map(([ticket, v]) => ({ ticket, label: v.label }));
  }

  private settle(ticket: string, body: string, status: "done" | "failed"): void {
    const entry = this.pending.get(ticket);
    if (!entry) return; // already settled (e.g. a poll resolved just as a human clicked "done")
    this.pending.delete(ticket);
    this.io.emit({ type: "job", ticket, status, label: entry.label, result: body });
    this.io.inject(formatJobResult(ticket, entry.label, body, status));
  }
}

// The envelope itself (format + parse) lives in inbound.ts — a pure module the browser client
// also imports. Re-exported here so hosts keep importing everything session-shaped from one place.
export { formatInbound, formatJobResult, parseInbound } from "./inbound";
export type { Inbound, InboundKind, ParsedInbound } from "./inbound";

// ─────────────────────────── live-session registry ───────────────────────────

/** A `claudeSessionId → live in-process session` registry. The single thing that stops a wakeup
 *  firing and a user reconnecting from opening two parallel `query()`s on the same transcript:
 *  both go through `reuseOrResume`, which reuses the one live session if it's in memory. The host
 *  instantiates one and holds it (like `JobRegistry`); bizagent owns the bookkeeping and the
 *  reuse-vs-resume decision, the host owns the actual resume (it has the manager) and any store. */
export interface SessionRegistry {
  /** Register a session once its id is ready; it auto-evicts when it closes. Returns the session
   *  so a caller can wrap a freshly started/resumed one: `track(manager.start(...))`. */
  track(s: BizSession): BizSession;
  /** The live session for a Claude Code session id, or undefined if none is in memory. */
  get(sid: string): BizSession | undefined;
  has(sid: string): boolean;
  /** Every live session, for an at-a-glance read model. */
  list(): BizSession[];
  /** Reuse the live session for `sid` (running `onReuse` on it — `send` a turn, `injectFrom` a
   *  cron line, whatever the caller needs) if one is in memory; otherwise call `resume()` to make
   *  a fresh session and track it. Returns whichever session ended up handling it. */
  reuseOrResume(sid: string, onReuse: (s: BizSession) => void, resume: () => BizSession): BizSession;
}

export function makeSessionRegistry(): SessionRegistry {
  const live = new Map<string, BizSession>();
  const register = (sid: string, s: BizSession) => {
    live.set(sid, s);
    void (async () => {
      for await (const ev of s.subscribe()) if (ev.type === "closed") break;
      if (live.get(sid) === s) live.delete(sid);
    })();
  };
  const track = (s: BizSession): BizSession => {
    // A resumed session knows its claudeSessionId up front (the manager pre-sets it) — register
    // NOW, so a second reconnect converges on this one instead of spawning another. A fresh
    // session's id only exists once the SDK init lands, so it registers via `ready`.
    if (s.claudeSessionId) register(s.claudeSessionId, s);
    else void s.ready.then((sid) => register(sid, s)).catch(() => {});
    return s;
  };
  return {
    track,
    get: (sid) => live.get(sid),
    has: (sid) => live.has(sid),
    list: () => [...live.values()],
    reuseOrResume(sid, onReuse, resume) {
      const existing = live.get(sid);
      if (existing) {
        onReuse(existing);
        return existing;
      }
      return track(resume());
    },
  };
}

// ─────────────────────────── the manager ───────────────────────────

/** Observability env Claude Code reads for its OWN OpenTelemetry export (metrics/logs/traces).
 *  When a session inherits process.env (the default, no auth.env) these flow through untouched;
 *  we only need to re-inject them when a platform supplies a replacement env via resolveAuth. */
function telemetryEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null && (k.startsWith("OTEL_") || k === "CLAUDE_CODE_ENABLE_TELEMETRY")) out[k] = v;
  }
  return out;
}

/** Translate AuthConfig into the SDK query option fields. Default ({}) leaves auth to the
 *  host CLI's subscription. */
function authOptions(auth: AuthConfig): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  // Always hand the SDK the real binary path — its own default resolution can land on a
  // non-binary and fail with EBADMACHO. auth.claudeExecutable (from resolveAuth) wins.
  const exe = auth.claudeExecutable ?? resolveClaudeExecutable();
  if (exe) o.pathToClaudeCodeExecutable = exe;
  // A replacement env REPLACES (not merges) what the SDK passes to claude, so carry the
  // telemetry keys through it — otherwise resolveAuth silently disables Claude Code's OTel.
  if (auth.env) o.env = { ...telemetryEnv(), ...auth.env };
  return o;
}

// Loose shapes for the dynamically-loaded SDK tool helpers + zod — core needs no compile-time
// dep on either; this is just the slice we call. Variable specifiers so TS/esbuild don't try to
// resolve the optional peers at build time.
type ToolDef = { name: string };
type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
type ToolFn = (name: string, description: string, schema: Record<string, unknown>, handler: ToolHandler) => ToolDef;
type CreateServerFn = (o: { name: string; version?: string; tools: ToolDef[] }) => unknown;
interface ZodLike {
  string(): unknown;
  number(): unknown;
}

const SDK_MODULE = "@anthropic-ai/claude-agent-sdk";
async function loadSdk(): Promise<{ query: (args: unknown) => AsyncIterable<unknown>; tool: ToolFn; createSdkMcpServer: CreateServerFn }> {
  const mod = (await import(SDK_MODULE)) as {
    query: (args: unknown) => AsyncIterable<unknown>;
    tool: ToolFn;
    createSdkMcpServer: CreateServerFn;
  };
  return { query: mod.query, tool: mod.tool, createSdkMcpServer: mod.createSdkMcpServer };
}

const ZOD_MODULE = "zod";
async function loadZodZ(): Promise<ZodLike> {
  const mod = (await import(ZOD_MODULE)) as { z?: ZodLike };
  return mod.z ?? (mod as unknown as ZodLike);
}

/** Description shown to the model for the built-in `defer_continue` tool (the self-wakeup seam).
 *  Fuller usage guidance rides in the injected system prompt (prompts/scheduling.md) — this is
 *  the short tool-call hint. Only offered when a SchedulerStore is configured. */
const DEFER_CONTINUE_DESC =
  "Schedule yourself to resume THIS session later instead of blocking or polling now. Pass " +
  "delaySeconds (clamped to 60–3600) and wakePrompt (what to do when you wake). Returns at once; " +
  "END your turn right after calling — the host resumes you at the scheduled time with wakePrompt " +
  "as your next instruction. There is a cap on how many times one chain may re-arm.";

/** Description shown to the model for the built-in `expect_result` tool. */
const EXPECT_RESULT_DESC =
  "Register that a result will arrive out-of-band — you started a long external job, or you're " +
  "waiting on a human or webhook. Returns immediately with a ticket; do NOT block on it. The " +
  "result is delivered into this conversation automatically when it's ready, so keep talking " +
  "with the user meanwhile. Pass a short note describing what you're waiting for.";

export function createSessionManager(o: {
  root: string;
  resolveAuth?: (id?: Identity) => AuthConfig | Promise<AuthConfig>;
  newId?: () => string;
  /** SDK permission mode. A headless server agent has no human to approve each tool. Default
   *  `acceptEdits` auto-approves file writes (so the worklog / memory get written) without
   *  opening up Bash etc. For full autonomy set `bypassPermissions` (= --dangerously-skip-
   *  permissions — a deliberate operator choice); for a policy, pass a canUseTool callback. */
  permissionMode?: string;
  /** Default model for sessions (per-start `model` overrides). Treated as a LOGICAL key — when a
   *  resolveModel is given it's mapped to a concrete id; otherwise forwarded verbatim. */
  model?: string;
  /** Map a logical model key -> concrete SDK config (id + optional backend binary/env). The
   *  platform's model registry / backend routing lives here. Left
   *  undefined, the key passes straight through (identityModelResolver) — the prior behavior. */
  resolveModel?: ModelResolver;
  /** Optional permission gate: the SDK calls this before a tool runs; return allow/deny. The seam
   *  for human-in-the-loop / policy. Left undefined keeps the headless default (permissionMode). */
  canUseTool?: (toolName: string, input: Record<string, unknown>, opts: unknown) => Promise<unknown>;
  /** Extra tools to pre-approve in addition to bizagent's MCP tools (which are always added). Use
   *  Claude Code's allowedTools grammar — `Read`, `Bash(curl:*)`, `WebFetch`, etc. Skipping the
   *  allowedTools path means the SDK falls through to permissionMode / canUseTool, which is fine
   *  but costs a callback per call; a headless host benefits from listing its known-safe tools
   *  here so they short-circuit. */
  allowedTools?: string[];
  /** Contribute extra in-process tools (built with the SDK's own `tool()`), e.g. an external-query
   *  tool that submits + polls in the background and injects the rows when done. The factory gets
   *  this session's JobContext so a tool handler can `runJob` / `openJob` / `inject`. */
  makeTools?: (ctx: JobContext) => unknown[];
  /** Persist + read scheduled wakeups. Given, a built-in `defer_continue` tool is offered (the
   *  agent can ask to be resumed later) and its usage guidance is injected into the system prompt.
   *  The HOST runs the tick (dueWakeups) on its own timer and resumes the session. Left undefined,
   *  no scheduling tool is offered and the guidance is omitted. */
  scheduler?: SchedulerStore;
  /** Per-turn usage observability: called whenever a turn's result reports usage/cost (the same
   *  numbers kept as session.usage). The host logs/aggregates; errors are swallowed so
   *  observability can never break the run loop. */
  onUsage?: (o: { business: string; runId: string; claudeSessionId?: string; identity?: Identity; usage: SessionUsage }) => void;
}): SessionManager {
  const sessions = new Map<string, BizSession>();
  const newId = o.newId ?? makeRunId;

  function spawn(opts: {
    business: string;
    identity?: Identity;
    prompt?: string;
    resume?: string;
    fork?: boolean;
    atMessageUuid?: string;
    model?: string;
    scope?: Scope;
    /** This session was started by the Nth wake in a self-wakeup chain (0/undefined = fresh). The
     *  host passes the fired row's chainCount here on resume so defer_continue keeps counting. */
    wakeupChain?: number;
    req?: string;
    /** The pre-seeded task this run was launched with (e.g. "module-setup:<mod>"), recorded so a
     *  UI can re-enter this run instead of starting a duplicate. */
    task?: string;
    /** Reuse an existing run (a resume converging on its conversation's original run) instead of
     *  minting a new one. All run-dir writes below are idempotent for an existing dir. */
    runId?: string;
  }): BizSession {
    const slug = opts.business;
    // Requirements are a business concept — a module is many-to-many with businesses, so a
    // module-workspace session must not hang off any single business's requirement.
    if (opts.req && parseModuleWorkspaceId(slug)) {
      throw new Error(`module workspaces don't take requirements (got req=${opts.req} for ${slug})`);
    }
    const cwd = businessDir(o.root, slug);
    const runId = opts.runId ?? makeRunId();
    mkdirp(path.join(deliverablesDir(o.root, slug), runId));
    ensureSkillsLink(o.root, slug); // backfill: businesses created before skills existed wire up here
    ensureKnowledgeLinks(o.root, slug); // backfill: module workspaces (and pre-knowledge businesses) get their knowledge/ mounts here
    // Under a requirement: lazily create it and link this run BEFORE buildSdkOptions assembles
    // the launch context (synchronous, so an invalid req id throws straight back to the caller).
    if (opts.req) {
      ensureRequirement({ root: o.root, slug, req: opts.req });
      recordRunReq({ root: o.root, slug, runId, req: opts.req });
    }
    // Mark the launching task (if any), so the run is re-enterable from the UI.
    if (opts.task) recordRunTask({ root: o.root, slug, runId, task: opts.task });
    // Pin a FRESH conversation to its launch model (opts.model from the picker, else the manager's
    // default), so resume() below re-binds the SAME model without the caller re-passing it. A resume
    // reuses runId and must NOT repin — that's what keeps one conversation on one model for its life.
    // Same shape for the originator: FRESH starts record `.requester` (the asker's identity), resumes
    // skip — one conversation keeps its recorded originator for life.
    if (!opts.resume) {
      const launchModel = opts.model ?? o.model;
      if (launchModel) recordRunModel({ root: o.root, slug, runId, model: launchModel });
      const requester = opts.identity?.userId;
      if (requester) recordRunRequester({ root: o.root, slug, runId, requester });
    }

    const id = newId();
    const input = makeInputChannel();
    const bus = new Broadcast();
    const checkWorklog = makeWorklogWatcher(o.root, slug, runId);
    // EVERY input lands through here so `busy` can't drift from the queue: any push marks the
    // session busy; the run loop clears it on `idle` once the queue is empty (and on close).
    // `session` is declared below — these closures only run after it exists.
    const pushInput = (text: string, images?: ImageInput[]) => {
      session.busy = true;
      input.push(text, images);
    };
    // An injected input, made VISIBLE: the SDK never echoes string user inputs (mapMessage maps
    // only tool_results), so without this emit a live viewer never sees an injected line at
    // all — it only resurfaces on transcript replay, styled as if the user typed it. Emitting
    // it as a user-role message keeps live and replay identical; the client reducer renders an
    // envelope-wrapped (formatInbound) line as an injected notice, anything else (e.g. a task
    // kickoff prompt) as a user turn. The replayed transcript carries the same line WITH a
    // uuid, so the client pairs the two by exact text (its seenInjected dedup).
    // User send() stays silent on the bus — the sender's own UI adds that turn optimistically.
    const injectLine = (text: string) => {
      bus.emit({ type: "message", text, role: "user", at: nowIso() });
      pushInput(text);
    };
    // Background jobs: a result pushes back through the SAME input channel (= re-invoke the agent
    // in its own context), and the lifecycle is broadcast as `job` events. Tickets are unique
    // within the session; the web layer routes a trigger by (session id, ticket).
    const jobs = new JobRegistry({ inject: injectLine, emit: (e) => bus.emit(e) });
    const ctx: JobContext = {
      inject: pushInput,
      injectFrom: (m) => injectLine(formatInbound(m)),
      openJob: (l) => jobs.open(l),
      runJob: (l, fn) => jobs.run(l, fn),
      sessionId: () => session.claudeSessionId,
      business: slug,
      runId,
    };

    let resolveReady!: (sid: string) => void;
    const ready = new Promise<string>((r) => (resolveReady = r));

    // The live SDK query handle, once the run loop launches it — interrupt() needs it. Null until
    // launch (a deferred resume launches on first send) and after the stream ends.
    let sdkQuery: { interrupt?: () => Promise<void> } | null = null;

    const session: BizSession = {
      id,
      business: slug,
      runId,
      scope: opts.scope,
      identity: opts.identity,
      req: opts.req,
      busy: false,
      ready,
      send(text, images) {
        pushInput(text, images);
      },
      inject(text) {
        pushInput(text);
      },
      injectFrom(m) {
        injectLine(formatInbound(m));
      },
      resolveJob(ticket, result) {
        return jobs.resolve(ticket, result);
      },
      async interrupt() {
        try {
          await sdkQuery?.interrupt?.();
        } catch {
          /* interrupting an already-finished turn is a no-op, not an error */
        }
      },
      listJobs() {
        return jobs.list();
      },
      subscribe(opts) {
        return bus.subscribe(opts?.afterSeq);
      },
      recentEvents() {
        return bus.recent();
      },
      async end() {
        input.close();
        // The run loop emits `closed` when the SDK stream finishes after input closes.
      },
    };
    sessions.set(id, session);
    // A start/resume carrying a prompt (a task kickoff like `?task=setup`, a subscription fire)
    // goes through injectLine, not bare pushInput: without the emit the live timeline opens on
    // the agent answering an invisible ask, while a replay of the same run shows the prompt —
    // live and replay disagreed.
    if (opts.prompt) injectLine(opts.prompt);
    // A non-fork resume continues a KNOWN conversation — its claudeSessionId is the one passed in
    // (the SDK keeps it; a changed id is caught in the run loop below). Setting it now lets the
    // registry index the session immediately and gives subscribers the id without waiting for an
    // init that, on a deferred launch, only comes after the first send. A fork is the opposite:
    // it exists to mint a NEW id, so it stays unset until init reveals it.
    if (opts.resume && !opts.fork) {
      session.claudeSessionId = opts.resume;
      bus.emit({ type: "session", claudeSessionId: opts.resume });
    }

    // The run loop: drive query() with streaming input, map output to events, project the
    // worklog, capture the session id. Runs in the background; start() returns immediately.
    void (async () => {
      try {
        // Deferred launch: a promptless non-fork resume is a user browsing history — don't boot a
        // Claude process for that. Wait for the first real input (it reaches the SDK already
        // queued, so Claude Code doesn't synthesize its "Continue from where you left off." turn
        // the way a resume with an empty input stream does). Closed before any input = the
        // conversation was only looked at; end without ever launching.
        if (opts.resume && !opts.fork && !opts.prompt) {
          const hasInput = await input.first;
          if (!hasInput) return;
        }
        const auth = (await (o.resolveAuth?.(opts.identity) ?? {})) as AuthConfig;
        const base = buildSdkOptions({ root: o.root, slug, runId, req: opts.req });
        // Whoever injects a tool describes it: append the in-process tools' usage guidance to the
        // launch prompt (NOT buildSystemPrompt — that's shared with the CLI path, which gets these
        // tools from Claude Code itself, not from us). scheduling guidance only when a scheduler
        // makes defer_continue real.
        const caps = buildCapabilitiesPrompt({ scheduler: !!o.scheduler });
        const baseAppend = (base.systemPrompt as { append?: string }).append ?? "";
        const systemPrompt = caps ? { ...base.systemPrompt, append: `${baseAppend}\n\n${caps}` } : base.systemPrompt;
        const options: Record<string, unknown> = {
          cwd: base.cwd,
          // Read access to linked modules through their symlink mounts (business sessions only;
          // empty for module workspaces). Writes there are denied by the PreToolUse guard.
          ...(base.additionalDirectories.length ? { additionalDirectories: base.additionalDirectories } : {}),
          systemPrompt,
          // The hook event has no SDK message behind it, so unlike message/tool events it gets no
          // uuid for free — mint one, or a reconnect's buffer replay re-appends it to the timeline
          // (uuid is what the client dedups replayed events by).
          hooks: wrapStopHooks(base.hooks, (reason) => bus.emit({ type: "hook", hook: "stop", text: reason, uuid: crypto.randomUUID(), at: nowIso() })),
          permissionMode: o.permissionMode ?? "acceptEdits",
          // Reuse Claude Code's token-level streaming so the web gets text/thinking deltas.
          includePartialMessages: true,
          ...authOptions(auth),
          ...(opts.resume ? { resume: opts.resume } : {}),
          // Fork = resume the source transcript but tell the SDK to COPY it into a new session
          // (forkSession), leaving the original untouched. resumeSessionAt branches from a
          // specific past message instead of the tip; the SDK ignores it when absent, so an
          // unrecognized field degrades to a tip fork rather than failing.
          ...(opts.fork ? { forkSession: true } : {}),
          ...(opts.atMessageUuid ? { resumeSessionAt: opts.atMessageUuid } : {}),
        };
        // Logical model key -> concrete SDK config. Without a resolveModel the key passes through
        // unchanged (old behavior). A resolved backend binary/env wins over authOptions (it's the
        // more specific decision); env merges over whatever auth set (or telemetry passthrough).
        const modelKey = opts.model ?? o.model;
        if (modelKey) {
          if (o.resolveModel) {
            const r = await o.resolveModel(modelKey, { identity: opts.identity, scope: opts.scope });
            options.model = r.model;
            if (r.claudeExecutable) options.pathToClaudeCodeExecutable = r.claudeExecutable;
            if (r.env) options.env = { ...((options.env as Record<string, string>) ?? telemetryEnv()), ...r.env };
          } else {
            options.model = modelKey;
          }
        }
        if (o.canUseTool) options.canUseTool = o.canUseTool;
        const debug = !!process.env.BIZ_DEBUG;
        if (!options.pathToClaudeCodeExecutable) {
          throw new Error("Claude Code binary not found. Install Claude Code, or set CLAUDE_PATH=/path/to/claude.");
        }
        const { query, tool, createSdkMcpServer } = await loadSdk();
        const z = await loadZodZ();
        // In-process tools that report back into THIS session: the built-in expect_result (the
        // human/webhook-triggered park) plus any host-supplied tools (e.g. a long-running poller). Listing
        // them in allowedTools auto-approves them, so a headless session never stalls on a prompt.
        const builtins: ToolDef[] = [
          tool("expect_result", EXPECT_RESULT_DESC, { note: z.string() }, async (args) => {
            const ticket = jobs.open(typeof args.note === "string" ? args.note : undefined);
            return { content: [{ type: "text", text: `Registered ticket ${ticket}. The result will land in this conversation when it's ready — keep going, don't wait.` }] };
          }),
        ];
        // Self-wakeup: write a pending row to the host's SchedulerStore and stop. The host's tick
        // resumes this session at wakeAt. chainCount continues from how this session was woken, so
        // a chain that re-arms every turn terminates at the cap (chainExhausted) instead of looping.
        if (o.scheduler) {
          const sched = o.scheduler;
          const chainBase = opts.wakeupChain ?? 0;
          builtins.push(
            tool("defer_continue", DEFER_CONTINUE_DESC, { delaySeconds: z.number(), wakePrompt: z.string() }, async (args) => {
              const sid = session.claudeSessionId;
              if (!sid) return { content: [{ type: "text", text: "Session not ready yet — can't schedule a wake this turn." }] };
              const chainCount = chainBase + 1;
              if (chainExhausted(chainCount)) return { content: [{ type: "text", text: "Self-wake chain budget exhausted; not scheduling. Wrap up instead." }] };
              const delay = clampDelay(Number(args.delaySeconds));
              await sched.insert({
                scopeKey: opts.scope ? scopeKey(opts.scope) : undefined,
                business: slug,
                claudeSessionId: sid,
                wakeAt: Date.now() + delay * 1000,
                wakePrompt: typeof args.wakePrompt === "string" ? args.wakePrompt : "Continue.",
                chainCount,
              });
              return { content: [{ type: "text", text: `Scheduled to resume in ~${delay}s. End your turn now; you'll be woken automatically.` }] };
            }),
          );
        }
        const extra = (o.makeTools ? o.makeTools(ctx) : []) as ToolDef[];
        const allTools = [...builtins, ...extra];
        options.mcpServers = { biz: createSdkMcpServer({ name: "biz", version: "0.1.0", tools: allTools }) };
        options.allowedTools = [...(o.allowedTools ?? []), ...allTools.map((t) => `mcp__biz__${t.name}`)];
        if (debug) console.error(`[biz session ${id}] query started (cwd=${base.cwd}, claude=${options.pathToClaudeCodeExecutable}, tools=${JSON.stringify(options.allowedTools)})`);
        const q = query({ prompt: input.gen, options }) as AsyncIterable<unknown> & { interrupt?: () => Promise<void> };
        sdkQuery = q;
        for await (const msg of q) {
          if (debug) console.error(`[biz session ${id}] <<`, JSON.stringify(msg).slice(0, 600));
          const sid = sessionIdOf(msg);
          if (sid && sid !== session.claudeSessionId) {
            // First init on a fresh session, or — defensively — an SDK that re-identified a
            // resumed conversation under a new id (fork semantics). Either way this id is now
            // the resumable one.
            session.claudeSessionId = sid;
            // Tell subscribers (buffered, so late joiners replay it). The manager `id` is NOT
            // resumable — this is the id a UI must put in URLs / pass back to resume.
            bus.emit({ type: "session", claudeSessionId: sid });
            // Persist runId -> claudeSessionId so the session can be listed and RESUMED later. The
            // SDK path doesn't run the CLI's transcript-path hook, so this is the only durable link.
            try {
              writeFile(path.join(deliverablesDir(o.root, slug), runId, ".session-id"), sid);
            } catch {
              /* best-effort: a missing session-id only costs resumability, not the live session */
            }
          }
          if (sid) resolveReady(sid); // no-op after the first resolution
          const events = mapMessage(msg);
          if (debug && events.length === 0 && (msg as { type?: string }).type === "assistant") {
            console.error(`[biz session ${id}] !! assistant message mapped to 0 events — content shape:`,
              JSON.stringify((msg as { message?: { content?: unknown } }).message?.content).slice(0, 400));
          }
          for (const ev of events) {
            // Stamp live message/tool events with their emit time (replay stamps from the jsonl).
            if (ev.type === "message" || ev.type === "tool") ev.at = nowIso();
            bus.emit(ev);
            // The turn finished and nothing else is queued → the session is at rest. (More queued
            // input means the SDK immediately starts the next turn — still busy.)
            if (ev.type === "idle" && input.size() === 0) session.busy = false;
            // Keep the latest usage/cost on the session for the read model (/api/sessions).
            if (ev.type === "usage") {
              const { type, ...u } = ev;
              session.usage = u;
              try {
                o.onUsage?.({ business: slug, runId, claudeSessionId: session.claudeSessionId, identity: opts.identity, usage: u });
              } catch {
                /* host observability must not break the run loop */
              }
            }
            // A tool result or a finished turn may have (re)written the worklog.
            if (ev.type === "tool" && ev.phase === "end") {
              const w = checkWorklog();
              if (w) bus.emit(w);
            }
          }
          if ((msg as { type?: string }).type === "result") {
            const w = checkWorklog();
            if (w) bus.emit(w);
          }
        }
        if (debug) console.error(`[biz session ${id}] query stream ended`);
      } catch (e) {
        // Surface the real cause on the server console (errors are worth seeing even without
        // BIZ_DEBUG) — the event also goes to subscribers.
        console.error(`[biz session ${id}] ERROR:`, e instanceof Error ? e.stack ?? e.message : e);
        bus.emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        sdkQuery = null;
        session.busy = false; // ended (or errored) — nothing left to drain for
        if (process.env.BIZ_DEBUG) console.error(`[biz session ${id}] loop ended`);
        bus.emit({ type: "closed" });
        // Do NOT drop the session here: a client may subscribe slightly after it ends and must
        // still replay the buffered events (incl. the error). TODO: GC ended sessions on a TTL.
      }
    })();

    return session;
  }

  return {
    start(s) {
      return spawn(s);
    },
    resume(s) {
      // Converge on the conversation's original run: one conversation = one run dir = one worklog
      // = one history entry, no matter how many times it's reopened. The run also remembers its
      // requirement, so a bare resume (URL reload, post-restart recovery) stays linked without the
      // caller re-passing `req`.
      const runId = s.runId ?? runForSessionId(o.root, s.business, s.claudeSessionId);
      const req = s.req ?? (runId ? runReq(o.root, s.business, runId) : undefined);
      // Re-bind the conversation's pinned model when the caller didn't pass one — URL reload,
      // post-restart recovery and scheduler wakeups all resume WITHOUT a model. Same shape as `req`.
      const model = s.model ?? (runId ? runModel(o.root, s.business, runId) : undefined);
      return spawn({ business: s.business, identity: s.identity, prompt: s.prompt, resume: s.claudeSessionId, model, scope: s.scope, wakeupChain: s.wakeupChain, req, runId });
    },
    fork(s) {
      return spawn({
        business: s.business,
        identity: s.identity,
        prompt: s.prompt,
        resume: s.fromClaudeSessionId,
        fork: true,
        atMessageUuid: s.atMessageUuid,
        model: s.model,
        scope: s.scope,
      });
    },
    get(id) {
      return sessions.get(id);
    },
    list(filter) {
      const all = [...sessions.values()];
      return filter?.business ? all.filter((s) => s.business === filter.business) : all;
    },
  };
}
