// Automated tests — Node's built-in runner (zero extra deps).
//   run:  npm test     (= node --import tsx --test test/*.test.ts)
// Each test scaffolds an isolated root under os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initRoot,
  newLine,
  newBusiness,
  writeMemory,
  recall,
  buildSystemPrompt,
  validateMemoryWrite,
  worklogWritten,
  updateIndex,
  freshIndexSince,
  promote,
  extractConclusions,
  findBusiness,
  listLineSlugs,
  businessLine,
} from "../src/index";

const FIXED = () => "2026-01-01T00:00:00.000Z";

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-test-"));
  initRoot({ root, now: FIXED });
  return root;
}

// ─────────────────────────── init / new ───────────────────────────

test("init scaffolds the root", () => {
  const root = tmpRoot();
  assert.ok(fs.existsSync(path.join(root, "bizagent.config.json")));
  assert.ok(fs.existsSync(path.join(root, "knowledge", "common")));
  assert.ok(fs.existsSync(path.join(root, "lines")));
  assert.ok(!fs.existsSync(path.join(root, "fence.md"))); // block protocol is injected, not a file
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "bizagent.config.json"), "utf8"));
  assert.equal(cfg.store, "filesystem");
});

test("init twice throws", () => {
  const root = tmpRoot();
  assert.throws(() => initRoot({ root }), /already a bizagent root/);
});

test("lines are real directories: explicit create, idempotent, listed; business requires one", () => {
  const root = tmpRoot();
  const r = newLine({ root, line: "growth" });
  assert.equal(r.created, true);
  for (const sub of ["knowledge", "modules", "businesses"]) {
    assert.ok(fs.existsSync(path.join(root, "lines", "growth", sub)), `missing lines/growth/${sub}`);
  }
  assert.equal(newLine({ root, line: "growth" }).created, false); // idempotent
  assert.throws(() => newLine({ root, line: "../../bad" }), /invalid line/);

  // a business cannot exist outside a line
  assert.throws(() => newBusiness({ root, slug: "x" } as never), /must belong to a product line/);

  newBusiness({ root, line: "growth", slug: "redpack" });
  newBusiness({ root, line: "ops", slug: "farm" }); // line lazily created
  assert.deepEqual(listLineSlugs(root).sort(), ["growth", "ops"]);
  assert.equal(businessLine(root, "redpack"), "growth");
  assert.equal(businessLine(root, "farm"), "ops");
  // slugs are globally unique across lines
  assert.throws(() => newBusiness({ root, line: "growth", slug: "farm" }), /already exists/);
});

test("new creates dirs, symlinks, lazily creates the line layer", () => {
  const root = tmpRoot();
  const r = newBusiness({ root, line: "ops", slug: "farm", now: FIXED });
  assert.equal(r.lineCreatedLazily, true);
  const ws = path.join(root, "lines", "ops", "businesses", "farm");
  for (const p of ["memory", ".bizagent/deliverables", ".claude", "knowledge/business", "business.json", "CLAUDE.md", ".claude/settings.json"]) {
    assert.ok(fs.existsSync(path.join(ws, p)), `missing ${p}`);
  }
  // symlinks resolve to the root shared layers
  assert.equal(fs.realpathSync(path.join(ws, "knowledge", "common")), fs.realpathSync(path.join(root, "knowledge", "common")));
  assert.equal(fs.realpathSync(path.join(ws, "knowledge", "ops")), fs.realpathSync(path.join(root, "lines", "ops", "knowledge")));
  // no physical fence.md (block protocol is injected) and no .mcp.json in v0
  assert.ok(!fs.existsSync(path.join(ws, "fence.md")));
  assert.ok(!fs.existsSync(path.join(ws, ".mcp.json")));
});

test("second business on same line reuses the line layer (not lazily created again)", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const r2 = newBusiness({ root, line: "ops", slug: "redpack" });
  assert.equal(r2.lineCreatedLazily, false);
});

test("new rejects duplicate slug, invalid slug, and missing root", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  assert.throws(() => newBusiness({ root, line: "ops", slug: "farm" }), /already exists/);
  assert.throws(() => newBusiness({ root, line: "ops", slug: "Bad_Slug" }), /invalid slug/);
  assert.throws(() => newBusiness({ root, slug: "redpack", line: "../../outside" }), /invalid line/);
  const notOrg = fs.mkdtempSync(path.join(os.tmpdir(), "biz-noorg-"));
  assert.throws(() => newBusiness({ root: notOrg, line: "ops", slug: "x" }), /not a bizagent root/);
});

test("findBusiness walks up to the enclosing business", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const sub = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "sess-1");
  fs.mkdirSync(sub, { recursive: true });
  const found = findBusiness(sub);
  assert.equal(found?.slug, "farm");
  assert.equal(fs.realpathSync(found!.root), fs.realpathSync(root));
});

// ─────────────────────────── memory write / recall / assemble ───────────────────────────

