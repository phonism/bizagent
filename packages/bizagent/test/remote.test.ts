// The sharing seam: fileRemote round-trips, the Stop/inject hooks publish & pull through it,
// and two users on separate roots (same business slug, one shared hub) see each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  initRoot,
  newBusiness,
  writeMemory,
  buildSystemPrompt,
  fileRemote,
  httpRemote,
  resolveRemote,
  pullRemoteIndex,
  publishMemories,
  publishTranscript,
  stopHook,
  injectHook,
} from "../src/index";
import type { Remote } from "../src/index";

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `biz-${tag}-`));
}

/** A user = a root with one `farm` business. */
function tmpUser(tag: string): { root: string; ws: string } {
  const root = tmpDir(tag);
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm" });
  return { root, ws: path.join(root, "lines", "ops", "businesses", "farm") };
}

function writeWorklog(ws: string, runId: string, description: string): void {
  const dir = path.join(ws, ".bizagent", "deliverables", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worklog.md"), `---\ndescription: ${description}\n---\n\nbody\n`);
}

test("fileRemote round-trips worklogs, the index, and memory", async () => {
  const remote = fileRemote(path.join(tmpDir("hub"), "farm"));
  await remote.publishWorklog({ runId: "20260601-1-aaaa", line: "- 2026-06-01 · did A · 20260601-1-aaaa", content: "A body" });
  await remote.publishWorklog({ runId: "20260601-1-aaaa", line: "- dup line should not append", content: "A body v2" }); // same runId

  const index = await remote.fetchIndex();
  assert.equal(index.length, 1); // index line appended once per runId
  assert.equal(index[0].runId, "20260601-1-aaaa");
  assert.equal(await remote.fetchWorklog("20260601-1-aaaa"), "A body v2"); // body is latest-wins
  assert.equal(await remote.fetchWorklog("nope"), null);

  await remote.publishMemory({ id: "m1", content: "GMV excludes cancelled" });
  const mem = await remote.fetchMemory();
  assert.deepEqual(mem, [{ id: "m1", content: "GMV excludes cancelled" }]);
});

test("two users on a shared hub see each other's worklog through Stop -> inject", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("userA");
  const b = tmpUser("userB");
  const remoteA = fileRemote(hub);
  const remoteB = fileRemote(hub);

  // User A finishes a session — the Stop hook indexes locally and publishes to the hub.
  const runA = "20260602-100000-aaaaaaaa";
  writeWorklog(a.ws, runA, "user A found the churn cause");
  const stopped = await stopHook({ cwd: a.ws, runId: runA, stopActive: false, remote: remoteA });
  assert.deepEqual(stopped, { indexed: 1 });
  assert.equal((await remoteA.fetchIndex()).length, 1); // published to hub

  // User B starts a turn — the inject hook pulls the hub and surfaces A's line as fresh.
  const runB = "20260602-110000-bbbbbbbb";
  writeWorklog(b.ws, runB, "user B working on something else");
  const injected = await injectHook({ cwd: b.ws, runId: runB, remote: remoteB });
  assert.ok(injected, "B should be told about A's session");
  assert.match(injected.context, /user A found the churn cause/);

  // B's local index now carries A's line (merged), so B's read surfaces stay consistent.
  const bIndex = fs.readFileSync(path.join(b.ws, ".bizagent", "worklog-index.md"), "utf8");
  assert.match(bIndex, /user A found the churn cause/);

  // Nothing new on the next turn (and the pull is idempotent by runId).
  assert.equal(await injectHook({ cwd: b.ws, runId: runB, remote: remoteB }), null);
});

test("business memory is shared: A publishes on Stop, B sees it in its launch context", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("memA");
  const b = tmpUser("memB");
  const remoteA = fileRemote(hub);
  const remoteB = fileRemote(hub);

  // User A records a business memory, then a Stop publishes it to the hub.
  writeMemory({ root: a.root, slug: "farm", body: "GMV excludes cancelled orders" });
  const runA = "20260606-100000-aaaaaaaa";
  writeWorklog(a.ws, runA, "A's session");
  await stopHook({ cwd: a.ws, runId: runA, stopActive: false, remote: remoteA });

  // Before pulling, B's launch context has no business memory.
  assert.doesNotMatch(buildSystemPrompt({ root: b.root, slug: "farm", runId: "x" }), /GMV excludes cancelled/);

  // B starts a turn — inject pulls A's memory into B's remote-memory cache.
  const runB = "20260606-110000-bbbbbbbb";
  writeWorklog(b.ws, runB, "B's session");
  await injectHook({ cwd: b.ws, runId: runB, remote: remoteB });

  // Now B's launch context includes A's business memory (merged from the cache).
  const ctx = buildSystemPrompt({ root: b.root, slug: "farm", runId: "x" });
  assert.match(ctx, /GMV excludes cancelled orders/);
  // And it landed in the cache dir, not B's own memory/ (which B git-tracks).
  assert.equal(fs.existsSync(path.join(b.ws, "memory")) && fs.readdirSync(path.join(b.ws, "memory")).length, 0);
  assert.ok(fs.existsSync(path.join(b.ws, ".bizagent", "remote-memory")));
});

