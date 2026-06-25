// SessionManager's pure pieces are tested without the SDK installed or any model call:
// the input channel, the multi-subscriber broadcast, message mapping, and worklog projection.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeInputChannel, Broadcast, JobRegistry, formatJobResult, formatInbound, makeSessionRegistry, mapMessage, extractUsage, toolResultText, sessionIdOf, makeWorklogWatcher, wrapStopHooks, createSessionManager, initRoot, newBusiness } from "../src/index";
import type { SessionEvent, BizSession } from "../src/index";

test("makeInputChannel yields pushed turns in order, ends on close", async () => {
  const ch = makeInputChannel();
  ch.push("one");
  ch.push("two");
  const got: string[] = [];
  // Consume in the background; close after the two are drained.
  const consume = (async () => {
    for await (const m of ch.gen) {
      got.push(m.message.content);
      assert.equal(m.type, "user");
      assert.equal(m.parent_tool_use_id, null);
      if (got.length === 2) ch.close();
    }
  })();
  await consume;
  assert.deepEqual(got, ["one", "two"]);
});

test("makeInputChannel blocks until a turn is pushed, then resumes", async () => {
  const ch = makeInputChannel();
  const it = ch.gen[Symbol.asyncIterator]();
  const pending = it.next(); // no data yet — should not resolve
  let resolved = false;
  void pending.then(() => (resolved = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false);
  ch.push("late");
  const { value } = await pending;
  assert.equal(value.message.content, "late");
});

test("Broadcast replays the recent buffer to a late subscriber, then streams live", async () => {
  const bus = new Broadcast();
  bus.emit({ type: "message", text: "early" });

  const seen: SessionEvent[] = [];
  const sub = (async () => {
    for await (const e of bus.subscribe()) seen.push(e);
  })();

  // Give the subscriber a tick to attach, then emit live + close.
  await new Promise((r) => setTimeout(r, 5));
  bus.emit({ type: "message", text: "live" });
  bus.emit({ type: "closed" });
  await sub;

  assert.deepEqual(
    seen.map((e) => (e.type === "message" ? e.text : e.type)),
    ["early", "live", "closed"],
  );
});

test("Broadcast stamps buffered events with seq, and subscribe(afterSeq) resumes past them", async () => {
  const bus = new Broadcast();
  bus.emit({ type: "message", text: "one" });
  bus.emit({ type: "message", text: "two" });
  bus.emit({ type: "delta", text: "x" }); // live-only: never buffered, never numbered
  bus.emit({ type: "message", text: "three" });

  // Buffered events carry the resume cursor in emit order.
  const seqs = bus.recent().map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3]);

  // A reconnect that already consumed seq 2 replays ONLY what came after — no duplicates.
  const seen: string[] = [];
  const sub = (async () => {
    for await (const e of bus.subscribe(2)) if (e.type === "message") seen.push(e.text);
  })();
  await new Promise((r) => setTimeout(r, 5));
  bus.emit({ type: "message", text: "four" });
  bus.emit({ type: "closed" });
  await sub;
  assert.deepEqual(seen, ["three", "four"]);
});

test("Broadcast fans out to two subscribers", async () => {
  const bus = new Broadcast();
  const a: string[] = [];
  const b: string[] = [];
  const run = (sink: string[]) => async () => {
    for await (const e of bus.subscribe()) if (e.type === "message") sink.push(e.text);
  };
  const pa = run(a)();
  const pb = run(b)();
  await new Promise((r) => setTimeout(r, 5));
  bus.emit({ type: "message", text: "x" });
  bus.emit({ type: "closed" });
  await Promise.all([pa, pb]);
  assert.deepEqual(a, ["x"]);
  assert.deepEqual(b, ["x"]);
});

