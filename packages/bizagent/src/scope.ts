// Scope — a hierarchical, opaque isolation namespace that travels from an entry point (a
// session, a scheduled job, a memory read) down into every SPI call. bizagent uses it ONLY to
// namespace — to build stable keys, path prefixes, and event tags — and to test containment
// (does one scope sit under another). It NEVER stores a scope and NEVER authorizes one:
// persistence and "who may touch which scope" are the application's job (its DB + its auth).
//
// It exists to make today's implicit, flat isolation explicit and layered. Right now a
// business slug is the de-facto scope; a platform with more tenancy dimensions maps them onto
// segments — e.g. a product line + business become scope("commerce", "webstore"), and a per-user scope
// adds a third segment. A single-tenant setup can ignore it: the root scope (no segments) is
// valid and serializes to "".
//
// Pure and dependency-free — unit-tested without the SDK or a filesystem.

/** A hierarchical isolation scope. Opaque to bizagent beyond namespacing + containment. */
export interface Scope {
  readonly parts: ReadonlyArray<string>;
}

const SEP = "/";

/** A scope segment becomes part of a filesystem path and a remote key, so it must be a single
 *  safe token: non-empty, trimmed, no separators, no traversal, no control chars. We reject
 *  rather than sanitize — a silent rewrite of a tenant id is worse than a clear error. */
function assertSegment(p: string): void {
  if (typeof p !== "string" || p.length === 0) throw new Error("scope segment must be a non-empty string");
  if (p !== p.trim()) throw new Error(`scope segment has edge whitespace: ${JSON.stringify(p)}`);
  if (p === "." || p === "..") throw new Error('scope segment cannot be "." or ".."');
  if (/[/\\]/.test(p)) throw new Error(`scope segment cannot contain a path separator: ${JSON.stringify(p)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new Error(`scope segment cannot contain control characters: ${JSON.stringify(p)}`);
}

/** Build a scope from ordered segments (outermost first). `scope()` is the valid root scope. */
export function scope(...parts: string[]): Scope {
  for (const p of parts) assertSegment(p);
  return { parts: [...parts] };
}

/** The stable string key — segments joined by "/". The root scope is "". Use for namespacing
 *  (path prefixes, remote hub dirs, event tags) and as a map key. Inverse of parseScope. */
export function scopeKey(s: Scope): string {
  return s.parts.join(SEP);
}

/** Parse a scopeKey back into a Scope. Empty string -> root. Re-validates every segment. */
export function parseScope(key: string): Scope {
  const trimmed = key.trim();
  if (!trimmed) return scope();
  return scope(...trimmed.split(SEP));
}

/** A descendant scope with extra segments appended. */
export function childOf(s: Scope, ...parts: string[]): Scope {
  return scope(...s.parts, ...parts);
}

/** The enclosing scope, or null if `s` is already the root. */
export function parentOf(s: Scope): Scope | null {
  return s.parts.length ? scope(...s.parts.slice(0, -1)) : null;
}

/** True if `s` is the root scope (no segments). */
export function isRoot(s: Scope): boolean {
  return s.parts.length === 0;
}

/** True if `inner` is `outer` or sits beneath it (prefix containment). The pure check a
 *  platform's auth layer can build on — bizagent never decides access, but it answers "does
 *  this scope belong under that one" so callers don't reinvent prefix matching. */
export function within(outer: Scope, inner: Scope): boolean {
  if (inner.parts.length < outer.parts.length) return false;
  for (let i = 0; i < outer.parts.length; i++) {
    if (inner.parts[i] !== outer.parts[i]) return false;
  }
  return true;
}

/** Structural equality of two scopes. */
export function scopeEq(a: Scope, b: Scope): boolean {
  return a.parts.length === b.parts.length && a.parts.every((p, i) => p === b.parts[i]);
}