test("publishMemories skips records unchanged since last publish", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("memSkip");
  const remote = fileRemote(hub);
  writeMemory({ root: a.root, slug: "farm", body: "fact one" });

  assert.equal((await publishMemories({ root: a.root, slug: "farm", remote })).published, 1);
  assert.equal((await publishMemories({ root: a.root, slug: "farm", remote })).published, 0); // unchanged -> skip

  writeMemory({ root: a.root, slug: "farm", body: "fact two" });
  assert.equal((await publishMemories({ root: a.root, slug: "farm", remote })).published, 1); // only the new one
});

test("pullRemoteIndex is throttled by its TTL, and dedups by runId", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const b = tmpUser("userB");
  const remote = fileRemote(hub);
  await remote.publishWorklog({ runId: "20260603-1-cccc", line: "- 2026-06-03 · C · 20260603-1-cccc", content: "c" });
  fs.writeFileSync(
    path.join(b.ws, ".bizagent", "worklog-index.md"),
    "- 2026-06-02 · mentioned 20260603-1-cccc in a summary · 20260602-1-local\n",
  );

  // First pull merges the entry, even if the remote runId appears in an existing description.
  assert.deepEqual(await pullRemoteIndex({ root: b.root, slug: "farm", remote, ttlMs: 0 }), { merged: 1 });
  // Pulling again (ttl 0) re-fetches but dedups by runId -> nothing merged.
  assert.deepEqual(await pullRemoteIndex({ root: b.root, slug: "farm", remote, ttlMs: 0 }), { merged: 0 });

  // A new remote entry, but within the TTL window -> the pull is skipped entirely.
  await remote.publishWorklog({ runId: "20260603-2-dddd", line: "- 2026-06-03 · D · 20260603-2-dddd", content: "d" });
  assert.deepEqual(await pullRemoteIndex({ root: b.root, slug: "farm", remote, ttlMs: 60_000 }), { merged: 0 });
});

function setRemoteConfig(root: string, remote: unknown): void {
  const cfgPath = path.join(root, "bizagent.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.remote = remote;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

test("resolveRemote builds a file remote from the root config, null when unset", async () => {
  const a = tmpUser("cfg");
  assert.equal(await resolveRemote(a.root, "farm"), null); // no remote block yet

  setRemoteConfig(a.root, { type: "file", dir: "../shared-hub" });
  const remote = await resolveRemote(a.root, "farm");
  assert.ok(remote, "remote should resolve from config");
  await remote.publishWorklog({ runId: "20260604-1-eeee", line: "- 2026-06-04 · E · 20260604-1-eeee", content: "e" });
  // It writes under <root>/../shared-hub/farm/ (dir resolved relative to the root, slug-scoped).
  const hubFarm = path.join(path.resolve(a.root, "../shared-hub"), "farm");
  assert.ok(fs.existsSync(path.join(hubFarm, "worklogs", "20260604-1-eeee.md")));
});

test("httpRemote follows the fixed contract and carries auth headers", async () => {
  const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.method === "GET" && req.url === "/index") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ runId: "r1", line: "- 2026-06-05 · remote A · r1" }]));
      } else if (req.method === "GET" && req.url === "/worklog/r1") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("remote body");
      } else {
        res.writeHead(204);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as import("node:net").AddressInfo;

  const remote = httpRemote({ url: `http://127.0.0.1:${port}`, headers: { Authorization: "Bearer secret" } });
  await remote.publishWorklog({ runId: "r2", line: "l", content: "c" });
  const index = await remote.fetchIndex();
  const body = await remote.fetchWorklog("r1");
  server.close();

  assert.deepEqual(index, [{ runId: "r1", line: "- 2026-06-05 · remote A · r1" }]);
  assert.equal(body, "remote body");
  const post = seen.find((s) => s.method === "POST");
  assert.equal(post?.url, "/worklog");
  assert.equal(JSON.parse(post!.body).runId, "r2"); // fixed POST /worklog body shape
  assert.ok(seen.every((s) => s.auth === "Bearer secret")); // auth header on every call
});

