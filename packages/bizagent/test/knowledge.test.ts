// Knowledge browse — the read-only per-layer listing + file read of a business's knowledge
// tree (business / line / common), addressed at real locations with the hub-style path defense.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRoot, newBusiness, listKnowledge, readKnowledgeFile, listLineKnowledge, readLineKnowledgeFile } from "../src/index";

function tmpRoot(): { root: string; ws: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-knowledge-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  return { root, ws: path.join(root, "lines", "ops", "businesses", "farm") };
}

test("listKnowledge lists the three layers at their real locations, nested dirs included", () => {
  const { root, ws } = tmpRoot();
  fs.writeFileSync(path.join(ws, "knowledge", "business", "overview.md"), "# overview");
  fs.mkdirSync(path.join(root, "lines", "ops", "knowledge", "tables"), { recursive: true });
  fs.writeFileSync(path.join(root, "lines", "ops", "knowledge", "caliber.md"), "# caliber");
  fs.writeFileSync(path.join(root, "lines", "ops", "knowledge", "tables", "dws.md"), "# dws");
  fs.writeFileSync(path.join(root, "knowledge", "common", "metrics.md"), "# metrics");
  // dotfiles and symlinks are skipped, never listed
  fs.writeFileSync(path.join(ws, "knowledge", "business", ".hidden"), "x");

  const layers = listKnowledge(root, "farm");
  assert.deepEqual(
    layers.map((l) => ({ layer: l.layer, name: l.name, files: l.files.map((f) => f.path) })),
    [
      { layer: "business", name: "farm", files: ["overview.md"] },
      { layer: "line", name: "ops", files: ["caliber.md", "tables/dws.md"] },
      { layer: "common", name: "common", files: ["metrics.md"] },
    ],
  );
  assert.ok(layers[0].files[0].size > 0);
});

test("listLineKnowledge lists only the shared layers (line + common), no business in sight", () => {
  const { root, ws } = tmpRoot();
  fs.writeFileSync(path.join(ws, "knowledge", "business", "overview.md"), "# overview");
  fs.writeFileSync(path.join(root, "lines", "ops", "knowledge", "caliber.md"), "# caliber");
  fs.writeFileSync(path.join(root, "knowledge", "common", "metrics.md"), "# metrics");

  const layers = listLineKnowledge(root, "ops");
  assert.deepEqual(
    layers.map((l) => ({ layer: l.layer, name: l.name, files: l.files.map((f) => f.path) })),
    [
      { layer: "line", name: "ops", files: ["caliber.md"] },
      { layer: "common", name: "common", files: ["metrics.md"] },
    ],
  );
  assert.equal(readLineKnowledgeFile(root, "ops", "line", "caliber.md"), "# caliber");
  assert.equal(readLineKnowledgeFile(root, "ops", "common", "metrics.md"), "# metrics");
  assert.throws(() => readLineKnowledgeFile(root, "ops", "line", "../../businesses/farm/business.json"));
});

test("readKnowledgeFile reads per layer; traversal and symlinks are rejected", () => {
  const { root, ws } = tmpRoot();
  fs.writeFileSync(path.join(ws, "knowledge", "business", "overview.md"), "# overview");
  fs.mkdirSync(path.join(root, "lines", "ops", "knowledge", "tables"), { recursive: true });
  fs.writeFileSync(path.join(root, "lines", "ops", "knowledge", "tables", "dws.md"), "# dws");

  assert.equal(readKnowledgeFile(root, "farm", "business", "overview.md"), "# overview");
  assert.equal(readKnowledgeFile(root, "farm", "line", "tables/dws.md"), "# dws");
  assert.equal(readKnowledgeFile(root, "farm", "common", "nope.md"), null);

  for (const bad of ["../business.json", "a/../../x", "/etc/passwd", ""]) {
    assert.throws(() => readKnowledgeFile(root, "farm", "business", bad), `should reject "${bad}"`);
  }
  // a symlink inside a layer is never followed
  fs.symlinkSync(path.join(ws, "business.json"), path.join(ws, "knowledge", "business", "leak.md"));
  assert.throws(() => readKnowledgeFile(root, "farm", "business", "leak.md"));
});
