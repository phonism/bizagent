// The web platform's static + list routes are testable without the SDK (no session started).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initRoot, newBusiness, createWebServer, createBizHandler, makeSessionRegistry, webConfig, updateIndex, recordRunReq } from "../src/index";
import type { BizSession, SessionManager } from "../src/index";

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-web-"));
  initRoot({ root, web: { port: 5005 }, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  newBusiness({ root, line: "ops", slug: "shop", name: "Shop" });
  return root;
}

async function serve(root: string): Promise<{ base: string; close: () => void }> {
  const server = createWebServer({ root });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("webConfig reads port/host from the root config, with defaults", () => {
  const root = tmpRoot();
  assert.deepEqual(webConfig(root), { port: 5005, host: "127.0.0.1" });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "biz-web-bare-"));
  initRoot({ root: bare });
  assert.deepEqual(webConfig(bare), { port: 4317, host: "127.0.0.1" }); // defaults when no web block
});

test("GET / serves the chat UI", async () => {
  const { base, close } = await serve(tmpRoot());
  const r = await fetch(`${base}/`);
  const body = await r.text();
  close();
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(body, /<title>BizAgent<\/title>/);
});

test("GET /api/businesses lists the root's businesses (with their line)", async () => {
  const { base, close } = await serve(tmpRoot());
  const list = (await (await fetch(`${base}/api/businesses`)).json()) as { slug: string; line: string; name: string }[];
  close();
  const bySlug = Object.fromEntries(list.map((w) => [w.slug, w.name]));
  assert.deepEqual(bySlug, { farm: "Farm", shop: "Shop" });
  assert.ok(list.every((w) => w.line === "ops"));
});