test("httpRemote treats non-2xx publish responses as failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const remote = httpRemote({ url: "http://example.invalid" });
    await assert.rejects(
      () => remote.publishWorklog({ runId: "r1", line: "l", content: "c" }),
      /publishWorklog failed: HTTP 500/,
    );
    await assert.rejects(() => remote.publishMemory({ id: "m1", content: "c" }), /publishMemory failed: HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveRemote http tier interpolates ${ENV} into headers (secrets stay in env)", async () => {
  const a = tmpUser("http");
  setRemoteConfig(a.root, {
    type: "http",
    url: "http://127.0.0.1:1/${BIZ_PATH}",
    headers: { Authorization: "Bearer ${BIZ_REMOTE_TOKEN}" },
  });
  process.env.BIZ_REMOTE_TOKEN = "tok-123";
  process.env.BIZ_PATH = "api";
  const remote = await resolveRemote(a.root, "farm");
  delete process.env.BIZ_REMOTE_TOKEN;
  delete process.env.BIZ_PATH;
  assert.ok(remote, "http remote should resolve"); // construction only; no network call here
});

// ── transcript mirroring (the hub's read-only session view) ──

test("fileRemote transcript chunks: append, overlap dropped, gap rejected with watermark", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const remote = fileRemote(hub);
  await remote.publishTranscript!({ runId: "r1", offset: 0, content: "a\n" });
  await remote.publishTranscript!({ runId: "r1", offset: 2, content: "b\n" });
  await remote.publishTranscript!({ runId: "r1", offset: 2, content: "b\nc\n" }); // lost-ack re-push: overlap dropped
  const mirror = path.join(hub, "transcripts", "r1.jsonl");
  assert.equal(fs.readFileSync(mirror, "utf8"), "a\nb\nc\n");

  // a chunk that would leave a hole is rejected, carrying the hub's watermark for the resync
  await assert.rejects(
    () => remote.publishTranscript!({ runId: "r1", offset: 99, content: "z\n" }),
    (e: Error & { have?: number }) => {
      assert.match(e.message, /transcript gap/);
      assert.equal(e.have, 6);
      return true;
    },
  );
  assert.equal(fs.readFileSync(mirror, "utf8"), "a\nb\nc\n"); // rejected chunk never applied

  // offset 0 re-push (the rotation/reset path) overwrites instead of appending
  await remote.publishTranscript!({ runId: "r1", offset: 0, content: "fresh\n" });
  assert.equal(fs.readFileSync(mirror, "utf8"), "fresh\n");
});

test("resolveRemote shares transcripts only behind `transcripts: true`", async () => {
  const a = tmpUser("tsgate");
  setRemoteConfig(a.root, { type: "file", dir: "../hub" });
  assert.equal((await resolveRemote(a.root, "farm"))?.publishTranscript, undefined); // default: worklog/memory only
  setRemoteConfig(a.root, { type: "file", dir: "../hub", transcripts: true });
  assert.ok((await resolveRemote(a.root, "farm"))?.publishTranscript, "opted in -> method present");
});

/** A run dir with a `.transcript-path` pointer at a fake Claude Code jsonl. */
function seedTranscript(ws: string, runId: string, jsonl: string): void {
  const dir = path.join(ws, ".bizagent", "deliverables", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".transcript-path"), jsonl);
}

test("publishTranscript pushes complete lines incrementally and resumes from its marker", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("tpush");
  const remote = fileRemote(hub);
  const runId = "20260611-100000-tttttttt";
  const jsonl = path.join(tmpDir("cc"), "session.jsonl");
  fs.writeFileSync(jsonl, "l1\nl2\nhalf"); // a half-written trailing line must wait
  seedTranscript(a.ws, runId, jsonl);
  const mirror = path.join(hub, "transcripts", `${runId}.jsonl`);

  assert.deepEqual(await publishTranscript({ root: a.root, slug: "farm", runId, remote }), { pushed: 1 });
  assert.equal(fs.readFileSync(mirror, "utf8"), "l1\nl2\n");

  fs.appendFileSync(jsonl, "-done\nl3\n"); // the half line completes, plus one more turn
  await publishTranscript({ root: a.root, slug: "farm", runId, remote });
  assert.equal(fs.readFileSync(mirror, "utf8"), "l1\nl2\nhalf-done\nl3\n");

  // nothing new -> nothing pushed; a remote that didn't opt in -> a no-op
  assert.deepEqual(await publishTranscript({ root: a.root, slug: "farm", runId, remote }), { pushed: 0 });
  const optedOut: Remote = { ...remote };
  delete optedOut.publishTranscript;
  assert.deepEqual(await publishTranscript({ root: a.root, slug: "farm", runId, remote: optedOut }), { pushed: 0 });
});

