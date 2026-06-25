// The built-in web platform — `biz web`. Serves the whole root: a business picker, a chat per
// business (SSE out, POST in), and a live worklog panel. It's the web counterpart of `biz run`:
// same root, the other front door. Built on SessionManager, so multi-turn streaming + worklog
// enforcement + remote sharing all come along unchanged.
//
// The routes are a framework-agnostic `Handler` (Request -> Response, see ./http-adapter) — the
// same backend can mount on Node, Bun, Deno, or a serverless route. `createWebServer` wraps that
// handler in a node:http server and adds the host-only bits (the wakeup tick + session registry).
//
// This is NOT scaffolded into the user's root as an editable server file (that would fork the
// platform per root). It lives in `biz`; the HTML is a bundled asset (web/app.html), and the
// root only carries a small `web` config block. Customizing the UI later = an override asset,
// the same pattern as prompts/*.custom.md — not forking this file.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fm from "./frontmatter";
import { exists, readFile, readFileOr, mkdirp } from "./fsutil";
import { rootConfigPath, memoryDir, deliverablesDir, wakeupStorePath, activeTurnsPath, parseModuleWorkspaceId, moduleConfigPath, moduleDir, parseAssistantWorkspaceId, assistantConfigPath, assistantDir } from "./paths";
import { makeTranscriptTailer, runHistory } from "./transcript";
import { listBusinesses, listLines, newBusiness, newLine, newModule, linkModule, unlinkModule, rootSummary, deleteBusiness } from "./root";
import { listModuleSlugs, readModuleMeta, updateModuleMeta, moduleStatus } from "./module";
import { listAssistants, readAssistantMeta } from "./assistant";
import { readBusinessMeta, updateBusinessMeta } from "./meta";
import { recall, writeMemory } from "./memory";
import { buildSystemPrompt } from "./context";
import { validateMemoryWrite, readWorklogIndex, readWorklog, listRuns, deleteRun, setRunTitle, listDeliverables, readDeliverable } from "./governance";
import { hubIndex, hubFetchWorklog, hubPublishWorklog, hubFetchMemory, hubPublishMemory, hubPublishTranscript, hubManifest, readHubFile } from "./hub";
import { listSkills, skillFiles, readSkillFile } from "./skill";
import { listKnowledge, readKnowledgeFile, listLineKnowledge, readLineKnowledgeFile, KnowledgeLayerKind } from "./knowledge";
import { listRequirements, readRequirementDoc, ensureRequirement, setRequirementGoal, deleteRequirement, renameRequirement, nextRequirementId } from "./requirement";
import { buildBusinessSetupPrompt, buildKnowledgeRefreshSetupPrompt, buildNewSubscriptionSetupPrompt, buildModuleSetupPrompt } from "./prompts";
import { createSessionManager, makeSessionRegistry, SessionManager, BizSession, SessionEvent, SessionRegistry, Identity, ImageInput } from "./session";
import { fileScheduler } from "./scheduler-file";
import { dueWakeups, SchedulerStore } from "./schedule";
import { fileActiveTurnStore } from "./active-turns-file";
import { snapshotActiveTurns, recoverActiveTurns, ActiveTurnStore } from "./graceful";
import { parseScope } from "./scope";
import { Handler, toSSE, nodeListener } from "./http-adapter";

// web/ sits next to src/ (dev) and dist/ (built) — one level up, like prompts/.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