test("lines API: list + create; business creation requires a line", async () => {
  const { base, close } = await serve(tmpRoot());
  const lines1 = (await (await fetch(`${base}/api/lines`)).json()) as { slug: string; name: string }[];
  assert.deepEqual(lines1, [{ slug: "ops", name: "ops" }]);
  const mk = await fetch(`${base}/api/lines`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ line: "growth" }),
  });
  assert.equal(mk.status, 200);
  const lines2 = (await (await fetch(`${base}/api/lines`)).json()) as { slug: string; name: string }[];
  assert.deepEqual(lines2.map((l) => l.slug).sort(), ["growth", "ops"]);
  // creating a business without a line -> 400
  const noLine = await fetch(`${base}/api/businesses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "lab" }),
  });
  close();
  assert.equal(noLine.status, 400);
});

test("POST /api/start rejects an unknown business", async () => {
  const { base, close } = await serve(tmpRoot());
  const r = await fetch(`${base}/api/start?business=nope`, { method: "POST" });
  close();
  assert.equal(r.status, 404);
});

// A client that mistook the manager `id` for the resumable session id (it's not a Claude session
// id) must converge on the live in-memory session — never spawn `claude --resume <manager id>`.
test("POST /api/start with a manager id as `resume` reattaches to the live session", async () => {
  const root = tmpRoot();
  const stubSession = (id: string): BizSession => ({
    id,
    business: "farm",
    runId: `run-${id}`,
    ready: new Promise<string>(() => {}), // never resolves — no Claude behind the stub
    send: () => {},
    interrupt: async () => {},
    inject: () => {},
    injectFrom: () => {},
    resolveJob: () => false,
    listJobs: () => [],
    subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    recentEvents: () => [],
    end: async () => {},
  });
  const calls: string[] = [];
  const live = stubSession("mgr-1");
  const manager: SessionManager = {
    start: () => {
      calls.push("start");
      return live;
    },
    resume: (o) => {
      calls.push(`resume:${o.claudeSessionId}`);
      return stubSession("mgr-2");
    },
    fork: () => {
      throw new Error("fork unused");
    },
    get: (id) => (id === "mgr-1" ? live : undefined),
    list: () => [live],
  };
  const handler = createBizHandler({ root, manager, registry: makeSessionRegistry() });

  // The live session's own id converges (no spawn, no Claude resume) …
  const r1 = await handler(new Request("http://t/api/start?business=farm&resume=mgr-1", { method: "POST" }));
  assert.equal(r1.status, 200);
  assert.equal(((await r1.json()) as { id: string }).id, "mgr-1");
  assert.deepEqual(calls, []);

  // … while an unknown id still goes through a real resume (the Claude session id path).
  const r2 = await handler(new Request("http://t/api/start?business=farm&resume=uuid-x", { method: "POST" }));
  assert.equal(((await r2.json()) as { id: string }).id, "mgr-2");
  assert.deepEqual(calls, ["resume:uuid-x"]);
});

test("POST /api/start hands the identify() result to the manager (start and resume)", async () => {
  const root = tmpRoot();
  const stub: BizSession = {
    id: "mgr-1",
    business: "farm",
    runId: "run-1",
    ready: new Promise<string>(() => {}),
    send: () => {},
    interrupt: async () => {},
    inject: () => {},
    injectFrom: () => {},
    resolveJob: () => false,
    listJobs: () => [],
    subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
    recentEvents: () => [],
    end: async () => {},
  };
  const seen: Array<unknown> = [];
  const manager: SessionManager = {
    start: (o) => {
      seen.push(o.identity);
      return stub;
    },
    resume: (o) => {
      seen.push(o.identity);
      return stub;
    },
    fork: () => {
      throw new Error("fork unused");
    },
    get: () => undefined,
    list: () => [],
  };
  const handler = createBizHandler({
    root,
    manager,
    registry: makeSessionRegistry(),
    identify: (req) => {
      const u = req.headers.get("x-test-user");
      return u ? { userId: u } : undefined;
    },
  });

  await handler(new Request("http://t/api/start?business=farm", { method: "POST", headers: { "x-test-user": "alice" } }));
  await handler(new Request("http://t/api/start?business=farm&resume=uuid-x", { method: "POST", headers: { "x-test-user": "bob" } }));
  // No header → identity undefined (the manager's resolveAuth still decides the fallback).
  await handler(new Request("http://t/api/start?business=farm", { method: "POST" }));
  assert.deepEqual(seen, [{ userId: "alice" }, { userId: "bob" }, undefined]);
});

// ── business read model + write routes (all SDK-free: no session is ever started) ──

function writeWorklog(root: string, slug: string, runId: string, description: string, body = "Did the thing."): void {
  const dir = path.join(root, "lines", "ops", "businesses", slug, ".bizagent", "deliverables", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worklog.md"), `---\ndescription: ${description}\n---\n# Worklog\n\n${body}\n`);
}

test("GET /api/health reports an root overview", async () => {
  const { base, close } = await serve(tmpRoot());
  const r = await fetch(`${base}/api/health`);
  const body = (await r.json()) as { ok: boolean; businesses: number; version: string };
  close();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.businesses, 2);
  assert.equal(typeof body.version, "string");
});

test("GET /api/businesses/:slug returns metadata; 404 for unknown", async () => {
  const { base, close } = await serve(tmpRoot());
  const meta = (await (await fetch(`${base}/api/businesses/farm`)).json()) as { name: string; line: string };
  const missing = await fetch(`${base}/api/businesses/nope`);
  close();
  assert.equal(meta.name, "Farm");
  assert.equal(meta.line, "ops");
  assert.equal(missing.status, 404);
});