test("mapMessage projects assistant text/tool_use, tool_result, and result", () => {
  assert.deepEqual(
    mapMessage({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } }),
    [{ type: "message", text: "hi", uuid: "u1" }],
  );
  assert.deepEqual(
    mapMessage({ type: "assistant", uuid: "u2", message: { content: [{ type: "tool_use", name: "Write" }] } }),
    [{ type: "tool", name: "Write", phase: "start", uuid: "u2" }],
  );
  assert.deepEqual(
    mapMessage({ type: "user", uuid: "u3", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } }),
    [{ type: "tool", phase: "end", uuid: "u3", id: "t" }],
  );
  assert.deepEqual(mapMessage({ type: "result", session_id: "s" }), [{ type: "idle" }]);
  // thinking blocks and init carry no event
  assert.deepEqual(mapMessage({ type: "assistant", message: { content: [{ type: "thinking" }] } }), []);
  assert.deepEqual(mapMessage({ type: "system", subtype: "init", session_id: "s" }), []);
});

test("mapMessage drops Claude Code's self-manufactured messages (model \"<synthetic>\")", () => {
  // Every `--resume` makes CC inject an isMeta "Continue from where you left off." turn and answer
  // itself "No response requested." — that answer (like every CC-manufactured message) carries
  // model "<synthetic>" and no real model call. Filtered from live AND replay by the marker.
  assert.deepEqual(
    mapMessage({ type: "assistant", uuid: "u1", message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } }),
    [],
  );
  assert.deepEqual(mapMessage({ type: "assistant", uuid: "u2", message: { model: "<synthetic>", content: "No response requested." } }), []);
  // A REAL model reply renders regardless of its text.
  assert.deepEqual(
    mapMessage({ type: "assistant", uuid: "u3", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "No response requested." }] } }),
    [{ type: "message", text: "No response requested.", uuid: "u3" }],
  );
});

test("mapMessage carries tool_use input on start and truncated tool_result + isError on end", () => {
  // tool_use start now includes the call args (observability: what the agent actually invoked)
  assert.deepEqual(
    mapMessage({ type: "assistant", uuid: "u1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } }),
    [{ type: "tool", name: "Bash", phase: "start", input: { command: "ls" }, uuid: "u1" }],
  );
  // tool_result end carries the result text (string content) — and the error flag when set
  assert.deepEqual(
    mapMessage({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", content: "ok", is_error: true }] } }),
    [{ type: "tool", phase: "end", result: "ok", isError: true, uuid: "u2" }],
  );
  // array content is normalized to text; a huge result is truncated with a marker
  const big = "x".repeat(2500);
  const [ev] = mapMessage({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: big }] }] } });
  assert.ok(ev.type === "tool" && ev.phase === "end" && ev.result!.length < big.length && /\+500 chars/.test(ev.result!));
});

test("mapMessage projects token-level deltas from stream_event (text + thinking)", () => {
  assert.deepEqual(
    mapMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } }),
    [{ type: "delta", text: "hel", uuid: undefined }],
  );
  assert.deepEqual(
    mapMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }),
    [{ type: "delta", text: "hmm", thinking: true, uuid: undefined }],
  );
  // structural stream events carry no UI event
  assert.deepEqual(mapMessage({ type: "stream_event", event: { type: "message_start" } }), []);
});

test("mapMessage result emits idle, plus usage when the result carries cost/tokens", () => {
  // bare result -> just idle (unchanged contract)
  assert.deepEqual(mapMessage({ type: "result", session_id: "s" }), [{ type: "idle" }]);
  // result with usage -> idle + a usage event in our neutral shape
  assert.deepEqual(
    mapMessage({
      type: "result",
      session_id: "s",
      total_cost_usd: 0.012,
      num_turns: 3,
      duration_ms: 4200,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
    }),
    [
      { type: "idle" },
      { type: "usage", costUsd: 0.012, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheCreationTokens: 10, numTurns: 3, durationMs: 4200 },
    ],
  );
});