test("writeMemory + recall filters by scope and query", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  writeMemory({ root, slug: "farm", body: "GMV excludes cancelled orders", confidence: 0.9 });
  writeMemory({ root, slug: "farm", body: "Push CTR uses deduped users" });

  assert.equal(recall({ root, slug: "farm" }).length, 2);
  assert.equal(recall({ root, slug: "farm", query: "gmv" }).length, 1);
  assert.equal(recall({ root, slug: "farm", scope: "common" }).length, 0);
  assert.equal(recall({ root, slug: "farm", query: "push" })[0].body.trim(), "Push CTR uses deduped users");
});

test("writeMemory rejects invalid or missing businesses", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  assert.throws(() => writeMemory({ root, slug: "../../outside", body: "bad" }), /invalid business slug/);
  assert.throws(() => writeMemory({ root, slug: "missing", body: "bad" }), /no such workspace/);
});

test("CLAUDE.md is minimal and holds no business memory (it's editable; important info is injected)", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  writeMemory({ root, slug: "farm", body: "GMV excludes cancelled orders" });
  const md = fs.readFileSync(path.join(root, "lines", "ops", "businesses", "farm", "CLAUDE.md"), "utf8");
  assert.match(md, /managed by \*\*bizagent\*\*/);
  assert.match(md, /injected at launch/);
  assert.ok(!md.includes("GMV excludes cancelled orders")); // business memory is NOT here
});