test("module routes: create in a line, list, meta 404, patch, link to a business (same line only)", async () => {
  const { base, close } = await serve(tmpRoot());
  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // create (= biz module new) — line-scoped
  const mk = await post("/api/lines/ops/modules", { slug: "strategy", type: "strategy", source: "https://github.com/acme/strategy" });
  assert.equal(mk.status, 200);
  assert.equal((await post("/api/lines/ops/modules", { slug: "strategy", type: "strategy" })).status, 400); // duplicate

  // list + meta + unknown 404
  const list = (await (await fetch(`${base}/api/lines/ops/modules`)).json()) as { slug: string; source?: string }[];
  assert.deepEqual(list.map((m) => m.slug), ["strategy"]);
  assert.equal(list[0].source, "https://github.com/acme/strategy");
  assert.equal((await fetch(`${base}/api/lines/ops/modules/nope`)).status, 404);

  // patch the recorded facts (= biz module set)
  const patched = (await (
    await fetch(`${base}/api/lines/ops/modules/strategy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploy: "ci deploy strategy", slug: "evil" }),
    })
  ).json()) as { slug: string; deploy?: string };
  assert.equal(patched.deploy, "ci deploy strategy");
  assert.equal(patched.slug, "strategy"); // slug not patchable

  // link into a business (= biz link) + resolved listing
  assert.equal((await post("/api/businesses/farm/modules", { module: "strategy" })).status, 200);
  const linked = (await (await fetch(`${base}/api/businesses/farm/modules`)).json()) as { slug: string }[];
  assert.deepEqual(linked.map((m) => m.slug), ["strategy"]);

  // unlink it (= the DELETE route): drops from the business's list; the module itself survives
  assert.equal((await fetch(`${base}/api/businesses/farm/modules/strategy`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/businesses/farm/modules`)).json(), []);
  assert.equal((await (await fetch(`${base}/api/lines/ops/modules`)).json() as unknown[]).length, 1);

  // a module from ANOTHER line can't link (modules never cross lines)
  assert.equal((await post("/api/lines/growth/modules", { slug: "xline", type: "data" })).status, 200);
  const cross = await post("/api/businesses/farm/modules", { module: "xline" });
  close();
  assert.equal(cross.status, 400);
});