/** Read the root's `web` config block (port/host), with defaults. */
export function webConfig(root: string): { port: number; host: string } {
  let cfg: { web?: { port?: number; host?: string } } = {};
  try {
    cfg = JSON.parse(readFileOr(rootConfigPath(root)) || "{}");
  } catch {
    /* fall through to defaults */
  }
  return { port: cfg.web?.port ?? 4317, host: cfg.web?.host ?? "127.0.0.1" };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve a `task=` start param into a pre-seeded opening prompt, server-side (the prompt
 *  assembly — skeleton + name substitution + custom snippet — lives here, not in the client).
 *  This is the web counterpart of the CLI's task launchers (e.g. `biz setup`). Returns
 *  undefined for an unknown/absent task, so the session just opens empty. */
function taskPrompt(root: string, slug: string, task: string | undefined): string | undefined {
  if (!task) return undefined;
  // Module workspace (`mod:<line>:<mod>`): `setup` opens the guided module bootstrap — clone
  // the code, correct the record, seed the module CLAUDE.md — running in the module's OWN directory.
  // (Module setup used to run inside a host business; modules are many-to-many with businesses,
  // so the conversation lives with the module itself now.)
  const mw = parseModuleWorkspaceId(slug);
  if (mw) {
    if (task === "setup") return buildModuleSetupPrompt({ root, slug, mod: mw.mod, line: mw.line });
    return undefined;
  }
  if (task === "setup") {
    const meta = readBusinessMeta(root, slug);
    return buildBusinessSetupPrompt({ root, slug, name: meta.name, line: meta.line });
  }
  // `setup:knowledge-refresh` — UI 上"未配置自动更新"卡的"立即配置"按钮触发；走 subscriptions
  // skill 的两层保鲜模板写 knowledge-refresh.md。沿用 `setup:` 前缀（与 subscription: / pulse:
  // 一致），未来扩别的 setup 子类型按 `setup:<key>` 加分支即可。
  if (task === "setup:knowledge-refresh") {
    const meta = readBusinessMeta(root, slug);
    return buildKnowledgeRefreshSetupPrompt({ root, slug, name: meta.name, line: meta.line });
  }
  // `setup:new-subscription` — 业务订阅页 / 空 list 上的「新建订阅」入口，让 agent 问清楚要跑啥
  // 然后按 subscriptions skill 写文件。和 knowledge-refresh 同形：薄交互、SoT 在 skill 里。
  if (task === "setup:new-subscription") {
    const meta = readBusinessMeta(root, slug);
    return buildNewSubscriptionSetupPrompt({ root, slug, name: meta.name, line: meta.line });
  }
  return undefined;
}

/** A session's event stream, ended right after the terminal `closed` event (so SSE consumers
 *  don't hang on a finished session). */
async function* untilClosed(src: AsyncIterable<SessionEvent>): AsyncGenerator<SessionEvent> {
  for await (const ev of src) {
    yield ev;
    if (ev.type === "closed") return;
  }
}

/** Tail a run's transcript into events: wait for a source to exist, then project each new line.
 *  The source is the local jsonl via the `.transcript-path` pointer (a session on THIS machine),
 *  or the hub-pushed mirror (`.transcript.jsonl`) for a session running on another machine —
 *  the mirror grows by one chunk per remote Stop, so the live view updates per turn. Loops until
 *  the SSE consumer disconnects (toSSE calls the iterator's return()). */
async function* tailTranscript(runDir: string): AsyncGenerator<SessionEvent> {
  let tail: ReturnType<typeof makeTranscriptTailer> | null = null;
  for (;;) {
    if (!tail) {
      const p = readFileOr(path.join(runDir, ".transcript-path")).trim();
      const mirror = path.join(runDir, ".transcript.jsonl");
      if (p) tail = makeTranscriptTailer(p);
      else if (exists(mirror)) tail = makeTranscriptTailer(mirror);
    }
    if (tail) for (const ev of tail()) yield ev;
    await delay(600);
  }
}

/** content-type for a served deliverable file, keyed off its extension. Text kinds carry an
 *  explicit utf-8 charset; images get their MIME; everything else is octet-stream (downloads). */
function deliverableCtype(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const text: Record<string, string> = {
    md: "text/markdown", txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
    json: "application/json", html: "text/html", log: "text/plain", yaml: "text/plain", yml: "text/plain",
  };
  if (text[ext]) return `${text[ext]}; charset=utf-8`;
  const bin: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
  };
  return bin[ext] ?? "application/octet-stream";
}

/** The platform's routes as a framework-agnostic Fetch handler — no node:http here. The wakeup
 *  tick + session registry live in `createWebServer` (host concerns), not in routing; pass a
 *  configured `manager`/`registry` in. */
