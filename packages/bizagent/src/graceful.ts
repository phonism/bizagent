// The graceful-restart BRAIN — pure logic + a storage contract, no timer and no IO of its own.
// The sibling of schedule.ts: a long-lived agent host must survive a restart without dropping
// turns that were mid-flight. Both halves are built on the `busy` seam (BizSession.busy):
//
//   - DRAIN (planned restart): stop starting new turns, then wait until none is busy, so the
//     process dies idle and nothing is lost. bizagent only counts what's busy and runs the wait;
//     refusing new turns (e.g. HTTP 503) is the host's routing concern — it owns its surface.
//   - SNAPSHOT + RECOVER (the unplanned case — crash, drain timeout): periodically record which
//     sessions are mid-turn, and on the next boot resume them and nudge the agent to pick its work
//     back up from the worklog. bizagent computes the snapshot rows and the recover filter; the
//     APP owns the store (a file via `fileActiveTurnStore`, or its own DB), the snapshot timer, and
//     when to call recover. The reference host that ticks/persists is `biz web`; a platform swaps in
//     its own store + loop. See [[bizagent-harness-boundary]].

import type { BizSession, SessionManager, SessionRegistry } from "./session";

/** A session that was mid-turn — the minimum needed to resume it on the next boot. */
export interface ActiveTurn {
  business: string;
  /** Which Claude Code session to resume. */
  claudeSessionId: string;
  /** The run to converge on (keeps one deliverables dir / worklog); the manager re-derives it from
   *  the session id when absent, but passing it is cheaper and exact. */
  runId?: string;
  /** The requirement the session ran under, re-linked on resume. */
  req?: string;
  /** Epoch ms the snapshot was taken — recovery skips turns interrupted too long ago. */
  at: number;
}

// Defaults a host can override — the stale window and the anti-storm cap on one boot's resumes.
export const RECOVER_MAX_AGE_MS = 60 * 60 * 1000; // 1h: an hour-old interrupted turn is stale news.
export const RECOVER_MAX_SESSIONS = 10;

/** The mid-turn set worth snapshotting: busy AND far enough along to have an SDK session id (a turn
 *  that never reached init has nothing to resume). Pure — the host persists the result on whatever
 *  cadence it likes. */
export function snapshotActiveTurns(sessions: BizSession[], now: number): ActiveTurn[] {
  const turns: ActiveTurn[] = [];
  for (const s of sessions) {
    if (!s.busy || !s.claudeSessionId) continue;
    turns.push({
      business: s.business,
      claudeSessionId: s.claudeSessionId,
      ...(s.runId ? { runId: s.runId } : {}),
      ...(s.req ? { req: s.req } : {}),
      at: now,
    });
  }
  return turns;
}

/** Split a loaded snapshot into the turns to resume now and a dropped count (for the host to log).
 *  Drops turns older than `maxAgeMs` (stale — better left for the user) and caps the total (a
 *  restart storm must not spawn a hundred resumes at once). Pure. */
export function recoverableTurns(
  turns: ActiveTurn[],
  now: number,
  opts?: { maxAgeMs?: number; max?: number },
): { recover: ActiveTurn[]; dropped: number } {
  const maxAgeMs = opts?.maxAgeMs ?? RECOVER_MAX_AGE_MS;
  const max = opts?.max ?? RECOVER_MAX_SESSIONS;
  const recover = turns.filter((t) => now - t.at <= maxAgeMs).slice(0, max);
  return { recover, dropped: turns.length - recover.length };
}

/** Sessions with unfinished work — the drain predicate (drain is complete at 0). Pure. */
export function busyCount(sessions: BizSession[]): number {
  return sessions.filter((s) => s.busy).length;
}

/** The storage contract for the active-turn snapshot (a file via `fileActiveTurnStore`, or the
 *  host's own DB). `save` OVERWRITES — it's the current mid-turn set, not an append log. `load` is
 *  consumed once on boot then `clear`ed, so a crash loop can't re-inject the same nudge forever. */
export interface ActiveTurnStore {
  save(turns: ActiveTurn[]): void;
  load(): ActiveTurn[];
  clear(): void;
}

/** The default nudge injected into a recovered session: tell the agent the process restarted and to
 *  continue (or confirm) from its worklog rather than redo finished work. A host passes its own
 *  wording (e.g. localized) via `recoverActiveTurns({ nudge })`. */
export const DEFAULT_RECOVER_NUDGE =
  "The host process just restarted and your last turn may have been interrupted. " +
  "Check this run's worklog and recent context: finish any unfinished work; if it was actually " +
  "already done, just confirm with the user — don't redo what's complete.";

/** Boot-time recovery: read the snapshot, resume each eligible session (converging on the live
 *  `registry` so a user reconnect and this resume don't open two queries on one transcript), inject
 *  the continue nudge, and CLEAR the store either way (consume once — a crash loop must not replay
 *  the nudge forever). The store read/clear and the resume calls are the only IO; no timer. Returns
 *  what it resumed/dropped for the host to log. */
export function recoverActiveTurns(o: {
  manager: SessionManager;
  registry: SessionRegistry;
  store: ActiveTurnStore;
  now: number;
  nudge?: string;
  maxAgeMs?: number;
  max?: number;
  onError?: (turn: ActiveTurn, err: unknown) => void;
}): { resumed: ActiveTurn[]; dropped: number } {
  const loaded = o.store.load();
  o.store.clear(); // consume once, whatever happens below
  if (loaded.length === 0) return { resumed: [], dropped: 0 };
  const { recover, dropped } = recoverableTurns(loaded, o.now, { maxAgeMs: o.maxAgeMs, max: o.max });
  const nudge = o.nudge ?? DEFAULT_RECOVER_NUDGE;
  const resumed: ActiveTurn[] = [];
  for (const t of recover) {
    try {
      const s = o.registry.reuseOrResume(
        t.claudeSessionId,
        () => {}, // already live (it kept running) — nothing to do
        () => o.manager.resume({ business: t.business, claudeSessionId: t.claudeSessionId, runId: t.runId, req: t.req }),
      );
      s.injectFrom({ kind: "system", from: "biz-host", text: nudge });
      resumed.push(t);
    } catch (err) {
      o.onError?.(t, err);
    }
  }
  return { resumed, dropped };
}

/** A drain controller for a planned restart: flip `draining()` (the host's routing layer reads it
 *  to refuse new turns), then `drain()` waits until no session is busy or the timeout elapses.
 *  `cancel` lifts it (a restart called off). The wait polls — bizagent owns no background timer, so
 *  this is the one place it sleeps, and only while a drain is in progress. */
export interface DrainController {
  draining(): boolean;
  drain(timeoutMs: number): Promise<{ drained: boolean; busy: number; waitedMs: number }>;
  cancel(): void;
}

export function makeDrainController(manager: SessionManager, opts?: { pollMs?: number }): DrainController {
  const pollMs = opts?.pollMs ?? 500;
  let draining = false;
  return {
    draining: () => draining,
    cancel: () => {
      draining = false;
    },
    async drain(timeoutMs) {
      draining = true;
      const t0 = Date.now();
      for (;;) {
        const busy = busyCount(manager.list());
        if (busy === 0) return { drained: true, busy: 0, waitedMs: Date.now() - t0 };
        if (Date.now() - t0 >= timeoutMs) return { drained: false, busy, waitedMs: Date.now() - t0 };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}
