// Requirements — the multi-session task container: lazy creation, the machine-written run
// link (.req marker), the derived reverse direction, and the requirement context that joins
// the launch system prompt. All file-based, no SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initRoot,
  newBusiness,
  ensureRequirement,
  readRequirementDoc,
  setRequirementGoal,
  recordRunReq,
  runReq,
  recordRunTask,
  runTask,
  runSessionId,
  runForSessionId,
  listRequirements,
  validReqId,
  deleteRequirement,
  renameRequirement,
  listRuns,
  buildSystemPrompt,
} from "../src/index";

function tmpWs(): { root: string; ws: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "biz-req-"));
  initRoot({ root, now: () => "2026-01-01T00:00:00.000Z" });
  newBusiness({ root, line: "ops", slug: "farm", name: "Farm" });
  return { root, ws: path.join(root, "lines", "ops", "businesses", "farm") };
}

test("ensureRequirement lazily creates the dir + skeleton doc, idempotently", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "checkout-refactor" });
  const doc = path.join(ws, "requirements", "checkout-refactor", "requirement.md");
  const first = fs.readFileSync(doc, "utf8");
  assert.match(first, /status: active/);
  assert.match(first, /# checkout-refactor/);
  assert.match(first, /## Current state/);
  assert.ok(!first.includes("<!--"), "skeleton must not carry the template header");

  // Idempotent: a second ensure never touches an existing doc.
  fs.writeFileSync(doc, first.replace("## Goal", "## Goal\n\nShip the new checkout."));
  ensureRequirement({ root, slug: "farm", req: "checkout-refactor" });
  assert.match(fs.readFileSync(doc, "utf8"), /Ship the new checkout/);
});

test("setRequirementGoal replaces only the Goal section, creating the requirement when missing", () => {
  const { root, ws } = tmpWs();
  // On a fresh id it creates the skeleton first, then seeds the goal (the POST `goal` path).
  setRequirementGoal({ root, slug: "farm", req: "checkout", goal: "  Ship the new checkout.  " });
  const doc = readRequirementDoc(root, "farm", "checkout")!;
  assert.match(doc, /## Goal\n\nShip the new checkout\.\n/);
  assert.ok(!doc.includes("What this requirement is for"), "placeholder must be replaced");
  assert.match(doc, /## Stories/);
  assert.match(doc, /## Current state/);

  // Editing again touches nothing but the Goal body — agent-written sections survive.
  const docPath = path.join(ws, "requirements", "checkout", "requirement.md");
  fs.writeFileSync(docPath, doc.replace("## Stories", "## Stories\n\n- [x] cart API"));
  setRequirementGoal({ root, slug: "farm", req: "checkout", goal: "Ship checkout v2 instead." });
  const next = fs.readFileSync(docPath, "utf8");
  assert.match(next, /## Goal\n\nShip checkout v2 instead\.\n/);
  assert.ok(!next.includes("Ship the new checkout."), "old goal must be gone");
  assert.match(next, /- \[x\] cart API/);

  assert.throws(() => setRequirementGoal({ root, slug: "farm", req: "checkout", goal: "  " }));
});

test("setRequirementGoal appends a Goal section when a hand-rolled doc lacks the heading", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "bare" });
  const docPath = path.join(ws, "requirements", "bare", "requirement.md");
  fs.writeFileSync(docPath, "---\nstatus: active\n---\n\n# bare\n\nJust notes.\n");
  setRequirementGoal({ root, slug: "farm", req: "bare", goal: "Make it real." });
  assert.match(fs.readFileSync(docPath, "utf8"), /Just notes\.\n\n## Goal\n\nMake it real\.\n$/);
});

test("a malformed requirement id throws (it becomes a dir + branch name)", () => {
  const { root } = tmpWs();
  assert.ok(validReqId("checkout-refactor") && validReqId("v2.pulse_x"));
  for (const bad of ["../escape", "a b", "", ".hidden", "x/y"]) {
    assert.ok(!validReqId(bad));
    assert.throws(() => ensureRequirement({ root, slug: "farm", req: bad }));
  }
});

test("recordRunReq links a run; runReq and listRuns surface it", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "checkout" });
  const runDir = path.join(ws, ".bizagent", "deliverables", "20260105-090000-aaa");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "worklog.md"), "---\ndescription: story 1\n---\nDid story 1.\n");
  recordRunReq({ root, slug: "farm", runId: "20260105-090000-aaa", req: "checkout" });

  assert.equal(runReq(root, "farm", "20260105-090000-aaa"), "checkout");
  assert.equal(runReq(root, "farm", "no-such-run"), undefined);
  const entry = listRuns(root, "farm").find((r) => r.runId === "20260105-090000-aaa");
  assert.equal(entry?.req, "checkout");
});

test("recordRunTask marks a run; runTask and listRuns surface it (so a UI can re-enter the task)", () => {
  const { root, ws } = tmpWs();
  const runDir = path.join(ws, ".bizagent", "deliverables", "20260105-090000-bbb");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "worklog.md"), "---\ndescription: setup\n---\nSet up the module.\n");
  recordRunTask({ root, slug: "farm", runId: "20260105-090000-bbb", task: "module-setup:strategy" });

  assert.equal(runTask(root, "farm", "20260105-090000-bbb"), "module-setup:strategy");
  assert.equal(runTask(root, "farm", "no-such-run"), undefined);
  const entry = listRuns(root, "farm").find((r) => r.runId === "20260105-090000-bbb");
  assert.equal(entry?.task, "module-setup:strategy");
});

