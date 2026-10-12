# Security Policy

This policy covers the `@bizagent/dsh` DeepSeek Harness (DSH) plugin in this repository.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest 1.x minor release | Yes |
| Older 1.x minor releases | No. Upgrade to the latest 1.x minor. |
| 0.x alphas and release candidates | No |

Security fixes ship as a new patch release of the latest 1.x minor.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting:
open the **Security** tab of [github.com/phonism/bizagent](https://github.com/phonism/bizagent/security)
and choose **Report a vulnerability**. This creates a private Security Advisory that only the
maintainers can see.

Do not open a public issue, discussion, or pull request for an unfixed vulnerability.

A useful report includes:

- the plugin version and DSH version;
- the relevant setup: bind address, whether the local human host is enabled, and how
  `workspaceHomes` and Home owners are configured;
- steps to reproduce, and what an attacker gains.

## What to expect

- We aim to acknowledge a report within 5 business days.
- We aim to confirm or reject the issue, with an initial severity assessment, within 15 business days.
- For a confirmed issue we prepare a fix privately and release it as soon as practical, normally
  within 90 days of the report.
- We coordinate the disclosure date with the reporter and publish a GitHub Security Advisory when the
  fix is released. We credit reporters unless they prefer not to be named.

## Trust model

The plugin is built for one person using DSH on their own machine.

- DSH Web runs locally and binds `127.0.0.1`. Binding it to any other interface (for example
  `0.0.0.0`) is unsupported. The plugin's UI routes and local human routes refuse to start when
  DSH Web is not bound to `127.0.0.1`.
- Anyone who can reach the DSH port, and any code running as the same OS user, is trusted.
- Agents are not trusted to follow only your instructions. Any Agent may be prompt-injected.
- Content written by another Home (Inbox mail, Work requests, Project and Seat text, proposals) is
  lower-trust data for the Home that receives it.

## What the plugin aims to provide

- **Same-Home writes.** An Agent Session writes memory, knowledge, and Worklogs only to the Home its
  Session is bound to, and reads Session evidence only from Sessions bound to that Home.
- **Reviewed cross-Home changes.** Learning reaches another Home only as a proposal that the target
  Home's owner reviews.
- **Human-only Project acceptance.** Agents can request rework, but final Project acceptance goes
  through the local human route, which requires a Bearer token.
- **Integrity-checked snapshots.** Worklog, Work, and Project artifacts are stored as SHA-256-checked
  snapshots. Files are read without following symlinks and must still be the file that was checked.
- **Route guard.** Every HTTP route the plugin registers requires a loopback `Host`, rejects
  cross-site requests (`Sec-Fetch-Site: cross-site`), and requires a same-origin `Origin` for any
  request that changes state. This blocks DNS-rebinding and cross-site request attacks from web pages.
- **Owner-scoped automation.** Automatic worker Sessions and Inbox wake-ups start only between Homes
  that have the same explicit owner. Owner changes made by editing `home.yaml` are refused.
- **Labeled foreign text.** Text from another Home is shown to the model on a single line or inside
  a fenced block marked as data, not instructions.

## What it does not protect against

- **Agents running shell or file tools as your OS user.** DSH's `workspace-write` sandbox limits
  writes only. An Agent can read any file you can read, including other Homes, the ledgers, and the
  local human token file. Home isolation and human review are enforced by the plugin's own tools;
  they are cooperative rules, not OS security boundaries.
- **A same-user Agent using the local human token.** An Agent that reads the token file can call the
  human routes as you.
- **Malicious Home files.** A tampered `home.yaml`, `identity.md`, `organization.yaml`,
  `directory.yaml`, or an imported Home archive from an untrusted source. The plugin validates these
  files, but treats them as under your control.
- **Prompt injection in general.** Labeling and fencing reduce the risk, but a model can still follow
  injected text.
- **Network attackers** when DSH Web is exposed beyond loopback, which is unsupported.

## Operator guidance

- Keep DSH Web on `127.0.0.1`. For remote access, use SSH port forwarding instead of binding another
  interface.
- Keep the local human token file (`BIZAGENT_LOCAL_HUMAN_TOKEN_FILE`) at mode `0600`, owned by you,
  and outside every DSH Workspace and Home directory.
- Map `workspaceHomes` deliberately. Give Homes the same `owner` only when they should be able to
  start work in each other's mapped Workspaces.
- Review candidate memories and proposals before accepting them. Accepted text is shown to future
  Sessions of that Home.
- Do not import Home archives from sources you do not trust.
- Check `bizagent doctor` or the overview health after unexpected changes. Refused owner changes and
  other integrity problems are reported there.
