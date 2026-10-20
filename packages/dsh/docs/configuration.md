# Configuration

New users can follow the [quick start](quickstart.md) without editing configuration.
This page is the reference for model connections, custom settings, and data locations.

## Model connection

For another OpenAI-compatible endpoint, use DSH's model settings or add provider rows to
`$DSH_HOME/profiles/web/cordis.patch.yml` (`DSH_HOME` defaults to `~/.dsh`):

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
          - id: your-model-id
            name: My model
            input: [text]
            contextWindow: 131072
            maxTokens: 16384
- id: agent-default-model
  config:
    provider: my-model
    model: your-model-id
```

Replace the URL, model ID, limits, and modalities with the endpoint's actual capabilities. Provide
`MY_MODEL_KEY` through DSH's credentials or the environment of a new DSH process. Selecting a
model in DSH can also save its default; check that default before starting automatic Work.

## Applying changes

Add only the options you change to the profile patch. For example:

```yaml
- id: bizagent
  config:
    timeZone: Europe/Berlin
    owner: alice
```

Rows merge over the bundle defaults. DSH Web profiles with HMR can apply profile changes and
reload changed plugins without restarting the main process. Disabled HMR, headless profiles, or
host dependency changes may require a planned restart. Let active work settle and inspect DSH's
reload result rather than assuming an edit has taken effect.

## Plugin options

| Option | Default | Meaning |
| --- | --- | --- |
| `homeRoot` | `$BIZAGENT_HOME`, else `~/BizAgent` | BizAgent's data folder: your personal Homes, the pointer to the active organization, and organizations under `orgs/`. Data from before 1.0 at `$DSH_HOME/bizagent` keeps being used until you move it. |
| `defaultHome` | `personal:default` | Your personal Home: it takes every session that no other Home claims, with or without an organization. |
| `autoCreateDefaultHome` | `true` | Create `defaultHome` in `homeRoot` on first start. |
| `defaultIdentity` | (none) | Text for the default Home's `identity.md` when BizAgent creates it. |
| `owner` | `$BIZAGENT_LOCAL_HUMAN_ID`, else your OS user name | The person who owns Homes BizAgent creates: the default Home, organizations, and Homes added in the panel. |
| `timeZone` | the host's time zone | IANA zone for cron schedules and daily limits, such as `Asia/Shanghai`. |
| `workspaceHomes` | `{}` | Extra directories mapped to Homes, as `{ "/path/to/repo": "role:engineering" }`. A session started in a mapped directory binds to that Home, and Work or Inbox wake-ups for that Home start there instead of in its own folder. |
| `identityMaxBytes` | `6144` | Most bytes of `identity.md` placed in a session's Home snapshot. |
| `indexMaxBytes` | `16384` | Most bytes of the asset index placed in a session's Home snapshot. |
| `learningCheckpointEnabled` | `true` | After a turn with an explicit correction, ask the agent once whether to keep it. |
| `learningSchedulerEnabled` | `false` | Run the `learningSchedules` below. Enable it on one DSH process per profile only. |
| `learningSchedules` | `[]` | Scheduled learning reviews; see below. |

### Scheduled learning reviews

A schedule starts a separate learning session in a Home when there is unreviewed material:

```yaml
- id: bizagent
  config:
    learningSchedulerEnabled: true
    workspaceHomes:
      /home/alice/work/analytics: role:analytics
    learningSchedules:
      - home: role:analytics
        cron: '0 3 * * *'      # every day at 03:00 in timeZone
        model: deepseek-flash  # add provider: <id> to pick a provider
        dailyRuns: 1           # 1 to 4
```

Each scheduled Home needs exactly one directory in `workspaceHomes`. The Home's page under
**Learning** then shows the schedule; its owner can pause it or change the time and daily runs
within the limits above.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `BIZAGENT_HOME` | BizAgent's data folder when `homeRoot` is not set (default `~/BizAgent`). Isolated runs set it next to their own `DSH_HOME`. |
| `DSH_HOME` | DSH's data directory (default `~/.dsh`). Holds sessions and BizAgent's ledgers. |
| `BIZAGENT_LOCAL_HUMAN_ID` | Your user id for owning Homes and reviewing, if it should differ from your OS user name. Letters, digits, `.`, `_`, `-`. |
| `BIZAGENT_LOCAL_HUMAN` | Set to `off` to disable the local review routes (Project acceptance, proposal decisions, My Inbox). |
| `BIZAGENT_LOCAL_HUMAN_TOKEN_FILE` | A private (mode 0600) file holding a 32 to 512 character token. Scripts can then call the review routes with `Authorization: Bearer <token>`. Not needed in the browser. |
| `BIZAGENT_LOCAL_PLATFORM_ADMIN` | Set to `1` to let the local owner review platform-wide shared Knowledge. |

## Local review

The `bizagent-local-human` plugin row (inserted by BizAgent's bundle) serves the routes behind
**Accept result**, proposal decisions, and **My Inbox**. In the DSH web app the person signed in
to DSH is the reviewer, acting as `owner`, so nothing needs to be set up. These routes only run
when DSH Web listens on `127.0.0.1`, which is the DSH default.

To accept a Project from a script, set `BIZAGENT_LOCAL_HUMAN_TOKEN_FILE` before starting DSH and
send the token:

```sh
curl -X POST 'http://127.0.0.1:<port>/api/bizagent/project-review' \
  -H "Authorization: Bearer $(cat ~/.config/bizagent/human.token)" \
  -H "Origin: http://127.0.0.1:<port>" -H 'Content-Type: application/json' \
  -d '{"projectId":"<id>","claimId":"<claim>","expectedRevision":3,"decision":"accept","reason":"Checked."}'
```

`GET /api/bizagent/project-review?projectId=<id>` with the same header returns the current claim
id and revision.

## Data and backups

- Home files live in `~/BizAgent` (or `homeRoot` / `BIZAGENT_HOME`): your outside personal Homes
  under `homes/`, and organization Homes under `orgs/<id>/homes/`. A Home folder is also its
  normal chat/worker directory, unless an explicit workspace mapping is configured.
- Bindings, proposals, Inbox, Work, Projects, and Worklogs live in DSH storage under `DSH_HOME`.
  Original conversations are DSH sessions. Retained artifact snapshots belong to the Home's data space.

An organization directory alone is not a full backup. Preserve both the Home data and the matching
DSH data. The Home archive commands verify the file portion; from `packages/dsh`:

```sh
BIZAGENT_ORG_ROOT="$HOME/BizAgent/orgs/your-organization"
node lib/cli.js --root "$BIZAGENT_ORG_ROOT" archive export ./homes-backup
node lib/cli.js archive verify ./homes-backup
```

One organization is active at a time. There is no general organization-switching UI in this
version. Keep the current organization when trying practice Homes; do not delete its directory
or active pointer as an onboarding step. For a separate sandbox, use new, matching `DSH_HOME`
and `BIZAGENT_HOME` directories and leave the existing instance intact.

## Hosts with their own login

Embedding BizAgent in another host, with real user accounts or notification channels, uses the
building blocks exported from `@bizagent/dsh-plugin/host`: route handlers for Project review, proposal
review, shared Knowledge review, and the human Inbox, each taking your own authentication and
authorization callbacks; runners for notifications and stalled conversations; and Home archive
export, verify, and import. Disable the local review row when you mount your own:

```yaml
- id: bizagent-local-human
  disabled: true
```
