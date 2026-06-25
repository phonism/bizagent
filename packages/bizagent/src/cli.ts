// `biz` — a thin wrapper over the core pure functions. No business logic here,
// only argument parsing + printing. Each subcommand maps to one export from
// index.ts, so it stays feature-equivalent to the programmatic API.
import { parseArgs } from "node:util";
import path from "node:path";
import { exists } from "./fsutil";
import {
  initRoot,
  newBusiness,
  listBusinesses,
  rootSummary,
  newLine,
  listLines,
  listLineSlugs,
  newModule,
  linkModule,
  listModuleSlugs,
  readModuleMeta,
  updateModuleMeta,
  moduleWorkspaceId,
  buildModuleSetupPrompt,
  writeMemory,
  recall,
  promote,
  runAgent,
  startWebServer,
  buildSystemPrompt,
  buildBusinessSetupPrompt,
  readBusinessMeta,
  updateBusinessMeta,
  readWorklogIndex,
  readWorklog,
  listRuns,
  deleteRun,
  listSkills,
  validateMemoryWrite,
  guardHook,
  injectHook,
  stopHook,
  findRoot,
  findBusiness,
  businessDir,
} from "./index";

const argv = process.argv.slice(2);
const cmd = argv[0];

const HELP = `biz <command>

  (inside a business, bare \`biz\` launches the agent — like \`biz run\`)

  init [dir]                              initialize a root
       [--web] [--port N]                 also configure the web platform (biz web)
       [--remote file:DIR|http:URL]       also configure cross-user sharing (a platform)
  line new <line> [--name n]              create a product line (lines/<line>/: knowledge,
                                          modules, businesses); also lazily created on first use.
                                          --name sets the display name (line.json); re-running
                                          with --name names a pre-existing line
  line list                               list the root's product lines
  new <slug> --line <line> [--name n]     create a business inside a line
             [--domain d]
             [--module a,b]               link existing modules (same line) into the business
  module new <slug> --line <l> --type <t> create a shared module inside a line (never crosses lines)
             [--source "where"]           where the code lives, free text — the agent clones per it
             [--deploy "info"]
  module list [--line <l>]                list modules (all lines, or one)
  module set <mod> --line <l>             correct a module's recorded facts
             [--type --source --deploy]
  module setup <mod> [--line <l>]         guided module bootstrap, in conversation: clone the
                                          code per source, fix the record, seed the module
                                          CLAUDE.md (runs in the module's OWN workspace; --line
                                          only needed when several lines define the same slug)
  link <biz> <module>                     link a module into a business (many-to-many)
  run [slug] [--agent claude] [--view]
             [--req <id>]                 launch the agent in the business (cwd or <slug>);
                                          --req runs the session under a requirement (multi-
                                          session task: shared state doc + sibling worklogs);
                                          --view opens a browser that live-renders the chat's
                                          charts/tables (the terminal keeps the TUI)
             [-- <agent args>]            anything after -- is passed to the agent
  setup <slug> [--agent claude]            guided setup, in conversation: fill the business
                                          profile, register/link modules (clone their code),
                                          seed the knowledge base, mark what's left
  web [--port N] [--host h]               serve the whole root as a web platform
  mem add <slug> "body"                   write a business memory (with provenance)
          [--desc "one-line summary"]     the record's line in the injected memory index
          [--scope business] [--confidence 0.8] [--session id]
  mem list <slug>                         retrieve (naive filter)
          [--scope business] [--query text]
  context <slug>                          print the system prompt biz run injects
  ls                                      list the root's businesses
  show <slug>                             print a business's metadata
  set <slug> [--name --domain]            edit metadata or the opaque ext bag
             [--ext json]
  status                                  root overview (root, version, business count)
  worklog <slug> [runId]                  list session worklogs, or print one in full
  runs <slug> [--delete <runId>]          list a business's sessions, or delete one
  skills                                  list root-level skills (read-only; files are the SOT)
  hook guard   --business .              PreToolUse: enforce memory write governance
  hook inject  --business .              UserPromptSubmit: inject other sessions' new work
  hook stop    --business .              Stop: require the worklog, then index the session`;

