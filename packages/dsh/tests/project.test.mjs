import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'
import { projectSnapshotPath, workSnapshotPath } from '../lib/worklog-snapshot.js'
import { FormalProjectSchema } from '../lib/project-ledger.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'

test('Project claim retains exact artifact bytes and requires evidence before acceptance', async t => {
  const root = await makeTempDir('bizagent-project-artifact-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'artifacts'), { recursive: true })
  await writeFile(join(workspace, 'artifacts', 'result.md'), 'Version one\n')
  await writeFile(join(root, 'outside.md'), 'outside')
  await symlink(join(root, 'outside.md'), join(workspace, 'artifacts', 'linked.md'))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'bob'), address: 'personal:bob' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const alice = runtime.agent('artifact-lead', workspace, 'Prepare project result.')
  const bob = runtime.agent('artifact-other', join(root, 'bob'), 'Inspect another Home.')
  const project = (await service.createProject(alice, {
    title: 'Artifact delivery', goal: 'Deliver a file.', doneWhen: 'A reviewable file exists.',
    idempotencyKey: 'artifact-delivery',
  })).project
  const input = { projectId: project.id, summary: 'File ready', body: 'See the retained file.',
    doneWhenAssessment: 'The file is complete.' }
  await assert.rejects(() => service.submitProject(alice, input), /retained artifact or a delivered formal Work result/)
  await assert.rejects(() => service.submitProject(alice, { ...input,
    artifactRefs: ['../outside.md'] }), /canonical under artifacts/)
  await assert.rejects(() => service.submitProject(alice, { ...input,
    artifactRefs: ['artifacts/linked.md'] }), /symlink/)
  const submitted = await service.submitProject(alice, { ...input,
    artifactRefs: ['artifacts/result.md'] })
  const artifact = submitted.claim.artifacts[0]
  assert.equal(artifact.snapshot, true)
  assert.equal(artifact.bytes, 12)
  await writeFile(join(workspace, 'artifacts', 'result.md'), 'Version two\n')
  assert.equal((await service.submitProject(alice, { ...input,
    artifactRefs: ['artifacts/result.md'] })).idempotentReplay, true)
  const page = await service.readProjectArtifact(alice, { projectId: project.id,
    claimId: submitted.claim.id, path: artifact.path, limit: 7 })
  assert.equal(Buffer.from(page.contentBase64, 'base64').toString(), 'Version')
  const rest = await service.readProjectArtifact(alice, { projectId: project.id,
    claimId: submitted.claim.id, path: artifact.path, offset: page.nextOffset })
  assert.equal(Buffer.from(rest.contentBase64, 'base64').toString(), ' one\n')
  await assert.rejects(() => service.readProjectArtifact(bob, { projectId: project.id,
    claimId: submitted.claim.id, path: artifact.path }), /not visible/)
  const authorizeOutcome = (principal, current) => principal === 'owner-user'
    && current.lead === project.lead
  const outcomeInbox = await service.listPendingProjectOutcomeReviewsAsHuman('owner-user',
    authorizeOutcome)
  assert.deepEqual(outcomeInbox.items.map(item => [item.projectId, item.claimId]),
    [[project.id, submitted.claim.id]])
  assert.equal(outcomeInbox.items[0].doneWhenAssessment, submitted.claim.doneWhenAssessment)
  assert.deepEqual(outcomeInbox.items[0].artifacts.map(item => item.sha256), [artifact.sha256])
  assert.deepEqual((await service.listPendingProjectOutcomeReviewsAsHuman('other-user',
    authorizeOutcome)).items, [])
  assert.deepEqual((await service.listPendingProjectOutcomeReviewsAsHuman('owner-user',
    authorizeOutcome, 1)).items, [])
  const snapshotFile = join(root, projectSnapshotPath(artifact.sha256))
  await writeFile(snapshotFile, 'damaged')
  await assert.rejects(() => service.reviewProjectAsHuman('owner-user', { projectId: project.id,
    claimId: submitted.claim.id, decision: 'accept', reason: 'Reviewed.',
    expectedRevision: submitted.project.revision }, authorizeOutcome),
  /missing, oversized, or changed|checksum mismatch/)
  await writeFile(snapshotFile, 'Version one\n')
  const humanInput = { projectId: project.id, claimId: submitted.claim.id,
    expectedRevision: submitted.project.revision, decision: 'accept', reason: 'Reviewed the retained file.' }
  await assert.rejects(() => service.reviewProjectAsHuman('owner-user', humanInput,
    () => false), /not authorized/)
  await assert.rejects(() => service.reviewProjectAsHuman('owner-user', {
    ...humanInput, expectedRevision: project.revision }, () => true), /revision conflict/)
  const accepted = await service.reviewProjectAsHuman('owner-user', humanInput,
    (_actor, current) => current.lead === project.lead)
  assert.equal(accepted.project.status, 'accepted')
  assert.equal(accepted.review.reviewedByPrincipal, 'owner-user')
  assert.equal(accepted.review.reviewedBySessionId, undefined)
  assert.deepEqual((await service.listPendingProjectOutcomeReviewsAsHuman('owner-user',
    authorizeOutcome)).items, [])
  FormalProjectSchema.parse(accepted.project)
  assert.throws(() => FormalProjectSchema.parse({ ...accepted.project,
    reviews: [{ ...accepted.review, reviewedBySessionId: 'forged-session' }] }),
  /exactly one Session or human principal/)
  await service.close()
})