export function createBizHandler(o: {
  root: string;
  manager: SessionManager;
  registry: SessionRegistry;
  /** Extract the requesting user from a Request (e.g. a gateway-injected auth header). The
   *  result flows to the manager as the session's Identity → resolveAuth (per-user backend
   *  credentials) + attribution. Absent or returning undefined, sessions start identity-less
   *  (the manager's resolveAuth still runs, with `undefined`). */
  identify?: (req: Request) => Identity | undefined;
}): Handler {
  const { root, manager, registry, identify } = o;
  const track = registry.track;
  const html = readFile(path.join(WEB_DIR, "app.html"));
  const viewerHtml = readFile(path.join(WEB_DIR, "viewer.html"));

  const json = (code: number, obj: unknown) =>
    new Response(JSON.stringify(obj), { status: code, headers: { "content-type": "application/json" } });
  const text = (code: number, ctype: string, body: string) => new Response(body, { status: code, headers: { "content-type": ctype } });
  const fail = (code: number, message: string) => json(code, { error: message });
  const empty = (code: number) => new Response(null, { status: code });
  const wsExists = (slug: string) => {
    const aw = parseAssistantWorkspaceId(slug);
    if (aw) return exists(assistantConfigPath(root, aw.im));
    const mw = parseModuleWorkspaceId(slug);
    if (mw) return exists(moduleConfigPath(root, mw.line, mw.mod));
    return listBusinesses(root).some((w) => w.slug === slug);
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname, searchParams } = url;
    const method = req.method;
    // Resolved here (not inside /api/start, where a `req` search param shadows the Request).
    const identity = identify?.(req);

    if (method === "GET" && pathname === "/") return text(200, "text/html; charset=utf-8", html);

    // ── root-level read model ──
    // Liveness + a one-glance overview (root, biz version, business count).
    if (method === "GET" && pathname === "/api/health") return json(200, { ok: true, ...rootSummary(root) });
    // Active in-memory sessions (the platform's own concern; not durable across restarts).
    if (method === "GET" && pathname === "/api/sessions")
      return json(
        200,
        manager.list().map((s) => ({ id: s.id, business: s.business, runId: s.runId, claudeSessionId: s.claudeSessionId, usage: s.usage, req: s.req, busy: s.busy })),
      );

    // ── businesses collection ──
    // List the businesses the platform serves.
    // ── product lines ──
    if (method === "GET" && pathname === "/api/lines") return json(200, listLines(root));
    if (method === "POST" && pathname === "/api/lines") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await req.text()) as Record<string, unknown>;
      } catch {
        return fail(400, "invalid json body");
      }
      const line = String(body.line ?? "");
      if (!line) return fail(400, "missing line");
      const name = body.name === undefined || body.name === null ? undefined : String(body.name);
      try {
        return json(200, newLine({ root, line, name }));
      } catch (e) {
        return fail(400, e instanceof Error ? e.message : String(e));
      }
    }

    // ── modules (line-scoped, never cross lines): /api/lines/:line/modules[/:mod] ──
    if (pathname.startsWith("/api/lines/")) {
      const segs = pathname.split("/"); // ["", "api", "lines", line, "modules"|"knowledge", ...]
      const line = decodeURIComponent(segs[3] ?? "");

      // Line-scoped knowledge browse (read-only): the SHARED layers (line + common) — a
      // platform's 知识库 tab. A business's own docs live on /api/businesses/:slug/knowledge.
      if (segs[4] === "knowledge") {
        if (method === "GET" && segs[5] === "file") {
          const layer = searchParams.get("layer") ?? "line";
          if (!["line", "common"].includes(layer)) return fail(400, "invalid layer");
          try {
            const content = readLineKnowledgeFile(root, line, layer as "line" | "common", searchParams.get("path") ?? "");
            if (content === null) return fail(404, "no such file");
            return text(200, "text/markdown; charset=utf-8", content);
          } catch (e) {
            return fail(400, e instanceof Error ? e.message : String(e));
          }
        }
        // UI 出口 — `expand` 让 caliber/<table>.md 这类被 _index.md 折叠的子目录在浏览器里
        // 完整展开（launch index 仍走默认折叠以省 token，那条路径走 workspaceKnowledgeLayers）。
        if (method === "GET" && !segs[5]) return json(200, listLineKnowledge(root, line, { expand: true }));
        return fail(404, "not found");
      }

      if (segs[4] !== "modules") return fail(404, "not found");
      const mod = segs[5] ? decodeURIComponent(segs[5]) : undefined;

      // Meta + the derived workspace status (code cloned / CLAUDE.md seeded / scripts present) —
      // one shape for every module read, so card UIs can mark set-up modules without a
      // per-module round-trip.
      const withStatus = (ln: string, s: string, meta = readModuleMeta(root, ln, s)) => ({ ...meta, status: moduleStatus(root, ln, s) });

      // List the line's modules, metas resolved (= `biz module list --line`).
      if (method === "GET" && !mod) return json(200, listModuleSlugs(root, line).map((s) => withStatus(line, s)));

      // Create one in this line (= `biz module new`); the line is lazily created.
      if (method === "POST" && !mod) {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await req.text()) as Record<string, unknown>;
        } catch {
          return fail(400, "invalid json body");
        }
        const slug = String(body.slug ?? "");
        if (!slug) return fail(400, "missing slug");
        if (!body.type) return fail(400, "missing type");
        try {
          return json(
            200,
            newModule({
              root,
              line,
              slug,
              type: String(body.type),
              source: body.source ? String(body.source) : undefined,
              deploy: body.deploy ? String(body.deploy) : undefined,
            }),
          );
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }

      if (mod) {
        if (!listModuleSlugs(root, line).includes(mod)) return fail(404, "unknown module");
        // Module meta (= `biz module list` one entry) + the CLAUDE.md content (the module's
        // living knowledge doc) so a detail UI can show it without a second round-trip.
        if (method === "GET")
          return json(200, { ...withStatus(line, mod), claudeMdContent: readFileOr(path.join(moduleDir(root, line, mod), "CLAUDE.md")) });
        // Correct the recorded facts — type / source / deploy only (= `biz module set`).
        if (method === "PATCH") {
          let patch: Record<string, unknown>;
          try {
            patch = JSON.parse(await req.text()) as Record<string, unknown>;
          } catch {
            return fail(400, "invalid json body");
          }
          return json(200, withStatus(line, mod, updateModuleMeta(root, line, mod, patch)));
        }
      }
      return fail(404, "not found");
    }

    // ── skills (root-level, READ-ONLY by design — the platform displays, files are the SOT) ──
    if (method === "GET" && pathname === "/api/skills") return json(200, listSkills(root));
    if (method === "GET" && pathname.startsWith("/api/skills/")) {
      const segs = pathname.split("/"); // ["", "api", "skills", name, "file"?]
      const name = decodeURIComponent(segs[3] ?? "");
      try {
        if (segs[4] === "file") {
          const content = readSkillFile(root, name, searchParams.get("path") ?? "");
          if (content === null) return fail(404, "not found");
          return text(200, "text/plain; charset=utf-8", content);
        }
        if (!segs[4]) {
          const files = skillFiles(root, name);
          if (files === null) return fail(404, "unknown skill");
          const meta = listSkills(root).find((s) => s.id === name);
          return json(200, { id: name, name: meta?.name ?? name, description: meta?.description ?? "", files });
        }
      } catch (e) {
        return fail(400, e instanceof Error ? e.message : String(e));
      }
    }

    if (method === "GET" && pathname === "/api/businesses") return json(200, listBusinesses(root));
    // Create one (= `biz new`).
    if (method === "POST" && pathname === "/api/businesses") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await req.text()) as Record<string, unknown>;
      } catch {
        return fail(400, "invalid json body");
      }
      const slug = String(body.slug ?? "");
      if (!slug) return fail(400, "missing slug");
      if (!body.line) return fail(400, "missing line (a business must belong to a product line)");
      try {
        return json(
          200,
          newBusiness({
            root,
            slug,
            line: String(body.line),
            name: body.name as string | undefined,
            domain: body.domain as string | undefined,
          }),
        );
      } catch (e) {
        return fail(400, e instanceof Error ? e.message : String(e));
      }
    }

    // ── one business: /api/businesses/:slug[/(context|memory|worklog|deliverables)[/:runId]] ──
    // `slug` may also be a module workspace id (`mod:<line>:<mod>`) — module sessions reuse this
    // whole surface for their runs / worklogs / history; see the gate below.
    if (pathname.startsWith("/api/businesses/")) {
      const segs = pathname.split("/"); // ["", "api", "businesses", slug, sub?, runId?]
      const slug = decodeURIComponent(segs[3] ?? "");
      const sub = segs[4];
      if (!wsExists(slug)) return fail(404, "unknown business");

      // Module workspaces expose only the session surface (meta read + context preview + runs /
      // worklog / deliverables + memory read-write). Business-only concerns — meta patches,
      // module links, requirements, knowledge layers, the hub — stay business-scoped.
      const mw = parseModuleWorkspaceId(slug);
      if (mw) {
        if (method === "GET" && !sub) {
          const m = readModuleMeta(root, mw.line, mw.mod);
          return json(200, { name: m.slug, slug, line: mw.line, kind: "module", type: m.type, source: m.source, deploy: m.deploy });
        }
        const sessionSurface = sub === "context" || sub === "runs" || sub === "worklog" || sub === "deliverables" || sub === "memory";
        if (!sessionSurface) return fail(400, `not supported for a module workspace: ${sub ?? method}`);
      }

      // Assistant workspaces — same shape as modules (session surface only, no product-line ties).
      const aw = parseAssistantWorkspaceId(slug);
      if (aw) {
        if (method === "GET" && !sub) {
          const m = readAssistantMeta(root, aw.im);
          const claudeMdContent = readFileOr(path.join(assistantDir(root, aw.im), "CLAUDE.md"));
          return json(200, { name: m.name ?? m.slug, slug, im: m.im, kind: "assistant", claudeMdContent });
        }
        const sessionSurface = sub === "context" || sub === "runs" || sub === "worklog" || sub === "deliverables" || sub === "memory";
        if (!sessionSurface) return fail(400, `not supported for an assistant workspace: ${sub ?? method}`);
      }

      // Business metadata (= `biz show`).
      if (method === "GET" && !sub) return json(200, readBusinessMeta(root, slug));

      // Patch business metadata — native fields or the opaque `ext` bag (the embedding app's
      // per-business data). Body is a JSON patch; `ext` is deep-merged one level.
      if (method === "PATCH" && !sub) {
        let patch: Record<string, unknown>;
        try {
          patch = JSON.parse(await req.text()) as Record<string, unknown>;
        } catch {
          return fail(400, "invalid json body");
        }
        try {
          return json(200, updateBusinessMeta(root, slug, patch));
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }

      // Delete a business (removes its directory).
      if (method === "DELETE" && !sub) {
        try {
          deleteBusiness(root, slug);
          return empty(204);
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }

      // The system prompt biz would inject at launch (= `biz context`).
      if (method === "GET" && sub === "context")
        return text(200, "text/plain; charset=utf-8", buildSystemPrompt({ root, slug, runId: "<preview>" }));

      // The business's linked modules, metas resolved in its own line (saves the client a
      // per-module round-trip); POST links one more (= `biz link`, same line only).
      if (sub === "modules") {
        const meta = readBusinessMeta(root, slug);
        if (method === "GET")
          return json(200, (meta.modules ?? []).map((m) => ({ ...readModuleMeta(root, meta.line, m), status: moduleStatus(root, meta.line, m) })));
        if (method === "POST") {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(await req.text()) as Record<string, unknown>;
          } catch {
            return fail(400, "invalid json body");
          }
          const mod = String(body.module ?? "");
          if (!mod) return fail(400, "missing module");
          try {
            return json(200, { ...linkModule({ root, biz: slug, module: mod }), module: mod });
          } catch (e) {
            return fail(400, e instanceof Error ? e.message : String(e));
          }
        }
        // Unlink one (= `biz unlink`): drop it from modules[] + remove the symlink. The module
        // itself (line-level) is untouched.
        if (method === "DELETE" && segs[5]) {
          try {
            return json(200, { ...unlinkModule({ root, biz: slug, module: decodeURIComponent(segs[5]) }), module: decodeURIComponent(segs[5]) });
          } catch (e) {
            return fail(400, e instanceof Error ? e.message : String(e));
          }
        }
      }

      // Business memory: read (recall) / write (with governance).
      if (sub === "memory") {
        if (method === "GET") {
          return json(
            200,
            recall({
              root,
              slug,
              scope: (searchParams.get("scope") ?? undefined) as never,
              query: searchParams.get("query") ?? undefined,
            }),
          );
        }
        if (method === "POST") {
          // Module workspaces keep no memory records — their knowledge is CLAUDE.md.
          if (mw) return fail(422, "module workspaces keep no memory records — maintain the module's CLAUDE.md instead.");
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(await req.text()) as Record<string, unknown>;
          } catch {
            return fail(400, "invalid json body");
          }
          const memBody = String(body.body ?? "");
          // The description is the record's only line in the injected memory index. Like the
          // CLI, derive it from the body's first line when the caller doesn't pass one.
          const description = (typeof body.description === "string" && body.description.trim()) || memBody.split("\n")[0].trim();
          const scope = (body.scope as string | undefined) ?? "business";
          // Validate through the SAME governance the write hook enforces — the web API must not
          // be a backdoor around memory write rules.
          const content = fm.stringify({ scope, description: description || undefined }, memBody);
          const check = validateMemoryWrite({ root, filePath: path.join(memoryDir(root, slug), "_new.md"), content });
          if (!check.ok) return fail(422, check.reason ?? "rejected by memory governance");
          return json(
            200,
            writeMemory({
              root,
              slug,
              body: memBody,
              description,
              scope: scope as never,
              confidence: typeof body.confidence === "number" ? body.confidence : undefined,
              source_session: body.source_session as string | undefined,
            }),
          );
        }
      }

      // Knowledge browse (read-only — the skills stance: agents/curators write the files, the
      // platform only displays them). Listed per layer so the UI can label ownership.
      if (method === "GET" && sub === "knowledge") {
        if (segs[5] === "file") {
          const layer = searchParams.get("layer") ?? "business";
          if (!["business", "line", "common"].includes(layer)) return fail(400, "invalid layer");
          try {
            const content = readKnowledgeFile(root, slug, layer as KnowledgeLayerKind, searchParams.get("path") ?? "");
            if (content === null) return fail(404, "no such file");
            return text(200, "text/markdown; charset=utf-8", content);
          } catch (e) {
            return fail(400, e instanceof Error ? e.message : String(e));
          }
        }
        // UI 出口 — 同 line 端点：`expand` 让浏览器看到每张表的 md，不被 _index.md 折叠。
        if (!segs[5]) return json(200, listKnowledge(root, slug, { expand: true }));
      }

      // Requirements (multi-session tasks): id + status for a UI's grouping rail. The sessions of
      // a requirement are derived from each run's `req` field on /runs — never stored on the doc.
      if (method === "GET" && sub === "requirements") {
        // /requirements/:id — the requirement's living state document (markdown). Empty when it has
        // none yet; the sessions under it come from /runs (each run's `req`), not from here.
        if (segs[5]) return text(200, "text/markdown; charset=utf-8", readRequirementDoc(root, slug, decodeURIComponent(segs[5])) ?? "");
        return json(200, listRequirements(root, slug));
      }
      // Set the requirement's Goal (the HUMAN-owned section of the state doc — the session prompt
      // tells the agent not to rewrite a filled goal, so a UI edit lands here, never via chat).
      if (method === "PUT" && sub === "requirements" && segs[5] && segs[6] === "goal") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await req.text()) as Record<string, unknown>;
        } catch {
          return fail(400, "invalid json body");
        }
        try {
          setRequirementGoal({ root, slug, req: decodeURIComponent(segs[5]), goal: String(body.goal ?? "") });
          return json(200, { ok: true });
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }
      // Create a requirement (lazy: dir + skeleton state doc). A session started under a new `req`
      // also creates it, so this is just for a UI that makes one up front, before any chat.
      // `id` is optional — omit it to get an auto-allocated numeric id (the UI's default; titles
      // are how humans recognize requirements). `title` seeds the doc's `# heading` so the list
      // shows the human name without a follow-up edit; `goal` seeds the Goal section.
      if (method === "POST" && sub === "requirements") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await req.text()) as Record<string, unknown>;
        } catch {
          return fail(400, "invalid json body");
        }
        const requested = String(body.id ?? "").trim();
        const id = requested || nextRequirementId(root, slug);
        const title = typeof body.title === "string" ? body.title : undefined;
        try {
          ensureRequirement({ root, slug, req: id, title });
          if (typeof body.goal === "string" && body.goal.trim()) setRequirementGoal({ root, slug, req: id, goal: body.goal });
          return json(200, { id, status: "active" });
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }

      // Rename a requirement (PATCH {id}) — moves the directory and re-points every linked
      // run's `.req` marker. Validation (id shape, collision) throws back as a 400.
      if (method === "PATCH" && sub === "requirements" && segs[5]) {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await req.text()) as Record<string, unknown>;
        } catch {
          return fail(400, "invalid json body");
        }
        try {
          const to = String(body.id ?? "");
          renameRequirement({ root, slug, from: decodeURIComponent(segs[5]), to });
          return json(200, { id: to });
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }
      // Delete a requirement: its directory plus the linked runs' `.req` markers. The runs
      // themselves survive as req-less conversations — deleting a requirement never deletes chats.
      if (method === "DELETE" && sub === "requirements" && segs[5]) {
        try {
          deleteRequirement({ root, slug, req: decodeURIComponent(segs[5]) });
          return empty(204);
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }

      // Runs (= sessions) for a conversation-history list: runId + date/description + the
      // claudeSessionId to resume each.
      if (method === "GET" && sub === "runs") {
        // /runs/:runId/history — the run's conversation replayed from its transcript, as the
        // SessionEvent backlog a chat UI folds into state before attaching the live stream.
        if (segs[5] && segs[6] === "history") return json(200, runHistory(root, slug, decodeURIComponent(segs[5])));
        if (!segs[5]) return json(200, listRuns(root, slug));
      }
      // Rename one run (PATCH {description}) — a human display title stored as a `.title` marker,
      // never written into the agent's worklog. An empty description clears the title.
      if (method === "PATCH" && sub === "runs" && segs[5]) {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await req.text()) as Record<string, unknown>;
        } catch {
          return fail(400, "invalid json body");
        }
        try {
          setRunTitle({ root, slug, runId: decodeURIComponent(segs[5]), title: String(body.description ?? "") });
          return json(200, { ok: true });
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }
      // Delete one run (= one conversation): hard-removes its deliverables + worklog-index line.
      // Claude Code's jsonl transcript is left untouched (CC's SOT under ~/.claude, not ours).
      if (method === "DELETE" && sub === "runs" && segs[5]) {
        try {
          deleteRun(root, slug, decodeURIComponent(segs[5]));
          return empty(204);
        } catch (e) {
          return fail(400, e instanceof Error ? e.message : String(e));
        }
      }

      // Worklog: the session index, or one session's full worklog.
      if (sub === "worklog") {
        const runId = segs[5] ? decodeURIComponent(segs[5]) : undefined;
        if (method === "GET" && !runId) return json(200, readWorklogIndex(root, slug));
        if (method === "GET" && runId) {
          const wl = readWorklog(root, slug, runId);
          if (wl === null) return fail(404, "unknown worklog");
          return text(200, "text/markdown; charset=utf-8", wl);
        }
      }

      // A run's deliverable files (worklog + referenced artifacts).
      if (sub === "deliverables") {
        const runId = segs[5] ? decodeURIComponent(segs[5]) : undefined;
        // Filename can be a subpath like `apps/gomoku.html`. The client encodes the slash as %2F
        // (so it lands in segs[6]), but some reverse proxies decode %2F in the
        // path before forwarding, splitting the filename across segs[6..]. Rejoin defensively so
        // either path shape — encoded or decoded — resolves the same file.
        const filename = segs[6]
          ? segs.slice(6).map((s) => decodeURIComponent(s)).join("/")
          : undefined;
        // One file's raw bytes (the platform's file viewer); content-type by extension so the
        // browser/overlay can pick a renderer. Falls back to octet-stream for unknown kinds.
        if (method === "GET" && runId && filename) {
          const buf = readDeliverable(root, slug, runId, filename);
          if (!buf) return fail(404, "unknown deliverable");
          // Buffer → Uint8Array: a valid BodyInit (the DOM lib's BodyInit type excludes node Buffer).
          return new Response(new Uint8Array(buf), { status: 200, headers: { "content-type": deliverableCtype(filename) } });
        }
        if (method === "GET" && runId) return json(200, listDeliverables(root, slug, runId));
      }

      // ── hub: the platform side of remote sharing. index/worklog/memory serve httpRemote's
      // fixed contract (a local agent's hooks push/pull through these); manifest/file is the
      // read-only surface a local `biz pull` bootstraps from. Live data: a pushed worklog
      // lists immediately, a pushed memory record serves the platform's own sessions.
      if (sub === "hub") {
        const part = segs[5];
        const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

        if (method === "GET" && part === "index") return json(200, hubIndex(root, slug));

        if (method === "GET" && part === "worklog" && segs[6]) {
          try {
            const wl = hubFetchWorklog(root, slug, decodeURIComponent(segs[6]));
            if (wl === null) return fail(404, "unknown worklog");
            return text(200, "text/markdown; charset=utf-8", wl);
          } catch (e) {
            return fail(400, errMsg(e));
          }
        }

        if (method === "POST" && part === "worklog") {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(await req.text()) as Record<string, unknown>;
          } catch {
            return fail(400, "invalid json body");
          }
          const runId = String(body.runId ?? "");
          const line = String(body.line ?? "");
          const content = String(body.content ?? "");
          if (!runId || !line || !content) return fail(400, "missing runId/line/content");
          try {
            hubPublishWorklog(root, slug, { runId, line, content });
            return json(200, { ok: true });
          } catch (e) {
            return fail(400, errMsg(e));
          }
        }

        if (method === "POST" && part === "transcript") {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(await req.text()) as Record<string, unknown>;
          } catch {
            return fail(400, "invalid json body");
          }
          const runId = String(body.runId ?? "");
          const offset = body.offset;
          const content = typeof body.content === "string" ? body.content : "";
          if (!runId || typeof offset !== "number" || offset < 0 || !content) return fail(400, "missing runId/offset/content");
          try {
            const r = hubPublishTranscript(root, slug, { runId, offset, content });
            // applied=false → the chunk would leave a hole; 409 + the watermark we DO have, so
            // the pusher backs up to it and retries.
            return json(r.applied ? 200 : 409, { have: r.have });
          } catch (e) {
            return fail(400, errMsg(e));
          }
        }

        if (method === "GET" && part === "memory") return json(200, hubFetchMemory(root, slug));

        if (method === "POST" && part === "memory") {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(await req.text()) as Record<string, unknown>;
          } catch {
            return fail(400, "invalid json body");
          }
          const id = String(body.id ?? "");
          const content = String(body.content ?? "");
          if (!id || !content) return fail(400, "missing id/content");
          try {
            const r = hubPublishMemory(root, slug, { id, content });
            if (!r.ok) return fail(422, r.reason ?? "rejected by memory governance");
            return json(200, { ok: true });
          } catch (e) {
            return fail(400, errMsg(e));
          }
        }

        if (method === "GET" && part === "manifest") return json(200, hubManifest(root, slug));

        if (method === "GET" && part === "file") {
          try {
            const content = readHubFile(root, slug, searchParams.get("path") ?? "");
            if (content === null) return fail(404, "not found");
            return text(200, "text/plain; charset=utf-8", content);
          } catch (e) {
            return fail(400, errMsg(e));
          }
        }
      }

      return fail(404, "not found");
    }

    // ── sessions (SDK-backed) ──
    // Start a session in a business (or resume one by claudeSessionId); returns its id.
    if (method === "POST" && pathname === "/api/start") {
      const business = searchParams.get("business");
      if (!business || !wsExists(business)) return fail(404, "unknown business");
      const resume = searchParams.get("resume");
      const model = searchParams.get("model") ?? undefined;
      const req = searchParams.get("req") ?? undefined;
      // A pre-seeded opening task (e.g. ?task=setup runs the guided setup). Only meaningful on
      // a fresh start — a resume reattaches to an existing transcript, so the task is ignored there.
      // The raw task string is also recorded on the run (a `.task` marker) so a UI can re-enter it.
      const task = searchParams.get("task") ?? undefined;
      const prompt = taskPrompt(root, business, task);
      try {
        // Resuming a session that's already live (a user reconnecting / reopening from history) must
        // reuse it, not open a second query on the same transcript — converge via the registry.
        // Also converge a manager id (a client that mistook `id` for the resumable session id):
        // reattach while live instead of handing Claude Code an id it can't resume.
        const s = resume
          ? registry.get(resume) ?? manager.get(resume) ?? track(manager.resume({ business, claudeSessionId: resume, model, req, identity }))
          : track(manager.start({ business, model, req, prompt, task: prompt ? task : undefined, identity }));
        return json(200, { id: s.id, runId: s.runId, business, busy: s.busy });
      } catch (e) {
        // e.g. a malformed requirement id (it becomes a dir + branch name, so it's validated)
        return fail(400, e instanceof Error ? e.message : String(e));
      }
    }

    // Push one user turn.
    // The body is a BARE string for text-only turns (the unchanged wire format — zero regression).
    // A turn carrying inline images arrives as JSON {text, images:[{data, mediaType}]}; that shape
    // is recognized ONLY when `text` is a string AND `images` is a non-empty array of well-typed
    // entries — so a user message that happens to be valid JSON still goes through verbatim as text.
    if (method === "POST" && pathname === "/api/send") {
      const id = searchParams.get("id") ?? "";
      const s = manager.get(id);
      const raw = await req.text();
      if (!s) return empty(404);
      let text = raw;
      let images: ImageInput[] | undefined;
      try {
        const parsed = JSON.parse(raw) as { text?: unknown; images?: unknown };
        if (parsed && typeof parsed === "object" && typeof parsed.text === "string" && Array.isArray(parsed.images)) {
          const imgs = parsed.images.filter(
            (im): im is ImageInput => !!im && typeof im === "object" && typeof (im as ImageInput).data === "string" && typeof (im as ImageInput).mediaType === "string",
          );
          if (imgs.length > 0) { text = parsed.text; images = imgs; }
        }
      } catch { /* not JSON → a plain-text turn, the common case */ }
      if (process.env.BIZ_DEBUG) console.error(`[biz web] /api/send id=${id} found=${!!s} text=${JSON.stringify(text).slice(0, 120)} images=${images?.length ?? 0}`);
      s.send(text, images);
      return empty(204);
    }

    // Upload file(s) into a session's run dir so the agent can Read them. Multipart form-data with
    // one or more `file` parts; they land under .bizagent/deliverables/<runId>/uploads/ — the path
    // the agent reads RELATIVE to its cwd (the business dir). The caller cites the returned relative
    // paths in its next send() so the agent knows what to open. Uploads are INPUTS, not deliverables
    // (listDeliverables filters the uploads/ subdir out), so they never show as 交付物 chips.
    if (method === "POST" && pathname === "/api/upload") {
      const id = searchParams.get("id") ?? "";
      const s = manager.get(id);
      if (!s) return empty(404);
      let form: FormData;
      try { form = await req.formData(); } catch { return fail(400, "expected multipart/form-data"); }
      const files = form.getAll("file").filter((f): f is File => f instanceof File);
      if (files.length === 0) return fail(400, "no file part");
      const dir = path.join(deliverablesDir(root, s.business), s.runId, "uploads");
      mkdirp(dir);
      const saved: { name: string; path: string; size: number }[] = [];
      for (const f of files) {
        // Path-traversal guard: keep only the basename, restrict to a safe charset, strip leading
        // dots, cap length. A name collision just overwrites — fine for a re-upload.
        const base = (path.basename(f.name).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120)) || "file";
        fs.writeFileSync(path.join(dir, base), Buffer.from(await f.arrayBuffer()));
        saved.push({ name: base, path: `.bizagent/deliverables/${s.runId}/uploads/${base}`, size: f.size });
      }
      return json(200, { files: saved });
    }

    // Stop the in-flight turn (the UI's stop button). The session stays open for the next send.
    if (method === "POST" && pathname === "/api/interrupt") {
      const s = manager.get(searchParams.get("id") ?? "");
      if (!s) return empty(404);
      await s.interrupt();
      return empty(204);
    }

    // List a session's still-open background jobs (pending task cards for the UI).
    if (method === "GET" && pathname === "/api/jobs") {
      const s = manager.get(searchParams.get("id") ?? "");
      if (!s) return fail(404, "unknown session");
      return json(200, s.listJobs());
    }

    // Settle an open background job — a human click or a webhook. The result is injected into the
    // conversation as a new turn and the agent picks it up. The request body is the result text.
    if (method === "POST" && pathname === "/api/jobs/done") {
      const s = manager.get(searchParams.get("id") ?? "");
      const ticket = searchParams.get("ticket") ?? "";
      if (!s) return fail(404, "unknown session");
      const result = await req.text();
      if (!s.resolveJob(ticket, result)) return fail(404, "unknown or already-settled ticket");
      return empty(204);
    }

    // Stream a session's events as Server-Sent Events. A reconnect resumes from its
    // Last-Event-ID (standard SSE header; `after` query param as the curl-friendly alias):
    // only events newer than that cursor replay, so a dropped connection never re-delivers.
    if (method === "GET" && pathname === "/api/stream") {
      const s = manager.get(searchParams.get("id") ?? "");
      if (!s) return empty(404);
      const cursor = req.headers.get("last-event-id") ?? searchParams.get("after");
      const afterSeq = cursor != null && cursor !== "" && Number.isFinite(Number(cursor)) ? Number(cursor) : undefined;
      // keepAlive: an idle session emits nothing, and a byte-silent stream gets killed by
      // intermediaries — undici (a Next.js proxy in front) times the body out at 300s.
      return toSSE(untilClosed(s.subscribe(afterSeq === undefined ? undefined : { afterSeq })), { keepAliveMs: 25000 });
    }

    // ── live view: read-only fence mirror of a `biz run` (TUI) session ──
    // The terminal keeps Claude Code; this renders the conversation's fences in the browser by
    // tailing that session's transcript. Purely file-backed (decoupled from SessionManager), so it
    // works for a TUI run that has no in-memory session on this server.
    if (method === "GET" && pathname.startsWith("/run/")) {
      return text(200, "text/html; charset=utf-8", viewerHtml);
    }
    if (method === "GET" && pathname.startsWith("/api/run/") && pathname.endsWith("/stream")) {
      const segs = pathname.split("/"); // ["", "api", "run", slug, runId, "stream"]
      const slug = decodeURIComponent(segs[3] ?? "");
      if (!wsExists(slug)) return fail(404, "unknown business");
      // The transcript source appears on the agent's first turn (the inject hook records the
      // local pointer; a remote session's first pushed chunk creates the mirror); until then the
      // generator waits, then tails it — each new line projected into events. Keep-alive so an
      // idle proxy doesn't drop the connection while we wait for the first turn.
      const runDir = path.join(deliverablesDir(root, slug), decodeURIComponent(segs[4] ?? ""));
      return toSSE(tailTranscript(runDir), { keepAliveMs: 25000 });
    }

    return empty(404);
  };
}