/** `biz run [slug]` — resolve the business (positional slug from root, else cwd)
 *  and launch the agent there. Splits passthrough args after `--`. */
function runBusiness(args: string[]): never {
  const dashdash = args.indexOf("--");
  const ownArgs = dashdash === -1 ? args : args.slice(0, dashdash);
  const passthrough = dashdash === -1 ? [] : args.slice(dashdash + 1);
  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: {
      agent: { type: "string" },
      req: { type: "string" },
      view: { type: "boolean" },
      "view-port": { type: "string" },
    },
    allowPositionals: true,
  });

  let root: string;
  let slug: string;
  if (positionals[0]) {
    root = requireRoot();
    slug = positionals[0];
    if (!exists(businessDir(root, slug))) {
      console.error(`x no such business: ${slug}`);
      process.exit(1);
    }
  } else {
    const ws = findBusiness(process.cwd());
    if (!ws) {
      console.error("x run inside a business, or pass a slug: biz run <slug>");
      process.exit(1);
    }
    root = ws.root;
    slug = ws.slug;
  }
  process.exit(
    runAgent({
      root,
      slug,
      agent: values.agent as string | undefined,
      req: values.req as string | undefined,
      args: passthrough,
      view: values.view === true,
      viewPort: values["view-port"] ? Number(values["view-port"]) : undefined,
    }),
  );
}

function requireRoot(): string {
  const root = findRoot(process.cwd());
  if (!root) {
    console.error("x not inside a bizagent root. Run `biz init` first.");
    process.exit(1);
  }
  return root;
}

/** `biz setup <slug>` — guided business setup. Same launcher as `biz run`, but the session
 *  opens already working on the setup task: interview the user to fill the business profile,
 *  register/link modules (and clone their code), and seed the knowledge base. The agent
 *  researches what it can, asks the user about gaps, and lists what's still missing. */
function setupBusiness(args: string[]): never {
  const dashdash = args.indexOf("--");
  const ownArgs = dashdash === -1 ? args : args.slice(0, dashdash);
  const passthrough = dashdash === -1 ? [] : args.slice(dashdash + 1);
  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: { agent: { type: "string" } },
    allowPositionals: true,
  });
  const slug = positionals[0];
  if (!slug) {
    console.error("usage: biz setup <slug> [--agent claude] [-- <agent args>]");
    process.exit(1);
  }
  const root = requireRoot();
  if (!exists(businessDir(root, slug))) {
    console.error(`x no such business: ${slug}`);
    process.exit(1);
  }
  const meta = readBusinessMeta(root, slug);
  const initialPrompt = buildBusinessSetupPrompt({ root, slug, name: meta.name, line: meta.line });
  process.exit(
    runAgent({
      root,
      slug,
      agent: values.agent as string | undefined,
      args: passthrough,
      initialPrompt,
    }),
  );
}

function splitList(v?: string): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Parse a --remote CLI arg into a config block: `file:../hub` or `http:https://host/api`.
 *  The `module` tier (custom code) is set by editing the config, not a one-liner flag. */
function parseRemoteArg(v?: string): Record<string, unknown> | undefined {
  if (!v) return undefined;
  const i = v.indexOf(":");
  const kind = i === -1 ? v : v.slice(0, i);
  const rest = i === -1 ? "" : v.slice(i + 1);
  if (kind === "file" && rest) return { type: "file", dir: rest };
  if (kind === "http" && rest) return { type: "http", url: rest };
  console.error(`x bad --remote "${v}" (use file:DIR or http:URL)`);
  process.exit(1);
}

function rel(from: string, to: string): string {
  return path.relative(from, to) || ".";
}

