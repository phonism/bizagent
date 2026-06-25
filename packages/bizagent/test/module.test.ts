// Modules: line-level shared components, many-to-many with the line's businesses (never across
// lines), linked via symlink and surfaced in the launch context (with the read-master /
// worktree-to-develop convention).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initRoot,
  newBusiness,
  newModule,
  linkModule,
  unlinkModule,
  listModuleSlugs,
  readModuleMeta,
  updateModuleMeta,
  businessesLinking,
  listBusinesses,
  buildSystemPrompt,
  buildModuleSetupPrompt,
  readBusinessMeta,
  moduleWorkspaceId,
  parseModuleWorkspaceId,
  businessDir,
  findBusiness,
  validateMemoryWrite,
  validateModuleDirWrite,
  linkedModuleDirs,
  writeMemory,
} from "../src/index";

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-mod-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  return root;
}

test("newModule creates code/ CLAUDE.md module.json (no memory/)", () => {
  const root = tmpRoot();
  const r = newModule({
    root,
    line: "ops",
    slug: "strategy",
    type: "strategy",
    source: "github.com/acme/strategy, ssh clone",
    deploy: "kubectl apply -f k8s/",
  });
  assert.ok(r.dir.includes(path.join("lines", "ops", "modules", "strategy")));
  assert.ok(fs.existsSync(path.join(r.dir, "code")));
  // The module's knowledge home is its CLAUDE.md (seeded, marked as the empty skeleton);
  // module memory is retired — no memory/ dir is scaffolded.
  const seed = fs.readFileSync(path.join(r.dir, "CLAUDE.md"), "utf8");
  assert.match(seed, /bizagent:module-claude-md-seed/);
  assert.match(seed, /# Module: strategy \(line: ops\)/);
  assert.ok(!fs.existsSync(path.join(r.dir, "memory")));
  const meta = readModuleMeta(root, "ops", "strategy");
  assert.equal(meta.type, "strategy");
  assert.equal(meta.source, "github.com/acme/strategy, ssh clone");
  assert.equal(meta.deploy, "kubectl apply -f k8s/");
  assert.deepEqual(listModuleSlugs(root, "ops"), ["strategy"]);
  // a module never crosses lines: it is invisible from another line
  assert.deepEqual(listModuleSlugs(root, "growth"), []);
});

test("linkModule is many-to-many: records in business.json and symlinks the module in", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "data", type: "data" });
  newBusiness({ root, line: "ops", slug: "farm" });
  newBusiness({ root, line: "ops", slug: "shop" });

  linkModule({ root, biz: "farm", module: "data" });
  linkModule({ root, biz: "shop", module: "data" }); // same module, second business

  assert.deepEqual(readBusinessMeta(root, "farm").modules, ["data"]);
  assert.deepEqual(readBusinessMeta(root, "shop").modules, ["data"]);

  // The symlink points at the line's shared module, resolving to its code.
  const link = path.join(root, "lines", "ops", "businesses", "farm", "modules", "data");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(link, "code")));
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(root, "lines", "ops", "modules", "data")));

  // Linking again is idempotent (no duplicate in the list).
  linkModule({ root, biz: "farm", module: "data" });
  assert.deepEqual(readBusinessMeta(root, "farm").modules, ["data"]);
});

test("unlinkModule drops it from modules[] and removes the symlink, leaving the module intact", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "data", type: "data" });
  newBusiness({ root, line: "ops", slug: "farm" });
  linkModule({ root, biz: "farm", module: "data" });
  const link = path.join(root, "lines", "ops", "businesses", "farm", "modules", "data");
  assert.ok(fs.existsSync(link));

  assert.deepEqual(unlinkModule({ root, biz: "farm", module: "data" }), { unlinked: true });
  assert.deepEqual(readBusinessMeta(root, "farm").modules, []);
  assert.ok(!fs.existsSync(link)); // symlink gone
  // The line-level module itself survives — only the link was removed.
  assert.deepEqual(listModuleSlugs(root, "ops"), ["data"]);
  // Idempotent: unlinking again is a no-op.
  assert.deepEqual(unlinkModule({ root, biz: "farm", module: "data" }), { unlinked: false });
});

test("newBusiness --module links existing modules at creation", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "backend", type: "backend" });
  newModule({ root, line: "ops", slug: "frontend", type: "frontend" });
  newBusiness({ root, line: "ops", slug: "farm", modules: ["backend", "frontend"] });
  assert.deepEqual(readBusinessMeta(root, "farm").modules, ["backend", "frontend"]);
});

