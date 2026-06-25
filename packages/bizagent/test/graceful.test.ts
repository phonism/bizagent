// The graceful-restart brain is pure where it counts — snapshot extraction, the recover filter,
// the busy count. (ActiveTurnStore is a contract; makeDrainController / recoverActiveTurns are host
// orchestration over the manager — nothing to unit-test here beyond the pure pieces.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  snapshotActiveTurns,
  recoverableTurns,
  busyCount,
  RECOVER_MAX_AGE_MS,
  RECOVER_MAX_SESSIONS,
  type ActiveTurn,
} from "../src/index";
import type { BizSession } from "../src/session";

// A minimal BizSession stand-in — only the fields the pure functions read.
function sess(p: Partial<BizSession>): BizSession {
  return { business: "farm", runId: "r1", busy: true, claudeSessionId: "c1", ...p } as BizSession;
}

test("snapshotActiveTurns keeps busy sessions with a claudeSessionId, drops the rest", () => {
  const now = 1000;
  const sessions = [
    sess({ business: "farm", claudeSessionId: "a", busy: true, runId: "ra" }),
    sess({ business: "shop", claudeSessionId: "b", busy: false }), // idle -> drop
    sess({ business: "mill", claudeSessionId: undefined, busy: true }), // no sdk id yet -> drop
    sess({ business: "barn", claudeSessionId: "d", busy: true, req: "q7" }),
  ];
  const turns = snapshotActiveTurns(sessions, now);
  assert.deepEqual(turns.map((t) => t.claudeSessionId), ["a", "d"]);
  assert.equal(turns[0].runId, "ra");
  assert.equal(turns[0].at, now);
  assert.equal(turns[1].req, "q7");
});

test("recoverableTurns drops turns older than the stale window", () => {
  const now = RECOVER_MAX_AGE_MS + 1000;
  const fresh: ActiveTurn = { business: "f", claudeSessionId: "fresh", at: now - 1000 };
  const stale: ActiveTurn = { business: "f", claudeSessionId: "stale", at: now - RECOVER_MAX_AGE_MS - 1 };
  const { recover, dropped } = recoverableTurns([fresh, stale], now);
  assert.deepEqual(recover.map((t) => t.claudeSessionId), ["fresh"]);
  assert.equal(dropped, 1);
});

test("recoverableTurns caps at the max, counting the overflow as dropped", () => {
  const now = 1000;
  const many: ActiveTurn[] = Array.from({ length: RECOVER_MAX_SESSIONS + 3 }, (_, i) => ({
    business: "f",
    claudeSessionId: `t${i}`,
    at: now,
  }));
  const { recover, dropped } = recoverableTurns(many, now);
  assert.equal(recover.length, RECOVER_MAX_SESSIONS);
  assert.equal(dropped, 3);
});

test("busyCount counts only busy sessions", () => {
  assert.equal(busyCount([sess({ busy: true }), sess({ busy: false }), sess({ busy: true })]), 2);
});
