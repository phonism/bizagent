// The hub: platform-side routes serving httpRemote's contract + the read-only pull surface.
// Contract/manifest tests go over a real listener (like web.test.ts); the round-trip test
// drives the REAL local machinery (resolveRemote with ${SLUG} → publish/pull) against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  initRoot,
  newBusiness,
  createWebServer,
  resolveRemote,
  publishWorklogs,
  publishMemories,
  pullRemoteIndex,
  pullRemoteMemory,
  writeMemory,
  listRuns,
  readWorklogIndex,
  runHistory,
} from "../src/index";

const NOW = () => "2026-01-01T00:00:00.000Z";

function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  initRoot({ root, now: NOW });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  return root;
}

async function serve(root: string): Promise<{ base: string; close: () => void }> {
  const server = createWebServer({ root });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const farmDir = (root: string) => path.join(root, "lines", "ops", "businesses", "farm");

const WORKLOG_BODY = "# Worklog\n\n- did things\n\n## Conclusions\n- it works\n";
const INDEX_LINE = "- 2026-01-01 · did things · run-aaa";
const MEM_RECORD = "---\nscope: business\ndescription: GMV excludes cancelled orders\nconfidence: 0.9\n---\n\nGMV excludes cancelled orders.\n";

test("hub worklog: push is idempotent by runId, body latest-wins, listed by listRuns", async () => {
  const root = tmpRoot("biz-hub-");
  const { base, close } = await serve(root);
  const hub = `${base}/api/businesses/farm/hub`;
  try {
    // empty index
    assert.deepEqual(await (await fetch(`${hub}/index`)).json(), []);

    // first push
    let r = await fetch(`${hub}/worklog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run-aaa", line: INDEX_LINE, content: WORKLOG_BODY }),
    });
    assert.equal(r.status, 200);

    // re-push same runId with a newer body: index stays single, body updates
    r = await fetch(`${hub}/worklog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run-aaa", line: INDEX_LINE, content: WORKLOG_BODY + "more\n" }),
    });
    assert.equal(r.status, 200);

    const idx = (await (await fetch(`${hub}/index`)).json()) as { runId: string; line: string }[];
    assert.equal(idx.length, 1);
    assert.deepEqual(idx[0], { runId: "run-aaa", line: INDEX_LINE });

    const body = await (await fetch(`${hub}/worklog/run-aaa`)).text();
    assert.match(body, /more/);
    assert.equal((await fetch(`${hub}/worklog/run-zzz`)).status, 404);

    // bad runId is rejected, never touches disk
    r = await fetch(`${hub}/worklog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "../evil", line: "- x · y · ../evil", content: "x" }),
    });
    assert.equal(r.status, 400);

    // live data: the pushed run shows up in the platform's conversation list (not resumable)
    const runs = listRuns(root, "farm");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, "run-aaa");
    assert.equal(runs[0].claudeSessionId, undefined);
  } finally {
    close();
  }
});

test("hub memory: governed write, raw fetch, 422 on bad record, 400 on bad id", async () => {
  const root = tmpRoot("biz-hub-mem-");
  const { base, close } = await serve(root);
  const hub = `${base}/api/businesses/farm/hub`;
  try {
    let r = await fetch(`${hub}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "gmv-rule", content: MEM_RECORD }),
    });
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(farmDir(root), "memory", "gmv-rule.md")));

    const blobs = (await (await fetch(`${hub}/memory`)).json()) as { id: string; content: string }[];
    assert.deepEqual(blobs.map((b) => b.id), ["gmv-rule"]);
    assert.match(blobs[0].content, /GMV excludes/);

    // wrong scope → the same governance the write hook enforces
    r = await fetch(`${hub}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad", content: "---\nscope: common\n---\n\nnope\n" }),
    });
    assert.equal(r.status, 422);

    // traversal id
    r = await fetch(`${hub}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "../escape", content: MEM_RECORD }),
    });
    assert.equal(r.status, 400);
  } finally {
    close();
  }
});