test("POST /api/businesses creates one; rejects bad slug and duplicates", async () => {
  const { base, close } = await serve(tmpRoot());
  const post = (slug: string, name?: string) =>
    fetch(`${base}/api/businesses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, line: "ops", name }),
    });
  const ok = await post("lab", "Lab");
  const bad = await post("Bad Slug");
  const dup = await post("farm");
  close();
  assert.equal(ok.status, 200);
  assert.equal(bad.status, 400);
  assert.equal(dup.status, 400);
});

test("PATCH /api/businesses/:slug merges the opaque ext bag; it round-trips through meta + the list", async () => {
  const { base, close } = await serve(tmpRoot());
  const patch = (body: unknown) =>
    fetch(`${base}/api/businesses/farm`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // first write nests under ext.gr
    const r1 = (await (await patch({ ext: { gr: { color: "#6f5eef", emoji: "🌾" } } })).json()) as { ext: { gr: Record<string, unknown> } };
    assert.equal(r1.ext.gr.color, "#6f5eef");

    // a second patch deep-merges ext one level: adds a key without clobbering the first app's bag
    await patch({ ext: { other: { pinned: true } } });
    const meta = (await (await fetch(`${base}/api/businesses/farm`)).json()) as { ext: Record<string, Record<string, unknown>>; name: string };
    assert.equal(meta.ext.gr.emoji, "🌾"); // survived
    assert.equal(meta.ext.other.pinned, true);
    assert.equal(meta.name, "Farm"); // native fields untouched

    // ext also rides the list projection so cards need no per-business round-trip
    const list = (await (await fetch(`${base}/api/businesses`)).json()) as { slug: string; ext?: { gr?: { color?: string } } }[];
    assert.equal(list.find((w) => w.slug === "farm")?.ext?.gr?.color, "#6f5eef");
  } finally {
    close();
  }
});

test("DELETE /api/businesses/:slug removes it; 404 for unknown", async () => {
  const { base, close } = await serve(tmpRoot());
  const before = (await (await fetch(`${base}/api/businesses`)).json()) as { slug: string }[];
  const del = await fetch(`${base}/api/businesses/shop`, { method: "DELETE" });
  const after = (await (await fetch(`${base}/api/businesses`)).json()) as { slug: string }[];
  const missing = await fetch(`${base}/api/businesses/nope`, { method: "DELETE" });
  close();
  assert.equal(del.status, 204);
  assert.ok(before.some((w) => w.slug === "shop"));
  assert.ok(!after.some((w) => w.slug === "shop"));
  assert.equal(missing.status, 404); // wsExists guard fires before the handler
});

test("memory: POST writes (governed), GET recalls; a non-business scope is rejected", async () => {
  const { base, close } = await serve(tmpRoot());
  const write = (payload: unknown) =>
    fetch(`${base}/api/businesses/farm/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const good = await write({ body: "Retention rose 5% after the push." });
  const bad = await write({ body: "Trying to write the common layer.", scope: "common" });
  const list = (await (await fetch(`${base}/api/businesses/farm/memory`)).json()) as { body: string }[];
  close();
  assert.equal(good.status, 200);
  assert.equal(bad.status, 422); // same governance the write hook enforces — web is not a backdoor
  assert.equal(list.length, 1);
  assert.match(list[0].body, /Retention rose/);
});

test("worklog: GET the index + one run's full text; 404 for an unknown run", async () => {
  const root = tmpRoot();
  writeWorklog(root, "farm", "20260102-100000-abc", "Investigated churn → found a leak.");
  updateIndex({ root, slug: "farm" });
  const { base, close } = await serve(root);
  const idx = (await (await fetch(`${base}/api/businesses/farm/worklog`)).json()) as {
    date: string;
    description: string;
    runId: string;
  }[];
  const full = await fetch(`${base}/api/businesses/farm/worklog/20260102-100000-abc`);
  const fullText = await full.text();
  const missing = await fetch(`${base}/api/businesses/farm/worklog/nope`);
  close();
  assert.equal(idx.length, 1);
  assert.equal(idx[0].runId, "20260102-100000-abc");
  assert.match(idx[0].description, /Investigated churn/);
  assert.equal(full.status, 200);
  assert.match(fullText, /# Worklog/);
  assert.equal(missing.status, 404);
});

test("GET /api/businesses/:slug/runs lists sessions with content + their claudeSessionId, skipping empty ones", async () => {
  const root = tmpRoot();
  writeWorklog(root, "farm", "20260105-090000-aaa", "First chat.");
  updateIndex({ root, slug: "farm" });
  // a run that had a real turn (transcript recorded on the first turn) + its persisted session id
  const runDir = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "20260106-090000-bbb");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, ".session-id"), "claude-sess-xyz");
  fs.writeFileSync(path.join(runDir, ".transcript-path"), "/tmp/whatever.jsonl");
  // an EMPTY session: SDK init wrote a session id but no turn ever ran — must NOT list
  const emptyDir = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "20260107-090000-ccc");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, ".session-id"), "claude-sess-empty");
  const { base, close } = await serve(root);
  const runs = (await (await fetch(`${base}/api/businesses/farm/runs`)).json()) as {
    runId: string;
    description: string;
    claudeSessionId?: string;
  }[];
  close();
  assert.equal(runs.some((r) => r.runId === "20260107-090000-ccc"), false); // empty session hidden
  // newest first among the runs that DO have content
  assert.equal(runs[0].runId, "20260106-090000-bbb");
  assert.equal(runs[0].claudeSessionId, "claude-sess-xyz");
  const withWorklog = runs.find((r) => r.runId === "20260105-090000-aaa");
  assert.match(withWorklog!.description, /First chat/);
});