/** Build the platform HTTP server over an existing (or fresh) SessionManager. Returns the
 *  server without listening — callers (or startWebServer) call `.listen`. */
export function createWebServer(o: { root: string; manager?: SessionManager; scheduler?: SchedulerStore; activeTurnStore?: ActiveTurnStore }): http.Server {
  const root = o.root;
  // The reference wakeup host: a file SchedulerStore + a 60s tick + a session registry. A
  // platform opts out by passing its own `manager` (configured with its own SchedulerStore) and
  // running its own scheduler — then this store sits idle.
  const scheduler = o.scheduler ?? fileScheduler(wakeupStorePath(root));
  const manager = o.manager ?? createSessionManager({ root, scheduler });

  // The live-session registry (bizagent helper): a wakeup resume and a user reconnect converge on
  // ONE query, never two parallel ones on the same transcript.
  const registry = makeSessionRegistry();
  // The tick the library deliberately does NOT own: fire due wakeups (reuse the live session if
  // any, else resume with the wake prompt as the next turn), retire exhausted chains. unref'd so
  // it never keeps the process alive; a platform runs its own loop instead.
  const tick = async () => {
    const now = Date.now();
    const { fire, exhausted } = dueWakeups(await scheduler.due(now), now);
    for (const r of fire) {
      registry.reuseOrResume(
        r.claudeSessionId,
        (s) => s.send(r.wakePrompt),
        () =>
          manager.resume({
            business: r.business,
            claudeSessionId: r.claudeSessionId,
            prompt: r.wakePrompt,
            wakeupChain: r.chainCount,
            scope: r.scopeKey ? parseScope(r.scopeKey) : undefined,
          }),
      );
      await scheduler.settle(r.id, "fired");
    }
    for (const r of exhausted) await scheduler.settle(r.id, "exhausted");
  };
  const timer = setInterval(() => void tick().catch((e) => console.error("[biz tick]", e instanceof Error ? e.message : e)), 60000);
  timer.unref();

  // Graceful restart (reference): on boot, resume whatever the previous process left mid-turn;
  // every 5s, snapshot the current mid-turn set so a crash/restart can recover it. A platform swaps
  // in its own ActiveTurnStore + loop (and its own drain). unref'd so the snapshot never keeps the
  // process alive.
  const turnStore = o.activeTurnStore ?? fileActiveTurnStore(activeTurnsPath(root));
  recoverActiveTurns({ manager, registry, store: turnStore, now: Date.now() });
  const snapTimer = setInterval(() => {
    try {
      turnStore.save(snapshotActiveTurns(manager.list(), Date.now()));
    } catch (e) {
      console.error("[biz snapshot]", e instanceof Error ? e.message : e);
    }
  }, 5000);
  snapTimer.unref();

  const handler = createBizHandler({ root, manager, registry });
  return http.createServer(nodeListener(handler));
}

/** Start the platform server, reading port/host from the root's `web` config unless overridden.
 *  Resolves once it's listening. */
export function startWebServer(o: {
  root: string;
  port?: number;
  host?: string;
  manager?: SessionManager;
}): Promise<{ server: http.Server; port: number; host: string }> {
  const defaults = webConfig(o.root);
  const port = o.port ?? defaults.port;
  const host = o.host ?? defaults.host;
  const server = createWebServer({ root: o.root, manager: o.manager });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port, host })));
}
