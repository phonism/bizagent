// Tests for prompt assembly (worklog skeleton + custom snippet + interpolation).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initRoot,
  newBusiness,
  renderPrompt,
  resolveCustom,
  buildWorklogPrompt,
  buildBusinessSetupPrompt,
} from "../src/index";

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-prompt-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  return root;
}

test("renderPrompt strips frontmatter and interpolates vars", () => {
  const tpl = "<!--\nname: X\n-->\nHello ${NAME}, modules: ${S}.";
  const out = renderPrompt(tpl, { NAME: "farm", S: "strategy, backend" });
  assert.ok(!out.includes("<!--"));
  assert.equal(out.trim(), "Hello farm, modules: strategy, backend.");
});

test("renderPrompt leaves missing vars empty", () => {
  assert.equal(renderPrompt("a ${MISSING} b", {}).trim(), "a  b");
});

test("buildWorklogPrompt contains the locked rules and the run's path", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  const p = buildWorklogPrompt({ root, slug: "farm", runId: "20260101-090000" });
  assert.match(p, /\.bizagent\/deliverables\/20260101-090000\/worklog\.md/);
  assert.match(p, /description:/); // the locked frontmatter description format
  assert.ok(!p.includes("${")); // no leftover placeholders
});

test("resolveCustom: business beats root beats user; empty when none", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  assert.equal(resolveCustom("worklog", { root, slug: "farm" }), "");

  // root-level custom
  fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(root, "prompts", "worklog.custom.md"), "ORG RULE");
  assert.equal(resolveCustom("worklog", { root, slug: "farm" }), "ORG RULE");

  // business-level wins over root
  fs.writeFileSync(path.join(root, "lines", "ops", "businesses", "farm", "worklog.custom.md"), "WS RULE");
  assert.equal(resolveCustom("worklog", { root, slug: "farm" }), "WS RULE");
});

test("buildWorklogPrompt splices the custom snippet in", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm" });
  fs.writeFileSync(path.join(root, "lines", "ops", "businesses", "farm", "worklog.custom.md"), "Always record the SQL and data source.");
  const p = buildWorklogPrompt({ root, slug: "farm", runId: "20260101-090000" });
  assert.match(p, /Business-specific additions/);
  assert.match(p, /Always record the SQL and data source\./);
});

test("buildBusinessSetupPrompt covers the three phases and addresses the right business", () => {
  const root = tmpRoot();
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  const p = buildBusinessSetupPrompt({ root, slug: "farm", name: "Farm", line: "ops" });
  assert.match(p, /\*\*Farm\*\* \(`farm`\)/);
  assert.match(p, /biz set farm/); // phase 1: profile lands via biz commands
  assert.match(p, /biz module new/); // phase 2: register modules...
  assert.match(p, /biz link farm/); // ...and link them to THIS business
  assert.match(p, /knowledge\/business\//); // phase 3: seed the knowledge base
  assert.match(p, /Open questions/); // gaps land in the worklog
  assert.ok(!p.includes("${")); // no leftover placeholders

  // custom snippet splices in like the other skeletons
  fs.writeFileSync(path.join(root, "lines", "ops", "businesses", "farm", "business-setup.custom.md"), "Ask about the KPI sheet.");
  assert.match(buildBusinessSetupPrompt({ root, slug: "farm", name: "Farm", line: "ops" }), /Ask about the KPI sheet\./);
});

test("buildCapabilitiesPrompt always describes expect_result; defer_continue only with a scheduler", async () => {
  const { buildCapabilitiesPrompt } = await import("../src/index");
  const off = buildCapabilitiesPrompt({ scheduler: false });
  assert.ok(off.includes("expect_result"), "expect_result is always offered");
  assert.ok(!off.includes("defer_continue"), "no scheduling guidance without a scheduler");

  const on = buildCapabilitiesPrompt({ scheduler: true });
  assert.ok(on.includes("expect_result"));
  assert.ok(on.includes("defer_continue"), "scheduling guidance included when wired");
  assert.ok(on.includes("60") && on.includes("3600"), "states the delay band");
});