test("DELETE /api/businesses/:slug/runs/:runId removes a run from the list and the worklog index", async () => {
  const root = tmpRoot();
  writeWorklog(root, "farm", "20260105-090000-aaa", "First chat.");
  writeWorklog(root, "farm", "20260106-090000-bbb", "Second chat.");
  updateIndex({ root, slug: "farm" });
  const { base, close } = await serve(root);
  try {
    const before = (await (await fetch(`${base}/api/businesses/farm/runs`)).json()) as { runId: string }[];
    assert.equal(before.length, 2);

    const del = await fetch(`${base}/api/businesses/farm/runs/20260106-090000-bbb`, { method: "DELETE" });
    assert.equal(del.status, 204);

    const after = (await (await fetch(`${base}/api/businesses/farm/runs`)).json()) as { runId: string }[];
    assert.deepEqual(after.map((r) => r.runId), ["20260105-090000-aaa"]);
    // the run dir is gone, and its line left the worklog index too
    assert.equal(fs.existsSync(path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "20260106-090000-bbb")), false);
    const index = (await (await fetch(`${base}/api/businesses/farm/worklog`)).json()) as { runId: string }[];
    assert.equal(index.some((e) => e.runId === "20260106-090000-bbb"), false);

    // deleting an unknown run is a 400, not a silent success
    const bad = await fetch(`${base}/api/businesses/farm/runs/nope`, { method: "DELETE" });
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
});

test("GET /api/businesses/:slug/requirements lists requirements with status", async () => {
  const root = tmpRoot();
  const reqDir = path.join(root, "lines", "ops", "businesses", "farm", "requirements", "checkout");
  fs.mkdirSync(reqDir, { recursive: true });
  fs.writeFileSync(path.join(reqDir, "requirement.md"), "---\nstatus: active\n---\n\n# checkout\n");
  const { base, close } = await serve(root);
  try {
    const list = (await (await fetch(`${base}/api/businesses/farm/requirements`)).json()) as { id: string; status: string; updatedAt?: string }[];
    assert.deepEqual(list.map(({ id, status }) => ({ id, status })), [{ id: "checkout", status: "active" }]);
    assert.ok(list[0].updatedAt); // doc mtime rides along
  } finally {
    close();
  }
});