test('Project Seat invitation is durable, grants scoped reads, and never accepts Work', async t => {
  const root = await makeTempDir('bizagent-project-seat-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  await store.createHome({ address: 'role:reviewer' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [
      { root: join(root, 'reviewer'), address: 'role:reviewer' },
      { root: join(root, 'bob'), address: 'personal:bob' },
    ],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('seat-lead', root, 'Lead the project.')
  const reviewer = runtime.agent('seat-reviewer', join(root, 'reviewer'), 'Join the project.')
  const bob = runtime.agent('seat-bob', join(root, 'bob'), 'Inspect the project.')
  const project = (await service.createProject(lead, {
    title: 'Scoped review', goal: 'Review source fields.', doneWhen: 'Fields are documented.',
    idempotencyKey: 'seat-review',
  })).project
  await assert.rejects(() => service.readProject(reviewer, project.id), /not visible/)
  await assert.rejects(() => service.inviteProjectSeat(bob, {
    projectId: project.id, homeAddress: 'role:reviewer', responsibility: 'Review fields',
  }), /only the lead Home/)
  await assert.rejects(() => service.inviteProjectSeat(lead, {
    projectId: project.id, homeAddress: 'personal:bob', responsibility: 'Review fields',
  }), /another shared Agent Home/)
  await assert.rejects(() => service.inviteProjectSeat(lead, {
    projectId: project.id, homeAddress: 'personal:alice', responsibility: 'Lead',
  }), /another shared Agent Home/)
  const invited = await service.inviteProjectSeat(lead, {
    projectId: project.id, homeAddress: 'role:reviewer', responsibility: 'Review fields',
  })
  assert.match(invited.seat.address, new RegExp(`^seat:${project.id}:seat-[a-f0-9]{20}$`))
  assert.equal(invited.seat.status, 'active')
  assert.equal(invited.projectRevision, 2)
  assert.deepEqual((await service.readProject(reviewer, project.id)).work, [])
  assert.deepEqual((await service.listProjects(reviewer)).projects.map(item => item.id), [project.id])
  await assert.rejects(() => service.readProject(bob, project.id), /not visible/)
  assert.equal((await service.inviteProjectSeat(lead, {
    projectId: project.id, homeAddress: 'role:reviewer', responsibility: 'Review fields',
  })).idempotentReplay, true)
  const changed = await service.inviteProjectSeat(lead, {
    projectId: project.id, homeAddress: 'role:reviewer', responsibility: 'Review fields and source files',
  })
  assert.equal(changed.projectRevision, 3)
  assert.equal(changed.seat.address, invited.seat.address)
  const released = await service.releaseProjectSeat(lead, {
    projectId: project.id, seatAddress: invited.seat.address,
  })
  assert.equal(released.projectRevision, 4)
  assert.equal(released.seat.status, 'released')
  assert.equal((await service.releaseProjectSeat(lead, {
    projectId: project.id, seatAddress: invited.seat.address,
  })).idempotentReplay, true)
  await assert.rejects(() => service.readProject(reviewer, project.id), /not visible/)
  assert.deepEqual((await service.listProjects(reviewer)).projects, [])
  const rejoined = await service.inviteProjectSeat(lead, {
    projectId: project.id, homeAddress: 'role:reviewer', responsibility: 'Review fields again',
  })
  assert.equal(rejoined.projectRevision, 5)
  assert.equal(rejoined.seat.address, invited.seat.address)
  assert.equal(rejoined.seat.releasedAt, undefined)
  const read = await service.readProject(reviewer, project.id)
  assert.deepEqual(read.project.seatEvents.map(event => event.action),
    ['joined', 'responsibility-updated', 'released', 'rejoined'])
  assert.equal(FormalProjectSchema.safeParse({ ...read.project,
    seats: [{ ...read.project.seats[0], address: 'seat:other:seat-bad' }],
  }).success, false)
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  assert.equal((await reopened.readProject(reviewer, project.id)).project.seats[0].address,
    invited.seat.address)
  const dispatched = await service.dispatchWork(lead, {
    toAddress: 'role:reviewer', goal: 'Review fields', acceptanceCriteria: 'Record findings.',
    idempotencyKey: 'seat-work', projectId: project.id,
  })
  assert.equal(dispatched.work.status, 'open')
  await assert.rejects(() => service.releaseProjectSeat(lead, {
    projectId: project.id, seatAddress: invited.seat.address,
  }), /unsettled formal Work/)
})

