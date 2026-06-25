// The scheduling brain is pure — clamp, chain guard, due-split. No store, no timer, no SDK.
// (SchedulerStore / Notifier are contracts the app implements; nothing to test here beyond the
// pure functions and the row algebra.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampDelay,
  chainExhausted,
  dueWakeups,
  WAKEUP_MIN_DELAY,
  WAKEUP_MAX_DELAY,
  WAKEUP_MAX_CHAIN,
  type WakeupRow,
} from "../src/index";

test("clampDelay holds the band; non-finite/negative fall to the minimum", () => {
  assert.equal(clampDelay(300), 300);
  assert.equal(clampDelay(10), WAKEUP_MIN_DELAY); // below floor
  assert.equal(clampDelay(99999), WAKEUP_MAX_DELAY); // above ceiling
  assert.equal(clampDelay(-5), WAKEUP_MIN_DELAY);
  assert.equal(clampDelay(NaN), WAKEUP_MIN_DELAY);
  assert.equal(clampDelay(120.9), 120); // floored
});

test("chainExhausted is true at/over the cap", () => {
  assert.equal(chainExhausted(0), false);
  assert.equal(chainExhausted(WAKEUP_MAX_CHAIN - 1), false);
  assert.equal(chainExhausted(WAKEUP_MAX_CHAIN), true);
  assert.equal(chainExhausted(WAKEUP_MAX_CHAIN + 1), true);
});

function row(p: Partial<WakeupRow>): WakeupRow {
  return {
    id: "r",
    claudeSessionId: "s",
    wakeAt: 0,
    wakePrompt: "go",
    chainCount: 0,
    status: "pending",
    ...p,
  };
}

test("dueWakeups fires due+in-budget rows, retires due+over-budget as exhausted", () => {
  const now = 1000;
  const rows = [
    row({ id: "due-ok", wakeAt: 500 }), // due, fresh chain -> fire
    row({ id: "future", wakeAt: 5000 }), // not due yet -> neither
    row({ id: "due-exhausted", wakeAt: 500, chainCount: WAKEUP_MAX_CHAIN }), // due but over cap -> exhausted
    row({ id: "already-fired", wakeAt: 500, status: "fired" }), // not pending -> neither
    row({ id: "exact", wakeAt: 1000 }), // now == wakeAt counts as due
  ];
  const { fire, exhausted } = dueWakeups(rows, now);
  assert.deepEqual(fire.map((r) => r.id).sort(), ["due-ok", "exact"]);
  assert.deepEqual(exhausted.map((r) => r.id), ["due-exhausted"]);
});

test("dueWakeups on an empty / all-future set fires nothing", () => {
  assert.deepEqual(dueWakeups([], 1000), { fire: [], exhausted: [] });
  assert.deepEqual(dueWakeups([row({ wakeAt: 9999 })], 1000), { fire: [], exhausted: [] });
});