test("extractUsage reads only present fields and returns null when empty", () => {
  assert.equal(extractUsage({ type: "result" }), null);
  assert.deepEqual(extractUsage({ total_cost_usd: 0.5, usage: { output_tokens: 7 } }), { costUsd: 0.5, outputTokens: 7 });
});

test("toolResultText normalizes string and array content", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
});

test("Broadcast does not replay deltas to a late subscriber (transient), but keeps the message", async () => {
  const bus = new Broadcast();
  bus.emit({ type: "delta", text: "stale fragment" }); // before subscribe -> must NOT be buffered
  bus.emit({ type: "message", text: "full" }); // before subscribe -> buffered (canonical)

  const seen: SessionEvent[] = [];
  const sub = (async () => {
    for await (const e of bus.subscribe()) seen.push(e);
  })();
  await new Promise((r) => setTimeout(r, 5));
  bus.emit({ type: "closed" });
  await sub;

  // the late subscriber catches up via the full message only — no stale delta fragment
  assert.deepEqual(seen.map((e) => e.type), ["message", "closed"]);
});

test("Broadcast hands a fresh subscriber the in-flight partial as synthetic deltas", async () => {
  const bus = new Broadcast();
  bus.emit({ type: "message", text: "done earlier" });
  bus.emit({ type: "delta", text: "thinking…", thinking: true, uuid: "t1" });
  bus.emit({ type: "delta", text: "half a ", uuid: "d1" });
  bus.emit({ type: "delta", text: "report", uuid: "d2" });

  const seen: SessionEvent[] = [];
  const sub = (async () => {
    for await (const e of bus.subscribe()) seen.push(e);
  })();
  await new Promise((r) => setTimeout(r, 5));
  bus.emit({ type: "closed" });
  await sub;

  // buffer first, then the accumulated prefix (thinking, then text) — synthetic deltas carry
  // no uuid (the client's uuid dedup must not eat them) and no seq (not a resume point)
  assert.deepEqual(
    seen.map((e) => (e.type === "delta" ? `delta:${e.thinking ? "think" : "text"}:${e.text}` : e.type)),
    ["message", "delta:think:thinking…", "delta:text:half a report", "closed"],
  );
  const deltas = seen.filter((e) => e.type === "delta");
  assert.ok(deltas.every((e) => !("uuid" in e) && e.seq === undefined));
});

test("Broadcast clears the partial at the client's flush points", async () => {
  const bus = new Broadcast();
  // thinking folds away at tool start (the live client flushes it into an item there)
  bus.emit({ type: "delta", text: "pondering", thinking: true });
  bus.emit({ type: "tool", name: "Bash", phase: "start" });
  // text reconciles when the assistant message lands
  bus.emit({ type: "delta", text: "partial text" });
  bus.emit({ type: "message", text: "the canonical text" });

  const seen: SessionEvent[] = [];
  const sub = (async () => {
    for await (const e of bus.subscribe()) seen.push(e);
  })();
  await new Promise((r) => setTimeout(r, 5));
  bus.emit({ type: "closed" });
  await sub;

  // nothing in flight anymore — no synthetic deltas, just the buffer
  assert.deepEqual(seen.map((e) => e.type), ["tool", "message", "closed"]);
});

test("sessionIdOf reads the id from init and result only", () => {
  assert.equal(sessionIdOf({ type: "system", subtype: "init", session_id: "abc" }), "abc");
  assert.equal(sessionIdOf({ type: "result", session_id: "def" }), "def");
  assert.equal(sessionIdOf({ type: "assistant", session_id: "nope" }), undefined);
});

