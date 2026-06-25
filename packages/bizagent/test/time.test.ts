// Time convention: every human-readable timestamp bizagent writes is UTC+8, regardless of the
// host machine's timezone. These tests pin the conversion with fixed instants so they pass
// identically on any TZ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nowIso, toIso, inUtc8, makeRunId } from "../src/index";

test("toIso renders a known instant as UTC+8 with explicit offset", () => {
  assert.equal(toIso(new Date("2026-01-02T03:04:05.678Z")), "2026-01-02T11:04:05.678+08:00");
  // crossing midnight: 17:30 UTC is 01:30 next day in UTC+8
  assert.equal(toIso(new Date("2026-06-10T17:30:00.000Z")), "2026-06-11T01:30:00.000+08:00");
});

test("toIso round-trips: parsing the string recovers the same instant", () => {
  const d = new Date("2026-06-11T08:09:10.111Z");
  assert.equal(Date.parse(toIso(d)), d.getTime());
});

test("nowIso carries the +08:00 offset", () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
});

test("inUtc8 shifts so getUTC* fields read as UTC+8 wall clock", () => {
  const t = inUtc8(new Date("2026-06-04T03:25:52.000Z"));
  assert.equal(t.getUTCHours(), 11);
  assert.equal(t.getUTCMinutes(), 25);
});

test("makeRunId uses the UTC+8 wall clock, not the host timezone", () => {
  const id = makeRunId(new Date("2026-06-04T03:25:52.000Z"));
  assert.match(id, /^20260604-112552-[0-9a-f]{8}$/);
});