test("hub transcript: chunked push mirrors a remote session, replayable read-only", async () => {
  const root = tmpRoot("biz-hub-tr-");
  const { base, close } = await serve(root);
  const hub = `${base}/api/businesses/farm/hub`;
  const L1 = JSON.stringify({ type: "user", message: { role: "user", content: "hi there" }, uuid: "u1" }) + "\n";
  const L2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello back" }] }, uuid: "a1" }) + "\n";
  const post = (body: unknown) =>
    fetch(`${hub}/transcript`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    let r = await post({ runId: "run-ttt", offset: 0, content: L1 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { have: L1.length });

    // a lost-ack re-push overlaps what the hub already has: dropped, never duplicated
    r = await post({ runId: "run-ttt", offset: 0, content: L1 + L2 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { have: (L1 + L2).length });

    // a chunk that would leave a hole -> 409 + the watermark the pusher resyncs to
    r = await post({ runId: "run-ttt", offset: (L1 + L2).length + 7, content: "x\n" });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { have: (L1 + L2).length });

    // traversal runId / missing fields are rejected
    assert.equal((await post({ runId: "../evil", offset: 0, content: "x\n" })).status, 400);
    assert.equal((await post({ runId: "run-ttt", content: "x\n" })).status, 400);

    const mirror = path.join(farmDir(root), ".bizagent", "deliverables", "run-ttt", ".transcript.jsonl");
    assert.equal(fs.readFileSync(mirror, "utf8"), L1 + L2);

    // The platform replays the mirror through the SAME projection local sessions use…
    const events = runHistory(root, "farm", "run-ttt") as { type: string; text?: string }[];
    assert.deepEqual(events.map((e) => e.type), ["message", "message"]);
    assert.equal(events[1].text, "hello back");
    // …but the run stays out of the conversation list until its worklog arrives, and a mirror
    // never comes with a `.session-id` — read-only by construction.
    assert.equal(listRuns(root, "farm").length, 0);
  } finally {
    close();
  }
});

test("hub manifest/file: whitelist only, symlinked knowledge excluded, traversal rejected", async () => {
  const root = tmpRoot("biz-hub-man-");
  const biz = farmDir(root);
  fs.writeFileSync(path.join(biz, "memory", "m1.md"), MEM_RECORD);
  fs.mkdirSync(path.join(biz, "knowledge", "business"), { recursive: true });
  fs.writeFileSync(path.join(biz, "knowledge", "business", "notes.md"), "# Notes\n");
  // seed the COMMON layer (symlinked into the business) — must NOT appear in the manifest
  fs.writeFileSync(path.join(root, "knowledge", "common", "seed.md"), "# Common\n");
  fs.mkdirSync(path.join(biz, ".bizagent", "deliverables", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(biz, ".bizagent", "deliverables", "run-1", "worklog.md"), WORKLOG_BODY);
  fs.writeFileSync(path.join(biz, ".bizagent", "deliverables", "run-1", ".session-id"), "secret\n");
  fs.writeFileSync(path.join(biz, ".bizagent", "worklog-index.md"), INDEX_LINE + "\n");

  const { base, close } = await serve(root);
  const hub = `${base}/api/businesses/farm/hub`;
  try {
    const man = (await (await fetch(`${hub}/manifest`)).json()) as { path: string; sha256: string }[];
    const paths = man.map((e) => e.path).sort();
    assert.deepEqual(paths, [
      ".bizagent/deliverables/run-1/worklog.md",
      ".bizagent/worklog-index.md",
      "business.json",
      "knowledge/business/notes.md",
      "memory/m1.md",
    ]);
    // sha256 is a real content hash
    const m1 = man.find((e) => e.path === "memory/m1.md");
    assert.equal(m1?.sha256.length, 64);

    // file read round-trips
    const got = await (await fetch(`${hub}/file?path=${encodeURIComponent("memory/m1.md")}`)).text();
    assert.equal(got, MEM_RECORD);

    // absent-but-allowed → 404; traversal / outside whitelist / symlink layer → 400
    assert.equal((await fetch(`${hub}/file?path=${encodeURIComponent("memory/none.md")}`)).status, 404);
    assert.equal((await fetch(`${hub}/file?path=${encodeURIComponent("../../../bizagent.config.json")}`)).status, 400);
    assert.equal((await fetch(`${hub}/file?path=${encodeURIComponent(".bizagent/deliverables/run-1/.session-id")}`)).status, 400);
    assert.equal((await fetch(`${hub}/file?path=${encodeURIComponent("knowledge/common/seed.md")}`)).status, 400);
  } finally {
    close();
  }
});

test("round-trip: local publishes through resolveRemote(${SLUG}) and a second local pulls", async () => {
  const platform = tmpRoot("biz-hub-plat-");
  const { base, close } = await serve(platform);

  // two "machines", same business, remote configured once with ${SLUG}
  const mkLocal = (prefix: string) => {
    const root = tmpRoot(prefix);
    const cfgPath = path.join(root, "bizagent.config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.remote = { type: "http", url: `${base}/api/businesses/\${SLUG}/hub` };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return root;
  };
  const localA = mkLocal("biz-hub-localA-");
  const localB = mkLocal("biz-hub-localB-");

  try {
    // machine A: a finished run + a distilled memory
    const runDir = path.join(farmDir(localA), ".bizagent", "deliverables", "run-aaa");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "worklog.md"), WORKLOG_BODY);
    writeMemory({ root: localA, slug: "farm", body: "GMV excludes cancelled orders.", scope: "business", now: NOW });

    const remoteA = await resolveRemote(localA, "farm");
    assert.ok(remoteA, "remote resolves from config");
    const pushed = await publishWorklogs({
      root: localA,
      slug: "farm",
      remote: remoteA,
      entries: [{ runId: "run-aaa", line: INDEX_LINE }],
    });
    assert.equal(pushed.published, 1);
    const mem = await publishMemories({ root: localA, slug: "farm", remote: remoteA });
    assert.equal(mem.published, 1);

    // ${SLUG} resolved: the files landed under the PLATFORM's farm business
    assert.ok(fs.existsSync(path.join(farmDir(platform), ".bizagent", "deliverables", "run-aaa", "worklog.md")));
    assert.equal(fs.readdirSync(path.join(farmDir(platform), "memory")).length, 1);

    // machine B: pulls A's work through the platform
    const remoteB = await resolveRemote(localB, "farm");
    assert.ok(remoteB);
    const idx = await pullRemoteIndex({ root: localB, slug: "farm", remote: remoteB });
    assert.equal(idx.merged, 1);
    assert.deepEqual(readWorklogIndex(localB, "farm").map((e) => e.runId), ["run-aaa"]);
    assert.equal(await remoteB.fetchWorklog("run-aaa"), WORKLOG_BODY);

    const pulled = await pullRemoteMemory({ root: localB, slug: "farm", remote: remoteB });
    assert.equal(pulled.merged, 1);
    const cache = path.join(farmDir(localB), ".bizagent", "remote-memory");
    assert.equal(fs.readdirSync(cache).length, 1);
  } finally {
    close();
  }
});