test("linkModule rejects an unknown module — including one from ANOTHER line", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  assert.throws(() => linkModule({ root, biz: "farm", module: "nope" }), /no such module/);
  // modules never cross lines: a module that exists in 'growth' is not linkable from 'ops'
  newModule({ root, line: "growth", slug: "crossline", type: "data" });
  assert.throws(() => linkModule({ root, biz: "farm", module: "crossline" }), /no such module in line ops/);
  assert.throws(() => linkModule({ root, biz: "../../outside", module: "nope" }), /invalid business slug/);
  assert.throws(() => linkModule({ root, biz: "farm", module: "../../outside" }), /invalid module slug/);
});

test("buildSystemPrompt surfaces linked modules + the clone-into-deliverables convention", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy", source: "https://github.com/acme/strategy", deploy: "ci deploy strategy" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm", modules: ["strategy"] });

  const ctx = buildSystemPrompt({ root, slug: "farm", runId: "20260607-1-aaaa" });
  assert.match(ctx, /# Modules/);
  assert.match(ctx, /\*\*strategy\*\* — strategy/);
  assert.match(ctx, /Source: https:\/\/github\.com\/acme\/strategy/);
  assert.match(ctx, /Deploy: ci deploy strategy/);
  // Module knowledge is NOT inlined — the index points at the module's CLAUDE.md to Read.
  assert.match(ctx, /Knowledge: `modules\/strategy\/CLAUDE\.md`/);
  // Reading happens through the mount (the sandbox grants read access); CHANGES happen in a
  // clone under the session's deliverables, on the requirement branch, merged outside.
  assert.match(ctx, /read `modules\/<name>\/code\/` directly/);
  assert.match(ctx, /\.bizagent\/deliverables\/20260607-1-aaaa\/dev\/<name>\//); // clone to change
  assert.match(ctx, /req\/20260607-1-aaaa/); // branch uses this run's id (no req)
  assert.match(ctx, /never touch the module's shared checkout/);
  assert.doesNotMatch(ctx, /worktree add/); // the old shared-checkout worktree convention is gone
});

test("no modules linked -> no Modules section", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "bare" });
  const ctx = buildSystemPrompt({ root, slug: "bare", runId: "x" });
  assert.doesNotMatch(ctx, /# Modules/);
});

test("updateModuleMeta patches knowledge fields; slug stays immutable", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });
  const next = updateModuleMeta(root, "ops", "strategy", { source: "github.com/acme/strategy", deploy: "ci deploy" });
  assert.equal(next.source, "github.com/acme/strategy");
  assert.equal(next.deploy, "ci deploy");
  assert.equal(next.slug, "strategy");
  assert.equal(readModuleMeta(root, "ops", "strategy").deploy, "ci deploy");
});

test("businessesLinking derives the linking businesses; module setup prompt addresses the module", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });
  newBusiness({ root, line: "ops", slug: "farm", modules: ["strategy"] });
  newBusiness({ root, line: "ops", slug: "shop" });

  const hosts = businessesLinking(listBusinesses(root), (s) => readBusinessMeta(root, s), "strategy");
  assert.deepEqual(hosts.map((h) => h.slug), ["farm"]);

  // The setup session runs in the module's OWN workspace now — the prompt addresses the module
  // directory directly (code/, CLAUDE.md, module.json), never a hosting business's mount path.
  const p = buildModuleSetupPrompt({ root, slug: "mod:ops:strategy", mod: "strategy", line: "ops" });
  assert.match(p, /module `strategy`/i);
  assert.match(p, /module's own directory \(line `ops`\)/); // runs in the module workspace
  assert.match(p, /If `code\/` is empty/); // phase 1: get the code
  assert.match(p, /editing `module\.json`/); // phase 2: correct the record
  assert.match(p, /fill in the module's CLAUDE\.md/); // phase 3: seed the knowledge doc
  assert.ok(!p.includes("${"));
});

// ── module workspaces: a module hosts sessions in its OWN directory (`mod:<line>:<mod>`) ──

test("module workspace id round-trips and resolves to the module directory", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });

  const id = moduleWorkspaceId("ops", "strategy");
  assert.equal(id, "mod:ops:strategy");
  assert.deepEqual(parseModuleWorkspaceId(id), { line: "ops", mod: "strategy" });
  assert.equal(parseModuleWorkspaceId("farm"), null); // a plain business slug is not a module id
  assert.equal(parseModuleWorkspaceId("mod:ops:../escape"), null); // traversal is rejected
  assert.equal(parseModuleWorkspaceId("mod:ops"), null); // missing segment

  // The central resolver lands every (root, slug) path helper inside the module dir.
  assert.equal(businessDir(root, id), path.join(root, "lines", "ops", "modules", "strategy"));
});

