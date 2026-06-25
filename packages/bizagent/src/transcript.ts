// Read Claude Code's session transcript (the per-session JSONL it writes as the conversation
// runs) and project it into the SAME SessionEvent stream the web layer already renders. This is
// how a `biz run` (TUI) session gets a browser fence viewer: the terminal keeps Claude Code, while
// a read-only browser view tails this file and renders ```chart / ```mermaid / tables live — the
// fences come out inline in the conversation, so the conversation is where we read them from.
//
// We read only the stable surface — assistant text/tool blocks + the human's prompts — and reuse
// mapMessage (a transcript `assistant` line matches the SDK message shape: content is a block
// array, uuid sits at top level). Noise line types (mode, attachment, file-history-snapshot,
// ai-title, …), subagent sidechain turns, and injected meta prompts are skipped. The JSONL schema
// is Claude Code's internal format: if it shifts we degrade (render less), never crash — the
// durable SOT is still our own files, this is only a render source.
import path from "node:path";
import { readFileOr } from "./fsutil";
import { deliverablesDir, transcriptMirrorPath } from "./paths";
import { mapMessage, type SessionEvent } from "./session";

interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Stamp mapped events with the transcript line's own wall-clock time, so replayed messages keep
 *  their original timestamps (a live session stamps `at` at emit instead). */
function stampAt(events: SessionEvent[], at?: string): SessionEvent[] {
  if (!at) return events;
  for (const ev of events) {
    if (ev.type === "message" || ev.type === "tool") ev.at = at;
  }
  return events;
}

/** Project one transcript JSONL line into zero or more SessionEvents. */
export function transcriptToEvents(line: unknown): SessionEvent[] {
  if (!line || typeof line !== "object") return [];
  const o = line as TranscriptLine;
  if (o.isSidechain) return []; // a subagent's own turns — not the main conversation
  if (o.type === "assistant") {
    // Thinking blocks only exist here in complete form (live sessions stream them as deltas, so
    // mapMessage deliberately skips the complete block to avoid emitting it twice). For replay
    // there is no delta stream, so surface them as thinking deltas — the reducer buffers those
    // and flushes them as a thinking item before the text/tool they precede. Thinking precedes
    // the response within a message, so emitting them ahead of mapMessage keeps the order.
    // CAVEAT (verified against real transcripts, Claude Code 2.1.x): the persisted thinking text
    // is ALWAYS empty — only the signature is stored — so replay currently yields no thinking
    // items. The mapping is kept for the day the text is persisted; the empty-string filter
    // below is what makes today's redacted blocks a no-op rather than blank timeline entries.
    const blocks = Array.isArray(o.message?.content) ? (o.message.content as Array<Record<string, unknown>>) : [];
    const thinking: SessionEvent[] = blocks
      .filter((b) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking)
      .map((b) => ({ type: "delta", text: b.thinking as string, thinking: true, uuid: o.uuid }));
    return [...thinking, ...stampAt(mapMessage(o), o.timestamp)];
  }
  if (o.type === "user") {
    const content = o.message?.content;
    if (typeof content === "string") {
      if (o.isMeta) {
        // A Stop-hook block is the one isMeta injection worth replaying: without it the agent's
        // post-hook continuation reads as an unprompted message. Claude Code prefixes the fed-back
        // reason with this fixed template; if the template shifts we degrade to skipping (as before).
        const HOOK_FEEDBACK_PREFIX = "Stop hook feedback:";
        if (content.startsWith(HOOK_FEEDBACK_PREFIX)) {
          const text = content.slice(HOOK_FEEDBACK_PREFIX.length).trim();
          if (text) return [{ type: "hook", hook: "stop", text, uuid: o.uuid, ...(o.timestamp ? { at: o.timestamp } : {}) }];
        }
        return []; // other injected context (new-sessions reminders etc.), not a human prompt
      }
      return content.trim() ? [{ type: "message", text: content, role: "user", uuid: o.uuid, ...(o.timestamp ? { at: o.timestamp } : {}) }] : [];
    }
    // Array content: real user input lands here as `[{type:'text', text:'...'}]` (Claude Code's
    // canonical user-message shape — 80% of replayed user turns in the wild). The string branch
    // only fires for platform-injected prompts. Surface text blocks as a user message; tool_result
    // blocks still go through mapMessage as `tool end`. mapMessage's own user branch ignores text
    // blocks, so the two don't double-emit.
    const out: SessionEvent[] = [];
    if (!o.isMeta && Array.isArray(content)) {
      const text = (content as Array<Record<string, unknown>>)
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (text.trim()) out.push({ type: "message", text, role: "user", uuid: o.uuid, ...(o.timestamp ? { at: o.timestamp } : {}) });
    }
    out.push(...stampAt(mapMessage(o), o.timestamp));
    return out;
  }
  return []; // system / mode / attachment / file-history-snapshot / ai-title / …
}

/** Parse a whole transcript file's text into events (the backlog a viewer gets on first connect). */
export function readTranscriptEvents(text: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    let line: unknown;
    try {
      line = JSON.parse(t);
    } catch {
      continue; // a partial / malformed line — skip it
    }
    out.push(...transcriptToEvents(line));
  }
  return out;
}

/** Replay a run's conversation from its Claude Code transcript: the SessionEvent backlog a chat
 *  UI folds into state before attaching the live stream. The transcript path is the one the
 *  inject hook recorded (`.transcript-path`); a run that ran on ANOTHER machine has no pointer,
 *  only the hub-pushed mirror (`.transcript.jsonl`) — fall back to that, which is what makes a
 *  remote user's session readable here. A run with neither (or whose jsonl is gone) replays as
 *  empty — degrade, don't fail, the jsonl is a render source, not our SOT. */
export function runHistory(root: string, slug: string, runId: string): SessionEvent[] {
  const tp = readFileOr(path.join(deliverablesDir(root, slug), runId, ".transcript-path")).trim();
  const text = (tp && readFileOr(tp)) || readFileOr(transcriptMirrorPath(root, slug, runId));
  return readTranscriptEvents(text);
}

/** Tail a transcript file: each call returns the events from whole lines appended since the last
 *  call (the first call returns the backlog). Only complete lines (terminated by a newline) are
 *  consumed — a half-written trailing line is left for the next poll. State (chars consumed) lives
 *  in the closure, the same shape as makeWorklogWatcher. A missing/rotated file restarts cleanly. */
export function makeTranscriptTailer(filePath: string): () => SessionEvent[] {
  let consumed = 0; // chars already split into complete lines
  return () => {
    const text = readFileOr(filePath);
    if (text.length < consumed) consumed = 0; // truncated / rotated — start over
    if (text.length <= consumed) return [];
    const slice = text.slice(consumed);
    const lastNl = slice.lastIndexOf("\n");
    if (lastNl === -1) return []; // no complete new line yet
    consumed += lastNl + 1;
    const out: SessionEvent[] = [];
    for (const raw of slice.slice(0, lastNl).split("\n")) {
      const t = raw.trim();
      if (!t) continue;
      let line: unknown;
      try {
        line = JSON.parse(t);
      } catch {
        continue;
      }
      out.push(...transcriptToEvents(line));
    }
    return out;
  };
}
