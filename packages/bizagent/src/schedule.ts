// The scheduling BRAIN — pure logic + the storage contract, no state and no timer of its own.
// An agent asks to be woken later (the `defer_continue` tool); that intent becomes a WakeupRow
// the APP persists (SchedulerStore) and a tick the APP runs on its own timer. bizagent only
// computes over the rows: clamp the delay, guard the self-wakeup chain, decide what's due. The
// "fire" itself (resume the session + inject the prompt) and the timer + the table are the
// host's job — see [[bizagent-harness-boundary]].
//
// Scope: self-wakeup is the ONE scheduling primitive bizagent owns — the core cross-session
// mechanism, and it needs no cron grammar (a one-shot delay). Recurring / cron-driven runs
// ("subscriptions") are an application concern: a host builds them from this primitive plus
// start/resume, owning its own schedule definitions, cron parser and timezone policy.

/** A scheduled wakeup. The app's store persists these as rows; bizagent computes over them.
 *  `scopeKey` is the serialized origin Scope (the app re-parses it to route/attribute). */
export interface WakeupRow {
  id: string;
  scopeKey?: string;
  /** The business slug to resume in — resume needs both this and the session id. */
  business: string;
  /** Which Claude Code session to resume when this fires. */
  claudeSessionId: string;
  /** Epoch ms; the row is due once now >= wakeAt. */
  wakeAt: number;
  /** Injected as the waking turn's prompt. */
  wakePrompt: string;
  /** How many times this self-wakeup chain has already fired — the anti-runaway counter. */
  chainCount: number;
  status: "pending" | "fired" | "cancelled" | "exhausted";
}

// The same delay band the Claude Code harness uses, so SDK behavior matches CLI: under 5 min
// keeps the prompt cache warm; an hour is the upper bound for a single deferral.
export const WAKEUP_MIN_DELAY = 60; // seconds
export const WAKEUP_MAX_DELAY = 3600; // seconds
// A self-wakeup chain that re-arms itself every turn must terminate; cap the hops.
export const WAKEUP_MAX_CHAIN = 50;

/** Clamp a requested delay (seconds) into the allowed band. A non-finite/negative request falls
 *  to the minimum rather than firing immediately or never. */
export function clampDelay(sec: number, min = WAKEUP_MIN_DELAY, max = WAKEUP_MAX_DELAY): number {
  if (!Number.isFinite(sec)) return min;
  return Math.min(max, Math.max(min, Math.floor(sec)));
}

/** Has a self-wakeup chain run past its budget? (anti-runaway: a row at/over the cap must not
 *  fire again, only be retired.) */
export function chainExhausted(chainCount: number, max = WAKEUP_MAX_CHAIN): boolean {
  return chainCount >= max;
}

/** The tick decision — pure, no I/O. Given the pending rows + now, split into the ones to FIRE
 *  (due, within chain budget) and the ones to retire as EXHAUSTED (due but over budget). The
 *  host resumes+injects each `fire`, settles each `exhausted`, and may notify on exhaustion. */
export function dueWakeups(rows: WakeupRow[], now: number): { fire: WakeupRow[]; exhausted: WakeupRow[] } {
  const fire: WakeupRow[] = [];
  const exhausted: WakeupRow[] = [];
  for (const r of rows) {
    if (r.status !== "pending" || r.wakeAt > now) continue;
    if (chainExhausted(r.chainCount)) exhausted.push(r);
    else fire.push(r);
  }
  return { fire, exhausted };
}

/** The storage contract the app implements with its own DB (a platform might use a `session_wakeups`
 *  table; `biz web`: a reference file store). bizagent never persists — it only calls this.
 *  Deliberately tiny: insert a pending row, read what's due, settle a terminal state. */
export interface SchedulerStore {
  /** Persist a new pending wakeup; returns its id. The host mints the id (DB autoincrement / a
   *  uuid) — bizagent passes only the payload. */
  insert(row: Omit<WakeupRow, "id" | "status">): Promise<string>;
  /** Pending rows due at/before `now` (the tick reads these each interval). */
  due(now: number): Promise<WakeupRow[]>;
  /** Mark a row's terminal state after the tick has acted on it. */
  settle(id: string, status: "fired" | "cancelled" | "exhausted"): Promise<void>;
}
