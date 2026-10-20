# Install and first success

[文档导航 / Documentation](README.md) · English | [中文](quickstart.zh-CN.md)

Already using BizAgent? Skip to [Use BizAgent](#use-bizagent).
This page gets you to one saved rule; configuration and architecture can wait.

## Install

Use Node.js 24+ or 22.19+ on the 22.x line, and pnpm 11. The commands below pin the DSH version
used in the manual browser acceptance run. Existing DSH users should first check `dsh --version`;
there is no need to replace a working installation just to try the plugin.

```sh
# Only if DSH / pnpm is not installed:
npm install --global @deepseek-ai/dsh@0.2.1-rc.2 pnpm@11

git clone https://github.com/phonism/bizagent.git
cd bizagent/packages/dsh
npm ci
npm run build
BIZAGENT_PACKAGE=$(npm pack --silent)
dsh plugin --profile web add "$PWD/$BIZAGENT_PACKAGE"
```

Installation, development dependencies, and CI use DSH `0.2.1-rc.2`, the same version used for
manual browser acceptance. See
[Verification](verification.md). Install into the same profile and `DSH_HOME` you intend to run.

## Connect a model and open DSH

For a new DSH process, configure the default DeepSeek provider before starting it:

```sh
export DEEPSEEK_API_KEY=sk-...
dsh --profile web
```

If DSH is already running, use its model/credential settings; exporting a variable in a new
terminal does not change the running process. The model must support tool calling and have room
for DSH's tools plus BizAgent's 59 tools. Other OpenAI-compatible endpoints are covered in
[Configuration](configuration.md#model-connection).

Open the login URL DSH prints in the terminal. **BizAgent organization** should appear in the
sidebar. If adding a plugin to a running profile, let DSH apply the profile change and refresh
the page. Consult the startup errors if the entry is missing; [troubleshooting](#troubleshooting)
does not require deleting existing data.

## Save your first rule

No organization is required:

1. Open **BizAgent organization → Learning → My personal Home → Chat**.
2. Send:

   > Remember this practice-only rule in this Home: for the fictional onboarding orders, GMV
   > includes paid orders and excludes cancelled and refunded orders. Save it, then tell me its
   > asset ID and status. Do not apply it as a real business policy.

3. Click the Home in the conversation header, or return to **Learning**. Expand the saved asset
   and check its body, source, and status. A success message in chat alone is not enough.
4. If it is `active`, start another DSH session **in that Home's workspace** and ask it to read
   the saved rule. Check the new session's Home. Clicking **Chat** again reopens the same
   Principal; it does not create a fresh session.

A `candidate` is saved for review but stays out of the default active index. Ask the agent to
review its evidence before publishing it. New sessions receive an asset index, not every full body.

## Use BizAgent

| What you want | Where to go | What to check |
| --- | --- | --- |
| Recall or inspect a rule | Home button → Learning | Body, evidence, active/candidate status |
| Borrow shared knowledge | Pick a shared Home from the composer's `@` suggestions | Frame bar; no independent worker is launched |
| Give another agent a deliverable | Ask for formal Work; open **Work & learning** | Assignee, work status, **View worker Session**, result |
| Accept a Project | Open the Project from **Work & learning**, or **Projects → My review queue** | Submitted claim, evidence, review reason, **Accept result** |
| Reply to an agent | **My Inbox** | Send a reply; check it returns to the originating session |

If no organization exists, **Create sample team** builds Sample Shop with a guide and an
`orders.csv`. Follow its four steps: teach the analyst a rule, ask the lead to create a Project,
open the Project's separate chat to dispatch Work, then inspect and accept its result. The sample
excludes cancelled/refunded orders and includes `shipped`: **120.50 + 45.25 + 200 + 34.75 = 400.50**.
You can then propose the rule to the Sample Shop Home and review it in Learning.

If an organization already exists, keep it. Open **Learning → Create Home** for practice agents,
or use your existing members. The [Chinese user guide](user-guide.zh-CN.md) supplies an isolated
four-order exercise with an expected total of **300**, including exact prompts and checkpoints.
To build your own organization on a fresh setup, choose the organization wizard instead of the sample.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| `pnpm was not found` | Install pnpm 11 and check it is on the DSH process's PATH. |
| No BizAgent sidebar entry | Confirm profile / `DSH_HOME`; inspect activation errors and the [tested versions](verification.md). |
| Writer already reserved | Check which process owns the data. Use a separate `DSH_HOME` **and** `BIZAGENT_HOME` for a sandbox; do not stop an unknown process. |
| Rule is missing | Check the Home, filters, and `candidate` status; inspect the save tool result. |
| No independent worker | Inspect Work status and launch errors; automatic execution requires the same owner. A Frame does not dispatch Work. |
| No Project or acceptance button | Return to the lead/project session, or use **My review queue**; verify login, ownership, a pending claim, and a filled review reason. |
| Wrong example total | Sample Shop is 400.50; the four-order exercise is 300. They use different orders and rules. |

Next: [Concepts](concepts.md) for the ownership model; [Configuration](configuration.md) for
custom settings, data locations, and backup scope.
