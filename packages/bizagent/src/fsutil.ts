// The single filesystem boundary. Every disk touch in the codebase goes through here —
// so the day the Store becomes sqlite/remote, only this file changes. v0: local disk.
import fs from "node:fs";
import path from "node:path";

export function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** Remove a file or directory tree, ignoring a missing target (the single rm boundary). */
export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

export function writeFile(file: string, content: string): void {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content);
}

export function readFile(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/** Read a file, or return a fallback when it doesn't exist. */
export function readFileOr(file: string, fallback = ""): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fallback;
}

/** Append a line (O_APPEND). Atomic vs other appenders on a local fs — no read-modify-write
 *  clobber when concurrent processes append to the same file. (NFS would need real locking.) */
export function appendLine(file: string, line: string): void {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}

/** Append raw text verbatim (O_APPEND) — no newline normalization, unlike appendLine. For
 *  callers that append pre-shaped chunks (e.g. transcript line batches that already end in \n). */
export function appendText(file: string, text: string): void {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, text);
}

/** Atomically create a marker file iff absent (`wx`). Returns true if we created it (won
 *  the race), false if it already existed. The basis for "claim once" under concurrency. */
export function claim(file: string, content = ""): boolean {
  mkdirp(path.dirname(file));
  try {
    fs.writeFileSync(file, content, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** Create a relative symlink (linkPath -> target). Skips if it exists; returns whether created. */
export function symlinkRel(linkPath: string, target: string): boolean {
  if (fs.existsSync(linkPath)) return false;
  mkdirp(path.dirname(linkPath));
  fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath);
  return true;
}

/** List files with a given extension (absolute paths). [] if dir is missing. */
export function listFiles(dir: string, ext = ".md"): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));
}

/** List immediate subdirectories (absolute paths, sorted). [] if dir is missing. */
export function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(dir, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Find an executable by name on $PATH, returning its absolute path (or undefined). A minimal
 *  `which` — needed because the Agent SDK must be given the real claude binary, and a bare name
 *  / shell alias won't do. Follows symlinks (X_OK check). */
export function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here / not executable — keep looking */
    }
  }
  return undefined;
}

/** Resolve symlinks on the deepest existing ancestor — works even when `p` doesn't exist
 *  yet (e.g. a file about to be written through a symlinked dir). */
export function realpathDeep(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    cur = fs.realpathSync(cur);
  } catch {
    /* keep lexical */
  }
  return tail.length ? path.join(cur, ...tail) : cur;
}