test("POST creates a requirement (with a skeleton doc); GET :id reads it back; bad id is 400", async () => {
  const { base, close } = await serve(tmpRoot());
  const post = (id: string) =>
    fetch(`${base}/api/businesses/farm/requirements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  try {
    const ok = await post("push-roi");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: "push-roi", status: "active" });

    // it now lists, and its skeleton state doc reads back as markdown
    const list = (await (await fetch(`${base}/api/businesses/farm/requirements`)).json()) as { id: string }[];
    assert.ok(list.some((r) => r.id === "push-roi"));
    const doc = await (await fetch(`${base}/api/businesses/farm/requirements/push-roi`)).text();
    assert.match(doc, /push-roi/); // the skeleton names the requirement

    // an unknown requirement's doc is empty (not a 404 — the list is the existence check)
    assert.equal(await (await fetch(`${base}/api/businesses/farm/requirements/nope`)).text(), "");
    // a malformed id (becomes a dir + branch name) is rejected
    assert.equal((await post("Bad Id!")).status, 400);
  } finally {
    close();
  }
});

test("GET /api/businesses/:slug/runs/:runId/history replays the run's transcript", async () => {
  const root = tmpRoot();
  const runDir = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  const jsonl = path.join(root, "t.jsonl");
  fs.writeFileSync(
    jsonl,
    JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hello" }] } }) + "\n",
  );
  fs.writeFileSync(path.join(runDir, ".transcript-path"), jsonl);
  const { base, close } = await serve(root);
  try {
    const events = (await (await fetch(`${base}/api/businesses/farm/runs/r1/history`)).json()) as unknown[];
    assert.deepEqual(events, [{ type: "message", text: "hello", uuid: "a1" }]);
    // a run that never recorded a transcript replays as empty, not an error
    const empty = (await (await fetch(`${base}/api/businesses/farm/runs/nope/history`)).json()) as unknown[];
    assert.deepEqual(empty, []);
  } finally {
    close();
  }
});

test("GET /api/businesses/:slug/deliverables lists a run's files, minus hidden markers", async () => {
  const root = tmpRoot();
  writeWorklog(root, "farm", "20260103-110000-def", "Built a report.");
  const runDir = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "20260103-110000-def");
  fs.writeFileSync(path.join(runDir, "report.csv"), "a,b\n1,2\n");
  fs.writeFileSync(path.join(runDir, ".indexed"), "x\n"); // a hidden marker — must not show up
  const { base, close } = await serve(root);
  const files = (await (await fetch(`${base}/api/businesses/farm/deliverables/20260103-110000-def`)).json()) as string[];
  close();
  assert.ok(files.includes("report.csv"));
  assert.ok(files.includes("worklog.md"));
  assert.ok(!files.some((f) => f.startsWith(".")));
});

test("GET /api/businesses/:slug/context previews the injected system prompt", async () => {
  const { base, close } = await serve(tmpRoot());
  const r = await fetch(`${base}/api/businesses/farm/context`);
  const body = await r.text();
  close();
  assert.equal(r.status, 200);
  assert.match(body, /Farm/);
});

test("GET /api/sessions is empty before any session starts", async () => {
  const { base, close } = await serve(tmpRoot());
  const list = (await (await fetch(`${base}/api/sessions`)).json()) as unknown[];
  close();
  assert.deepEqual(list, []);
});

// Rename/delete for requirements and the run display title — the UI's 改名/删除 entry points.
test("PATCH/DELETE requirements and PATCH run title round-trip over HTTP", async () => {
  const root = tmpRoot();
  // These routes never touch a session — a manager that refuses everything is enough.
  const manager = { start() { throw new Error("unused"); }, resume() { throw new Error("unused"); }, fork() { throw new Error("unused"); }, get: () => undefined, list: () => [] } as unknown as SessionManager;
  const handler = createBizHandler({ root, manager, registry: makeSessionRegistry() });
  const call = (method: string, p: string, body?: unknown) =>
    handler(new Request(`http://t${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));

  await call("POST", "/api/businesses/farm/requirements", { id: "old-req" });
  // Link a run to it, with a transcript marker so listRuns shows it.
  recordRunReq({ root, slug: "farm", runId: "r1", req: "old-req" });
  fs.writeFileSync(path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "r1", ".transcript-path"), "/tmp/x.jsonl");

  // Rename: dir moves, the run follows.
  const rn = await call("PATCH", "/api/businesses/farm/requirements/old-req", { id: "new-req" });
  assert.equal(rn.status, 200);
  let runs = (await (await call("GET", "/api/businesses/farm/runs")).json()) as Array<{ runId: string; req?: string; description: string }>;
  assert.equal(runs.find((r) => r.runId === "r1")?.req, "new-req");
  // Collision -> 400.
  await call("POST", "/api/businesses/farm/requirements", { id: "taken" });
  assert.equal((await call("PATCH", "/api/businesses/farm/requirements/new-req", { id: "taken" })).status, 400);

  // Run title: set -> wins over the (absent) worklog summary; clear -> falls back.
  assert.equal((await call("PATCH", "/api/businesses/farm/runs/r1", { description: "我的标题" })).status, 200);
  runs = (await (await call("GET", "/api/businesses/farm/runs")).json()) as Array<{ runId: string; description: string }>;
  assert.equal(runs.find((r) => r.runId === "r1")?.description, "我的标题");
  assert.equal((await call("PATCH", "/api/businesses/farm/runs/ghost", { description: "x" })).status, 400);

  // Delete: requirement gone, the run survives req-less.
  assert.equal((await call("DELETE", "/api/businesses/farm/requirements/new-req")).status, 204);
  assert.equal((await call("DELETE", "/api/businesses/farm/requirements/new-req")).status, 400);
  runs = (await (await call("GET", "/api/businesses/farm/runs")).json()) as Array<{ runId: string; req?: string }>;
  assert.equal(runs.find((r) => r.runId === "r1")?.req, undefined);
});