test("findBusiness resolves a module dir (and its children) to the module workspace", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });
  const dir = path.join(root, "lines", "ops", "modules", "strategy");

  const ws = findBusiness(dir);
  assert.ok(ws);
  assert.equal(ws.slug, "mod:ops:strategy");
  assert.equal(ws.dir, dir);

  const fromChild = findBusiness(path.join(dir, "code"));
  assert.equal(fromChild?.slug, "mod:ops:strategy");
});

test("module memory is retired: all writes denied, writeMemory throws for module workspaces", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });
  const memFile = path.join(root, "lines", "ops", "modules", "strategy", "memory", "note.md");

  // Even a well-formed legacy-style record is denied — module knowledge lives in CLAUDE.md.
  const denied = validateMemoryWrite({ root, filePath: memFile, content: "---\nscope: module\n---\nbuild with make" });
  assert.equal(denied.ok, false);
  assert.match(denied.reason ?? "", /CLAUDE\.md/);

  assert.throws(() => writeMemory({ root, slug: "mod:ops:strategy", body: "entry point is src/main.py" }), /CLAUDE\.md/);
});

test("module workspace sessions get the module flavor of the system prompt (CLAUDE.md injected)", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy", source: "github.com/acme/strategy" });

  // Fresh module: the seed CLAUDE.md is injected as-is (it carries its own fill-me instructions).
  const seeded = buildSystemPrompt({ root, slug: "mod:ops:strategy", runId: "r1" });
  assert.match(seeded, /shared module "strategy"/);
  assert.match(seeded, /\*\*Source\*\*: github\.com\/acme\/strategy/);
  assert.match(seeded, /# Module CLAUDE\.md/);
  assert.match(seeded, /bizagent:module-claude-md-seed/);
  assert.ok(!seeded.includes("${"));
  assert.ok(!/Business memory/.test(seeded)); // no business context leaks into a module session

  // Real content replaces the seed — what the agent wrote is what later sessions launch with.
  fs.writeFileSync(
    path.join(root, "lines", "ops", "modules", "strategy", "CLAUDE.md"),
    "# Module: strategy\n\n## Operations\n\nbuild with make\n",
  );
  const real = buildSystemPrompt({ root, slug: "mod:ops:strategy", runId: "r2" });
  assert.match(real, /build with make/);
  assert.doesNotMatch(real, /bizagent:module-claude-md-seed/);
});

test("linkedModuleDirs: business sessions get their linked modules' real dirs; module workspaces get none", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });
  newModule({ root, line: "ops", slug: "data", type: "data" });
  newBusiness({ root, line: "ops", slug: "farm", modules: ["strategy"] });

  assert.deepEqual(linkedModuleDirs(root, "farm"), [path.join(root, "lines", "ops", "modules", "strategy")]);
  assert.deepEqual(linkedModuleDirs(root, "mod:ops:strategy"), []); // cwd IS the module dir
  assert.deepEqual(linkedModuleDirs(root, "no-such-business"), []); // fail-open: no extra dirs
});

test("module dir is read-only from a business session, writable from its own workspace", () => {
  const root = tmpRoot();
  newModule({ root, line: "ops", slug: "strategy", type: "strategy" });
  newBusiness({ root, line: "ops", slug: "farm", modules: ["strategy"] });
  const codeFile = path.join(root, "lines", "ops", "modules", "strategy", "code", "main.py");
  const claudeFile = path.join(root, "lines", "ops", "modules", "strategy", "CLAUDE.md");

  // From the business: code AND CLAUDE.md writes are denied (read the mount, clone to change).
  for (const fp of [codeFile, claudeFile]) {
    const denied = validateModuleDirWrite({ root, wsSlug: "farm", filePath: fp });
    assert.equal(denied.ok, false);
    assert.match(denied.reason ?? "", /read-only/);
  }
  // Through the business's symlink mount the target is the same real path — same verdict.
  const viaMount = validateModuleDirWrite({
    root,
    wsSlug: "farm",
    filePath: path.join(root, "lines", "ops", "businesses", "farm", "modules", "strategy", "code", "main.py"),
  });
  assert.equal(viaMount.ok, false);

  // From the module's own workspace both are allowed.
  for (const fp of [codeFile, claudeFile]) {
    assert.equal(validateModuleDirWrite({ root, wsSlug: "mod:ops:strategy", filePath: fp }).ok, true);
  }
  // Unrelated paths are not governed here.
  assert.equal(validateModuleDirWrite({ root, wsSlug: "farm", filePath: path.join(root, "lines", "ops", "businesses", "farm", "memory", "x.md") }).ok, true);
});