test("runForSessionId maps a claudeSessionId back to its OLDEST run (the conversation's original)", () => {
  const { root, ws } = tmpWs();
  const mkRun = (runId: string, sid: string) => {
    const dir = path.join(ws, ".bizagent", "deliverables", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".session-id"), sid);
  };
  // Two runs record the same conversation — duplicates a pre-convergence resume minted. The
  // original (oldest) run must win, so the duplicate is never picked up again.
  mkRun("20260105-090000-aaa", "sid-7");
  mkRun("20260105-100000-bbb", "sid-7");
  mkRun("20260105-110000-ccc", "sid-other");
  assert.equal(runForSessionId(root, "farm", "sid-7"), "20260105-090000-aaa");
  assert.equal(runForSessionId(root, "farm", "sid-other"), "20260105-110000-ccc");
  assert.equal(runForSessionId(root, "farm", "sid-unknown"), undefined);

  // A CLI run records `.transcript-path` instead — its jsonl basename IS the session id.
  const cliDir = path.join(ws, ".bizagent", "deliverables", "20260105-120000-ddd");
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, ".transcript-path"), "/tmp/projects/x/sid-cli.jsonl");
  assert.equal(runSessionId(root, "farm", "20260105-120000-ddd"), "sid-cli");
  assert.equal(runForSessionId(root, "farm", "sid-cli"), "20260105-120000-ddd");
});

test("listRequirements reads each doc's status, defaulting to active", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "alpha" });
  ensureRequirement({ root, slug: "farm", req: "beta" });
  const betaDoc = path.join(ws, "requirements", "beta", "requirement.md");
  fs.writeFileSync(betaDoc, fs.readFileSync(betaDoc, "utf8").replace("status: active", "status: done"));

  const list = listRequirements(root, "farm").sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(list.map(({ id, status }) => ({ id, status })), [
    { id: "alpha", status: "active" },
    { id: "beta", status: "done" },
  ]);
  assert.ok(list.every((r) => typeof r.updatedAt === "string" && r.updatedAt)); // doc mtime rides along
  assert.deepEqual(listRequirements(root, "shop"), []); // unknown business -> empty, not an error
});

test("buildSystemPrompt with req injects the state doc + sibling worklogs; without req it doesn't", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "checkout" });
  const doc = path.join(ws, "requirements", "checkout", "requirement.md");
  fs.writeFileSync(doc, "---\nstatus: active\n---\n\n# checkout\n\nGoal: ship the new checkout flow.\n");

  // A sibling session on the same requirement, with a worklog.
  const sib = path.join(ws, ".bizagent", "deliverables", "20260105-090000-aaa");
  fs.mkdirSync(sib, { recursive: true });
  fs.writeFileSync(path.join(sib, "worklog.md"), "---\ndescription: story 1 done\n---\nImplemented the cart API.\n");
  recordRunReq({ root, slug: "farm", runId: "20260105-090000-aaa", req: "checkout" });
  // An unrelated session (no req) must NOT appear in the requirement section.
  const other = path.join(ws, ".bizagent", "deliverables", "20260106-090000-bbb");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "worklog.md"), "---\ndescription: pulse tuning\n---\nTuned pulse thresholds.\n");

  const withReq = buildSystemPrompt({ root, slug: "farm", runId: "20260107-090000-ccc", req: "checkout" });
  assert.match(withReq, /Current requirement: checkout/);
  assert.match(withReq, /ship the new checkout flow/);
  assert.match(withReq, /Implemented the cart API/); // sibling worklog, full text
  assert.ok(!withReq.includes("Tuned pulse thresholds"), "an unrelated run's worklog body must not be injected");

  const without = buildSystemPrompt({ root, slug: "farm", runId: "20260107-090000-ccc" });
  assert.ok(!without.includes("Current requirement"));
});

test("renameRequirement moves the dir and re-points every linked run's marker", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "old-name" });
  recordRunReq({ root, slug: "farm", runId: "r1", req: "old-name" });
  recordRunReq({ root, slug: "farm", runId: "r2", req: "other" });

  renameRequirement({ root, slug: "farm", from: "old-name", to: "new-name" });
  assert.ok(fs.existsSync(path.join(ws, "requirements", "new-name", "requirement.md")));
  assert.ok(!fs.existsSync(path.join(ws, "requirements", "old-name")));
  assert.equal(runReq(root, "farm", "r1"), "new-name");
  assert.equal(runReq(root, "farm", "r2"), "other"); // unrelated link untouched

  // Guards: malformed target, unknown source, collision.
  assert.throws(() => renameRequirement({ root, slug: "farm", from: "new-name", to: "BAD NAME" }));
  assert.throws(() => renameRequirement({ root, slug: "farm", from: "ghost", to: "x" }));
  ensureRequirement({ root, slug: "farm", req: "taken" });
  assert.throws(() => renameRequirement({ root, slug: "farm", from: "new-name", to: "taken" }));
});

test("deleteRequirement removes the dir + run links; the runs themselves survive", () => {
  const { root, ws } = tmpWs();
  ensureRequirement({ root, slug: "farm", req: "doomed" });
  recordRunReq({ root, slug: "farm", runId: "r1", req: "doomed" });
  fs.writeFileSync(path.join(ws, ".bizagent", "deliverables", "r1", ".transcript-path"), "/tmp/x.jsonl");

  deleteRequirement({ root, slug: "farm", req: "doomed" });
  assert.ok(!fs.existsSync(path.join(ws, "requirements", "doomed")));
  assert.equal(runReq(root, "farm", "r1"), undefined); // link gone…
  assert.equal(listRuns(root, "farm").find((r) => r.runId === "r1")?.req, undefined); // …run survives req-less
  assert.throws(() => deleteRequirement({ root, slug: "farm", req: "doomed" })); // already gone
});
