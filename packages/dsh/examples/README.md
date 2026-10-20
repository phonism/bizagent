# Learning Lab

Three scripted cases that run BizAgent's real learning and collaboration services without a model
or a DSH process. Use them to see what BizAgent records, step by step, in a few seconds.

| Case | From → to | What is learned |
| --- | --- | --- |
| `growth` | Personal analyst → Role `growth-strategy` | A retention comparison method with stated limits |
| `engineering` | Personal developer → Capability `config-review` | A method for verifying backups before configuration changes |
| `support` | Personal support agent → Business `demo-store` | Product knowledge tied to a product version |

The cases and their wording are fictional teaching material, not real business policies.

## Run

```sh
cd packages/dsh
npm ci
npm run examples                 # all three cases
npm run examples -- growth       # one case
node examples/learning-lab.mjs   # after a build, or from an unpacked tarball
```

Each case uses a fresh temporary directory, removes it afterwards, and prints eleven checks:

```text
[growth] Growth analysis: comparable retention cohorts
  1. Candidate saved; default search excludes it; source evidence is readable.
  2. Stale publication rejected; the reviewed revision is now active.
  3. Agents cannot approve; a host-authenticated human accepts; replay creates no duplicate.
  4. A read-only Agent Frame reuses the target index without changing the author Home.
  5. Future context contains only the index; feedback requests review; owner retires the asset.
  6. Home files reload correctly; retirement does not alter the author's copy.
  7. Review progress is explicit; later Session changes remain pending after a ledger reopen.
  8. Inbox delivery, reply, and handling survive a ledger reopen without changing Work or Memory.
  9. Formal Work binds one worker Session and one returned result beyond ordinary Inbox replies.
  10. Project submission records linked Work and a human acceptance across ledger reopen.
  11. Session Worklog links formal Work, verifies source events, and tracks a Workspace file.
...
Learning lab passed: 3 scenarios. Temporary data removed.
```

## What is real here

| Part | In the lab | Covers |
| --- | --- | --- |
| Home files | Real `HomeStore` on a temporary directory | Candidates, revisions, index, retirement, reload |
| BizAgent service | Real | Ownership, revision conflicts, proposals, feedback, Inbox, Work, Projects, Worklogs |
| Ledgers | Real schemas and logic over in-memory tables | Records within one process; not persistence across processes |
| DSH sessions | Small synthetic event logs | Evidence references and bounded reads |
| Model and data | None; fixed fixtures | Not whether a model calls the tools well |

To see the same loops with a real model, follow the sample team in the
[quick start](../docs/quickstart.md#use-bizagent).

## Read the code

- [learning-lab.mjs](learning-lab.mjs): the eleven steps in order, each with assertions.
- [scenarios.mjs](scenarios.mjs): inputs and reviewed text for the three cases.
- [demo-runtime.mjs](demo-runtime.mjs): the in-memory stand-in for DSH storage and sessions.

The lab imports internal modules from `lib/` to show the current implementation; they are not a
stable API. Agents use the [tools](../docs/tools.md); hosts use the package entry points listed in
the [package README](../README.md#package-entry-points).
