// The transcript reader projects Claude Code's session JSONL into SessionEvents (reusing
// mapMessage), so a browser viewer can mirror a `biz run` (TUI) session and render its fences.
// Tested with fixture lines shaped like the real transcript — no SDK, no claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptToEvents, readTranscriptEvents, runHistory } from "../src/index";

test("assistant text (with a chart fence) projects to a message event", () => {
  const e = transcriptToEvents({
    type: "assistant",
    uuid: "a1",
    message: { role: "assistant", content: [{ type: "text", text: "see the chart\n```chart\n{}\n```" }] },
  });
  assert.equal(e.length, 1);
  assert.ok(e[0].type === "message" && /```chart/.test(e[0].text));
});

test("assistant thinking projects to a thinking delta, ahead of the text it precedes", () => {
  const e = transcriptToEvents({
    type: "assistant",
    uuid: "a3",
    message: { content: [{ type: "thinking", thinking: "weighing options" }, { type: "text", text: "answer" }] },
  });
  assert.deepEqual(e[0], { type: "delta", text: "weighing options", thinking: true, uuid: "a3" });
  assert.ok(e[1].type === "message" && e[1].text === "answer");
  // An empty thinking block adds nothing.
  assert.deepEqual(transcriptToEvents({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }), []);
});

test("assistant tool_use projects to a tool start", () => {
  assert.deepEqual(
    transcriptToEvents({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", name: "Write" }] } }),
    [{ type: "tool", name: "Write", phase: "start", uuid: "a2" }],
  );
});

test("user string prompt projects to a user-role message; injected meta is skipped", () => {
  assert.deepEqual(
    transcriptToEvents({ type: "user", uuid: "u1", message: { role: "user", content: "analyze retention" } }),
    [{ type: "message", text: "analyze retention", role: "user", uuid: "u1" }],
  );
  assert.deepEqual(transcriptToEvents({ type: "user", isMeta: true, message: { content: "<injected>" } }), []);
});

test("a Stop-hook feedback line projects to a hook event; other meta stays skipped", () => {
  // The real line shape: isMeta user turn whose content is Claude Code's fixed template + our
  // reminder. It replays as a `hook` event so the agent's continuation has visible cause.
  assert.deepEqual(
    transcriptToEvents({
      type: "user",
      isMeta: true,
      uuid: "h1",
      timestamp: "2026-06-10T12:00:00Z",
      message: { role: "user", content: "Stop hook feedback:\nYou haven't written this session's worklog. Create it.\n" },
    }),
    [{ type: "hook", hook: "stop", text: "You haven't written this session's worklog. Create it.", uuid: "h1", at: "2026-06-10T12:00:00Z" }],
  );
  // A template-shifted (or empty-bodied) feedback line degrades to skipped, like any other meta.
  assert.deepEqual(transcriptToEvents({ type: "user", isMeta: true, message: { content: "Stop hook feedback:" } }), []);
});

test("user tool_result projects to a tool end", () => {
  assert.deepEqual(
    transcriptToEvents({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } }),
    [{ type: "tool", phase: "end", uuid: "u2", id: "t" }],
  );
});

test("sidechain turns and noise line types are skipped", () => {
  assert.deepEqual(
    transcriptToEvents({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } }),
    [],
  );
  assert.deepEqual(transcriptToEvents({ type: "mode" }), []);
  assert.deepEqual(transcriptToEvents({ type: "file-history-snapshot" }), []);
  assert.deepEqual(transcriptToEvents("not even an object"), []);
});

test("runHistory replays a run's transcript; missing pointer or file degrade to empty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-hist-"));
  const runDir = path.join(root, "lines", "ops", "businesses", "farm", ".bizagent", "deliverables", "r1");
  fs.mkdirSync(runDir, { recursive: true });
  const jsonl = path.join(root, "t.jsonl");
  fs.writeFileSync(
    jsonl,
    [
      JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hello" }] },
      }),
    ].join("\n"),
  );
  fs.writeFileSync(path.join(runDir, ".transcript-path"), jsonl);

  assert.deepEqual(
    runHistory(root, "farm", "r1").map((e) => e.type),
    ["message", "delta", "message"], // user prompt, replayed thinking, assistant text
  );
  assert.deepEqual(runHistory(root, "farm", "never-recorded"), []);
  fs.writeFileSync(path.join(runDir, ".transcript-path"), path.join(root, "gone.jsonl"));
  assert.deepEqual(runHistory(root, "farm", "r1"), []);
});

test("readTranscriptEvents parses a multi-line transcript, skipping blank/bad lines", () => {
  const text = [
    JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
    "not json",
    "",
    JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hello" }] } }),
  ].join("\n");
  assert.deepEqual(
    readTranscriptEvents(text).map((e) => e.type),
    ["message", "message"],
  );
});