test("makeWorklogWatcher emits once on change, nothing when unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-wl-"));
  const slug = "farm";
  const runId = "20260607-1-aaaa";
  const dir = path.join(root, "lines", "ops", "businesses", slug, ".bizagent", "deliverables", runId);
  fs.mkdirSync(dir, { recursive: true });
  const watch = makeWorklogWatcher(root, slug, runId);

  assert.equal(watch(), null); // no file yet
  fs.writeFileSync(path.join(dir, "worklog.md"), "---\ndescription: v1\n---\n");
  const first = watch();
  assert.ok(first && first.type === "worklog" && /v1/.test(first.content));
  assert.equal(watch(), null); // unchanged -> nothing
  fs.writeFileSync(path.join(dir, "worklog.md"), "---\ndescription: v2\n---\n");
  const second = watch();
  assert.ok(second && second.type === "worklog" && /v2/.test(second.content));
});

test("wrapStopHooks reports a Stop block to onBlock and passes the output through", async () => {
  const blocked: string[] = [];
  const hooks = {
    Stop: [{ hooks: [async () => ({ decision: "block", reason: "write the worklog" })] }],
    PreToolUse: [{ hooks: [async () => ({}) ] }],
  };
  const wrapped = wrapStopHooks(hooks, (reason) => blocked.push(reason));
  assert.deepEqual(await wrapped.Stop[0].hooks[0]({}), { decision: "block", reason: "write the worklog" });
  assert.deepEqual(blocked, ["write the worklog"]);
  assert.equal(wrapped.PreToolUse, hooks.PreToolUse); // other events untouched

  // A non-blocking Stop (the normal end of a session) reports nothing.
  const quiet = wrapStopHooks({ Stop: [{ hooks: [async () => ({})] }] }, (reason) => blocked.push(reason));
  assert.deepEqual(await quiet.Stop[0].hooks[0]({}), {});
  assert.deepEqual(blocked, ["write the worklog"]);
});

// ── background jobs ──
// A job outlives the agent's turn: opened without blocking, then settled (by a human/webhook via
// `resolve`, or by a background fn via `run`) — settling injects the result back + emits a `job`.