/** Emit a Claude Code hook JSON response on stdout (the structured hook output contract). */
function emitHookJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/** Read a Claude Code hook event JSON from stdin. Returns {} when invoked manually. */
async function readHookInput(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  // Bare `biz` inside a business launches the agent; elsewhere shows help.
  if (!cmd) {
    if (findBusiness(process.cwd())) runBusiness([]);
    console.log(HELP);
    return;
  }
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "run":
      runBusiness(argv.slice(1));
      break;

    case "setup":
      setupBusiness(argv.slice(1));
      break;

    case "init": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        options: {
          web: { type: "boolean" },
          port: { type: "string" },
          remote: { type: "string" },
        },
        allowPositionals: true,
      });
      const root = path.resolve(positionals[0] ?? ".");
      const web = values.web || values.port ? { port: values.port ? Number(values.port) : undefined } : undefined;
      const remote = parseRemoteArg(values.remote as string | undefined);
      const r = initRoot({ root, web, remote });
      console.log(`ok  bizagent root initialized at ${r.root}`);
      r.created.forEach((c) => console.log(`  + ${c}`));
      if (web) console.log(`  + web platform configured (biz web)`);
      if (remote) console.log(`  + sharing configured (remote: ${remote.type})`);
      console.log(`\nnext:  biz new <slug> --line <product-line>`);
      break;
    }

    case "web": {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { port: { type: "string" }, host: { type: "string" } },
        allowPositionals: true,
      });
      const root = requireRoot();
      const { port, host } = await startWebServer({
        root,
        port: values.port ? Number(values.port) : undefined,
        host: values.host as string | undefined,
      });
      console.log(`bizagent web platform → http://${host}:${port}`);
      // Keep the process alive (startWebServer resolved once listening).
      break;
    }

    case "new": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        options: {
          line: { type: "string" },
          name: { type: "string" },
          domain: { type: "string" },
          module: { type: "string" },
        },
        allowPositionals: true,
      });
      const slug = positionals[0];
      if (!slug || !values.line) {
        console.error("usage: biz new <slug> --line <line> [--name n] [--domain d] [--module a,b]");
        if (slug && !values.line) console.error("x a business must belong to a product line (pass --line)");
        process.exit(1);
      }
      const root = requireRoot();
      const r = newBusiness({
        root,
        slug,
        line: values.line as string,
        name: values.name as string | undefined,
        domain: values.domain as string | undefined,
        modules: splitList(values.module as string | undefined),
      });
      console.log(`ok  business '${slug}' created at ${rel(root, r.dir)}`);
      if (r.lineCreatedLazily) console.log(`  (lazily created line '${values.line}')`);
      r.created.forEach((c) => console.log(`  + ${c}`));
      r.symlinks.forEach((s) => console.log(`  -> ${s}  (symlink)`));
      console.log(`\nnext:  biz setup ${slug}     guided setup — profile, modules, knowledge base`);
      console.log(`  or:  biz run ${slug}       start working right away`);
      break;
    }

    case "line": {
      const sub = argv[1];
      const root = requireRoot();
      if (sub === "new") {
        const { values, positionals } = parseArgs({
          args: argv.slice(2),
          options: { name: { type: "string" } },
          allowPositionals: true,
        });
        const line = positionals[0];
        if (!line) {
          console.error("usage: biz line new <line> [--name <display name>]");
          process.exit(1);
        }
        const r = newLine({ root, line, name: values.name as string | undefined });
        console.log(r.created ? `ok  line '${line}' created at ${rel(root, r.dir)}` : `line '${line}' already exists${values.name ? ` (name set to '${values.name}')` : ""}`);
        if (r.created) console.log(`\nnext:  biz new <slug> --line ${line}`);
      } else if (sub === "list") {
        const lines = listLines(root);
        if (!lines.length) console.log("(none)");
        lines.forEach((l) => console.log(l.name === l.slug ? `- ${l.slug}` : `- ${l.slug}  (${l.name})`));
      } else {
        console.error("line subcommands: new | list");
        process.exit(1);
      }
      break;
    }

    case "module": {
      const sub = argv[1];
      const root = requireRoot();
      if (sub === "new") {
        const { values, positionals } = parseArgs({
          args: argv.slice(2),
          options: { line: { type: "string" }, type: { type: "string" }, source: { type: "string" }, deploy: { type: "string" } },
          allowPositionals: true,
        });
        const slug = positionals[0];
        if (!slug || !values.type || !values.line) {
          console.error(
            'usage: biz module new <slug> --line <line> --type <strategy|backend|frontend|data|...> [--source "where the code lives"] [--deploy "info"]',
          );
          if (slug && !values.line) console.error("x a module must belong to a product line (pass --line)");
          process.exit(1);
        }
        const m = newModule({
          root,
          slug,
          line: values.line as string,
          type: values.type as string,
          source: values.source as string | undefined,
          deploy: values.deploy as string | undefined,
        });
        console.log(`ok  module '${slug}' created at ${rel(root, m.dir)}  (line=${m.line}, type=${values.type})`);
        m.created.forEach((c) => console.log(`  + ${c}`));
        if (values.source) {
          console.log(`\nthe agent will clone the code per --source; link with:  biz link <biz> ${slug}`);
        } else {
          console.log(`\nput the module's code (a git repo) in ${rel(root, m.dir)}/code/, then:  biz link <biz> ${slug}`);
        }
      } else if (sub === "list") {
        const { values } = parseArgs({ args: argv.slice(2), options: { line: { type: "string" } } });
        const lines = values.line ? [values.line as string] : listLineSlugs(root);
        let any = false;
        for (const line of lines) {
          for (const s of listModuleSlugs(root, line)) {
            any = true;
            const meta = readModuleMeta(root, line, s);
            const extras = [meta.source && `source: ${meta.source}`, meta.deploy && `deploy: ${meta.deploy}`].filter(Boolean);
            console.log(`- ${line}/${s}  (${meta.type})${extras.length ? `  ${extras.join("  ")}` : ""}`);
          }
        }
        if (!any) console.log("(none)");
      } else if (sub === "set") {
        const { values, positionals } = parseArgs({
          args: argv.slice(2),
          options: { line: { type: "string" }, type: { type: "string" }, source: { type: "string" }, deploy: { type: "string" } },
          allowPositionals: true,
        });
        const slug = positionals[0];
        if (!slug || !values.line) {
          console.error('usage: biz module set <mod> --line <line> [--type <t>] [--source "..."] [--deploy "..."]');
          process.exit(1);
        }
        const patch: Record<string, string> = {};
        if (values.type) patch.type = values.type as string;
        if (values.source) patch.source = values.source as string;
        if (values.deploy) patch.deploy = values.deploy as string;
        if (Object.keys(patch).length === 0) {
          console.error("x nothing to set (pass --type / --source / --deploy)");
          process.exit(1);
        }
        const meta = updateModuleMeta(root, values.line as string, slug, patch);
        console.log(`ok  module '${values.line}/${slug}' updated  (type=${meta.type})`);
      } else if (sub === "setup") {
        // Guided module bootstrap — runs in the module's OWN workspace (`mod:<line>:<mod>`).
        // Modules are many-to-many with businesses, so no business hosts the conversation; its
        // runs, worklogs and CLAUDE.md accumulate in the module directory, shared by every
        // linking business. The line is inferred when the slug is unique across lines; else --line.
        const dashdash = argv.indexOf("--");
        const ownArgs = (dashdash === -1 ? argv : argv.slice(0, dashdash)).slice(2);
        const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1);
        const { values, positionals } = parseArgs({
          args: ownArgs,
          options: { line: { type: "string" }, agent: { type: "string" } },
          allowPositionals: true,
        });
        const mod = positionals[0];
        if (!mod) {
          console.error("usage: biz module setup <mod> [--line <l>] [--agent claude] [-- <agent args>]");
          process.exit(1);
        }
        const lines = (values.line ? [values.line as string] : listLineSlugs(root)).filter((l) => listModuleSlugs(root, l).includes(mod));
        if (lines.length === 0) {
          console.error(`x no module '${mod}'${values.line ? ` in line '${values.line as string}'` : ""} — create it first: biz module new ${mod} --line <l> --type <t>`);
          process.exit(1);
        }
        if (lines.length > 1) {
          console.error(`x module '${mod}' exists in several lines (${lines.join(", ")}) — pick one with --line <l>`);
          process.exit(1);
        }
        const wsId = moduleWorkspaceId(lines[0], mod);
        const initialPrompt = buildModuleSetupPrompt({ root, slug: wsId, mod, line: lines[0] });
        process.exit(runAgent({ root, slug: wsId, agent: values.agent as string | undefined, args: passthrough, initialPrompt }));
      } else {
        console.error("module subcommands: new | list | set | setup");
        process.exit(1);
      }
      break;
    }

    case "link": {
      const root = requireRoot();
      const biz = argv[1];
      const mod = argv[2];
      if (!biz || !mod) {
        console.error("usage: biz link <biz> <module>");
        process.exit(1);
      }
      const r = linkModule({ root, biz, module: mod });
      console.log(`ok  linked module '${mod}' into business '${biz}'${r.symlinked ? "" : " (already linked)"}`);
      break;
    }

    case "mem": {
      const sub = argv[1];
      const root = requireRoot();
      if (sub === "add") {
        const { values, positionals } = parseArgs({
          args: argv.slice(2),
          options: {
            scope: { type: "string" },
            session: { type: "string" },
            confidence: { type: "string" },
            desc: { type: "string" },
          },
          allowPositionals: true,
        });
        const slug = positionals[0];
        const body = positionals.slice(1).join(" ");
        if (!slug || !body) {
          console.error('usage: biz mem add <slug> "memory body" [--desc "one-line summary"] [--scope business] [--confidence 0.8]');
          process.exit(1);
        }
        const scope = (values.scope as string | undefined) ?? "business";
        // Description is the record's only line in the injected memory index — default to the
        // body (one-liner records) so the CLI stays one command.
        const desc = ((values.desc as string | undefined) ?? body.split("\n")[0]).trim();
        const check = validateMemoryWrite({
          root,
          filePath: path.join(businessDir(root, slug), "memory", "_new.md"),
          content: `---\nscope: ${scope}\ndescription: ${desc}\n---\n\n${body}\n`,
        });
        if (!check.ok) {
          console.error(`x ${check.reason ?? "invalid memory"}`);
          process.exit(1);
        }
        const rec = writeMemory({
          root,
          slug,
          body,
          description: desc,
          scope: scope as never,
          source_session: values.session as string | undefined,
          confidence: values.confidence ? Number(values.confidence) : undefined,
        });
        console.log(`ok  wrote memory/${rec.id}.md  (scope=${rec.scope})`);
        console.log(`  (description joins the memory index on next \`biz run\`; the body is read on demand)`);
      } else if (sub === "list") {
        const { values, positionals } = parseArgs({
          args: argv.slice(2),
          options: { scope: { type: "string" }, query: { type: "string" } },
          allowPositionals: true,
        });
        const slug = positionals[0];
        if (!slug) {
          console.error("usage: biz mem list <slug> [--scope business] [--query text]");
          process.exit(1);
        }
        const recs = recall({
          root,
          slug,
          scope: values.scope as never,
          query: values.query as string | undefined,
        });
        if (recs.length === 0) console.log("(none)");
        recs.forEach((r) => console.log(`- [${r.scope}] ${r.body.split("\n")[0]}`));
      } else {
        console.error("mem subcommands: add | list");
        process.exit(1);
      }
      break;
    }

    case "context": {
      // Preview the system prompt that `biz run` would inject (all the important stuff).
      const root = requireRoot();
      const slug = argv[1];
      if (!slug) {
        console.error("usage: biz context <slug>");
        process.exit(1);
      }
      process.stdout.write(buildSystemPrompt({ root, slug, runId: "<runId>" }));
      break;
    }

    case "ls": {
      const root = requireRoot();
      const ws = listBusinesses(root);
      if (ws.length === 0) {
        console.log("(no businesses yet) — create one: biz new <slug> --line <line>");
        break;
      }
      ws.forEach((w) => {
        const name = w.name !== w.slug ? `  (${w.name})` : "";
        console.log(`- ${w.line}/${w.slug}${name}`);
      });
      break;
    }

    case "skills": {
      const root = requireRoot();
      const skills = listSkills(root);
      if (skills.length === 0) {
        console.log("(no skills) — drop Claude Code skill dirs under <root>/skills/<name>/SKILL.md");
        break;
      }
      skills.forEach((s) => {
        const display = s.name !== s.id ? ` (${s.name})` : "";
        const desc = s.description ? ` — ${s.description.split("\n")[0].slice(0, 100)}` : "";
        console.log(`- ${s.id}${display}${desc}`);
      });
      break;
    }

    case "show": {
      const root = requireRoot();
      const slug = argv[1];
      if (!slug) {
        console.error("usage: biz show <slug>");
        process.exit(1);
      }
      if (!exists(businessDir(root, slug))) {
        console.error(`x no such business: ${slug}`);
        process.exit(1);
      }
      const m = readBusinessMeta(root, slug);
      console.log(`name:      ${m.name}`);
      console.log(`slug:      ${m.slug}`);
      if (m.line) console.log(`line:      ${m.line}`);
      if (m.domain) console.log(`domain:    ${m.domain}`);
      if (m.modules?.length) console.log(`modules:   ${m.modules.join(", ")}`);
      if (m.ext) console.log(`ext:       ${JSON.stringify(m.ext)}`);
      console.log(`created:   ${m.createdAt}`);
      console.log(`updated:   ${m.updatedAt}`);
      break;
    }

    case "set": {
      const root = requireRoot();
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        options: {
          name: { type: "string" },
          domain: { type: "string" },
          ext: { type: "string" },
        },
        allowPositionals: true,
      });
      const slug = positionals[0];
      if (!slug) {
        console.error("usage: biz set <slug> [--name <s>] [--domain <s>] [--ext '<json>']");
        process.exit(1);
      }
      if (!exists(businessDir(root, slug))) {
        console.error(`x no such business: ${slug}`);
        process.exit(1);
      }
      const patch: Record<string, unknown> = {};
      if (values.name) patch.name = values.name as string;
      if (values.domain) patch.domain = values.domain as string;
      if (values.ext) {
        try {
          patch.ext = JSON.parse(values.ext as string);
        } catch {
          console.error("x --ext must be valid JSON");
          process.exit(1);
        }
      }
      if (Object.keys(patch).length === 0) {
        console.error("x nothing to set (pass --name / --domain / --ext)");
        process.exit(1);
      }
      updateBusinessMeta(root, slug, patch);
      console.log(`updated ${slug}`);
      break;
    }

    case "status": {
      const root = requireRoot();
      const s = rootSummary(root);
      console.log(`bizagent ${s.version}`);
      console.log(`root:       ${s.root}`);
      console.log(`businesses: ${s.businesses}`);
      break;
    }

    case "worklog": {
      const root = requireRoot();
      const slug = argv[1];
      if (!slug) {
        console.error("usage: biz worklog <slug> [runId]");
        process.exit(1);
      }
      if (!exists(businessDir(root, slug))) {
        console.error(`x no such business: ${slug}`);
        process.exit(1);
      }
      const runId = argv[2];
      if (runId) {
        const wl = readWorklog(root, slug, runId);
        if (wl === null) {
          console.error(`x no worklog for run: ${runId}`);
          process.exit(1);
        }
        process.stdout.write(wl);
      } else {
        const idx = readWorklogIndex(root, slug);
        if (idx.length === 0) console.log("(no worklogs yet)");
        idx.forEach((e) => console.log(`- ${e.date}  ${e.description}  · ${e.runId}`));
      }
      break;
    }

    case "runs": {
      const root = requireRoot();
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        options: { delete: { type: "string" } },
        allowPositionals: true,
      });
      const slug = positionals[0];
      if (!slug) {
        console.error("usage: biz runs <slug> [--delete <runId>]");
        process.exit(1);
      }
      if (!exists(businessDir(root, slug))) {
        console.error(`x no such business: ${slug}`);
        process.exit(1);
      }
      if (values.delete) {
        try {
          deleteRun(root, slug, values.delete as string);
          console.log(`removed session ${values.delete as string}`);
        } catch (e) {
          console.error(`x ${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
        break;
      }
      const runs = listRuns(root, slug);
      if (runs.length === 0) console.log("(no sessions yet)");
      runs.forEach((r) => console.log(`- ${r.date || r.runId}  ${r.description || "(no worklog)"}  · ${r.claudeSessionId ?? "—"}`));
      break;
    }

    case "hook": {
      // Invoked by Claude Code hooks (or manually). Resolves the business from cwd
      // (settings wire `--business .`, and claude/SDK run with cwd = business dir).
      const sub = argv[1];
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { business: { type: "string" } },
        allowPositionals: true,
      });
      const cwd = path.resolve((values.business as string) ?? ".");
      const input = await readHookInput();

      // Decisions live in hooks.ts (shared with the SDK runtime); here we only translate
      // them to Claude Code's JSON wire format.
      if (sub === "guard") {
        const ti = (input.tool_input as Record<string, unknown> | undefined) ?? {};
        const out = guardHook({
          cwd,
          toolName: input.tool_name as string | undefined,
          filePath: ti.file_path as string | undefined,
          content: typeof ti.content === "string" ? ti.content : undefined,
          oldString: typeof ti.old_string === "string" ? ti.old_string : undefined,
          newString: typeof ti.new_string === "string" ? ti.new_string : undefined,
        });
        if (out) {
          emitHookJson({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: out.deny },
          });
        }
        process.exit(0);
      }

      if (sub === "inject") {
        const out = await injectHook({ cwd, runId: process.env.BIZ_RUN_ID, transcriptPath: input.transcript_path });
        // additionalContext is the inject channel; Claude Code wraps it in a <system-reminder>.
        if (out) emitHookJson({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: out.context } });
        process.exit(0);
      }

      if (sub === "stop" || sub === "index") {
        // `index` is a plain re-index (no worklog enforcement) -> omit runId.
        const out = await stopHook({
          cwd,
          runId: sub === "stop" ? process.env.BIZ_RUN_ID : undefined,
          stopActive: input.stop_hook_active === true,
        });
        if ("block" in out) {
          emitHookJson({ decision: "block", reason: out.block });
        } else if (out.indexed) {
          process.stderr.write(`bizagent: indexed ${out.indexed} session(s).\n`);
        }
        process.exit(0);
      }

      if (sub === "promote") {
        // Optional: distill this business's unpromoted worklogs into business memory.
        const ws = findBusiness(cwd);
        if (ws) {
          const r = promote({ root: ws.root, slug: ws.slug });
          if (r.promoted.length) {
            process.stderr.write(
              `bizagent: promoted ${r.promoted.length} record(s) from ${r.worklogs.length} worklog(s) into business memory.\n`,
            );
          }
        }
        process.exit(0);
      }

      console.error("hook subcommands: guard | inject | stop | index | promote");
      process.exit(1);
      break;
    }

    default:
      console.log(HELP);
  }
}

// Core functions throw plain Errors (duplicate slug, cross-line link, missing root...);
// surface them as one clean line, not a stack trace.
main().catch((e: unknown) => {
  console.error(`x ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
