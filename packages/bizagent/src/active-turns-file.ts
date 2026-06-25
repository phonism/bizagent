// Reference ActiveTurnStore over a single JSON file — the `biz web` host's default, the snapshot
// sibling of scheduler-file.ts. A platform implements ActiveTurnStore against its own DB and never
// uses this. Whole-file overwrite (the snapshot is the CURRENT mid-turn set, not a log), so there's
// no torn-append concern; single-process. A real platform's DB handles concurrency.
import { readFileOr, writeFile, rmrf } from "./fsutil";
import type { ActiveTurn, ActiveTurnStore } from "./graceful";

export function fileActiveTurnStore(file: string): ActiveTurnStore {
  return {
    save(turns) {
      writeFile(file, JSON.stringify(turns, null, 2));
    },
    load() {
      const raw = readFileOr(file);
      if (!raw.trim()) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ActiveTurn[]) : [];
      } catch {
        return []; // torn/partial file — recover nothing rather than crash the boot
      }
    },
    clear() {
      rmrf(file);
    },
  };
}