test("JobRegistry.open emits a job event and lists the ticket; resolve settles it + injects once", () => {
  const injected: string[] = [];
  const events: SessionEvent[] = [];
  const r = new JobRegistry({ inject: (t) => injected.push(t), emit: (e) => events.push(e), newTicket: () => "T1" });

  const ticket = r.open("waiting for deploy");
  assert.equal(ticket, "T1");
  assert.deepEqual(r.list(), [{ ticket: "T1", label: "waiting for deploy" }]);
  assert.deepEqual(events, [{ type: "job", ticket: "T1", status: "open", label: "waiting for deploy" }]);
  assert.equal(injected.length, 0); // nothing injected until it settles — the chat isn't blocked

  assert.equal(r.resolve("T1", "deploy done, build #42"), true);
  assert.deepEqual(r.list(), []); // no longer pending
  assert.deepEqual(events[1], { type: "job", ticket: "T1", status: "done", label: "waiting for deploy", result: "deploy done, build #42" });
  assert.equal(injected.length, 1);
  assert.match(injected[0], /background task finished — waiting for deploy/);
  assert.match(injected[0], /deploy done, build #42/);
});

test("JobRegistry.resolve on an unknown / already-settled ticket is a no-op", () => {
  const injected: string[] = [];
  const r = new JobRegistry({ inject: (t) => injected.push(t), emit: () => {}, newTicket: () => "T1" });
  assert.equal(r.resolve("nope", "x"), false);
  r.open();
  r.resolve("T1", "once");
  assert.equal(r.resolve("T1", "twice"), false); // already settled
  assert.equal(injected.length, 1); // injected exactly once
});

test("JobRegistry.run injects the resolved result (the poll path)", async () => {
  const injected: string[] = [];
  const events: SessionEvent[] = [];
  const r = new JobRegistry({ inject: (t) => injected.push(t), emit: (e) => events.push(e), newTicket: () => "T1" });

  r.run("tda query", async () => "rows: 123");
  assert.deepEqual(events[0], { type: "job", ticket: "T1", status: "open", label: "tda query" }); // opened synchronously, returns at once
  await new Promise((res) => setTimeout(res, 5)); // let the background fn resolve
  assert.equal(injected.length, 1);
  assert.match(injected[0], /tda query/);
  assert.match(injected[0], /rows: 123/);
  const last = events.at(-1);
  assert.ok(last && last.type === "job" && last.status === "done");
});

test("JobRegistry.run reports a failing job (failed event + injected error)", async () => {
  const injected: string[] = [];
  const events: SessionEvent[] = [];
  const r = new JobRegistry({ inject: (t) => injected.push(t), emit: (e) => events.push(e), newTicket: () => "T1" });
  r.run("flaky", async () => {
    throw new Error("timed out");
  });
  await new Promise((res) => setTimeout(res, 5));
  const last = events.at(-1);
  assert.ok(last && last.type === "job" && last.status === "failed");
  assert.match(injected[0], /background task FAILED — flaky/);
  assert.match(injected[0], /timed out/);
});

test("formatJobResult marks done vs failed and falls back to ticket when unlabeled", () => {
  assert.equal(formatJobResult("T1", "q", "ok", "done"), "[background task finished — q]\nok");
  assert.equal(formatJobResult("T1", undefined, "boom", "failed"), "[background task FAILED — T1]\nboom");
});

test("formatInbound wears the per-kind tag and appends the source", () => {
  assert.equal(formatInbound({ kind: "user", from: "Alice", text: "hi" }), "[message — Alice]\nhi");
  assert.equal(formatInbound({ kind: "agent", from: "farm-bot", text: "done" }), "[agent message — farm-bot]\ndone");
  assert.equal(formatInbound({ kind: "cron", from: "daily-pulse", text: "run" }), "[scheduled trigger — daily-pulse]\nrun");
});

test("formatInbound drops the dash when there is no source", () => {
  assert.equal(formatInbound({ kind: "system", text: "recap saved" }), "[system]\nrecap saved");
});

test("formatInbound lets a caller override the tag (job done/failed rides this)", () => {
  assert.equal(
    formatInbound({ kind: "job", tag: "background task finished", from: "q", text: "ok" }),
    "[background task finished — q]\nok",
  );
});

// A minimal BizSession the registry can drive: a resolvable `ready`, a Broadcast for `subscribe`
// (so we can fire `closed`), and a `send` spy. Only the bits makeSessionRegistry touches.
function fakeSession(sid: string): { session: BizSession; ready: (id: string) => void; bus: Broadcast; sent: string[] } {
  const bus = new Broadcast();
  const sent: string[] = [];
  let resolveReady!: (id: string) => void;
  const ready = new Promise<string>((r) => (resolveReady = r));
  const session = {
    id: sid,
    business: "farm",
    runId: sid,
    ready,
    send: (t: string) => sent.push(t),
    inject: () => {},
    injectFrom: () => {},
    resolveJob: () => false,
    listJobs: () => [],
    subscribe: () => bus.subscribe(),
    end: async () => {},
  } as unknown as BizSession;
  return { session, ready: resolveReady, bus, sent };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("makeSessionRegistry registers a session once ready and evicts it on close", async () => {
  const reg = makeSessionRegistry();
  const f = fakeSession("sess-1");
  reg.track(f.session);
  assert.equal(reg.has("sess-1"), false); // not yet ready
  f.ready("sess-1");
  await settle();
  assert.equal(reg.get("sess-1"), f.session);
  assert.deepEqual(reg.list(), [f.session]);
  f.bus.emit({ type: "closed" });
  await settle();
  assert.equal(reg.has("sess-1"), false);
});

test("makeSessionRegistry registers a resumed session immediately (claudeSessionId pre-set)", async () => {
  const reg = makeSessionRegistry();
  const f = fakeSession("mgr-1");
  (f.session as { claudeSessionId?: string }).claudeSessionId = "sid-resumed";
  reg.track(f.session);
  // No `ready` needed: a reconnect that lands right after the resume converges on this session
  // instead of spawning a second one.
  assert.equal(reg.get("sid-resumed"), f.session);
  f.bus.emit({ type: "closed" });
  await settle();
  assert.equal(reg.has("sid-resumed"), false);
});

test("manager.resume converges on the conversation's original run and defers the SDK launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-mgr-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  const mkRun = (runId: string, sid: string, req?: string) => {
    const dir = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".session-id"), sid);
    if (req) fs.writeFileSync(path.join(dir, ".req"), req);
  };
  // The conversation's original run plus a duplicate a pre-convergence resume minted.
  mkRun("20260101-080000-aaaaaaaa", "sid-42", "checkout");
  mkRun("20260101-090000-bbbbbbbb", "sid-42");

  const mgr = createSessionManager({ root });
  const s = mgr.resume({ business: "farm", claudeSessionId: "sid-42" });
  assert.equal(s.runId, "20260101-080000-aaaaaaaa"); // oldest match, not a fresh mint
  assert.equal(s.req, "checkout"); // derived from the run's .req marker
  assert.equal(s.claudeSessionId, "sid-42"); // known up front, no init needed
  assert.deepEqual(s.recentEvents(), [{ type: "session", claudeSessionId: "sid-42", seq: 1 }]); // seq = the SSE resume cursor

  // Promptless resume = browsing history: ending before any send must close cleanly without
  // ever having launched the SDK (this test passes with no claude binary involved).
  await s.end();
  for await (const ev of s.subscribe()) if (ev.type === "closed") break;

  // An unknown session id falls back to minting a fresh run.
  const fresh = mgr.resume({ business: "farm", claudeSessionId: "sid-unknown" });
  assert.notEqual(fresh.runId, "20260101-080000-aaaaaaaa");
  assert.equal(fresh.req, undefined);
  await fresh.end();
  for await (const ev of fresh.subscribe()) if (ev.type === "closed") break;
});

