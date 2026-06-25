// The headless client: the pure reducer + SSE parsing (no network), then the JSON methods
// against a real `biz web` server (SDK-free routes only — no session is ever started).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initRoot, newBusiness, createWebServer, reduceSession, initialSessionState, readSSE, createBizClient } from "../src/index";
import type { SessionEvent, TimelineItem } from "../src/index";

// ─────────────────────────── reduceSession (pure) ───────────────────────────

const fold = (events: SessionEvent[]) => events.reduce(reduceSession, initialSessionState());

test("deltas accumulate, then a message lands them as a text item and clears the buffer", () => {
  const s = fold([
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
  ]);
  assert.equal(s.streaming, "Hello");
  assert.equal(s.items.length, 0);
  const done = reduceSession(s, { type: "message", text: "Hello", role: "assistant" });
  assert.equal(done.streaming, "");
  assert.deepEqual(done.items, [{ kind: "text", text: "Hello" }]);
});

test("thinking deltas buffer separately and land as a thinking item before the text", () => {
  const s = fold([
    { type: "delta", text: "let me think", thinking: true },
    { type: "delta", text: "the answer", thinking: false },
    { type: "message", text: "the answer", role: "assistant" },
  ]);
  assert.equal(s.thinking, "");
  assert.deepEqual(s.items, [
    { kind: "thinking", text: "let me think" },
    { kind: "text", text: "the answer" },
  ]);
});

test("the timeline interleaves user, text, tool, text in arrival order", () => {
  const s = fold([
    { type: "message", text: "run ls", role: "user" },
    { type: "message", text: "Sure, running it.", role: "assistant" },
    { type: "tool", name: "Bash", phase: "start", input: { cmd: "ls" }, id: "t1" },
    { type: "tool", phase: "end", result: "a\nb", id: "t1" },
    { type: "message", text: "Done — two files.", role: "assistant" },
  ]);
  assert.deepEqual(
    s.items.map((it) => it.kind),
    ["user", "text", "tool", "text"],
  );
  const tool = s.items[2] as Extract<(typeof s.items)[number], { kind: "tool" }>;
  assert.equal(tool.running, false);
  assert.equal(tool.result, "a\nb");
  assert.deepEqual(tool.input, { cmd: "ls" });
});

test("tool end pairs to its start by tool_use id", () => {
  const s = fold([
    { type: "tool", name: "A", phase: "start", id: "x", input: 1 },
    { type: "tool", name: "B", phase: "start", id: "y", input: 2 },
    { type: "tool", phase: "end", result: "ry", id: "y" },
  ]);
  const tools = s.items.filter((it) => it.kind === "tool") as Array<Extract<(typeof s.items)[number], { kind: "tool" }>>;
  assert.equal(tools.find((t) => t.id === "y")!.running, false);
  assert.equal(tools.find((t) => t.id === "x")!.running, true); // unrelated tool stays running
});

test("jobs upsert by ticket; usage, idle, closed, error fold in", () => {
  const s = fold([
    { type: "job", ticket: "T1", status: "open", label: "deploy" },
    { type: "job", ticket: "T1", status: "done", result: "shipped" },
    { type: "usage", costUsd: 0.12 } as SessionEvent,
    { type: "idle" },
    { type: "error", message: "boom" },
    { type: "closed" },
  ]);
  assert.equal(s.jobs.T1.status, "done");
  assert.equal(s.jobs.T1.result, "shipped");
  assert.equal(s.idle, true);
  assert.equal(s.closed, true);
  assert.equal(s.error, "boom");
  assert.ok(s.usage);
});

test("a hook event lands as a hook item and keeps the turn live (idle false)", () => {
  const s = fold([
    { type: "message", text: "all done", role: "assistant" },
    { type: "hook", hook: "stop", text: "Write the worklog first.", at: "2026-06-10T12:00:00Z" },
    { type: "tool", name: "Write", phase: "start", id: "w1" },
    { type: "tool", phase: "end", id: "w1" },
    { type: "message", text: "Worklog created.", role: "assistant" },
  ]);
  assert.deepEqual(
    s.items.map((it) => it.kind),
    ["text", "hook", "tool", "text"],
  );
  assert.deepEqual(s.items[1], { kind: "hook", hook: "stop", text: "Write the worklog first.", at: "2026-06-10T12:00:00Z" });
  assert.equal(s.idle, false);
});

test("a new user turn clears a stale error (retry path)", () => {
  const s = fold([
    { type: "error", message: "boom" },
    { type: "message", text: "try again", role: "user" },
  ]);
  assert.equal(s.error, undefined);
});

test("a terminal event settles tools still running (an interrupted turn never sends their tool end)", () => {
  // The user hits stop mid-tool: the SDK interrupt ends the turn with a `result` (→ idle) but the
  // in-flight tool_use never gets a tool_result — the spinner must not run forever.
  const s = fold([
    { type: "tool", name: "Bash", phase: "start", id: "t1" },
    { type: "idle" },
  ]);
  const tool = s.items.find((it) => it.kind === "tool") as Extract<TimelineItem, { kind: "tool" }>;
  assert.equal(tool.running, false);
  assert.equal(tool.result, "(interrupted)");
  // Same settling on error/closed; a tool that DID finish keeps its real result.
  const s2 = fold([
    { type: "tool", name: "Read", phase: "start", id: "a" },
    { type: "tool", phase: "end", id: "a", result: "ok" },
    { type: "tool", name: "Bash", phase: "start", id: "b" },
    { type: "error", message: "boom" },
  ]);
  const [done, killed] = s2.items.filter((it) => it.kind === "tool") as Array<Extract<TimelineItem, { kind: "tool" }>>;
  assert.equal(done.result, "ok");
  assert.equal(killed.running, false);
});