test("publishTranscript caps each chunk — a backlog catches up over several pushes", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("tchunk");
  const remote = fileRemote(hub);
  const runId = "20260611-110000-cccccccc";
  const jsonl = path.join(tmpDir("cc"), "session.jsonl");
  fs.writeFileSync(jsonl, "aaaa\nbbbb\ncccc\n");
  seedTranscript(a.ws, runId, jsonl);

  const r = await publishTranscript({ root: a.root, slug: "farm", runId, remote, chunk: 5 });
  assert.equal(r.pushed, 3); // one line per capped chunk
  assert.equal(fs.readFileSync(path.join(hub, "transcripts", `${runId}.jsonl`), "utf8"), "aaaa\nbbbb\ncccc\n");
});

test("publishTranscript resyncs to the remote's watermark when the hub lost data", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("tsync");
  const remote = fileRemote(hub);
  const runId = "20260611-120000-gggggggg";
  const jsonl = path.join(tmpDir("cc"), "session.jsonl");
  fs.writeFileSync(jsonl, "l1\nl2\n");
  seedTranscript(a.ws, runId, jsonl);
  await publishTranscript({ root: a.root, slug: "farm", runId, remote });

  // The hub loses the mirror (run wiped platform-side); local marker is now ahead of it.
  const mirror = path.join(hub, "transcripts", `${runId}.jsonl`);
  fs.rmSync(mirror);
  fs.appendFileSync(jsonl, "l3\n");

  // Next push gets the gap rejection, backs up to the hub's watermark (0), re-pushes whole.
  const r = await publishTranscript({ root: a.root, slug: "farm", runId, remote });
  assert.equal(r.pushed, 1);
  assert.equal(fs.readFileSync(mirror, "utf8"), "l1\nl2\nl3\n");
});

test("publishTranscript restarts from the top when the local transcript was rotated", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("trot");
  const remote = fileRemote(hub);
  const runId = "20260611-130000-rrrrrrrr";
  const jsonl = path.join(tmpDir("cc"), "session.jsonl");
  fs.writeFileSync(jsonl, "before-1\nbefore-2\n");
  seedTranscript(a.ws, runId, jsonl);
  await publishTranscript({ root: a.root, slug: "farm", runId, remote });

  fs.writeFileSync(jsonl, "after\n"); // rotated: shorter than what we already pushed
  await publishTranscript({ root: a.root, slug: "farm", runId, remote });
  assert.equal(fs.readFileSync(path.join(hub, "transcripts", `${runId}.jsonl`), "utf8"), "after\n");
});

test("stopHook mirrors the turn's transcript when the remote shares transcripts", async () => {
  const hub = path.join(tmpDir("hub"), "farm");
  const a = tmpUser("tstop");
  const remote = fileRemote(hub);
  const runId = "20260611-140000-hhhhhhhh";
  writeWorklog(a.ws, runId, "did things");
  const jsonl = path.join(tmpDir("cc"), "session.jsonl");
  fs.writeFileSync(jsonl, '{"type":"user"}\n');
  seedTranscript(a.ws, runId, jsonl);

  await stopHook({ cwd: a.ws, runId, stopActive: false, remote });
  assert.equal(fs.readFileSync(path.join(hub, "transcripts", `${runId}.jsonl`), "utf8"), '{"type":"user"}\n');
});

test("httpRemote surfaces a transcript gap (409) with the hub's watermark", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ have: 5 }), { status: 409 })) as typeof fetch;
  try {
    const remote = httpRemote({ url: "http://example.invalid" });
    await remote.publishTranscript!({ runId: "r", offset: 9, content: "x\n" }).then(
      () => assert.fail("a 409 must reject"),
      (e: Error & { have?: number }) => {
        assert.match(e.message, /transcript gap/);
        assert.equal(e.have, 5);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveRemote module tier loads the user's own Remote factory", async () => {
  const a = tmpUser("mod");
  const modPath = path.join(a.root, "my-remote.mjs");
  // A user-authored Remote: any transport/auth they like. Here it just records the call.
  fs.writeFileSync(
    modPath,
    `export function createRemote(ctx) {
       return {
         async publishWorklog(o) { globalThis.__bizPublished = { slug: ctx.slug, runId: o.runId }; },
         async fetchIndex() { return []; },
         async fetchWorklog() { return null; },
         async publishMemory() {},
         async fetchMemory() { return []; },
       };
     }`,
  );
  setRemoteConfig(a.root, { type: "module", path: "./my-remote.mjs" });
  const remote = await resolveRemote(a.root, "farm");
  assert.ok(remote, "module remote should load");
  await remote.publishWorklog({ runId: "rx", line: "l", content: "c" });
  assert.deepEqual((globalThis as Record<string, unknown>).__bizPublished, { slug: "farm", runId: "rx" });
});
