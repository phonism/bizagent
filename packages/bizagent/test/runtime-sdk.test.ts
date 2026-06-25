// The SDK adapter's wiring is testable without the SDK installed or any model call:
// buildSdkOptions is pure, and its hook callbacks call the same core decisions as the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRoot, newBusiness, writeMemory, buildSdkOptions } from "../src/index";

function tmpWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-sdk-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm" });
  return { root, ws: path.join(root, "lines", "ops", "businesses", "farm") };
}

const runId = "20260604-120000-aaaa1111";
const preToolUse = (o: ReturnType<typeof buildSdkOptions>) => o.hooks.PreToolUse[0].hooks[0];
const userPromptSubmit = (o: ReturnType<typeof buildSdkOptions>) => o.hooks.UserPromptSubmit[0].hooks[0];
const stop = (o: ReturnType<typeof buildSdkOptions>) => o.hooks.Stop[0].hooks[0];

test("buildSdkOptions injects the launch context as claude_code appendSystemPrompt", () => {
  const { root, ws } = tmpWs();
  writeMemory({ root, slug: "farm", body: "GMV excludes cancelled orders" });
  const o = buildSdkOptions({ root, slug: "farm", runId });
  assert.equal(o.cwd, ws);
  assert.equal(o.systemPrompt.preset, "claude_code");
  assert.match(o.systemPrompt.append, /# Business memory/);
  assert.match(o.systemPrompt.append, /GMV excludes cancelled orders/);
});

test("PreToolUse callback denies a malformed memory write (SDK shape)", async () => {
  const { root } = tmpWs();
  const o = buildSdkOptions({ root, slug: "farm", runId });
  const denied = await preToolUse(o)({ tool_name: "Write", tool_input: { file_path: "memory/x.md", content: "---\nconfidence: 0.5\n---\n\nb" } });
  assert.equal((denied as any).hookSpecificOutput.permissionDecision, "deny");
  const ok = await preToolUse(o)({ tool_name: "Write", tool_input: { file_path: "code/a.ts", content: "x" } });
  assert.deepEqual(ok, {});
});

test("Stop callback blocks without a worklog, then passes once written", async () => {
  const { root, ws } = tmpWs();
  fs.mkdirSync(path.join(ws, ".bizagent", "deliverables", runId), { recursive: true });
  const o = buildSdkOptions({ root, slug: "farm", runId });
  const blocked = await stop(o)({ stop_hook_active: false });
  assert.equal((blocked as any).decision, "block");
  fs.writeFileSync(path.join(ws, ".bizagent", "deliverables", runId, "worklog.md"), "---\ndescription: did x\n---\n");
  assert.deepEqual(await stop(o)({ stop_hook_active: false }), {});
});

test("UserPromptSubmit callback injects other sessions' fresh work via additionalContext", async () => {
  const { root, ws } = tmpWs();
  fs.mkdirSync(path.join(ws, ".bizagent", "deliverables", runId), { recursive: true });
  fs.writeFileSync(path.join(ws, ".bizagent", "worklog-index.md"), "- 2026-05-30 · session A · 20260530-1-aaaa\n");
  const o = buildSdkOptions({ root, slug: "farm", runId });
  const injected = await userPromptSubmit(o)({});
  assert.match((injected as any).hookSpecificOutput.additionalContext, /session A/);
  assert.deepEqual(await userPromptSubmit(o)({}), {}); // nothing new the second time
});