test('Project persists one owner, linked Work, versioned submission, rework, and acceptance', async (t) => {
  const root = await makeTempDir('bizagent-project-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:reviewer' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/reviewer`, address: 'role:reviewer' },
      { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('lead-project', root, 'Create a project.')
  const reviewer = runtime.agent('reviewer-project', `${root}/reviewer`, 'Review the work.')
  const create = {
    title: 'Cohort definition', goal: 'Agree on a reusable cohort definition.',
    doneWhen: 'A reviewed definition and source fields are recorded.', idempotencyKey: 'cohort-v1',
  }
  const first = await service.createProject(lead, create)
  const projectId = first.project.id
  assert.equal(first.project.status, 'open')
  assert.equal((await service.createProject(lead, create)).idempotentReplay, true)
  await assert.rejects(() => service.createProject(lead, { ...create, goal: 'Changed goal' }), /conflicts/)
  await assert.rejects(() => service.readProject(reviewer, projectId), /not visible/)
  await assert.rejects(() => service.dispatchWork(reviewer, {
    toAddress: 'personal:alice', goal: 'Wrong owner', acceptanceCriteria: 'Result',
    idempotencyKey: 'wrong-owner', projectId,
  }), /linked Project must be open and led/)

  const dispatched = await service.dispatchWork(lead, {
    toAddress: 'role:reviewer', goal: 'Inspect source fields',
    acceptanceCriteria: 'List source fields and mismatches.', idempotencyKey: 'field-review', projectId,
  })
  assert.equal(dispatched.work.projectId, projectId)
  const claimInput = {
    projectId, summary: 'Definition ready', body: 'The definition is attached in the Work result.',
    doneWhenAssessment: 'Source fields verified.',
  }
  await assert.rejects(() => service.submitProject(lead, claimInput), /unsettled Work/)
  await service.acceptWork(reviewer, dispatched.work.id)
  await mkdir(join(root, 'reviewer', 'artifacts'), { recursive: true })
  await writeFile(join(root, 'reviewer', 'artifacts', 'fields.md'), 'Fields verified\n')
  await service.completeWork(reviewer, {
    workId: dispatched.work.id, subject: 'Fields checked', body: 'All source fields match.',
    artifactRefs: ['artifacts/fields.md'],
  })
  const submitted = await service.submitProject(lead, claimInput)
  assert.equal(submitted.project.status, 'awaiting_acceptance')
  assert.deepEqual(submitted.claim.work.map(item => item.id), [dispatched.work.id])
  const inbox = await service.listPendingProjectOutcomeReviewsAsHuman('owner-user',
    (principal, current) => principal === 'owner-user' && current.id === projectId)
  assert.equal(inbox.items[0].work[0].resultSubject, 'Fields checked')
  assert.match(inbox.items[0].work[0].resultBody, /All source fields match\./)
  assert.equal(inbox.items[0].work[0].resultArtifacts[0].path, 'artifacts/fields.md')
  assert.equal((await service.submitProject(lead, claimInput)).idempotentReplay, true)
  await assert.rejects(() => service.dispatchWork(lead, {
    toAddress: 'role:reviewer', goal: 'Late task', acceptanceCriteria: 'Finish it.',
    idempotencyKey: 'late-task', projectId,
  }), /linked Project must be open/)
  await assert.rejects(() => service.reviewProjectAsHuman('owner-user', {
    projectId, claimId: 'wrong-claim', decision: 'accept', reason: 'Looks good.',
    expectedRevision: submitted.project.revision,
  }, () => true), /current pending claim/)
  await assert.rejects(() => service.reviewProject(lead, {
    projectId, claimId: submitted.claim.id, decision: 'accept', reason: 'Looks good.',
  }), /host-authenticated human review/)

  const putOutcomeMessage = runtime.ledger.putInboxMessage.bind(runtime.ledger)
  runtime.ledger.putInboxMessage = async () => { throw new Error('outcome Inbox write unavailable') }
  const reworked = await service.reviewProject(lead, {
    projectId, claimId: submitted.claim.id, decision: 'rework', reason: 'Clarify the denominator.',
  })
  assert.equal(reworked.project.status, 'open')
  assert.equal(reworked.notification, 'pending')
  runtime.ledger.putInboxMessage = putOutcomeMessage
  const repairedOutcome = await service.reconcileProjectOutcomeReworkNotifications()
  assert.equal(repairedOutcome.failed.length, 0)
  assert.equal(repairedOutcome.delivered.length, 1)
  const outcomeNotice = runtime.ledger.getInboxMessage(repairedOutcome.delivered[0])
  assert.equal(outcomeNotice.kind, 'project-outcome-rework')
  assert.equal(outcomeNotice.projectOutcomeRework.claimId, submitted.claim.id)
  assert.match(outcomeNotice.body, /Clarify the denominator/)
  assert.equal(runtime.ledger.getInboxDelivery(outcomeNotice.id, reworked.project.lead).status, 'delivered')
  assert.deepEqual((await service.reconcileProjectOutcomeReworkNotifications()).delivered, [])
  const outcomePrompts = []
  const outcomeLive = new Map()
  const outcomeRunner = new InboxWakeRunner({
    get(id) { return outcomeLive.get(String(id)) },
    async create(options) {
      const agent = runtime.agent(String(options.sessionId), options.meta.cwd, 'Read Project outcome.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = prompt => { outcomePrompts.push(prompt); agent.inbox.nextTurn.push(prompt) }
      agent.whenIdle = () => new Promise(() => {})
      outcomeLive.set(String(options.sessionId), agent)
      return { agent, async dispose() { outcomeLive.delete(String(options.sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }, runtime.sessionQuery, service, config)
  const outcomePass = await outcomeRunner.recoverBatch(4, Date.parse(outcomeNotice.sentAt) + 1000)
  assert.deepEqual(outcomePass.failed, [])
  assert.equal(outcomePass.started.length, 1)
  assert.match(outcomePrompts[0].content[0].text, new RegExp(outcomeNotice.id))
  await outcomeRunner.close()
  const revised = await service.submitProject(lead, {
    ...claimInput, body: 'The denominator and source fields are clarified.',
  })
  assert.notEqual(revised.claim.id, submitted.claim.id)
  const workArtifact = runtime.workLedger.get(dispatched.work.id).resultArtifacts[0]
  const snapshotFile = join(root, workSnapshotPath(workArtifact.sha256))
  await writeFile(snapshotFile, 'damaged')
  await assert.rejects(() => service.reviewProjectAsHuman('owner-user', {
    projectId, claimId: revised.claim.id, decision: 'accept', reason: 'Evidence unavailable.',
    expectedRevision: revised.project.revision,
  }, () => true), /missing, oversized, or changed|checksum mismatch/)
  await writeFile(snapshotFile, 'Fields verified\n')
  const accepted = await service.reviewProjectAsHuman('owner-user', {
    projectId, claimId: revised.claim.id, decision: 'accept', reason: 'Meets the completion standard.',
    expectedRevision: revised.project.revision,
  }, () => true)
  assert.equal(accepted.project.status, 'accepted')
  assert.equal(accepted.review.reviewedByPrincipal, 'owner-user')
  assert.equal(accepted.project.acceptedClaimId, revised.claim.id)
  assert.equal(accepted.notification, undefined)
  assert.equal(runtime.ledger.listInboxMessages().filter(message =>
    message.projectOutcomeRework?.projectId === projectId).length, 1)
  const replayedWork = await service.dispatchWork(lead, {
    toAddress: 'role:reviewer', goal: 'Inspect source fields',
    acceptanceCriteria: 'List source fields and mismatches.', idempotencyKey: 'field-review', projectId,
  })
  assert.equal(replayedWork.work.id, dispatched.work.id)
  assert.equal(runtime.workLedger.list().length, 1)
  assert.equal((await service.reviewProjectAsHuman('owner-user', {
    projectId, claimId: revised.claim.id, decision: 'accept', reason: 'Meets the completion standard.',
    expectedRevision: accepted.project.revision,
  }, () => true)).idempotentReplay, true)
  await assert.rejects(() => service.reviewProject(reviewer, {
    projectId, claimId: revised.claim.id, decision: 'rework', reason: 'Override.',
  }), /only the Project lead Home/)

  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  const read = await reopened.readProject(lead, projectId)
  assert.equal(read.project.claims.length, 2)
  assert.equal(read.project.reviews.length, 2)
  assert.equal(read.project.status, 'accepted')
  assert.equal(read.work[0].id, dispatched.work.id)
  assert.deepEqual((await reopened.listProjects(lead)).projects.map(item => item.id), [projectId])
  assert.equal((await reopened.listProjects(reviewer)).projects.length, 0)
})

test('superseded Project outcome rework does not wake a coordinator for an old claim', async t => {
  const root = await makeTempDir('bizagent-project-stale-rework-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'artifacts'))
  await writeFile(join(root, 'artifacts', 'result.md'), 'Evidence\n')
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('stale-rework-lead', root, 'Lead the Project.')
  const project = (await service.createProject(lead, {
    title: 'Stale rework', goal: 'Deliver a result.', doneWhen: 'Evidence is retained.',
    idempotencyKey: 'stale-rework',
  })).project
  const first = await service.submitProject(lead, { projectId: project.id,
    summary: 'First version', body: 'Initial result.', doneWhenAssessment: 'Evidence is ready.',
    artifactRefs: ['artifacts/result.md'] })
  await service.reviewProject(lead, { projectId: project.id, claimId: first.claim.id,
    decision: 'rework', reason: 'Revise the explanation.' })
  const notice = runtime.ledger.listInboxMessages().find(message =>
    message.projectOutcomeRework?.claimId === first.claim.id)
  assert.ok(notice)
  const runner = new InboxWakeRunner({
    get() { return undefined },
    async create() { throw new Error('factory temporarily unavailable') },
    async resume() { throw new Error('stale notice must not resume a Session') },
  }, runtime.sessionQuery, service, config)
  const firstPass = await runner.recoverBatch(4, Date.parse(notice.sentAt) + 1000)
  assert.equal(firstPass.failed.length, 1)
  await service.submitProject(lead, { projectId: project.id,
    summary: 'Second version', body: 'Revised explanation.', doneWhenAssessment: 'Evidence is ready.',
    artifactRefs: ['artifacts/result.md'] })
  assert.deepEqual((await service.reconcileProjectOutcomeReworkNotifications()).delivered, [])
  assert.deepEqual(await runner.recoverBatch(4, Date.parse(notice.sentAt) + 6 * 60_000),
    { started: [], skipped: [firstPass.failed[0].planId], failed: [] })
  await runner.close()
})

test('ordinary Home Project participation binds one turn and leaves later unrelated turns alone', async t => {
  const root = await makeTempDir('bizagent-project-turn-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'bob'), address: 'personal:bob' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const coordinator = runtime.agent('turn-coordinator', root, 'Coordinate the Project.')
  const participant = runtime.agent('turn-participant', root, 'Work on the Project.')
  const outsider = runtime.agent('turn-outsider', join(root, 'bob'), 'Unrelated work.')
  const project = (await service.createProject(coordinator, { title: 'Turn scope',
    goal: 'Track one active turn.', doneWhen: 'The turn ends.', idempotencyKey: 'turn-scope' })).project
  await assert.rejects(() => service.joinProjectTurn(outsider, project.id), /not a Project participant/)
  const joined = await service.joinProjectTurn(participant, project.id)
  assert.equal(joined.participation.turn, 1)
  assert.equal((await service.joinProjectTurn(participant, project.id)).participation.recordedAt,
    joined.participation.recordedAt)
  assert.equal((await runtime.reopenLedger()).listProjectTurns(project.id).length, 1)
  runtime.appendSessionEvent(participant.id, { seq: 2, time: Date.now(), type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } } })
  participant.session.events.push({ seq: 3, time: Date.now(), type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(runtime.ledger.listProjectTurns(project.id).map(item => item.turn), [1])
  assert.equal((await service.joinProjectTurn(participant, project.id)).participation.turn, 2)
  assert.deepEqual(runtime.ledger.listProjectTurns(project.id).map(item => item.turn).sort(), [1, 2])
})
