// Scope is a pure primitive — no root scaffold needed; just exercise the algebra and the
// segment validation (which is a safety boundary: a scope segment ends up in a path / key).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scope,
  scopeKey,
  parseScope,
  childOf,
  parentOf,
  isRoot,
  within,
  scopeEq,
} from "../src/index";

test("scope() builds from ordered segments; scopeKey joins with /", () => {
  assert.equal(scopeKey(scope("ops", "farm")), "ops/farm");
  assert.equal(scopeKey(scope("farm")), "farm");
});

test("the root scope has no segments and serializes to empty string", () => {
  const r = scope();
  assert.equal(isRoot(r), true);
  assert.equal(scopeKey(r), "");
  assert.deepEqual(r.parts, []);
});

test("parseScope is the inverse of scopeKey (round-trip), root included", () => {
  for (const key of ["", "farm", "ops/farm", "ops/farm/alice"]) {
    assert.equal(scopeKey(parseScope(key)), key);
  }
  assert.equal(isRoot(parseScope("")), true);
  assert.equal(isRoot(parseScope("   ")), true); // whitespace-only -> root
});

test("childOf appends segments; parentOf drops the last; parent of root is null", () => {
  const s = scope("ops");
  const c = childOf(s, "farm");
  assert.equal(scopeKey(c), "ops/farm");
  assert.equal(scopeKey(parentOf(c)!), "ops");
  assert.equal(parentOf(scope()), null);
});

test("within is reflexive and prefix-based; not a suffix or sibling match", () => {
  const ops = scope("ops");
  assert.equal(within(ops, ops), true); // reflexive
  assert.equal(within(ops, scope("ops", "farm")), true); // descendant
  assert.equal(within(scope(), scope("anything", "deep")), true); // root contains all
  assert.equal(within(scope("ops", "farm"), ops), false); // outer deeper than inner
  assert.equal(within(ops, scope("growth", "farm")), false); // different branch
});

test("scopeEq is structural", () => {
  assert.equal(scopeEq(scope("ops", "farm"), scope("ops", "farm")), true);
  assert.equal(scopeEq(scope("ops"), scope("ops", "farm")), false);
  assert.equal(scopeEq(scope(), scope()), true);
});

test("segment validation rejects unsafe tokens rather than sanitizing", () => {
  assert.throws(() => scope(""), /non-empty/);
  assert.throws(() => scope("a/b"), /path separator/);
  assert.throws(() => scope("a\\b"), /path separator/);
  assert.throws(() => scope(".."), /cannot be/);
  assert.throws(() => scope("."), /cannot be/);
  assert.throws(() => scope(" ops"), /edge whitespace/);
  assert.throws(() => scope("ops "), /edge whitespace/);
  assert.throws(() => scope("a\nb"), /control characters/);
});

test("parseScope re-validates: a key with a traversal segment throws", () => {
  assert.throws(() => parseScope("ops/../etc"), /cannot be/);
});
