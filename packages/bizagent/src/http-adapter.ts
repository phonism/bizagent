// The framework-agnostic HTTP seam. The platform's routes are expressed once as a `Handler`
// (the Web Fetch contract: a `Request` in, a `Response` out) with NO node:http in sight, so the
// same backend mounts on Node, Bun, Deno, or a Cloudflare/Next route. `nodeListener` is the ONE
// place that touches node:http — it adapts a `Handler` to node's (req, res); `toSSE` turns an
// async iterable of events into a streaming Server-Sent-Events `Response`. Everything here is
// runtime-glue, not business logic.
import type { IncomingMessage, ServerResponse, RequestListener } from "node:http";

/** A route table reduced to one function: a standard Request in, a standard Response out. */
export type Handler = (req: Request) => Promise<Response> | Response;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** Stream an async iterable of JSON-serializable events as an SSE `Response`. Each value becomes
 *  a `data: <json>\n\n` frame. When the consumer disconnects, the iterator's `return()` is called
 *  so the source can clean up (the single reason this lives in the harness, not each app). An
 *  optional keep-alive emits `: ping` comments so idle proxies don't drop the connection. */
export function toSSE(events: AsyncIterable<unknown>, opts: { keepAliveMs?: number } = {}): Response {
  const enc = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // An immediate comment frame (ignored by SSE clients) so the response has a first chunk
      // even when the source has nothing to say yet — node and any proxy in front (e.g. the
      // Next.js layer forwarding to the agent host) buffer headers until the body starts.
      controller.enqueue(enc.encode(": connected\n\n"));
      if (opts.keepAliveMs && opts.keepAliveMs > 0) {
        ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": ping\n\n"));
          } catch {
            /* controller already closed */
          }
        }, opts.keepAliveMs);
        ping.unref?.();
      }
      void (async () => {
        try {
          for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
            // Events carrying a `seq` become resumable SSE frames: the `id:` line feeds the
            // client's Last-Event-ID, so a reconnect can ask for "everything after this" instead
            // of a full replay. Events without one (deltas, plain objects) stay id-less.
            const seq = (r.value as { seq?: unknown }).seq;
            const id = typeof seq === "number" ? `id: ${seq}\n` : "";
            controller.enqueue(enc.encode(`${id}data: ${JSON.stringify(r.value)}\n\n`));
          }
        } catch {
          /* aborted or source threw — just end the stream */
        } finally {
          if (ping) clearInterval(ping);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
    cancel() {
      if (ping) clearInterval(ping);
      void iterator.return?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** Buffer a node request body into a Buffer (empty for GET/HEAD). */
function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

/** Adapt a Fetch-style `Handler` to a node:http request listener — the only node:http coupling
 *  in the platform. Converts the incoming message to a `Request`, runs the handler, and writes
 *  the `Response` back, streaming the body chunk-by-chunk (so SSE flushes live) and cancelling the
 *  body reader when the client hangs up. */
export function nodeListener(handler: Handler): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v == null) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const hasBody = method !== "GET" && method !== "HEAD";
      const body = hasBody ? await readNodeBody(req) : undefined;
      const request = new Request(url, {
        method,
        headers,
        // Copy into a plain Uint8Array — a node Buffer is one structurally but not by the DOM
        // BodyInit type the Fetch Request expects.
        body: body && body.length ? new Uint8Array(body) : undefined,
      });

      let response: Response;
      try {
        response = await handler(request);
      } catch (e) {
        response = new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(response.status, outHeaders);
      // node cork-buffers headers until the first body write — an SSE response whose source has
      // nothing to say yet (e.g. tailing a transcript that doesn't exist) would otherwise leave
      // the client waiting for the 200 itself. Flush them now so the stream is established.
      res.flushHeaders();

      if (!response.body) {
        res.end(await response.text());
        return;
      }
      const reader = response.body.getReader();
      req.on("close", () => void reader.cancel().catch(() => {}));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
      } catch {
        /* client disconnected mid-stream */
      }
      res.end();
    })();
  };
}
