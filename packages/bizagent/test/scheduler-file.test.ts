// The reference file SchedulerStore — insert / due / settle round-trips over a JSONL file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileScheduler, dueWakeups, type WakeupRow } from "../src/index";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "biz-sched-"));
  return path.join(dir, "wakeups.jsonl");
}

const payload = (p: Partial<Omit<WakeupRow, "id" | "status">>): Omit<WakeupRow, "id" | "status"> => ({
  business: "farm",
  claudeSessionId: "sess-1",
  wakeAt: 1000,
  wakePrompt: "continue",
  chainCount: 1,
  ...p,
});

test("insert returns an id; due reads back pending rows at/before now", async () => {
  const store = fileScheduler(tmpFile());
  const id = await store.insert(payload({ wakeAt: 500 }));
  assert.ok(id);
  const due = await store.due(1000);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, id);
  assert.equal(due[0].business, "farm");
  assert.equal(due[0].status, "pending");
});

test("due excludes future rows", async () => {
  const store = fileScheduler(tmpFile());
  await store.insert(payload({ wakeAt: 5000 }));
  assert.deepEqual(await store.due(1000), []);
});

test("settle flips a row's status so due no longer returns it", async () => {
  const store = fileScheduler(tmpFile());
  const id = await store.insert(payload({ wakeAt: 500 }));
  await store.settle(id, "fired");
  assert.deepEqual(await store.due(1000), []);
});

test("multiple rows persist independently; settle touches only the named id", async () => {
  const file = tmpFile();
  const store = fileScheduler(file);
  const a = await store.insert(payload({ wakeAt: 100, wakePrompt: "a" }));
  const b = await store.insert(payload({ wakeAt: 200, wakePrompt: "b" }));
  await store.settle(a, "fired");
  const due = await store.due(1000);
  assert.deepEqual(due.map((r) => r.id), [b]);
  // The whole brain wired together: store -> dueWakeups split.
  const { fire } = dueWakeups(due, 1000);
  assert.deepEqual(fire.map((r) => r.wakePrompt), ["b"]);
});
