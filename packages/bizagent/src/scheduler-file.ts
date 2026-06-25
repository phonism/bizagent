// Reference SchedulerStore over a JSONL file — the `biz web` host's default. One row per line.
// A platform implements SchedulerStore against its own DB (e.g. a `session_wakeups` table) and
// never uses this; it exists so the built-in host can drive wakeups out of the box
// and to back the tests. Single-process only: each method body is synchronous between awaits
// (no interleaving), so an append (insert) can't be lost by a concurrent rewrite (settle) —
// fine for one host, NOT for multiple writers. A real platform's DB handles concurrency.
import { readFileOr, appendLine, writeFile } from "./fsutil";
import { makeRunId } from "./runtime-cli";
import type { SchedulerStore, WakeupRow } from "./schedule";

export function fileScheduler(file: string): SchedulerStore {
  function readAll(): WakeupRow[] {
    return readFileOr(file)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as WakeupRow;
        } catch {
          return null; // a torn/partial line — skip it
        }
      })
      .filter((r): r is WakeupRow => !!r);
  }

  return {
    async insert(payload) {
      const id = makeRunId();
      const row: WakeupRow = { ...payload, id, status: "pending" };
      appendLine(file, JSON.stringify(row));
      return id;
    },
    async due(now) {
      return readAll().filter((r) => r.status === "pending" && r.wakeAt <= now);
    },
    async settle(id, status) {
      const rows = readAll().map((r) => (r.id === id ? { ...r, status } : r));
      writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    },
  };
}
