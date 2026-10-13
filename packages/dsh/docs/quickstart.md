# Quick start

This guide installs BizAgent into the DSH web app, connects a model, and walks through the
sample team. It takes about fifteen minutes, most of it waiting for the model.

## 1. Install DSH and BizAgent

You need Node.js 22.19+ or 24+ and [pnpm](https://pnpm.io). DSH installs plugins with pnpm, so
`dsh plugin add` fails with "pnpm was not found" without it.

```sh
npm install --global @deepseek-ai/dsh@0.2.0-rc.2 pnpm
```

BizAgent is not on npm yet. Build the package from a checkout and add the tarball to the DSH `web`
profile:

```sh
git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci && npm run build && npm pack
dsh plugin --profile web add "$PWD"/bizagent-dsh-*.tgz
```

`dsh plugin add` also accepts the URL of a tarball, such as a release download. BizAgent targets
DSH `0.2.0-rc.2`. DSH checks plugin versions at startup and skips a plugin built for a different
DSH line, so keep the two in step.

## 2. Connect a model

The DSH web profile uses DeepSeek by default. Put your key in the environment, or in
`~/.dsh/.env`:

```sh
export DEEPSEEK_API_KEY=sk-...
```

To use another OpenAI-compatible model (vLLM, Ollama, a hosted API), add it in **Settings** in the
DSH web app, or add rows to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-model:
        displayName: My model
        apiKeyEnv: MY_MODEL_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        models:
          - id: Qwen/Qwen3.8-27B
            name: Qwen3.8 27B
            input: [text]
            contextWindow: 131072
            maxTokens: 16384
- id: agent-default-model
  config:
    provider: my-model
    model: Qwen/Qwen3.8-27B
```

BizAgent adds about 60 tools to each session, so the model should handle tool calling well and
have a context window of at least 32K tokens.

## 3. Start DSH

```sh
dsh --profile web
```

DSH prints a URL with a one-time login token and opens it in your browser. The browser keeps a
login cookie for 30 days. To open DSH in another browser, use the URL from the terminal. Anyone
signed in to DSH this way acts as you: they can chat with your agents and accept their results.

## 4. Try the sample team

Click **BizAgent organization** at the bottom left of DSH, then **Create sample team**. BizAgent
creates *Sample Shop* in your DSH workspace:

| Home | What it is |
| --- | --- |
| Growth lead (`personal:growth-lead`) | Starts and runs Projects |
| Data analyst (`personal:data-analyst`) | Owns metric definitions; has `orders.csv` in its directory |
| Growth, Analytics (`role:…`) | The roles the two members fill |
| Metric definitions (`capability:metrics`) | Shared definitions the team reuses |
| Sample Shop, Sample Shop PMO | The organization itself |

You own all of them. The Organization page then shows a five-minute guide. Each step has a
**Chat with …** button and a prompt to copy:

1. **Teach a team rule.** Tell the analyst that GMV excludes cancelled and refunded orders. It
   saves the rule in its Home. Open **Learning → Data analyst** to see it, with a link to the chat
   it came from.
2. **Start a Project.** Ask the growth lead to create the "Q3 GMV check" Project.
3. **Run it and accept the result.** In **Projects**, open the Project chat and ask it to run: it
   invites the analyst, hands over formal Work, and the analyst computes GMV in its own session
   from `orders.csv`. When the Project chat submits the result, accept it in **Projects**. The
   correct GMV is 400.50.
4. **Share what was learned.** Ask the analyst to propose the GMV rule to the Sample Shop Home,
   then accept the proposal under **Learning → Sample Shop**.

Every chat a step opens also appears in the DSH sidebar, in a workspace named after the Home.

## 5. Your own organization

Instead of the sample, the four-step setup asks for a name, a mission, members with roles, and
shared capabilities, then creates their Homes inside the DSH workspace you pick. A workspace holds
one BizAgent organization. To start over, move or delete the `bizagent` folder in that workspace
and restart DSH.

Outside an organization, every DSH session still gets a Home: `personal:default`, kept under
`~/.dsh/bizagent`.

## Where your data lives

- Homes are folders of Markdown and YAML under `<workspace>/bizagent/<organization>/homes/`. Each
  Home folder is also the working directory of that Home's chats, so files an agent writes while
  working (like `orders.csv`) sit next to its memory.
- Session bindings, proposals, Inbox mail, Work, Projects, and Worklogs live in DSH's own storage
  under `~/.dsh`. The original conversations are DSH sessions.

Copying the organization folder alone is not a full backup. The `bizagent` command in the package
exports and verifies Home files:

```sh
node lib/cli.js --root <workspace>/bizagent/<organization> archive export ./homes-backup
node lib/cli.js archive verify ./homes-backup
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `dsh: pnpm was not found` | Install pnpm: `npm install --global pnpm`. |
| No **BizAgent organization** entry in DSH | The terminal lists plugins that did not activate. Most often the DSH version differs from `0.2.0-rc.2`. |
| `BizAgent writer is already reserved` | Another DSH process runs BizAgent on the same `~/.dsh`. Run one at a time. |
| The analyst never starts on handed-over Work | Work starts on its own only between Homes with the same owner. Ask the analyst in its own chat to accept the Work. |
| No **Accept result** button | Open DSH from the URL the terminal printed (the browser needs its login), and check that you own the Project's lead Home. |
| Every turn fails with a model error | Check the model settings in DSH; the session's model needs tool calling. |

Next: [Concepts](concepts.md) explains what BizAgent keeps and why; [Configuration](configuration.md)
lists every option.
