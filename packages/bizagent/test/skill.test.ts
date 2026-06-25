// Skills: read-only root-level capability packages, assembled into every business via one
// .claude/skills symlink so Claude Code discovers them in the session cwd.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { initRoot, newBusiness, createWebServer, listSkills, skillFiles, readSkillFile, ensureSkillsLink } from "../src/index";

const SKILL_MD = `---
name: tda-query
description: Run TDA Spark SQL queries.
---

# TDA query

Use scripts/run.py.
`;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-skill-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  // seed one skill BEFORE the business exists
  fs.mkdirSync(path.join(root, "skills", "tda", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "tda", "SKILL.md"), SKILL_MD);
  fs.writeFileSync(path.join(root, "skills", "tda", "scripts", "run.py"), "print('hi')\n");
  return root;
}

test("newBusiness links .claude/skills at the root skills dir; list/read work", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });

  const link = path.join(root, "lines", "ops", "businesses", "farm", ".claude", "skills");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  // the business sees the skill through its own .claude/skills (what Claude Code reads)
  assert.ok(fs.existsSync(path.join(link, "tda", "SKILL.md")));

  const skills = listSkills(root);
  assert.equal(skills.length, 1);
  assert.deepEqual(
    { id: skills[0].id, name: skills[0].name, fileCount: skills[0].fileCount },
    { id: "tda", name: "tda-query", fileCount: 2 },
  );
  assert.match(skills[0].description, /Spark SQL/);

  assert.deepEqual(
    skillFiles(root, "tda")?.map((f) => f.path),
    ["SKILL.md", "scripts/run.py"],
  );
  assert.equal(skillFiles(root, "nope"), null);

  assert.match(readSkillFile(root, "tda", "SKILL.md") ?? "", /TDA query/);
  assert.equal(readSkillFile(root, "tda", "scripts/none.py"), null);
  assert.throws(() => readSkillFile(root, "tda", "../../bizagent.config.json"));
  assert.throws(() => readSkillFile(root, "../escape", "SKILL.md"));
});

test("listSkills handles YAML folded-scalar and quoted descriptions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-skill-fm-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  fs.mkdirSync(path.join(root, "skills", "folded"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "folded", "SKILL.md"),
    "---\nname: folded\ndescription: >\n  数据分析师。端到端完成数据分析全流程：\n  需求理解 → SQL 生成 → 提交执行。\n---\n\nbody\n",
  );
  fs.mkdirSync(path.join(root, "skills", "quoted"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "quoted", "SKILL.md"),
    "---\nname: quoted\ndescription: '在线执行 DQC 数据质量校验。'\n---\n\nbody\n",
  );
  const byId = new Map(listSkills(root).map((s) => [s.id, s]));
  assert.equal(byId.get("folded")?.description, "数据分析师。端到端完成数据分析全流程： 需求理解 → SQL 生成 → 提交执行。");
  assert.equal(byId.get("quoted")?.description, "在线执行 DQC 数据质量校验。");
});

test("ensureSkillsLink backfills a business created without skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-skill-bf-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm" }); // no skills dir existed yet — link still created, target lazily
  const link = path.join(root, "lines", "ops", "businesses", "farm", ".claude", "skills");
  // idempotent re-ensure (the session-launch path)
  ensureSkillsLink(root, "farm");
  ensureSkillsLink(root, "farm");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.statSync(path.join(root, "skills")).isDirectory());
  assert.deepEqual(listSkills(root), []);
});

test("web: GET /api/skills list + detail + file, read-only surface", async () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const server = createWebServer({ root });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const list = (await (await fetch(`${base}/api/skills`)).json()) as { id: string }[];
    assert.deepEqual(list.map((s) => s.id), ["tda"]);

    const detail = (await (await fetch(`${base}/api/skills/tda`)).json()) as { name: string; files: { path: string }[] };
    assert.equal(detail.name, "tda-query");
    assert.deepEqual(detail.files.map((f) => f.path), ["SKILL.md", "scripts/run.py"]);

    const md = await (await fetch(`${base}/api/skills/tda/file?path=SKILL.md`)).text();
    assert.match(md, /TDA query/);

    assert.equal((await fetch(`${base}/api/skills/none`)).status, 404);
    assert.equal((await fetch(`${base}/api/skills/tda/file?path=../../bizagent.config.json`)).status, 400);
  } finally {
    server.close();
  }
});