test("a start carrying a prompt emits it as a user-role message (live kickoff visibility)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-mgr-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  // A never-resolving resolveAuth parks the run loop before the SDK launch — the kickoff emit
  // is synchronous in makeSession, so no claude binary is involved here.
  const mgr = createSessionManager({ root, resolveAuth: () => new Promise(() => {}) });
  const s = mgr.start({ business: "farm", prompt: "# Set up the module `pay`\n\ndo the phases" });
  const kickoff = s.recentEvents().find((e) => e.type === "message" && e.role === "user");
  assert.ok(kickoff, "the kickoff prompt must reach the live event stream");
  assert.equal((kickoff as Extract<SessionEvent, { type: "message" }>).text, "# Set up the module `pay`\n\ndo the phases");
  assert.equal(s.busy, true); // the queued prompt marks the session busy like any other input
  await s.end();
});

test("reuseOrResume reuses a live session and never calls resume", async () => {
  const reg = makeSessionRegistry();
  const f = fakeSession("sess-1");
  reg.track(f.session);
  f.ready("sess-1");
  await settle();
  let resumed = false;
  const got = reg.reuseOrResume("sess-1", (s) => s.send("continue"), () => {
    resumed = true;
    return fakeSession("sess-2").session;
  });
  assert.equal(got, f.session);
  assert.deepEqual(f.sent, ["continue"]);
  assert.equal(resumed, false);
});

test("reuseOrResume resumes and tracks when nothing is live", async () => {
  const reg = makeSessionRegistry();
  const fresh = fakeSession("sess-9");
  const got = reg.reuseOrResume("sess-9", () => assert.fail("should not reuse"), () => fresh.session);
  assert.equal(got, fresh.session);
  fresh.ready("sess-9"); // the resumed session registers like any other
  await settle();
  assert.equal(reg.get("sess-9"), fresh.session);
});
