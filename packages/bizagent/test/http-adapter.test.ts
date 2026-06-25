// The framework-agnostic HTTP seam: toSSE encodes/cleans up an event stream; nodeListener
// round-trips a Fetch Handler over a real node:http server.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { toSSE, nodeListener } from "../src/index";
import type { Handler } from "../src/index";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("toSSE encodes each event as a data frame and sets SSE headers", async () => {
  async function* gen() {
    yield { a: 1 };
    yield { b: 2 };
  }
  const res = toSSE(gen());
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  // The leading `: connected` comment is the first-chunk flush: node (and any proxy in front)
  // buffers headers until the body starts, so an SSE stream with a slow source would otherwise
  // leave the client waiting for the 200 itself. SSE clients ignore comment frames.
  assert.equal(await res.text(), ': connected\n\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
});

test("toSSE writes an id: line for events carrying a seq (the SSE resume cursor)", async () => {
  async function* gen() {
    yield { type: "message", text: "hi", seq: 7 };
    yield { type: "delta", text: "x" }; // no seq → no id line
  }
  const body = await toSSE(gen()).text();
  assert.equal(body, ': connected\n\nid: 7\ndata: {"type":"message","text":"hi","seq":7}\n\ndata: {"type":"delta","text":"x"}\n\n');
});

test("toSSE cancels the source iterator when the consumer disconnects", async () => {
  let cleanedUp = false;
  async function* infinite() {
    try {
      for (let i = 0; ; i++) {
        yield { i };
        await delay(5);
      }
    } finally {
      cleanedUp = true;
    }
  }
  const res = toSSE(infinite());
  const reader = res.body!.getReader();
  await reader.read(); // pull the first frame
  await reader.cancel(); // consumer hangs up -> iterator.return() runs the generator's finally
  await delay(20);
  assert.equal(cleanedUp, true);
});

async function serve(handler: Handler): Promise<{ base: string; close: () => void }> {
  const server = http.createServer(nodeListener(handler));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("nodeListener round-trips method, body, status, and headers", async () => {
  const handler: Handler = async (req) => {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/echo")
      return new Response(await req.text(), { status: 201, headers: { "x-test": "yes" } });
    return new Response("nope", { status: 404 });
  };
  const { base, close } = await serve(handler);
  const ok = await fetch(`${base}/echo`, { method: "POST", body: "hi there" });
  const miss = await fetch(`${base}/elsewhere`);
  close();
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get("x-test"), "yes");
  assert.equal(await ok.text(), "hi there");
  assert.equal(miss.status, 404);
});

test("nodeListener streams an SSE response live over the wire", async () => {
  const handler: Handler = (req) =>
    new URL(req.url).pathname === "/sse"
      ? toSSE(
          (async function* () {
            yield { n: 1 };
            yield { n: 2 };
          })(),
        )
      : new Response(null, { status: 404 });
  const { base, close } = await serve(handler);
  const r = await fetch(`${base}/sse`);
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const body = await r.text();
  close();
  assert.equal(body, ': connected\n\ndata: {"n":1}\n\ndata: {"n":2}\n\n');
});
