// Hook decisions are runtime-neutral core functions — tested directly here, no CLI/JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRoot, newBusiness, guardHook, injectHook, stopHook } from "../src/index";

function tmpWs(): { root: string; ws: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-hooks-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm" });
  return { root, ws: path.join(root, "lines", "ops", "businesses", "farm") };
}

test("guardHook denies a malformed memory write, allows valid / non-memory", () => {
  const { ws } = tmpWs();
  // missing scope -> deny
  const bad = guardHook({ cwd: ws, toolName: "Write", filePath: "memory/x.md", content: "---\nconfidence: 0.5\n---\n\nb" });
  assert.ok(bad && /scope/.test(bad.deny));
  // valid -> allow (null); description is part of the schema (it is the record's index line)
  assert.equal(
    guardHook({ cwd: ws, toolName: "Write", filePath: "memory/x.md", content: "---\nscope: business\ndescription: b summary\n---\n\nb" }),
    null,
  );
  // missing description -> deny (the index injects only the description line)
  const noDesc = guardHook({ cwd: ws, toolName: "Write", filePath: "memory/x.md", content: "---\nscope: business\n---\n\nb" });
  assert.ok(noDesc && /description/.test(noDesc.deny));
  // plain code -> allow
  assert.equal(guardHook({ cwd: ws, toolName: "Write", filePath: "code/a.ts", content: "x" }), null);
  // non-write tool -> allow
  assert.equal(guardHook({ cwd: ws, toolName: "Bash" }), null);
});

test("guardHook validates the post-edit content for memory records", () => {
  const { ws } = tmpWs();
  const file = path.join(ws, "memory", "x.md");
  fs.writeFileSync(file, "---\nscope: business\ndescription: x summary\n---\n\nbody\n");

  assert.equal(
    guardHook({ cwd: ws, toolName: "Edit", filePath: "memory/x.md", oldString: "body", newString: "updated body" }),
    null,
  );
  const bad = guardHook({ cwd: ws, toolName: "Edit", filePath: "memory/x.md", oldString: "scope: business", newString: "scope: common" });
  assert.ok(bad && /scope: business/.test(bad.deny));
  const unknownEdit = guardHook({ cwd: ws, toolName: "Edit", filePath: "memory/x.md", oldString: "not present", newString: "x" });
  assert.ok(unknownEdit && /full post-write content/.test(unknownEdit.deny));
});

test("stopHook blocks when worklog missing, then indexes once written", async () => {
  const { ws } = tmpWs();
  const runId = "20260604-120000-aaaa1111";
  fs.mkdirSync(path.join(ws, ".bizagent", "deliverables", runId), { recursive: true });

  // missing -> block
  const blocked = await stopHook({ cwd: ws, runId, stopActive: false });
  assert.ok("block" in blocked && /worklog/.test(blocked.block));

  // still missing but stopActive -> don't block (loop guard) -> indexed:0
  assert.deepEqual(await stopHook({ cwd: ws, runId, stopActive: true }), { indexed: 0 });

  // write it -> not blocked, indexed:1
  fs.writeFileSync(path.join(ws, ".bizagent", "deliverables", runId, "worklog.md"), "---\ndescription: did x\n---\n");
  assert.deepEqual(await stopHook({ cwd: ws, runId, stopActive: false }), { indexed: 1 });
});

test("injectHook returns other sessions' fresh lines once, then null", async () => {
  const { root, ws } = tmpWs();
  const runId = "20260604-130000-self0001";
  fs.mkdirSync(path.join(ws, ".bizagent", "deliverables", runId), { recursive: true });
  fs.writeFileSync(path.join(ws, ".bizagent", "worklog-index.md"), "- 2026-05-30 · session A · 20260530-1-aaaa\n");

  const first = await injectHook({ cwd: ws, runId });
  assert.ok(first && /session A/.test(first.context));
  // nothing new -> null
  assert.equal(await injectHook({ cwd: ws, runId }), null);
  // no runId -> null
  assert.equal(await injectHook({ cwd: ws }), null);
  void root;
});

test("injectHook records the transcript path for the run", async () => {
  const { ws } = tmpWs();
  await injectHook({ cwd: ws, runId: "run-1", remote: null, transcriptPath: "/tmp/x.jsonl" });
  assert.equal(fs.readFileSync(path.join(ws, ".bizagent", "deliverables", "run-1", ".transcript-path"), "utf8").trim(), "/tmp/x.jsonl");
  // a non-string transcript_path is ignored, never an error
  await injectHook({ cwd: ws, runId: "run-2", remote: null, transcriptPath: 42 });
  assert.equal(fs.existsSync(path.join(ws, ".bizagent", "deliverables", "run-2", ".transcript-path")), false);
});
