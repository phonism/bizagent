# Configuration

BizAgent works without configuration. To change a setting, add a row for the `bizagent` plugin to
your DSH profile's own patch file, `~/.dsh/profiles/web/cordis.patch.yml`, and restart DSH:

```yaml
- id: bizagent
  config:
    timeZone: Europe/Berlin
    owner: alice
```

Rows in this file are merged over the defaults that BizAgent's bundle inserts, so list only the
options you change.

## Plugin options

| Option | Default | Meaning |
| --- | --- | --- |
| `homeRoot` | `$DSH_HOME/bizagent` | Where the default Home and the pointer to the active organization live. |
| `defaultHome` | `personal:default` | Home for sessions that no other Home claims, before an organization exists. |
| `autoCreateDefaultHome` | `true` | Create `defaultHome` on first start when no organization exists. |
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
| `DSH_HOME` | DSH's data directory (default `~/.dsh`). BizAgent's default `homeRoot` lives inside it. |
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
curl -X POST http://127.0.0.1:<port>/api/bizagent/project-review \
  -H "Authorization: Bearer $(cat ~/.config/bizagent/human.token)" \
  -H "Origin: http://127.0.0.1:<port>" -H 'Content-Type: application/json' \
  -d '{"projectId":"<id>","claimId":"<claim>","expectedRevision":3,"decision":"accept","reason":"Checked."}'
```

`GET /api/bizagent/project-review?projectId=<id>` with the same header returns the current claim
id and revision.

## Hosts with their own login

Embedding BizAgent in another host, with real user accounts or notification channels, uses the
building blocks exported from `@bizagent/dsh/host`: route handlers for Project review, proposal
review, shared Knowledge review, and the human Inbox, each taking your own authentication and
authorization callbacks; runners for notifications and stalled conversations; and Home archive
export, verify, and import. Disable the local review row when you mount your own:

```yaml
- id: bizagent-local-human
  disabled: true
```
