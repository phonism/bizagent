// All human-readable timestamps in bizagent are UTC+8 (Asia/Shanghai, no DST), regardless of
// the host machine's timezone — so server file listings, worklog ids, and agent-visible stamps
// all agree. Epoch-millisecond arithmetic (Date.now()) is timezone-free and stays as-is.

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const TZ_SUFFIX = "+08:00";

/** `date` shifted so its getUTC* fields read as UTC+8 wall-clock time. */
export function inUtc8(date: Date): Date {
  return new Date(date.getTime() + TZ_OFFSET_MS);
}

/** `date` as ISO 8601 in UTC+8, e.g. "2026-06-11T15:30:00.123+08:00". */
export function toIso(date: Date): string {
  return inUtc8(date).toISOString().replace("Z", TZ_SUFFIX);
}

/** Current time as ISO 8601 in UTC+8. */
export function nowIso(): string {
  return toIso(new Date());
}