test("buildSystemPrompt carries the important context (memory, blocks, past sessions, worklog)", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  writeMemory({ root, slug: "farm", body: "GMV excludes cancelled orders", confidence: 0.9 });
  const sp = buildSystemPrompt({ root, slug: "farm", runId: "20260101-090000" });
  // Memory is injected as an INDEX: the record's file path + its description line, body on disk.
  assert.match(sp, /# Business memory \(index\)/);
  assert.match(sp, /`memory\/[^`]+\.md` — GMV excludes cancelled orders/);
  assert.match(sp, /Fence 规约/); // block protocol inlined from prompts/fence.md, not a file
  assert.match(sp, /# Past sessions/);
  assert.match(sp, /\.bizagent\/deliverables\/20260101-090000\/worklog\.md/); // worklog spliced in
  assert.ok(!sp.includes("${")); // no leftover placeholders
});

// ─────────────────────────── governance (guard) ───────────────────────────

test("validateMemoryWrite governs memory writes", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const ws = path.join(root, "lines", "ops", "businesses", "farm");

  // valid business memory (scope + description + body — description is the record's index line)
  assert.equal(
    validateMemoryWrite({ root, filePath: path.join(ws, "memory", "x.md"), content: "---\nscope: business\ndescription: d\n---\n\nbody" }).ok,
    true,
  );
  // missing description -> blocked (without it the record is invisible in the injected index)
  const noDesc = validateMemoryWrite({ root, filePath: path.join(ws, "memory", "x.md"), content: "---\nscope: business\n---\n\nbody" });
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.reason!, /description/);
  // missing scope -> blocked
  const noScope = validateMemoryWrite({ root, filePath: path.join(ws, "memory", "x.md"), content: "---\nconfidence: 0.5\n---\n\nbody" });
  assert.equal(noScope.ok, false);
  assert.match(noScope.reason!, /scope/);
  // empty body -> blocked
  assert.equal(validateMemoryWrite({ root, filePath: path.join(ws, "memory", "x.md"), content: "---\nscope: business\n---\n" }).ok, false);
  // curator layer through the business symlink -> blocked (symlink resolved)
  const curator = validateMemoryWrite({ root, filePath: path.join(ws, "knowledge", "common", "x.md"), content: "hi" });
  assert.equal(curator.ok, false);
  assert.match(curator.reason!, /curator-only/);
  // knowledge/business doc -> allowed (no schema requirement)
  assert.equal(validateMemoryWrite({ root, filePath: path.join(ws, "knowledge", "business", "doc.md"), content: "free text" }).ok, true);
  // plain code -> not governed
  assert.equal(validateMemoryWrite({ root, filePath: path.join(ws, "code", "foo.ts"), content: "export const x=1" }).ok, true);
  // Memory edits need full post-write content so schema cannot be bypassed.
  assert.equal(validateMemoryWrite({ root, filePath: path.join(ws, "memory", "x.md") }).ok, false);
});

// ─────────────────────────── worklog enforcement (Stop) ───────────────────────────

test("worklogWritten is false until a non-empty worklog exists", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const runId = "20260604-150000-abcd1234";
  const sd = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", runId);
  fs.mkdirSync(sd, { recursive: true });
  assert.equal(worklogWritten({ root, slug: "farm", runId }), false);
  fs.writeFileSync(path.join(sd, "worklog.md"), "   \n"); // whitespace only -> still not written
  assert.equal(worklogWritten({ root, slug: "farm", runId }), false);
  fs.writeFileSync(path.join(sd, "worklog.md"), "---\ndescription: did x\n---\n");
  assert.equal(worklogWritten({ root, slug: "farm", runId }), true);
});

// ─────────────────────────── worklog index (Stop) ───────────────────────────

test("updateIndex lifts the worklog summary into the shared index, idempotently", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const sd = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "20260530-101500-abcd1234");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "worklog.md"), "---\ndescription: checked大促 GMV drop → presale deposit accounting\n---\n# Worklog\n- did stuff\n");

  const r1 = updateIndex({ root, slug: "farm" });
  assert.equal(r1.added.length, 1);

  const idx = fs.readFileSync(path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "worklog-index.md"), "utf8");
  assert.match(idx, /2026-05-30 · checked大促 GMV drop → presale deposit accounting · 20260530-101500-abcd1234/);

  // idempotent: a second run adds nothing
  const r2 = updateIndex({ root, slug: "farm" });
  assert.equal(r2.added.length, 0);
  assert.equal(fs.readFileSync(path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "worklog-index.md"), "utf8").trim().split("\n").length, 1);

  // and that index shows up in the next session's system prompt
  const sp = buildSystemPrompt({ root, slug: "farm", runId: "20260601-090000" });
  assert.match(sp, /presale deposit accounting/);
});

test("updateIndex skips an already-claimed session (no duplicate under concurrency)", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const base = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables");
  for (const id of ["20260530-100000-aaaa1111", "20260530-110000-bbbb2222"]) {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    fs.writeFileSync(path.join(base, id, "worklog.md"), `---\ndescription: did ${id}\n---\n`);
  }
  // pre-claim the first session (as if a concurrent hook already indexed it)
  fs.writeFileSync(path.join(base, "20260530-100000-aaaa1111", ".indexed"), "claimed\n");

  const r = updateIndex({ root, slug: "farm" });
  assert.equal(r.added.length, 1); // only the unclaimed one
  assert.equal(r.added[0].runId, "20260530-110000-bbbb2222");
  const idx = fs.readFileSync(path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "worklog-index.md"), "utf8");
  assert.ok(!idx.includes("aaaa1111")); // the pre-claimed one was not re-indexed
  assert.equal(idx.trim().split("\n").length, 1);
});

// ─────────────────────────── per-turn injection (UserPromptSubmit) ───────────────────────────

test("freshIndexSince returns the delta once, skips own line, advances the cursor", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const runId = "20260604-160000-self0001";
  fs.mkdirSync(path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", runId), { recursive: true });
  const idx = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "worklog-index.md");

  fs.writeFileSync(idx, "- 2026-05-30 · session A · 20260530-100000-aaaa1111\n");
  assert.deepEqual(freshIndexSince({ root, slug: "farm", runId }), [
    "- 2026-05-30 · session A · 20260530-100000-aaaa1111",
  ]);
  // nothing changed -> nothing fresh
  assert.deepEqual(freshIndexSince({ root, slug: "farm", runId }), []);
  // a new line from another session -> only that is fresh
  fs.appendFileSync(idx, "- 2026-05-31 · session B · 20260531-100000-bbbb2222\n");
  const fresh = freshIndexSince({ root, slug: "farm", runId });
  assert.equal(fresh.length, 1);
  assert.match(fresh[0], /session B/);
  // this session's own line is never injected back to it
  fs.appendFileSync(idx, `- 2026-06-01 · my own work · ${runId}\n`);
  assert.deepEqual(freshIndexSince({ root, slug: "farm", runId }), []);
});

// ─────────────────────────── distillation (promote) ───────────────────────────

test("extractConclusions parses bullets under the Conclusions section only", () => {
  const md = [
    "## Steps",
    "- did a thing",
    "## Conclusions",
    "- finding A",
    "- finding B",
    "## Notes",
    "- not a conclusion",
  ].join("\n");
  const cs = extractConclusions(md);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0], { body: "finding A" });
  assert.deepEqual(cs[1], { body: "finding B" });
});

test("extractConclusions matches Chinese heading 结论", () => {
  const cs = extractConclusions("## 结论\n- 一条结论");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].body, "一条结论");
});

test("promote distills worklog conclusions and is idempotent", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const sd = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "sess-9001");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "worklog.md"), "## Conclusions\n- promo GMV excludes deposits\n- another finding\n");

  const r1 = promote({ root, slug: "farm" });
  assert.equal(r1.promoted.length, 2);
  assert.equal(r1.worklogs.length, 1);

  const recs = recall({ root, slug: "farm" });
  const promo = recs.find((x) => x.body.includes("promo GMV"));
  assert.ok(promo);
  assert.equal(promo!.source_session, "sess-9001");
  assert.equal(promo!.confidence, 0.5);
  assert.ok(fs.existsSync(path.join(sd, ".promoted")));

  // second run: nothing new (idempotent)
  const r2 = promote({ root, slug: "farm" });
  assert.equal(r2.promoted.length, 0);
  assert.equal(recall({ root, slug: "farm" }).length, 2);
});

test("promote targets a single session when sessionId is given", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  for (const sid of ["a", "b"]) {
    const sd = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", sid);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "worklog.md"), `## Conclusions\n- finding from ${sid}\n`);
  }
  const r = promote({ root, slug: "farm", sessionId: "a" });
  assert.equal(r.promoted.length, 1);
  assert.equal(r.promoted[0].source_session, "a");
});
