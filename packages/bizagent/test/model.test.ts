// ModelResolver is a pure SPI — bizagent ships only the contract + the identity default; the
// real registry lives in the app. These tests pin the default's behavior and the resolver shape
// (sync + async, backend override) as executable documentation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { identityModelResolver, type ModelResolver } from "../src/index";

test("identityModelResolver forwards the key as the model id, no backend override", async () => {
  const r = await identityModelResolver("opus");
  assert.deepEqual(r, { model: "opus" });
});

test("a custom resolver can map a key to a backend-specific id + binary + env", async () => {
  const custom: ModelResolver = (key) =>
    key === "opus"
      ? { model: "claude-opus-4-7", claudeExecutable: "/opt/custom/bin/agent", env: { CUSTOM: "1" } }
      : { model: key };
  assert.deepEqual(await custom("opus"), {
    model: "claude-opus-4-7",
    claudeExecutable: "/opt/custom/bin/agent",
    env: { CUSTOM: "1" },
  });
  assert.deepEqual(await custom("sonnet"), { model: "sonnet" });
});

test("a resolver may be async and may read the context (identity/scope)", async () => {
  const byUser: ModelResolver = async (key, ctx) => ({
    model: ctx?.identity?.userId === "vip" ? "opus" : key,
  });
  assert.equal((await byUser("haiku", { identity: { userId: "vip" } })).model, "opus");
  assert.equal((await byUser("haiku", { identity: { userId: "joe" } })).model, "haiku");
});