test("a session event surfaces the Claude session id (the resumable id — NOT the handle's `id`)", () => {
  const s = reduceSession(initialSessionState(), { type: "session", claudeSessionId: "uuid-1" });
  assert.equal(s.claudeSessionId, "uuid-1");
});

test("reduceSession is pure — the input state is not mutated", () => {
  const before = initialSessionState();
  const after = reduceSession(before, { type: "delta", text: "x" });
  assert.equal(before.streaming, "");
  assert.notEqual(before, after);
});

// ─────────────────────────── readSSE ───────────────────────────

function sseResponse(text: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

test("readSSE parses data frames and skips ping comments", async () => {
  const wire = 'data: {"type":"delta","text":"hi"}\n\n: ping\n\ndata: {"type":"idle"}\n\n';
  const got: SessionEvent[] = [];
  for await (const ev of readSSE(sseResponse(wire))) got.push(ev);
  assert.deepEqual(got, [
    { type: "delta", text: "hi" },
    { type: "idle" },
  ]);
});

// ─────────────────────────── createBizClient (JSON routes) ───────────────────────────

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-client-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  return root;
}

async function serve(root: string): Promise<{ base: string; close: () => void }> {
  const server = createWebServer({ root });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("resume with runId seeds state from history and skips the live stream's replayed messages", async () => {
  const history: SessionEvent[] = [
    { type: "message", text: "hi", role: "user", uuid: "u1" },
    { type: "message", text: "hello", uuid: "a1" },
  ];
  // The live stream replays the last assistant message (same uuid as history) before a new turn —
  // the handle must fold the new turn but not duplicate the replayed one.
  const wire =
    'data: {"type":"message","text":"hello","uuid":"a1"}\n\n' +
    'data: {"type":"message","text":"new turn","uuid":"a2"}\n\n' +
    'data: {"type":"closed"}\n\n';
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/history")) return new Response(JSON.stringify(history), { headers: { "content-type": "application/json" } });
    if (url.includes("/api/start"))
      return new Response(JSON.stringify({ id: "s1", runId: "r1", business: "farm" }), { headers: { "content-type": "application/json" } });
    if (url.includes("/api/stream")) return sseResponse(wire);
    throw new Error(`unexpected fetch ${url}`);
  };

  const client = createBizClient({ baseUrl: "http://test", fetch: mockFetch });
  const h = await client.resume({ business: "farm", claudeSessionId: "sid", runId: "r1" });
  // Seeded synchronously — the history is visible before any live event lands.
  assert.deepEqual(h.getState().items, [
    { kind: "user", text: "hi" },
    { kind: "text", text: "hello" },
  ]);
  await new Promise<void>((resolve) => h.onState((s) => s.closed && resolve()));
  assert.deepEqual(h.getState().items, [
    { kind: "user", text: "hi" },
    { kind: "text", text: "hello" }, // not duplicated by the live replay
    { kind: "text", text: "new turn" },
  ]);
  h.close();
});

test("send recovers from a server restart: re-resumes by claudeSessionId and redelivers", async () => {
  const calls: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input).replace("http://test", "");
    calls.push(url);
    if (url.includes("/history")) return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
    if (url.startsWith("/api/start")) {
      // The pre-restart process hands out s1; the post-restart re-resume hands out s2.
      const id = calls.filter((c) => c.startsWith("/api/start")).length === 1 ? "s1" : "s2";
      return new Response(JSON.stringify({ id, runId: "r1", business: "farm" }), { headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("/api/stream")) return sseResponse(""); // connects, then quietly ends (the loop backs off)
    if (url.startsWith("/api/send")) return new Response(null, { status: url.includes("id=s1") ? 404 : 204 });
    throw new Error(`unexpected fetch ${url}`);
  };

  const client = createBizClient({ baseUrl: "http://test", fetch: mockFetch });
  const h = await client.resume({ business: "farm", claudeSessionId: "sid-1", runId: "r1" });
  await h.send("hello again");
  h.close();

  // 404 on the dead manager id -> transparent /api/start?resume=<claudeSessionId> -> resend.
  assert.deepEqual(
    calls.filter((c) => c.startsWith("/api/send")),
    ["/api/send?id=s1", "/api/send?id=s2"],
  );
  const starts = calls.filter((c) => c.startsWith("/api/start"));
  assert.equal(starts.length, 2);
  assert.ok(starts[1].includes("resume=sid-1"));
  // The user's turn shows exactly once despite the retry. (`at` is the optimistic send's
  // wall-clock stamp — dynamic, so assert around it.)
  assert.deepEqual(h.getState().items.map(({ kind, text }) => ({ kind, text })), [{ kind: "user", text: "hello again" }]);
  assert.ok((h.getState().items[0] as { at?: string }).at);
});

test("createBizClient mirrors the JSON API (health, list, create, memory, context)", async () => {
  const { base, close } = await serve(tmpRoot());
  const client = createBizClient({ baseUrl: base });
  try {
    const health = await client.health();
    assert.equal(health.ok, true);

    const ws = await client.listBusinesses();
    assert.deepEqual(ws.map((w) => w.slug), ["farm"]);

    await client.createBusiness({ slug: "lab", line: "ops", name: "Lab" });
    assert.ok((await client.listBusinesses()).some((w) => w.slug === "lab"));

    await client.writeMemory("farm", { body: "Retention rose 5%." });
    const recalled = (await client.recall("farm")) as { body: string }[];
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].body, /Retention rose/);

    assert.match(await client.context("farm"), /Farm/);
  } finally {
    close();
  }
});
