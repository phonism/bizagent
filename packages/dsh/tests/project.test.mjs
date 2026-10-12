import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'
import { projectSnapshotPath, workSnapshotPath } from '../lib/worklog-snapshot.js'
import { FormalProjectSchema, projectRoleAssignmentState } from '../lib/project-ledger.js'
import { FormalWorkSchema } from '../lib/work-ledger.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { createProjectInterventionRuntimeHooks, inspectProjectRuntime,
  interruptProjectSessions, projectSessionIds } from '../lib/project-runtime.js'

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

test('Project working assets retain Seat publications and enforce version and visibility', async t => {
  const root = await makeTempDir('bizagent-project-working-assets-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const analystCwd = join(root, 'analyst')
  await mkdir(join(analystCwd, 'context'), { recursive: true })
  await writeFile(join(analystCwd, 'context', 'research.md'), 'First draft\n')
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:analyst' })
  await store.createHome({ address: 'role:outsider' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: analystCwd, address: 'role:analyst' },
      { root: join(root, 'outsider'), address: 'role:outsider' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('asset-lead', root, 'Lead the Project.')
  const analyst = runtime.agent('asset-analyst', analystCwd, 'Publish working evidence.')
  const outsider = runtime.agent('asset-outsider', join(root, 'outsider'), 'Try to read evidence.')
  const project = (await service.createProject(lead, { title: 'Working evidence',
    goal: 'Review evidence together.', doneWhen: 'A final result is accepted.',
    idempotencyKey: 'working-evidence' })).project
  const seat = await service.inviteProjectSeat(lead, { projectId: project.id,
    homeAddress: 'role:analyst', responsibility: 'Prepare evidence.' })
  const first = await service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'context/research.md', expectedProjectRevision: seat.projectRevision,
    expectedPreviousSha256: null, idempotencyKey: 'research-1' })
  assert.equal(first.asset.revision, 1)
  assert.equal(Buffer.from((await service.readProjectWorkingAsset(lead, {
    projectId: project.id, path: 'context/research.md' })).contentBase64, 'base64').toString(), 'First draft\n')
  await assert.rejects(() => service.readProjectWorkingAsset(outsider, {
    projectId: project.id, path: 'context/research.md' }), /not visible/)
  await writeFile(join(analystCwd, 'context', 'research.md'), 'Second draft\n')
  assert.equal((await service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'context/research.md', expectedProjectRevision: seat.projectRevision,
    expectedPreviousSha256: null, idempotencyKey: 'research-1' })).idempotentReplay, true)
  await assert.rejects(() => service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'context/research.md', expectedProjectRevision: first.project.revision,
    expectedPreviousSha256: null, idempotencyKey: 'research-stale' }), /version changed/)
  const second = await service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'context/research.md', expectedProjectRevision: first.project.revision,
    expectedPreviousSha256: first.asset.sha256, idempotencyKey: 'research-2' })
  assert.equal(second.asset.revision, 2)
  assert.equal(second.asset.previousSha256, first.asset.sha256)
  assert.equal(Buffer.from((await service.readProjectWorkingAsset(lead, {
    projectId: project.id, path: 'context/research.md', revision: 1 })).contentBase64, 'base64').toString(),
  'First draft\n')
  assert.equal(Buffer.from((await service.readProjectWorkingAsset(lead, {
    projectId: project.id, path: 'context/research.md' })).contentBase64, 'base64').toString(),
  'Second draft\n')
  await assert.rejects(() => service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: '../escape.md', expectedProjectRevision: second.project.revision,
    expectedPreviousSha256: null, idempotencyKey: 'escape' }), /canonical/)
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  assert.equal(reopened.projectLedger.get(project.id).workingAssets.length, 2)
  assert.equal(Buffer.from((await reopened.readProjectWorkingAsset(lead, {
    projectId: project.id, path: 'context/research.md', revision: 1 })).contentBase64, 'base64').toString(),
  'First draft\n')
  await mkdir(join(analystCwd, 'artifacts'))
  await writeFile(join(analystCwd, 'artifacts', 'result.md'), 'Shared final evidence\n')
  const sharedResult = await reopened.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'artifacts/result.md', expectedProjectRevision: second.project.revision,
    expectedPreviousSha256: null, idempotencyKey: 'shared-result' })
  await reopened.releaseProjectSeat(lead, { projectId: project.id, seatAddress: seat.seat.address })
  await assert.rejects(() => reopened.readProjectWorkingAsset(analyst, {
    projectId: project.id, path: 'context/research.md' }), /not visible/)
  const submitted = await reopened.submitProject(lead, { projectId: project.id,
    summary: 'Shared evidence ready', body: 'The Analyst published the final file.',
    doneWhenAssessment: 'Evidence is retained.', artifactRefs: ['artifacts/result.md'] })
  assert.equal(submitted.claim.artifacts[0].sha256, sharedResult.asset.sha256)
  assert.equal(Buffer.from((await reopened.readProjectArtifact(lead, { projectId: project.id,
    claimId: submitted.claim.id, path: 'artifacts/result.md' })).contentBase64, 'base64').toString(),
  'Shared final evidence\n')
})

test('Project delivery feedback freezes reviewed bytes, survives notice failure, and resolves to a published version', async t => {
  const root = await makeTempDir('bizagent-project-delivery-feedback-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const analystCwd = join(root, 'analyst')
  await mkdir(join(analystCwd, 'context'), { recursive: true })
  await writeFile(join(analystCwd, 'context', 'notes.md'), 'First evidence\n')
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:analyst' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: analystCwd, address: 'role:analyst' },
      { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('feedback-lead', root, 'Lead the Project.')
  const analyst = runtime.agent('feedback-analyst', analystCwd, 'Review the delivery.')
  const project = (await service.createProject(lead, { title: 'Delivery feedback',
    goal: 'Share evidence.', doneWhen: 'Evidence is reviewed.', idempotencyKey: 'delivery-feedback' })).project
  const seat = await service.inviteProjectSeat(lead, { projectId: project.id,
    homeAddress: 'role:analyst', responsibility: 'Review evidence.' })
  const first = await service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'context/notes.md', expectedProjectRevision: seat.projectRevision,
    expectedPreviousSha256: null, idempotencyKey: 'notes-one' })
  const putMessage = runtime.ledger.putInboxMessage.bind(runtime.ledger)
  runtime.ledger.putInboxMessage = async () => { throw new Error('Inbox temporarily unavailable') }
  const input = { projectId: project.id, path: 'context/notes.md', version: 'working',
    expectedSha256: first.asset.sha256, expectedProjectRevision: first.project.revision,
    idempotencyKey: 'opinion-one', section: 'Evidence', body: 'Include the sample range.' }
  const commented = await service.addProjectDeliveryFeedback(analyst, input)
  assert.equal(commented.notification, 'pending')
  assert.equal(commented.feedback.workingRevision, 1)
  assert.equal(runtime.projectLedger.get(project.id).deliveryFeedback.length, 1)
  const retry = await service.addProjectDeliveryFeedback(analyst, input)
  assert.equal(retry.idempotentReplay, true)
  assert.equal(retry.notification, 'pending')
  runtime.ledger.putInboxMessage = putMessage
  assert.equal((await service.reconcileProjectDeliveryFeedbackNotifications()).delivered.length, 1)
  const message = runtime.ledger.listInboxMessages().find(item =>
    item.projectDeliveryFeedback?.feedbackId === commented.feedback.id)
  assert.equal(message.kind, 'project-delivery-feedback')
  assert.equal(message.to[0], project.lead)
  assert.equal(runtime.ledger.getInboxDelivery(message.id, project.lead).status, 'delivered')
  const prompts = []
  const live = new Map()
  const activeRunner = new InboxWakeRunner({
    get(id) { return live.get(String(id)) },
    async create(options) {
      const agent = runtime.agent(String(options.sessionId), options.meta.cwd, 'Address delivery feedback.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = prompt => { prompts.push(prompt); agent.inbox.nextTurn.push(prompt) }
      agent.whenIdle = () => new Promise(() => {})
      live.set(String(options.sessionId), agent)
      return { agent, async dispose() { live.delete(String(options.sessionId)) } }
    },
    async resume() { throw new Error('unexpected feedback Session resume') },
  }, runtime.sessionQuery, service, config)
  assert.equal((await activeRunner.recoverBatch(4, Date.parse(message.sentAt) + 1000)).started.length, 1)
  assert.match(prompts[0].content[0].text, new RegExp(message.id))
  await activeRunner.close()
  await writeFile(join(analystCwd, 'context', 'notes.md'), 'Second evidence\n')
  assert.equal(Buffer.from((await service.readProjectDeliveryFeedbackSnapshot(lead, {
    projectId: project.id, feedbackId: commented.feedback.id })).contentBase64, 'base64').toString(),
  'First evidence\n')
  const second = await service.publishProjectWorkingAsset(analyst, { projectId: project.id,
    path: 'context/notes.md', expectedProjectRevision: commented.project.revision,
    expectedPreviousSha256: first.asset.sha256, idempotencyKey: 'notes-two' })
  await assert.rejects(() => service.addProjectDeliveryFeedback(analyst, {
    ...input, idempotencyKey: 'stale-opinion', expectedProjectRevision: second.project.revision,
  }), /asset changed/)
  const resolved = await service.resolveProjectDeliveryFeedback(lead, {
    projectId: project.id, feedbackId: commented.feedback.id,
    expectedProjectRevision: second.project.revision, reply: 'Added the sample range.',
    path: 'context/notes.md', workingRevision: 2 })
  assert.equal(resolved.feedback.resolution.sha256, second.asset.sha256)
  assert.equal((await service.resolveProjectDeliveryFeedback(lead, {
    projectId: project.id, feedbackId: commented.feedback.id,
    expectedProjectRevision: second.project.revision, reply: 'Added the sample range.',
    path: 'context/notes.md', workingRevision: 2 })).idempotentReplay, true)
  assert.deepEqual((await service.reconcileProjectDeliveryFeedbackNotifications()).delivered, [])
  const runner = new InboxWakeRunner({ get() { return undefined },
    async create() { throw new Error('resolved feedback must not wake a Session') },
    async resume() { throw new Error('resolved feedback must not resume a Session') },
  }, runtime.sessionQuery, service, config)
  assert.deepEqual(await runner.recoverBatch(4, Date.parse(message.sentAt) + 1000),
    { started: [], skipped: [], failed: [] })
  await runner.close()
  await mkdir(join(root, 'artifacts'))
  await writeFile(join(root, 'artifacts', 'result.md'), 'Submitted evidence\n')
  const finalAsset = await service.publishProjectWorkingAsset(lead, { projectId: project.id,
    path: 'artifacts/result.md', expectedProjectRevision: resolved.project.revision,
    expectedPreviousSha256: null, idempotencyKey: 'final-result' })
  const submitted = await service.submitProject(lead, { projectId: project.id,
    summary: 'Evidence ready', body: 'The retained version is complete.',
    doneWhenAssessment: 'The final evidence is present.', artifactRefs: ['artifacts/result.md'] })
  const submittedOpinion = await service.addProjectDeliveryFeedback(analyst, {
    projectId: project.id, path: 'artifacts/result.md', version: 'submitted',
    expectedSha256: finalAsset.asset.sha256, expectedProjectRevision: submitted.project.revision,
    idempotencyKey: 'submitted-opinion', body: 'Please clarify the conclusion.' })
  assert.equal(submittedOpinion.feedback.claimId, submitted.claim.id)
  assert.equal(submittedOpinion.feedback.workingRevision, undefined)
  assert.equal(Buffer.from((await service.readProjectDeliveryFeedbackSnapshot(analyst, {
    projectId: project.id, feedbackId: submittedOpinion.feedback.id })).contentBase64, 'base64').toString(),
  'Submitted evidence\n')
  await assert.rejects(() => service.resolveProjectDeliveryFeedback(analyst, {
    projectId: project.id, feedbackId: submittedOpinion.feedback.id,
    expectedProjectRevision: submittedOpinion.project.revision, reply: 'Done.',
    path: 'context/notes.md', workingRevision: 2 }), /only the Project lead/)
  const humanInput = { projectId: project.id, path: 'artifacts/result.md', version: 'submitted',
    expectedSha256: finalAsset.asset.sha256,
    expectedProjectRevision: submittedOpinion.project.revision,
    idempotencyKey: 'human-opinion', body: 'Explain the final scope.' }
  await assert.rejects(() => service.addProjectDeliveryFeedbackAsHuman('reviewer-user', humanInput,
    () => false), /not authorized/)
  const humanOpinion = await service.addProjectDeliveryFeedbackAsHuman('reviewer-user', humanInput,
    (principal, current) => principal === 'reviewer-user' && current.lead === project.lead)
  assert.equal(humanOpinion.feedback.byPrincipal, 'reviewer-user')
  assert.equal(humanOpinion.feedback.bySessionId, undefined)
  await service.releaseProjectSeat(lead, { projectId: project.id, seatAddress: seat.seat.address })
  await assert.rejects(() => service.readProjectDeliveryFeedbackSnapshot(analyst, {
    projectId: project.id, feedbackId: humanOpinion.feedback.id }), /not visible/)
  FormalProjectSchema.parse(runtime.projectLedger.get(project.id))
})

test('Project Role Seat principal suggestions require human confirmation without granting Project access', async t => {
  const root = await makeTempDir('bizagent-project-role-principals-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'personal:bob', owner: 'bob' })
  await store.createHome({ address: 'personal:carol', owner: 'carol' })
  await store.createHome({ address: 'role:analyst', owner: 'alice' })
  const analystCwd = join(root, 'analyst')
  const bobCwd = join(root, 'bob')
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: analystCwd, address: 'role:analyst' },
      { root: bobCwd, address: 'personal:bob' }, { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('role-lead', root, 'Lead the Project.')
  const analyst = runtime.agent('role-analyst', analystCwd, 'Suggest a responsible person.')
  const bob = runtime.agent('role-bob', bobCwd, 'Try to read the Project.')
  const project = (await service.createProject(lead, { title: 'Role accountability',
    goal: 'Assign a responsible person.', doneWhen: 'Accountability is explicit.',
    idempotencyKey: 'role-accountability' })).project
  const invited = await service.inviteProjectSeat(lead, { projectId: project.id,
    homeAddress: 'role:analyst', responsibility: 'Analyze the material.' })
  const suggestionInput = { projectId: project.id, roleHome: 'role:analyst',
    proposedPrincipal: 'bob', reason: 'Bob owns the analysis.',
    expectedProjectRevision: invited.projectRevision, idempotencyKey: 'bob-proposal' }
  const suggested = await service.suggestProjectRolePrincipal(analyst, suggestionInput)
  assert.equal(suggested.suggestion.bySessionId, String(analyst.id))
  assert.equal(projectRoleAssignmentState(suggested.project).suggestions[0].status, 'pending')
  assert.equal((await service.suggestProjectRolePrincipal(analyst, suggestionInput)).idempotentReplay, true)
  await assert.rejects(() => service.readProject(bob, project.id), /not visible/)
  await assert.rejects(() => service.suggestProjectRolePrincipal(analyst, {
    ...suggestionInput, idempotencyKey: 'unknown-proposal', proposedPrincipal: 'unknown',
    expectedProjectRevision: suggested.project.revision,
  }), /registered human principal/)
  const authorizeManager = (principal, current) => principal === 'alice' && current.lead === project.lead
  const authorizeTarget = (principal, _current, roleHome) =>
    ['bob', 'carol'].includes(principal) && roleHome === 'role:analyst'
  const decisionInput = { projectId: project.id, roleHome: 'role:analyst', action: 'assign',
    targetPrincipal: 'bob', suggestionId: suggested.suggestion.id,
    expectedProjectRevision: suggested.project.revision, expectedBindingRevision: 0,
    idempotencyKey: 'accept-bob', reason: 'Bob has current responsibility.' }
  await assert.rejects(() => service.decideProjectRoleAsHuman('mallory', decisionInput,
    authorizeManager, authorizeTarget), /not authorized/)
  await assert.rejects(() => service.decideProjectRoleAsHuman('alice', {
    ...decisionInput, expectedProjectRevision: invited.projectRevision,
  }, authorizeManager, authorizeTarget), /current open Project revision/)
  const accepted = await service.decideProjectRoleAsHuman('alice', decisionInput,
    authorizeManager, authorizeTarget)
  assert.deepEqual(projectRoleAssignmentState(accepted.project).bindings.map(item => item.principal), ['bob'])
  assert.equal(projectRoleAssignmentState(accepted.project).suggestions[0].status, 'accepted')
  assert.equal((await service.decideProjectRoleAsHuman('alice', decisionInput,
    authorizeManager, authorizeTarget)).idempotentReplay, true)
  await assert.rejects(() => service.readProject(bob, project.id), /not visible/)
  const nextSuggestion = await service.suggestProjectRolePrincipal(analyst, {
    projectId: project.id, roleHome: 'role:analyst', proposedPrincipal: 'carol',
    reason: 'Carol now coordinates the analysis.', expectedProjectRevision: accepted.project.revision,
    idempotencyKey: 'carol-proposal' })
  const reassigned = await service.decideProjectRoleAsHuman('alice', {
    projectId: project.id, roleHome: 'role:analyst', action: 'assign', targetPrincipal: 'carol',
    expectedProjectRevision: nextSuggestion.project.revision, expectedBindingRevision: 1,
    idempotencyKey: 'direct-carol', reason: 'Manager chose Carol directly.' },
  authorizeManager, authorizeTarget)
  assert.equal(projectRoleAssignmentState(reassigned.project).suggestions.at(-1).status, 'superseded')
  await assert.rejects(() => service.decideProjectRoleAsHuman('alice', {
    projectId: project.id, roleHome: 'role:analyst', action: 'reject',
    suggestionId: nextSuggestion.suggestion.id, expectedProjectRevision: reassigned.project.revision,
    expectedBindingRevision: 2, idempotencyKey: 'reject-stale', reason: 'No longer current.' },
  authorizeManager, authorizeTarget), /no longer pending/)
  const cleared = await service.decideProjectRoleAsHuman('alice', {
    projectId: project.id, roleHome: 'role:analyst', action: 'clear',
    expectedProjectRevision: reassigned.project.revision, expectedBindingRevision: 2,
    idempotencyKey: 'clear-carol', reason: 'The role is vacant.' },
  authorizeManager, authorizeTarget)
  assert.deepEqual(projectRoleAssignmentState(cleared.project).bindings, [])
  assert.equal(projectRoleAssignmentState(cleared.project).revision, 3)
  FormalProjectSchema.parse(cleared.project)
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

test('Project delegation freezes Seat attribution and lets an invited Home delegate onward', async t => {
  const root = await makeTempDir('bizagent-project-delegate-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  for (const address of ['personal:alice', 'personal:bob', 'role:analyst', 'capability:checker']) {
    await store.createHome({ address })
  }
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [
      { root: join(root, 'analyst'), address: 'role:analyst' },
      { root: join(root, 'checker'), address: 'capability:checker' },
      { root: join(root, 'bob'), address: 'personal:bob' },
    ],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('delegate-lead', root, 'Lead the project.')
  const analyst = runtime.agent('delegate-analyst', join(root, 'analyst'), 'Analyze the project.')
  const checker = runtime.agent('delegate-checker', join(root, 'checker'), 'Check the project.')
  const bob = runtime.agent('delegate-bob', join(root, 'bob'), 'Inspect the project.')
  const project = (await service.createProject(lead, {
    title: 'Delegate a review', goal: 'Review evidence.', doneWhen: 'A checked result exists.',
    idempotencyKey: 'delegate-project',
  })).project
  const firstInput = {
    projectId: project.id, toAddress: 'role:analyst', responsibility: 'Analyze evidence',
    goal: 'Analyze evidence', acceptanceCriteria: 'Deliver a source list.',
    idempotencyKey: 'analysis',
  }
  await assert.rejects(() => service.delegateProjectWork(bob, firstInput), /led by or shared/)
  await assert.rejects(() => service.delegateProjectWork(lead, {
    ...firstInput, toAddress: 'personal:bob',
  }), /another shared Agent Home/)
  const first = await service.delegateProjectWork(lead, firstInput)
  assert.equal(first.work.projectId, project.id)
  assert.equal(first.work.assigneeSeatAddress, first.seat.address)
  assert.equal(first.work.requesterSeatAddress, undefined)
  assert.equal((await service.readProject(analyst, project.id)).project.seats.length, 1)
  const request = runtime.ledger.getInboxMessage(first.work.requestMessageId)
  assert.match(request.body, new RegExp(`Project: ${project.id}`))
  assert.ok(request.body.includes(`Your Project Seat: ${first.seat.address}`))
  const revision = first.projectRevision
  const replay = await service.delegateProjectWork(lead, {
    ...firstInput, responsibility: 'Changed responsibility on replay',
  })
  assert.equal(replay.idempotentReplay, true)
  assert.equal(replay.projectRevision, revision)
  assert.equal((await service.readProject(analyst, project.id)).project.seats[0].responsibility,
    'Analyze evidence')
  await assert.rejects(() => service.delegateProjectWork(lead, {
    ...firstInput, goal: 'Different Work with same key',
  }), /idempotency key conflicts/)
  assert.equal((await service.readProject(lead, project.id)).project.revision, revision)
  const second = await service.delegateProjectWork(analyst, {
    projectId: project.id, toAddress: 'capability:checker', responsibility: 'Check source list',
    goal: 'Check the source list', acceptanceCriteria: 'Report discrepancies.',
    idempotencyKey: 'checker',
  })
  assert.equal(second.work.requester, 'role:analyst')
  assert.equal(second.work.requesterSeatAddress, first.seat.address)
  assert.equal(second.work.assigneeSeatAddress, second.seat.address)
  assert.equal(FormalWorkSchema.safeParse({ ...second.work,
    assigneeSeatAddress: first.seat.address,
  }).success, false)
  assert.equal((await service.readWork(checker, second.work.id)).work.id, second.work.id)
  await assert.rejects(() => service.releaseProjectSeat(lead, {
    projectId: project.id, seatAddress: first.seat.address,
  }), /unsettled formal Work/)
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  assert.equal((await reopened.readProject(lead, project.id)).work.find(work =>
    work.id === second.work.id).requesterSeatAddress, first.seat.address)
  await service.cancelWork(analyst, { workId: second.work.id, reason: 'No longer needed.' })
  await service.cancelWork(lead, { workId: first.work.id, reason: 'No longer needed.' })
  await service.releaseProjectSeat(lead, { projectId: project.id, seatAddress: first.seat.address })
  const replayAfterRelease = await service.delegateProjectWork(lead, firstInput)
  assert.equal(replayAfterRelease.idempotentReplay, true)
  assert.equal(replayAfterRelease.work.id, first.work.id)
  await assert.rejects(() => service.readProject(analyst, project.id), /not visible/)
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

test('Agent plan proposals are durable drafts until a human applies a current revision', async t => {
  const root = await makeTempDir('bizagent-workflow-proposal-')
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
  const lead = runtime.agent('proposal-lead', root, 'Lead the Workflow.')
  const bob = runtime.agent('proposal-bob', join(root, 'bob'), 'Inspect the Workflow.')
  const first = { id: 'first', title: 'First', intent: 'Collect evidence.',
    executor: 'personal:alice', acceptanceCriteria: 'Return evidence.', after: [] }
  const created = (await service.createProject(lead, {
    title: 'Plan proposal', goal: 'Test proposals.', doneWhen: 'Work is done.',
    idempotencyKey: 'proposal-project', workflow: { summary: 'Original plan', steps: [first] },
  })).project
  const proposedPlan = { summary: 'Add a second task', steps: [first,
    { id: 'second', title: 'Second', intent: 'Analyze evidence.',
      executor: 'personal:bob', acceptanceCriteria: 'Return analysis.', after: ['first'] }] }
  const input = { projectId: created.id, expectedProjectRevision: created.revision,
    expectedWorkflowRevision: 1, reason: 'The analysis needs a separate task.',
    idempotencyKey: 'proposal-one', workflow: proposedPlan }
  await assert.rejects(() => service.proposeProjectWorkflow(bob, input), /only the lead Home/)
  const proposed = await service.proposeProjectWorkflow(lead, input)
  assert.equal(proposed.project.revision, created.revision + 1)
  assert.deepEqual(proposed.project.workflow, created.workflow)
  assert.equal(proposed.proposal.baseWorkflowRevision, 1)
  assert.equal(proposed.proposal.workflow.revision, 2)
  assert.equal(proposed.proposal.bySessionId, String(lead.id))
  assert.equal((await service.proposeProjectWorkflow(lead, input)).idempotentReplay, true)
  await assert.rejects(() => service.proposeProjectWorkflow(lead, {
    ...input, idempotencyKey: 'proposal-stale',
  }), /revision changed/)
  const refinedPlan = { ...proposedPlan, summary: 'Refined plan with analysis' }
  const refined = await service.proposeProjectWorkflow(lead, {
    ...input, expectedProjectRevision: proposed.project.revision,
    idempotencyKey: 'proposal-two', workflow: refinedPlan,
  })
  assert.deepEqual(refined.project.workflow, created.workflow)
  assert.equal(FormalProjectSchema.safeParse({ ...proposed.project,
    workflowProposals: [{ ...proposed.proposal, baseWorkflowRevision: 2 }],
  }).success, false)
  const authorize = (principal, project) => principal === 'alice'
    && project.lead === 'personal:alice'
  await assert.rejects(() => service.amendProjectWorkflowAsHuman('alice', {
    ...input, expectedProjectRevision: refined.project.revision,
    idempotencyKey: 'apply-old-proposal', proposalKey: input.idempotencyKey,
  }, authorize), /proposal changed/)
  await assert.rejects(() => service.amendProjectWorkflowAsHuman('mallory', {
    ...input, expectedProjectRevision: refined.project.revision,
    idempotencyKey: 'apply-proposal', proposalKey: 'proposal-two', workflow: refinedPlan,
  }, authorize), /not authorized/)
  const applied = await service.amendProjectWorkflowAsHuman('alice', {
    ...input, expectedProjectRevision: refined.project.revision,
    idempotencyKey: 'apply-proposal', proposalKey: 'proposal-two', workflow: refinedPlan,
  }, authorize)
  assert.equal(applied.project.workflow.revision, 2)
  assert.equal(applied.amendment.proposalKey, 'proposal-two')
  assert.equal(applied.amendment.byPrincipal, 'alice')
  await assert.rejects(() => service.amendProjectWorkflowAsHuman('alice', {
    ...input, expectedProjectRevision: applied.project.revision,
    expectedWorkflowRevision: 2, idempotencyKey: 'apply-again',
    proposalKey: input.idempotencyKey,
    workflow: { ...proposedPlan, summary: 'Changed again' },
  }, authorize), /proposal changed/)
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  const read = await reopened.readProject(lead, created.id)
  assert.equal(read.project.workflowProposals.length, 2)
  assert.equal(read.project.workflowAmendments[0].proposalKey, 'proposal-two')
})

test('progression changes govern future submissions while pending Work keeps its reviewer', async t => {
  const root = await makeTempDir('bizagent-project-progression-')
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
  const alice = runtime.agent('progression-alice', root, 'Lead the Project.')
  const bob = runtime.agent('progression-bob', join(root, 'bob'), 'Review or execute Work.')
  const project = (await service.createProject(alice, {
    title: 'Progression test', goal: 'Check review policy.', doneWhen: 'Both nodes complete.',
    idempotencyKey: 'progression-test', workflow: { summary: 'Two nodes', steps: [
      { id: 'first', title: 'First', intent: 'Collect evidence.', executor: 'personal:alice',
        acceptanceCriteria: 'Return evidence.', after: [] },
      { id: 'second', title: 'Second', intent: 'Analyze evidence.', executor: 'personal:bob',
        acceptanceCriteria: 'Return analysis.', after: ['first'] },
    ] },
  })).project
  const authorizeManager = (principal, current) => principal === 'alice'
    && current.lead === 'personal:alice'
  const authorizeReviewerHome = (principal, _current, home) => principal === 'alice'
    && home === 'personal:bob'
  const authorizeReviewer = (principal, _current, home) => principal === 'bob'
    && home === 'personal:bob'
  const first = (await service.dispatchProjectNode(alice, {
    projectId: project.id, nodeId: 'first',
  })).work
  await service.acceptWork(alice, first.id)
  await assert.rejects(() => service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: project.revision, mode: 'reviewed',
    reviewers: [{ nodeId: 'first', reviewerHome: 'personal:alice' },
      { nodeId: 'second', reviewerHome: 'personal:bob' }], reason: 'Unauthorized reviewer.',
  }, authorizeManager, authorizeReviewerHome), /not authorized/)
  await assert.rejects(() => service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: project.revision, mode: 'reviewed',
    reviewers: [{ nodeId: 'first', reviewerHome: 'personal:bob' }],
    reason: 'Missing a reviewer.',
  }, authorizeManager, authorizeReviewerHome), /must cover every unfinished Workflow node/)
  const reviewed = await service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: project.revision, mode: 'reviewed',
    reviewers: [{ nodeId: 'first', reviewerHome: 'personal:bob' },
      { nodeId: 'second', reviewerHome: 'personal:bob' }],
    reason: 'Require an independent check of each result.',
  }, authorizeManager, authorizeReviewerHome)
  await assert.rejects(() => service.setProjectProgressionAsHuman('mallory', {
    projectId: project.id, expectedRevision: reviewed.project.revision, mode: 'automatic',
    reviewers: [], reason: 'Skip reviews.',
  }, authorizeManager, authorizeReviewerHome), /not authorized/)
  await assert.rejects(() => service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: project.revision, mode: 'automatic',
    reviewers: [], reason: 'Stale change.',
  }, authorizeManager, authorizeReviewerHome), /revision conflict/)
  const submitted = await service.completeWork(alice, { workId: first.id,
    subject: 'Evidence', body: 'Evidence gathered.' })
  assert.equal(submitted.work.workflowReview.mode, 'reviewed')
  assert.equal(submitted.work.workflowReview.reviewerHome, 'personal:bob')
  assert.equal((await service.readProject(alice, project.id)).workflow.nodes[0].status, 'waiting')
  const automatic = await service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: reviewed.project.revision, mode: 'automatic',
    reviewers: [], reason: 'Continue automatically after this pending check.',
  }, authorizeManager, authorizeReviewerHome)
  assert.equal((await service.readProject(alice, project.id)).workflow.nodes[0].status, 'waiting')
  const inbox = await service.listPendingProjectNodeReviewsAsHuman('bob', authorizeReviewer)
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].workId, first.id)
  assert.equal(inbox.items[0].reviewerHome, 'personal:bob')
  const assigned = await service.reassignProjectNodeReviewerAsHuman('alice', {
    projectId: project.id, nodeId: 'first', workId: first.id,
    expectedRevision: automatic.project.revision, expectedPrincipal: null,
    assignedPrincipal: 'bob', reason: 'Bob owns the pending check.',
  }, authorizeManager, (target, _current, home, nodeId, workId) =>
    target === 'bob' && home === 'personal:bob' && nodeId === 'first' && workId === first.id)
  assert.equal(assigned.assignment.reviewerHome, 'personal:bob')
  await assert.rejects(() => service.reviewProjectNodeAsHuman('mallory', {
    projectId: project.id, nodeId: 'first', workId: first.id,
    expectedRevision: assigned.project.revision, decision: 'approve', reason: 'Looks good.',
  }, authorizeReviewer), /not authorized/)
  const approval = await service.reviewProjectNodeAsHuman('bob', {
    projectId: project.id, nodeId: 'first', workId: first.id,
    expectedRevision: assigned.project.revision, decision: 'approve', reason: 'Looks good.',
  }, authorizeReviewer)
  const remainingReviewed = await service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: approval.project.revision, mode: 'reviewed',
    reviewers: [{ nodeId: 'second', reviewerHome: 'personal:bob' }],
    reason: 'Review the remaining analysis.',
  }, authorizeManager, authorizeReviewerHome)
  assert.equal(remainingReviewed.progression.reviewers.length, 1)
  const amended = await service.amendProjectWorkflowAsHuman('alice', {
    projectId: project.id, expectedProjectRevision: remainingReviewed.project.revision,
    expectedWorkflowRevision: 1, reason: 'Clarify the summary after the first result.',
    idempotencyKey: 'progression-summary', workflow: {
      summary: 'Two nodes with a reviewed analysis',
      steps: remainingReviewed.project.workflow.steps,
    },
  }, authorizeManager)
  assert.equal(amended.project.workflow.revision, 2)
  const second = (await service.dispatchProjectNode(alice, {
    projectId: project.id, nodeId: 'second',
  })).work
  await service.acceptWork(bob, second.id)
  await service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: amended.project.revision,
    mode: 'automatic', reviewers: [], reason: 'Let the running analysis finish automatically.',
  }, authorizeManager, authorizeReviewerHome)
  const finished = await service.completeWork(bob, { workId: second.id,
    subject: 'Analysis', body: 'Analysis complete.' })
  assert.equal(finished.work.workflowReview.mode, 'automatic')
  assert.deepEqual((await service.readProject(alice, project.id)).workflow.nodes.map(node => node.status),
    ['done', 'done'])
  assert.equal((await service.listPendingProjectNodeReviewsAsHuman('bob', authorizeReviewer)).items.length, 0)
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  const read = await reopened.readProject(alice, project.id)
  assert.equal(read.project.progressionChanges.length, 4)
  assert.equal(read.work.find(item => item.id === first.id).workflowReview.reviewerHome, 'personal:bob')
  assert.deepEqual(read.workflow.nodes.map(node => node.status), ['done', 'done'])
})

test('Project progression notice survives Inbox failure and wakes the lead Home once', async t => {
  const root = await makeTempDir('bizagent-project-progression-notice-')
  t.after(() => rm(root, { recursive: true, force: true }))
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
  const alice = runtime.agent('progression-notice-lead', root, 'Lead the Project.')
  const project = (await service.createProject(alice, {
    title: 'Notice test', goal: 'Confirm progression.', doneWhen: 'One node completes.',
    idempotencyKey: 'progression-notice-test', workflow: { summary: 'One node', steps: [
      { id: 'first', title: 'First', intent: 'Do the work.', executor: 'personal:alice',
        acceptanceCriteria: 'Report result.', after: [] },
    ] },
  })).project
  const put = runtime.ledger.putInboxMessage.bind(runtime.ledger)
  runtime.ledger.putInboxMessage = async () => { throw new Error('Inbox write unavailable') }
  const changed = await service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: project.revision, mode: 'automatic',
    reviewers: [], reason: 'Proceed after confirmation.',
  }, () => true, () => true)
  assert.equal(changed.notification, 'pending')
  assert.equal(runtime.projectLedger.get(project.id).progressionChanges.length, 1)
  runtime.ledger.putInboxMessage = put
  const recovered = await service.reconcileProjectProgressionNotifications()
  assert.equal(recovered.failed.length, 0)
  assert.equal(recovered.delivered.length, 1)
  const message = runtime.ledger.getInboxMessage(recovered.delivered[0])
  assert.equal(message.fromAddress, 'engine:inbox')
  assert.equal(message.kind, 'project-progression')
  assert.equal(message.projectProgression.revision, 1)
  assert.equal(message.to[0], project.lead)
  assert.equal(runtime.ledger.getInboxDelivery(message.id, project.lead).status, 'delivered')
  assert.deepEqual((await service.reconcileProjectProgressionNotifications()).delivered, [])
  const nextProgression = await service.setProjectProgressionAsHuman('alice', {
    projectId: project.id, expectedRevision: changed.project.revision, mode: 'reviewed',
    reviewers: [{ nodeId: 'first', reviewerHome: 'personal:alice' }],
    reason: 'Require a check for the next result.',
  }, () => true, () => true)
  assert.equal(nextProgression.notification, 'delivered')
  const currentNotice = runtime.ledger.listInboxMessages().find(item =>
    item.projectProgression?.projectId === project.id && item.projectProgression.revision === 2)
  assert.ok(currentNotice)

  const prompts = []
  const live = new Map()
  const agents = {
    get(id) { return live.get(String(id)) },
    async create(options) {
      const agent = runtime.agent(String(options.sessionId), options.meta.cwd, 'Review Inbox.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = prompt => { prompts.push(prompt); agent.inbox.nextTurn.push(prompt) }
      agent.whenIdle = () => new Promise(() => {})
      live.set(String(options.sessionId), agent)
      return { agent, async dispose() { live.delete(String(options.sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const pass = await runner.recoverBatch(4, Date.parse(currentNotice.sentAt) + 1000)
  assert.equal(pass.failed.length, 0)
  assert.equal(pass.started.length, 1)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, new RegExp(currentNotice.id))
  assert.equal(prompts[0].content[0].text.includes(message.id), false)
  assert.deepEqual((await runner.recoverBatch(4, Date.parse(currentNotice.sentAt) + 1000)).started, [])
  await runner.close()
})

test('Workflow amendments preserve dispatched node contracts and append a durable plan history', async t => {
  const root = await makeTempDir('bizagent-workflow-amend-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  await store.createHome({ address: 'role:analyst' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'bob'), address: 'personal:bob' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('amend-lead', root, 'Lead the Workflow.')
  const bob = runtime.agent('amend-bob', join(root, 'bob'), 'Inspect the Workflow.')
  const first = { id: 'collect', title: 'Collect evidence', intent: 'Collect source evidence.',
    executor: 'personal:alice', acceptanceCriteria: 'Return source evidence.', after: [] }
  const second = { id: 'review', title: 'Review evidence', intent: 'Review the sources.',
    executor: 'role:analyst', acceptanceCriteria: 'Return a review.', after: ['collect'] }
  const create = { title: 'Evidence plan', goal: 'Review evidence.',
    doneWhen: 'The evidence is reviewed.', idempotencyKey: 'evidence-plan',
    workflow: { summary: 'Collect, then review.', steps: [first, second] } }
  const project = (await service.createProject(lead, create)).project
  const dispatched = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'collect' })
  const next = { summary: 'Collect, review, then audit.', steps: [first,
    { ...second, acceptanceCriteria: 'Return a review with citations.' },
    { id: 'audit', title: 'Audit the review', intent: 'Check the cited sources.',
      executor: 'role:analyst', acceptanceCriteria: 'Return an audit.', after: ['review'] }] }
  const input = { projectId: project.id, expectedProjectRevision: project.revision,
    expectedWorkflowRevision: 1, reason: 'Add a source audit.', idempotencyKey: 'audit-plan',
    workflow: next }
  await assert.rejects(() => service.amendProjectWorkflow(bob, input), /only the lead Home/)
  await assert.rejects(() => service.amendProjectWorkflow(lead, {
    ...input, workflow: { ...next, steps: [{ ...first, intent: 'Different work.' }, ...next.steps.slice(1)] },
  }), /has dispatched Work/)
  await assert.rejects(() => service.amendProjectWorkflow(lead, {
    ...input, workflow: { ...next, steps: next.steps.slice(1) },
  }), /unknown Workflow dependency|cannot remove nodes/)
  let humanGrant = false
  const authorizeHuman = (principal, current) => humanGrant
    && principal === 'alice' && current.lead === 'personal:alice'
  await assert.rejects(() => service.amendProjectWorkflowAsHuman('alice', input, authorizeHuman),
    /not authorized/)
  humanGrant = true
  const amended = await service.amendProjectWorkflowAsHuman('alice', input, authorizeHuman)
  assert.equal(amended.project.workflow.revision, 2)
  assert.equal(amended.project.revision, project.revision + 1)
  assert.equal(amended.amendment.before.revision, 1)
  assert.equal(amended.amendment.after.steps[2].id, 'audit')
  assert.equal(amended.amendment.byPrincipal, 'alice')
  assert.equal(FormalProjectSchema.safeParse({ ...amended.project,
    workflowAmendments: [{ ...amended.amendment, bySessionId: 'forged-session' }],
  }).success, false)
  assert.equal((await service.amendProjectWorkflowAsHuman('alice', input, authorizeHuman)).idempotentReplay, true)
  await assert.rejects(() => service.amendProjectWorkflow(lead, {
    ...input, reason: 'Different reason.',
  }), /idempotency key conflicts/)
  await assert.rejects(() => service.amendProjectWorkflow(lead, {
    ...input, idempotencyKey: 'stale-plan',
  }), /revision changed/)
  const amendedAgain = await service.amendProjectWorkflow(lead, {
    projectId: project.id, expectedProjectRevision: amended.project.revision,
    expectedWorkflowRevision: 2, reason: 'Tighten the final audit.',
    idempotencyKey: 'tighten-audit', workflow: {
      ...next, steps: [...next.steps.slice(0, 2),
        { ...next.steps[2], acceptanceCriteria: 'Return an audit with citations.' }],
    },
  })
  assert.equal(amendedAgain.project.workflow.revision, 3)
  assert.equal(amendedAgain.project.workflowAmendments[1].before.revision, 2)
  assert.equal((await service.createProject(lead, create)).idempotentReplay, true)
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.nodes.map(item => item.status),
    ['running', 'pending', 'pending'])
  assert.equal(FormalProjectSchema.safeParse({ ...amended.project,
    workflowAmendments: [{ ...amended.amendment, before: amended.amendment.after }],
  }).success, false)
  await service.acceptWork(lead, dispatched.work.id)
  await service.completeWork(lead, { workId: dispatched.work.id,
    subject: 'Evidence collected', body: 'Sources are ready.' })
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.readyNodeIds, ['review'])
  const review = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'review' })
  assert.equal(review.work.acceptanceCriteria, 'Return a review with citations.')
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  const read = await reopened.readProject(lead, project.id)
  assert.equal(read.project.workflowAmendments.length, 2)
  assert.equal(read.project.workflow.revision, 3)
  assert.equal(read.project.workflowAmendments[0].byPrincipal, 'alice')
  assert.equal(read.work.find(item => item.id === review.work.id).acceptanceCriteria,
    'Return a review with citations.')
})

test('paused Workflow rebuild removes nodes, retains valid results, and isolates old Work attempts', async t => {
  const root = await makeTempDir('bizagent-workflow-rebuild-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:analyst' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'reviewer'), address: 'role:analyst' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('rebuild-lead', root, 'Lead the Workflow.')
  const reviewer = runtime.agent('rebuild-reviewer', join(root, 'reviewer'), 'Review the Workflow.')
  const first = { id: 'source', title: 'Source', intent: 'Find sources.',
    executor: 'personal:alice', acceptanceCriteria: 'Return sources.', after: [] }
  const independent = { id: 'independent', title: 'Independent', intent: 'Find other evidence.',
    executor: 'personal:alice', acceptanceCriteria: 'Return other evidence.', after: [] }
  const dependent = { id: 'verify', title: 'Verify', intent: 'Verify sources.',
    executor: 'personal:alice', acceptanceCriteria: 'Return verification.', after: ['source'],
    reviewer: 'role:analyst', reviewCriteria: 'Check the verification.' }
  const project = (await service.createProject(lead, {
    title: 'Rebuild', goal: 'Verify evidence.', doneWhen: 'Evidence is verified.',
    idempotencyKey: 'rebuild-project',
    workflow: { summary: 'Original plan.', steps: [first, independent, dependent] },
  })).project
  const complete = async nodeId => {
    const { work } = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId })
    await service.acceptWork(lead, work.id)
    await service.completeWork(lead, { workId: work.id,
      subject: `${nodeId} result`, body: `${nodeId} completed.` })
    return work.id
  }
  const sourceWorkId = await complete('source')
  const independentWorkId = await complete('independent')
  const oldVerifyWorkId = await complete('verify')
  await service.reviewProjectNode(reviewer, { projectId: project.id, nodeId: 'verify',
    workId: oldVerifyWorkId, decision: 'approve', reason: 'Verified.' })
  const beforePause = (await service.readProject(lead, project.id)).project
  const paused = await service.pauseProject(lead, { projectId: project.id,
    expectedProjectRevision: beforePause.revision, reason: 'Source is obsolete.' })
  const newIndependent = { ...independent, title: 'Independent evidence',
    reviewer: 'role:analyst', reviewCriteria: 'Check independent evidence.' }
  const revised = { summary: 'Rebuilt plan.', steps: [newIndependent,
    { ...dependent, after: [], title: 'Verify revised sources.' }] }
  const input = { projectId: project.id, expectedProjectRevision: paused.project.revision,
    expectedWorkflowRevision: 1, reason: 'Remove obsolete source and redo verification.',
    idempotencyKey: 'remove-source', workflow: revised }
  await assert.rejects(() => service.rebuildProjectWorkflow(reviewer, input,
    async () => ({ status: 'quiet', sessionIds: [] })), /only the lead Home/)
  await assert.rejects(() => service.rebuildProjectWorkflow(lead, input,
    async () => ({ status: 'busy', sessionIds: ['worker'] })), /busy/)
  let humanGrant = true
  const authorizeHuman = (principal, current) => humanGrant
    && principal === 'alice' && current.lead === 'personal:alice'
  await assert.rejects(() => service.rebuildProjectWorkflowAsHuman('alice', input,
    authorizeHuman, async () => ({ status: 'unknown', sessionIds: ['worker'] })), /unknown/)
  humanGrant = false
  await assert.rejects(() => service.rebuildProjectWorkflowAsHuman('alice', input,
    authorizeHuman, async () => ({ status: 'quiet', sessionIds: [] })), /not authorized/)
  humanGrant = true
  const rebuilt = await service.rebuildProjectWorkflowAsHuman('alice', input,
    authorizeHuman, async () => ({ status: 'quiet', sessionIds: [] }))
  assert.equal(rebuilt.amendment.mode, 'rebuild')
  assert.equal(rebuilt.amendment.byPrincipal, 'alice')
  assert.equal(rebuilt.amendment.executionEpoch, 1)
  assert.deepEqual(rebuilt.amendment.retained, [{ nodeId: 'independent', workId: independentWorkId }])
  assert.equal((await service.rebuildProjectWorkflowAsHuman('alice', input, authorizeHuman,
    async () => { throw new Error('replay must not inspect runtime') })).idempotentReplay, true)
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.nodes.map(node => node.status),
    ['done', 'ready'])
  assert.equal((await service.readProjectNode(lead, { projectId: project.id,
    nodeId: 'verify' })).latestWork, undefined)
  await assert.rejects(() => service.rebuildProjectWorkflow(lead, { ...input,
    idempotencyKey: 'stale-rebuild' }, async () => ({ status: 'quiet', sessionIds: [] })),
  /revision changed/)
  const resumed = await service.resumeProject(lead, { projectId: project.id,
    expectedProjectRevision: rebuilt.project.revision },
  async () => ({ status: 'quiet', sessionIds: [] }))
  assert.equal(resumed.project.intervention.epoch, 1)
  const newVerify = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'verify' })
  assert.equal(newVerify.attempt, 2)
  assert.equal(newVerify.work.workflowExecutionEpoch, 1)
  assert.notEqual(newVerify.work.id, oldVerifyWorkId)
  await service.acceptWork(lead, newVerify.work.id)
  await service.completeWork(lead, { workId: newVerify.work.id,
    subject: 'New verification', body: 'Revised sources verified.' })
  await service.reviewProjectNode(reviewer, { projectId: project.id, nodeId: 'verify',
    workId: newVerify.work.id, decision: 'approve', reason: 'Revised result verified.' })
  const ready = await service.readProject(lead, project.id)
  assert.deepEqual(ready.workflow.nodes.map(node => node.status), ['done', 'done'])
  const pausedAgain = await service.pauseProject(lead, { projectId: project.id,
    expectedProjectRevision: ready.project.revision, reason: 'Remove verification.' })
  const removedReview = await service.rebuildProjectWorkflow(lead, {
    projectId: project.id, expectedProjectRevision: pausedAgain.project.revision,
    expectedWorkflowRevision: 2, reason: 'Verification is no longer required.',
    idempotencyKey: 'remove-verify', workflow: {
      summary: 'Independent evidence only.', steps: [newIndependent],
    },
  }, async () => ({ status: 'quiet', sessionIds: [] }))
  assert.deepEqual(removedReview.amendment.retained,
    [{ nodeId: 'independent', workId: independentWorkId }])
  const reintroduced = await service.rebuildProjectWorkflow(lead, {
    projectId: project.id, expectedProjectRevision: removedReview.project.revision,
    expectedWorkflowRevision: 3, reason: 'Start source collection again.',
    idempotencyKey: 'reintroduce-source', workflow: {
      summary: 'Collect a new source and retain independent evidence.',
      steps: [first, newIndependent],
    },
  }, async () => ({ status: 'quiet', sessionIds: [] }))
  assert.deepEqual(reintroduced.amendment.retained,
    [{ nodeId: 'independent', workId: independentWorkId }])
  const restarted = await service.rebuildProjectWorkflow(lead, {
    projectId: project.id, expectedProjectRevision: reintroduced.project.revision,
    expectedWorkflowRevision: 4, reason: 'Redo independent evidence and its verification.',
    idempotencyKey: 'restart-independent', restartNodeIds: ['independent'], workflow: {
      summary: 'Repeat the independent branch.',
      steps: [first, newIndependent, { ...dependent, after: ['independent'] }],
    },
  }, async () => ({ status: 'quiet', sessionIds: [] }))
  assert.deepEqual(restarted.amendment.retained, [])
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  const persisted = await reopened.readProject(lead, project.id)
  assert.equal(persisted.project.workflowAmendments.length, 4)
  assert.equal(persisted.project.workflowAmendments[0].byPrincipal, 'alice')
  assert.deepEqual(persisted.workflow.nodes.map(node => node.status), ['ready', 'ready', 'pending'])
  assert.equal(persisted.work.find(work => work.id === sourceWorkId).status, 'completed')
  assert.equal(persisted.work.find(work => work.id === oldVerifyWorkId).status, 'completed')
})

test('Project pause persists a dispatch fence, cancels delegated Work, and resumes only after runtime inspection', async t => {
  const root = await makeTempDir('bizagent-project-pause-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const analystCwd = join(root, 'analyst')
  await mkdir(analystCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:analyst', owner: 'alice' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: analystCwd, address: 'role:analyst' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('pause-lead', root, 'Lead the Project.')
  const analyst = runtime.agent('pause-analyst', analystCwd, 'Analyze the Project.')
  const project = (await service.createProject(lead, { title: 'Paused review', goal: 'Review evidence.',
    doneWhen: 'The evidence is reviewed.', idempotencyKey: 'paused-review' })).project
  const delegated = await service.delegateProjectWork(lead, {
    projectId: project.id, toAddress: 'role:analyst', responsibility: 'Analyze evidence',
    goal: 'Analyze the evidence', acceptanceCriteria: 'Return findings.', idempotencyKey: 'analysis',
  })
  await service.acceptWork(analyst, delegated.work.id)
  const revision = delegated.projectRevision
  await assert.rejects(() => service.pauseProject(analyst, {
    projectId: project.id, expectedProjectRevision: revision, reason: 'Change the plan.',
  }), /only the lead Home/)
  const paused = await service.pauseProject(lead, {
    projectId: project.id, expectedProjectRevision: revision, reason: 'Change the plan.',
  })
  assert.equal(paused.project.intervention.paused, true)
  assert.deepEqual(paused.cancelledWorkIds, [delegated.work.id])
  assert.deepEqual(paused.notificationFailures, [])
  assert.deepEqual(paused.unsettledWorkIds, [])
  assert.equal(runtime.workLedger.get(delegated.work.id).status, 'cancelled')
  assert.equal(runtime.workLedger.get(delegated.work.id).cancelledByProjectSessionId, lead.id)
  assert.equal(runtime.ledger.getInboxDelivery(runtime.workLedger.get(delegated.work.id).cancelMessageId,
    'role:analyst').status, 'delivered')
  assert.deepEqual(projectSessionIds(service, project.id), [analyst.id])
  assert.equal((await service.pauseProject(lead, {
    projectId: project.id, expectedProjectRevision: revision, reason: 'Change the plan.',
  })).idempotentReplay, true)
  assert.equal((await service.readProject(lead, project.id)).project.revision, paused.project.revision)
  await assert.rejects(() => service.dispatchWork(lead, { toAddress: 'role:analyst',
    goal: 'Another review', acceptanceCriteria: 'Return findings.', idempotencyKey: 'again',
    projectId: project.id }), /paused/)
  await assert.rejects(() => service.delegateProjectWork(lead, { projectId: project.id,
    toAddress: 'role:analyst', responsibility: 'Analyze evidence', goal: 'Another review',
    acceptanceCriteria: 'Return findings.', idempotencyKey: 'again',
  }), /open dynamic Project/)
  await assert.rejects(() => service.completeWork(analyst, { workId: delegated.work.id,
    subject: 'Late result', body: 'Too late.' }), /paused/)
  const interrupted = []
  const live = { id: analyst.id, status: 'running', session: analyst.session,
    inbox: { nextTurn: [], nextStep: [] },
    cancel(cause) { interrupted.push(cause); this.status = 'idle' } }
  const agents = { get(id) { return id === analyst.id ? live : undefined } }
  assert.equal((await inspectProjectRuntime(agents, runtime.sessionQuery, service,
    project.id, lead.id)).status, 'busy')
  const released = []
  const hooks = createProjectInterventionRuntimeHooks(agents, runtime.sessionQuery, service,
    { releaseWhenIdle: id => { released.push(id) } })
  assert.deepEqual((await hooks.afterPause({ userId: 'alice' }, project.id,
    [delegated.work.id])).interrupted, [analyst.id])
  assert.deepEqual(released, [delegated.work.id])
  assert.equal(interrupted[0].kind, 'hook')
  await assert.rejects(() => service.resumeProject(lead, {
    projectId: project.id, expectedProjectRevision: paused.project.revision,
  }, () => inspectProjectRuntime(agents, runtime.sessionQuery, service,
    project.id, lead.id)), /unknown/)
  runtime.appendSessionEvent(analyst.id, { seq: 2, time: Date.now(), type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } } })
  live.inbox.nextTurn.push({ id: 'unrelated-home-followup' })
  assert.equal((await inspectProjectRuntime(agents, runtime.sessionQuery, service,
    project.id, lead.id)).status, 'quiet')
  live.inbox.nextTurn.length = 0
  assert.equal((await inspectProjectRuntime(agents, runtime.sessionQuery, service,
    project.id, lead.id)).status, 'quiet')
  const resumed = await service.resumeProject(lead, {
    projectId: project.id, expectedProjectRevision: paused.project.revision,
  }, () => inspectProjectRuntime(agents, runtime.sessionQuery, service, project.id, lead.id))
  assert.equal(resumed.project.intervention.paused, false)
  assert.equal(resumed.project.intervention.epoch, 1)
  assert.deepEqual(resumed.project.intervention.history.map(item => item.action), ['pause', 'resume'])
  assert.equal(FormalProjectSchema.safeParse({ ...resumed.project,
    intervention: { ...resumed.project.intervention, epoch: 0 },
  }).success, false)
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  assert.equal((await reopened.readProject(lead, project.id)).project.intervention.epoch, 1)
  const again = await service.dispatchWork(lead, { toAddress: 'role:analyst',
    goal: 'New review', acceptanceCriteria: 'Return new findings.', idempotencyKey: 'new-review',
    projectId: project.id })
  assert.equal(again.work.status, 'open')
  const putInboxMessage = runtime.ledger.putInboxMessage.bind(runtime.ledger)
  let failCancelNotice = true
  runtime.ledger.putInboxMessage = async message => {
    if (failCancelNotice && message.kind === 'work-notice' && message.subject.startsWith('Work cancelled:')) {
      failCancelNotice = false
      throw new Error('injected cancellation notice failure')
    }
    return putInboxMessage(message)
  }
  let humanGrant = false
  const authorizeHuman = (principal, current) => humanGrant && principal === 'alice'
    && current.lead === 'personal:alice'
  await assert.rejects(() => service.pauseProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: resumed.project.revision, reason: 'Check the replacement Work.' },
  authorizeHuman), /not authorized/)
  humanGrant = true
  await assert.rejects(() => service.pauseProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: resumed.project.revision + 1, reason: 'Check the replacement Work.' },
  authorizeHuman), /revision changed/)
  const pausedAgain = await service.pauseProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: resumed.project.revision, reason: 'Check the replacement Work.' },
  authorizeHuman)
  assert.equal(pausedAgain.notificationFailures.length, 1)
  assert.equal(runtime.workLedger.get(again.work.id).status, 'cancelled')
  assert.equal(runtime.workLedger.get(again.work.id).cancelledByProjectPrincipal, 'alice')
  assert.equal(runtime.workLedger.get(again.work.id).cancelledByProjectSessionId, undefined)
  assert.equal(pausedAgain.project.intervention.history.at(-1).byPrincipal, 'alice')
  assert.equal(FormalWorkSchema.safeParse({ ...runtime.workLedger.get(again.work.id),
    cancelledByProjectSessionId: 'forged-session' }).success, false)
  assert.equal(FormalProjectSchema.safeParse({ ...pausedAgain.project,
    intervention: { ...pausedAgain.project.intervention,
      history: pausedAgain.project.intervention.history.map((event, index) =>
        index === pausedAgain.project.intervention.history.length - 1
          ? { ...event, bySessionId: 'forged-session' } : event) } }).success, false)
  await assert.rejects(() => service.resumeProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: pausedAgain.project.revision }, authorizeHuman,
  async () => ({ status: 'quiet', sessionIds: [] })), /cancellations are not delivered/)
  runtime.ledger.putInboxMessage = putInboxMessage
  const retriedPause = await service.pauseProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: resumed.project.revision,
    reason: 'A retry must keep the original pause reason.' }, authorizeHuman)
  assert.equal(retriedPause.idempotentReplay, true)
  assert.deepEqual(retriedPause.notifiedWorkIds, [again.work.id])
  assert.equal(retriedPause.notificationFailures.length, 0)
  assert.equal(runtime.workLedger.get(again.work.id).cancelReason,
    'Project paused: Check the replacement Work.')
  const humanPauseRecovery = await service.reconcilePausedProjects()
  assert.equal(humanPauseRecovery.repaired[0].coordinatorSessionId, undefined)
  assert.deepEqual(humanPauseRecovery.failed, [])
  const repaired = await service.reconcileWorkNotifications()
  assert.deepEqual(repaired.failed, [])
  assert.equal(repaired.repaired.some(item => item.workId === again.work.id && item.phase === 'cancel'), false)
  humanGrant = false
  await assert.rejects(() => service.resumeProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: pausedAgain.project.revision }, authorizeHuman,
  async () => ({ status: 'quiet', sessionIds: [] })), /not authorized/)
  humanGrant = true
  const recovered = await service.resumeProjectAsHuman('alice', { projectId: project.id,
    expectedProjectRevision: pausedAgain.project.revision }, authorizeHuman,
  async () => ({ status: 'quiet', sessionIds: [] }))
  assert.equal(recovered.project.intervention.epoch, 2)
  assert.equal(recovered.project.intervention.history.at(-1).byPrincipal, 'alice')
  const reopenedHuman = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopenedHuman.initialize()
  assert.equal(reopenedHuman.projectLedger.get(project.id).intervention.history.at(-1).byPrincipal, 'alice')
  assert.equal(reopenedHuman.workLedger.get(again.work.id).cancelledByProjectPrincipal, 'alice')
})

test('paused Project recovery finishes cancellation after a crash between the fence and Work cleanup', async t => {
  const root = await makeTempDir('bizagent-project-pause-recovery-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:analyst' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'analyst'), address: 'role:analyst' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('crash-pause-lead', root, 'Lead the Project.')
  const project = (await service.createProject(lead, { title: 'Crash pause',
    goal: 'Verify two reports.', doneWhen: 'Both reports are reviewed.',
    idempotencyKey: 'crash-pause' })).project
  const workIds = []
  for (const key of ['first', 'second']) {
    const { work } = await service.dispatchWork(lead, { toAddress: 'role:analyst',
      goal: `Prepare ${key} report`, acceptanceCriteria: 'Return a report.',
      idempotencyKey: `crash-${key}`, projectId: project.id })
    workIds.push(work.id)
  }
  const originalPut = runtime.workLedger.put.bind(runtime.workLedger)
  let cancellationWrites = 0
  runtime.workLedger.put = async work => {
    if (work.status === 'cancelled' && ++cancellationWrites === 2) {
      throw new Error('injected host loss during cancellation')
    }
    return originalPut(work)
  }
  await assert.rejects(() => service.pauseProject(lead, { projectId: project.id,
    expectedProjectRevision: project.revision, reason: 'Stop before revising.' }),
  /injected host loss/)
  assert.equal(runtime.projectLedger.get(project.id).intervention.paused, true)
  assert.deepEqual(workIds.map(id => runtime.workLedger.get(id).status).sort(), ['cancelled', 'open'])
  runtime.workLedger.put = originalPut
  const reopened = new BizAgentService(store, await runtime.reopenLedger(), config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  const recovered = await reopened.reconcilePausedProjects()
  assert.deepEqual(recovered.failed, [])
  assert.deepEqual(recovered.repaired.map(item => item.projectId), [project.id])
  assert.equal(recovered.repaired[0].coordinatorSessionId, lead.id)
  assert.equal(recovered.repaired[0].cancelledWorkIds.length, 1)
  assert.equal(recovered.repaired[0].notifiedWorkIds.length, 2)
  for (const id of workIds) {
    const work = reopened.workLedger.get(id)
    assert.equal(work.status, 'cancelled')
    assert.equal(work.cancelReason, 'Project paused: Stop before revising.')
    assert.equal(work.cancelledByProjectSessionId, lead.id)
    assert.equal(reopened.ledger.getInboxDelivery(work.cancelMessageId, 'role:analyst').status,
      'delivered')
  }
  const repeated = await reopened.reconcilePausedProjects()
  assert.deepEqual(repeated.failed, [])
  assert.deepEqual(repeated.repaired[0].cancelledWorkIds, [])
  assert.deepEqual(repeated.repaired[0].notifiedWorkIds, [])
  assert.equal((await reopened.readProject(lead, project.id)).project.revision, project.revision + 1)
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
  assert.deepEqual(projectSessionIds(service, project.id), [participant.id])
  assert.equal((await runtime.reopenLedger()).listProjectTurns(project.id).length, 1)
  const paused = await service.pauseProject(coordinator, { projectId: project.id,
    expectedProjectRevision: project.revision, reason: 'Stop the active project turn.' })
  let interrupts = 0
  const live = { id: participant.id, status: 'running', session: participant.session,
    inbox: { nextTurn: [], nextStep: [] },
    cancel() { interrupts++; this.status = 'idle' } }
  const agents = { get(id) { return id === participant.id ? live : undefined } }
  assert.equal((await inspectProjectRuntime(agents, runtime.sessionQuery, service,
    project.id, coordinator.id)).status, 'busy')
  assert.deepEqual(interruptProjectSessions(agents, service, project.id, coordinator.id).interrupted,
    [participant.id])
  assert.equal(interrupts, 1)
  runtime.appendSessionEvent(participant.id, { seq: 2, time: Date.now(), type: 'turn/end',
    data: { turn: 1, reason: { kind: 'cancelled' } } })
  participant.session.events.push({ seq: 3, time: Date.now(), type: 'turn/start', data: { turn: 2 } })
  live.status = 'running'
  assert.deepEqual(interruptProjectSessions(agents, service, project.id, coordinator.id).interrupted, [])
  assert.equal(interrupts, 1)
  assert.equal((await inspectProjectRuntime(agents, runtime.sessionQuery, service,
    project.id, coordinator.id)).status, 'quiet')
  await service.resumeProject(coordinator, { projectId: project.id,
    expectedProjectRevision: paused.project.revision },
  () => inspectProjectRuntime(agents, runtime.sessionQuery, service, project.id, coordinator.id))
})

test('frozen Project Workflow gates Work by dependencies and retries cancelled node attempts', async (t) => {
  const root = await makeTempDir('bizagent-workflow-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:reviewer' })
  await store.createHome({ address: 'capability:checker' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [
      { root: `${root}/reviewer`, address: 'role:reviewer' },
      { root: `${root}/checker`, address: 'capability:checker' },
      { root, address: 'personal:alice' },
    ],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('lead-workflow', root, 'Start a planned project.')
  const reviewer = runtime.agent('reviewer-workflow', `${root}/reviewer`, 'Review a planned result.')
  const checker = runtime.agent('checker-workflow', `${root}/checker`, 'Check the node result.')
  const create = {
    title: 'Planned cohort check', goal: 'Agree on cohort fields and interpretation.',
    doneWhen: 'Both planned nodes have completed with a final conclusion.',
    idempotencyKey: 'planned-cohort',
    workflow: {
      summary: 'Analyze before review.',
      steps: [
        { id: 'analyze', title: 'Analyze fields', intent: 'List cohort fields.',
          executor: 'personal:alice', acceptanceCriteria: 'Return the source field list.', after: [] },
        { id: 'review', title: 'Review fields', intent: 'Check the analysis.',
          executor: 'role:reviewer', acceptanceCriteria: 'Return discrepancies.', after: ['analyze'],
          reviewer: 'capability:checker', reviewCriteria: 'Confirm all discrepancies have evidence.' },
      ],
    },
  }
  await assert.rejects(() => service.createProject(lead, {
    ...create, workflow: { ...create.workflow, steps: [
      { ...create.workflow.steps[0], after: ['review'] }, create.workflow.steps[1],
    ] },
  }), /cycle/)
  await assert.rejects(() => service.createProject(lead, {
    ...create, workflow: { ...create.workflow, steps: [
      create.workflow.steps[0], { ...create.workflow.steps[1], after: ['missing'] },
    ] },
  }), /unknown Workflow dependency/)
  const project = (await service.createProject(lead, create)).project
  assert.equal((await service.createProject(lead, create)).idempotentReplay, true)
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.readyNodeIds, ['analyze'])
  await assert.rejects(() => service.dispatchWork(lead, {
    toAddress: 'role:reviewer', goal: 'Bypass the plan', acceptanceCriteria: 'Finish.',
    idempotencyKey: 'bypass', projectId: project.id,
  }), /through a defined node/)
  await assert.rejects(() => service.dispatchProjectNode(lead, {
    projectId: project.id, nodeId: 'review',
  }), /dependencies are not complete/)
  const first = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'analyze' })
  assert.equal(first.work.requester, first.work.assignee)
  assert.equal(first.work.workflowAttempt, 1)
  assert.equal((await service.dispatchProjectNode(lead, {
    projectId: project.id, nodeId: 'analyze',
  })).work.id, first.work.id)
  await assert.rejects(() => service.submitProject(lead, {
    projectId: project.id, summary: 'Early', body: 'Not finished.', doneWhenAssessment: 'Incomplete.',
  }), /Workflow nodes are unfinished/)
  await service.acceptWork(lead, first.work.id)
  await service.completeWork(lead, {
    workId: first.work.id, subject: 'Analysis done', body: 'The source fields are known.',
  })
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.readyNodeIds, ['review'])
  const reviewAttempt1 = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'review' })
  await service.cancelWork(lead, { workId: reviewAttempt1.work.id, reason: 'Use revised criteria.' })
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.readyNodeIds, ['review'])
  const reviewAttempt2 = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'review' })
  assert.notEqual(reviewAttempt2.work.id, reviewAttempt1.work.id)
  assert.equal(reviewAttempt2.work.workflowAttempt, 2)
  await service.acceptWork(reviewer, reviewAttempt2.work.id)
  await service.completeWork(reviewer, {
    workId: reviewAttempt2.work.id, subject: 'Review done', body: 'No discrepancies remain.',
  })
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.nodes.map(node => node.status), ['done', 'waiting'])
  await assert.rejects(() => service.dispatchProjectNode(lead, {
    projectId: project.id, nodeId: 'review',
  }), /waiting for its assigned review/)
  await assert.rejects(() => service.submitProject(lead, {
    projectId: project.id, summary: 'Too soon', body: 'Not reviewed.', doneWhenAssessment: 'Still waiting.',
  }), /Workflow nodes are unfinished/)
  await assert.rejects(() => service.readProjectNode(reviewer, {
    projectId: project.id, nodeId: 'review',
  }), /not visible/)
  const reviewMaterial = await service.readProjectNode(checker, {
    projectId: project.id, nodeId: 'review',
  })
  assert.equal(reviewMaterial.latestWork.resultMessageId, reviewAttempt2.work.resultMessageId ??
    runtime.workLedger.get(reviewAttempt2.work.id).resultMessageId)
  await assert.rejects(() => service.reviewProjectNode(reviewer, {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt2.work.id,
    decision: 'approve', reason: 'Wrong reviewer.',
  }), /assigned reviewer Home/)
  let humanGrant = false
  const authorizeHuman = (principal, current, reviewerHome, nodeId) => humanGrant
    && ['alice', 'bob'].includes(principal) && current.id === project.id
    && reviewerHome === 'capability:checker' && nodeId === 'review'
  await assert.rejects(() => service.readProjectNodeReviewAsHuman('alice', project.id,
    'review', authorizeHuman), /not authorized/)
  humanGrant = true
  let pending = await service.readProjectNodeReviewAsHuman('alice', project.id,
    'review', authorizeHuman)
  assert.equal(pending.canReview, true)
  assert.equal(pending.workId, reviewAttempt2.work.id)
  let managerGrant = false
  let targetGrant = false
  const authorizeManager = (principal, current) => managerGrant
    && principal === 'manager' && current.id === project.id
  const authorizeTarget = (principal, current, reviewerHome, nodeId, workId) => targetGrant
    && ['alice', 'bob'].includes(principal) && current.id === project.id
    && reviewerHome === 'capability:checker' && nodeId === 'review'
    && workId === reviewAttempt2.work.id
  const assignmentInput = { projectId: project.id, nodeId: 'review',
    workId: reviewAttempt2.work.id, expectedRevision: pending.revision,
    expectedPrincipal: null, assignedPrincipal: 'bob', reason: 'Bob is on review duty.' }
  await assert.rejects(() => service.reassignProjectNodeReviewerAsHuman('manager',
    assignmentInput, authorizeManager, authorizeTarget), /not authorized/)
  managerGrant = true
  await assert.rejects(() => service.reassignProjectNodeReviewerAsHuman('manager',
    assignmentInput, authorizeManager, authorizeTarget), /not authorized/)
  targetGrant = true
  await assert.rejects(() => service.reassignProjectNodeReviewerAsHuman('manager',
    { ...assignmentInput, expectedRevision: pending.revision + 1 },
    authorizeManager, authorizeTarget), /revision conflict/)
  const assignedBob = await service.reassignProjectNodeReviewerAsHuman('manager',
    assignmentInput, authorizeManager, authorizeTarget)
  assert.equal(assignedBob.assignment.assignedPrincipal, 'bob')
  assert.equal(assignedBob.assignment.assignedByPrincipal, 'manager')
  assert.equal(assignedBob.assignment.previousPrincipal, undefined)
  const bobInbox = await service.listPendingProjectNodeReviewsAsHuman('bob', authorizeHuman)
  assert.deepEqual(bobInbox.items.map(item => [item.projectId, item.nodeId, item.workId]),
    [[project.id, 'review', reviewAttempt2.work.id]])
  assert.match(bobInbox.items[0].resultBody, /No discrepancies remain\./)
  assert.deepEqual((await service.listPendingProjectNodeReviewsAsHuman('bob',
    authorizeHuman, 1)).items, [])
  assert.deepEqual((await service.listPendingProjectNodeReviewsAsHuman('alice',
    authorizeHuman)).items, [])
  await assert.rejects(() => service.readProjectNodeReviewAsHuman('alice', project.id,
    'review', authorizeHuman), /not authorized/)
  assert.equal((await service.readProjectNodeReviewAsHuman('bob', project.id,
    'review', authorizeHuman)).canReview, true)
  await assert.rejects(() => service.readProjectNode(checker, {
    projectId: project.id, nodeId: 'review',
  }), /not visible/)
  await assert.rejects(() => service.reviewProjectNode(checker, {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt2.work.id,
    decision: 'approve', reason: 'Agent review after human assignment.',
  }), /not authorized/)
  await assert.rejects(() => service.reviewProjectNodeAsHuman('alice', {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt2.work.id,
    expectedRevision: assignedBob.project.revision, decision: 'rework', reason: 'Wrong person.',
  }, authorizeHuman), /not authorized/)
  await assert.rejects(() => service.reassignProjectNodeReviewerAsHuman('manager',
    { ...assignmentInput, expectedRevision: assignedBob.project.revision,
      assignedPrincipal: 'alice' }, authorizeManager, authorizeTarget), /assignment changed/)
  const assignedAlice = await service.reassignProjectNodeReviewerAsHuman('manager',
    { ...assignmentInput, expectedRevision: assignedBob.project.revision,
      expectedPrincipal: 'bob', assignedPrincipal: 'alice', reason: 'Alice takes over.' },
    authorizeManager, authorizeTarget)
  assert.equal(assignedAlice.assignment.previousPrincipal, 'bob')
  assert.deepEqual((await service.listPendingProjectNodeReviewsAsHuman('bob',
    authorizeHuman)).items, [])
  assert.equal((await service.listPendingProjectNodeReviewsAsHuman('alice',
    authorizeHuman)).items[0].assignedPrincipal, 'alice')
  await assert.rejects(() => service.readProjectNodeReviewAsHuman('bob', project.id,
    'review', authorizeHuman), /not authorized/)
  pending = await service.readProjectNodeReviewAsHuman('alice', project.id,
    'review', authorizeHuman)
  assert.equal(pending.revision, assignedAlice.project.revision)
  await assert.rejects(() => service.reviewProjectNodeAsHuman('alice', {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt2.work.id,
    expectedRevision: pending.revision + 1, decision: 'rework', reason: 'Stale review.',
  }, authorizeHuman), /revision conflict/)
  humanGrant = false
  await assert.rejects(() => service.reviewProjectNodeAsHuman('alice', {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt2.work.id,
    expectedRevision: pending.revision, decision: 'rework', reason: 'No longer authorized.',
  }, authorizeHuman), /not authorized/)
  humanGrant = true
  const putDecisionDelivery = runtime.ledger.putInboxDelivery.bind(runtime.ledger)
  runtime.ledger.putInboxDelivery = async () => { throw new Error('decision Inbox receipt unavailable') }
  const rework = await service.reviewProjectNodeAsHuman('alice', {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt2.work.id,
    expectedRevision: pending.revision, decision: 'rework', reason: 'Explain the denominator.',
  }, authorizeHuman)
  assert.equal(rework.notification, 'pending')
  runtime.ledger.putInboxDelivery = putDecisionDelivery
  const repairedDecision = await service.reconcileProjectNodeDecisionNotifications()
  assert.equal(repairedDecision.failed.length, 0)
  assert.equal(repairedDecision.delivered.length, 1)
  const reworkNotice = runtime.ledger.getInboxMessage(repairedDecision.delivered[0])
  assert.equal(reworkNotice.kind, 'project-node-decision')
  assert.equal(reworkNotice.projectNodeDecision.workId, reviewAttempt2.work.id)
  assert.match(reworkNotice.body, /Explain the denominator/)
  assert.equal(runtime.ledger.getInboxDelivery(reworkNotice.id, project.lead).status, 'delivered')
  assert.deepEqual((await service.reconcileProjectNodeDecisionNotifications()).delivered, [])
  const decisionPrompts = []
  const decisionLive = new Map()
  const decisionAgents = {
    get(id) { return decisionLive.get(String(id)) },
    async create(options) {
      const agent = runtime.agent(String(options.sessionId), options.meta.cwd, 'Read Project decision.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = prompt => { decisionPrompts.push(prompt); agent.inbox.nextTurn.push(prompt) }
      agent.whenIdle = () => new Promise(() => {})
      decisionLive.set(String(options.sessionId), agent)
      return { agent, async dispose() { decisionLive.delete(String(options.sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }
  const decisionRunner = new InboxWakeRunner(decisionAgents, runtime.sessionQuery, service, config)
  const decisionPass = await decisionRunner.recoverBatch(4, Date.parse(reworkNotice.sentAt) + 1000)
  assert.deepEqual(decisionPass.failed, [])
  assert.equal(decisionPass.started.length, 1)
  assert.match(decisionPrompts[0].content[0].text, new RegExp(reworkNotice.id))
  await decisionRunner.close()
  assert.equal(rework.review.reviewedByPrincipal, 'alice')
  assert.equal(rework.review.reviewedBySessionId, undefined)
  assert.equal(rework.review.resultMessageId, runtime.workLedger.get(reviewAttempt2.work.id).resultMessageId)
  assert.deepEqual((await service.listPendingProjectNodeReviewsAsHuman('alice',
    authorizeHuman)).items, [])
  await assert.rejects(() => service.reassignProjectNodeReviewerAsHuman('manager',
    { ...assignmentInput, expectedRevision: rework.project.revision,
      expectedPrincipal: 'alice', assignedPrincipal: 'bob', reason: 'Too late.' },
    authorizeManager, authorizeTarget), /current pending Work result/)
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.readyNodeIds, ['review'])
  const reviewAttempt3 = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'review' })
  assert.equal(reviewAttempt3.work.workflowAttempt, 3)
  assert.equal(service.projectNodeDecisionCurrent(runtime.projectLedger.get(project.id),
    reviewAttempt2.work.id), false)
  await service.acceptWork(reviewer, reviewAttempt3.work.id)
  await mkdir(join(root, 'reviewer', 'artifacts'), { recursive: true })
  const nodeArtifact = join(root, 'reviewer', 'artifacts', 'denominator.md')
  await writeFile(nodeArtifact, 'Documented denominator\n')
  await service.completeWork(reviewer, {
    workId: reviewAttempt3.work.id, subject: 'Revised review', body: 'The denominator is documented.',
    artifactRefs: ['artifacts/denominator.md'],
  })
  const frozen = await service.readWorkArtifact(checker, {
    workId: reviewAttempt3.work.id, path: 'artifacts/denominator.md',
  })
  assert.equal(Buffer.from(frozen.contentBase64, 'base64').toString(), 'Documented denominator\n')
  assert.deepEqual(runtime.ledger.getInboxMessage(runtime.workLedger.get(reviewAttempt3.work.id).resultMessageId)
    .contextRefs, ['artifacts/denominator.md'])
  await writeFile(nodeArtifact, 'Changed denominator\n')
  await assert.rejects(() => service.reviewProjectNode(checker, {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt3.work.id,
    decision: 'approve', reason: 'The denominator and evidence now match.',
  }), /artifact changed after Work completion/)
  await writeFile(nodeArtifact, 'Documented denominator\n')
  const approved = await service.reviewProjectNode(checker, {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt3.work.id,
    decision: 'approve', reason: 'The denominator and evidence now match.',
  })
  assert.equal(approved.review.decision, 'approve')
  assert.equal(approved.notification, 'delivered')
  const decisionMessages = runtime.ledger.listInboxMessages().filter(message =>
    message.projectNodeDecision?.projectId === project.id)
  assert.equal(decisionMessages.length, 2)
  assert.match(decisionMessages.find(message => message.projectNodeDecision.workId === reviewAttempt3.work.id).body,
    /Continue ready nodes/)
  assert.equal((await service.reviewProjectNode(checker, {
    projectId: project.id, nodeId: 'review', workId: reviewAttempt3.work.id,
    decision: 'approve', reason: 'The denominator and evidence now match.',
  })).idempotentReplay, true)
  assert.equal(runtime.ledger.listInboxMessages().filter(message =>
    message.projectNodeDecision?.projectId === project.id).length, 2)
  const flow = (await service.readProject(lead, project.id)).workflow
  assert.deepEqual(flow.nodes.map(node => node.status), ['done', 'done'])
  assert.deepEqual(flow.nodes.map(node => node.attempts), [1, 3])
  const submitted = await service.submitProject(lead, {
    projectId: project.id, summary: 'Cohort check complete', body: 'The fields and review agree.',
    doneWhenAssessment: 'Both planned nodes completed.',
  })
  assert.deepEqual(submitted.claim.work.map(item => item.status).sort(), ['cancelled', 'completed', 'completed', 'completed'])
  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await reopened.initialize()
  assert.deepEqual((await reopened.readProject(lead, project.id)).workflow.readyNodeIds, [])
  assert.equal(reopened.projectLedger.get(project.id).nodeReviews[0].reviewedByPrincipal, 'alice')
  assert.deepEqual(reopened.projectLedger.get(project.id).nodeReviewerAssignments.map(item =>
    item.assignedPrincipal), ['bob', 'alice'])
  const audited = reopened.projectLedger.get(project.id)
  assert.equal(FormalProjectSchema.safeParse({ ...audited, nodeReviewerAssignments: [
    audited.nodeReviewerAssignments[0],
    { ...audited.nodeReviewerAssignments[1], previousPrincipal: 'mallory' },
  ] }).success, false)
  assert.equal(FormalProjectSchema.safeParse({ ...audited, nodeReviews: [
    { ...audited.nodeReviews[0], reviewedByPrincipal: 'mallory' },
    ...audited.nodeReviews.slice(1),
  ] }).success, false)
})

test('human node review inbox paginates current authorized Work across Projects', async t => {
  const root = await makeTempDir('bizagent-review-inbox-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'capability:checker' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'checker'), address: 'capability:checker' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('review-inbox-lead', root, 'Create two reviewable projects.')
  const ids = []
  for (const number of [1, 2]) {
    const project = (await service.createProject(lead, {
      title: `Review project ${number}`, goal: 'Check the result.', doneWhen: 'Reviewer approves.',
      idempotencyKey: `review-inbox-${number}`,
      workflow: { summary: 'Submit a result.', steps: [{ id: 'check', title: 'Check result',
        intent: 'Prepare evidence.', executor: 'personal:alice',
        acceptanceCriteria: 'Return a result.', after: [],
        reviewer: 'capability:checker', reviewCriteria: 'Verify evidence.' }] },
    })).project
    ids.push(project.id)
    const dispatched = await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'check' })
    await service.acceptWork(lead, dispatched.work.id)
    await service.completeWork(lead, { workId: dispatched.work.id,
      subject: `Result ${number}`, body: `Evidence ${number}.` })
  }
  const grants = new Set(ids)
  const authorize = (principal, project, reviewerHome, nodeId) => principal === 'alice'
    && grants.has(project.id) && reviewerHome === 'capability:checker' && nodeId === 'check'
  const first = await service.listPendingProjectNodeReviewsAsHuman('alice', authorize, 0, 1)
  const second = await service.listPendingProjectNodeReviewsAsHuman('alice', authorize,
    first.nextOffset, 1)
  assert.equal(first.nextOffset, 1)
  assert.equal(second.nextOffset, undefined)
  assert.deepEqual(new Set([first.items[0].projectId, second.items[0].projectId]), new Set(ids))
  grants.delete(second.items[0].projectId)
  assert.deepEqual((await service.listPendingProjectNodeReviewsAsHuman('alice',
    authorize)).items.map(item => item.projectId), [first.items[0].projectId])
  assert.deepEqual((await service.listPendingProjectNodeReviewsAsHuman('bob',
    authorize)).items, [])
})

test('approved node artifact drift blocks downstream and settlement until audited reopen and rework', async t => {
  const root = await makeTempDir('bizagent-workflow-reopen-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'capability:checker' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'checker'), address: 'capability:checker' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('reopen-lead', root, 'Lead a two node project.')
  const checker = runtime.agent('reopen-checker', join(root, 'checker'), 'Review source evidence.')
  const project = (await service.createProject(lead, {
    title: 'Evidence chain', goal: 'Publish checked source evidence.',
    doneWhen: 'Source and downstream summary agree.', idempotencyKey: 'evidence-chain',
    workflow: { summary: 'Check then summarize.', steps: [
      { id: 'source', title: 'Source', intent: 'Prepare source.', executor: 'personal:alice',
        acceptanceCriteria: 'Provide source file.', after: [], reviewer: 'capability:checker',
        reviewCriteria: 'Inspect the source file.' },
      { id: 'summary', title: 'Summary', intent: 'Summarize source.', executor: 'personal:alice',
        acceptanceCriteria: 'Provide a summary.', after: ['source'] },
    ] },
  })).project
  await mkdir(join(root, 'artifacts'), { recursive: true })
  const sourcePath = join(root, 'artifacts', 'source.md')
  await writeFile(sourcePath, 'First version\n')
  const source1 = (await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'source' })).work
  await service.acceptWork(lead, source1.id)
  await service.completeWork(lead, { workId: source1.id, subject: 'Source ready', body: 'First version.',
    artifactRefs: ['artifacts/source.md'] })
  await service.reviewProjectNode(checker, { projectId: project.id, nodeId: 'source',
    workId: source1.id, decision: 'approve', reason: 'Source checked.' })
  await writeFile(sourcePath, 'Changed before downstream\n')
  await assert.rejects(() => service.dispatchProjectNode(lead, {
    projectId: project.id, nodeId: 'summary',
  }), /approved Workflow node source is stale/)
  await writeFile(sourcePath, 'First version\n')
  const summary1 = (await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'summary' })).work
  await assert.rejects(() => service.reopenProjectNode(checker, {
    projectId: project.id, nodeId: 'source', reason: 'Wrong Home.',
  }), /only the lead Home/)
  await assert.rejects(() => service.reopenProjectNode(lead, {
    projectId: project.id, nodeId: 'source', reason: 'Source revised.',
  }), /descendants still have active Work/)
  await service.acceptWork(lead, summary1.id)
  await service.completeWork(lead, { workId: summary1.id, subject: 'Summary ready', body: 'Summarized first version.' })
  await writeFile(sourcePath, 'Second version\n')
  const claim = { projectId: project.id, summary: 'Ready', body: 'Both nodes completed.',
    doneWhenAssessment: 'Source and summary agree.' }
  await assert.rejects(() => service.submitProject(lead, claim), /approved Workflow node source is stale/)
  const reopened = await service.reopenProjectNode(lead, {
    projectId: project.id, nodeId: 'source', reason: 'Source revised.',
  })
  assert.deepEqual(reopened.reopens.map(item => item.nodeId), ['source', 'summary'])
  assert.equal((await service.reopenProjectNode(lead, {
    projectId: project.id, nodeId: 'source', reason: 'Source revised.',
  })).idempotentReplay, true)
  assert.deepEqual((await service.readProject(lead, project.id)).workflow.nodes.map(node => node.status),
    ['ready', 'pending'])
  await assert.rejects(() => service.reviewProjectNode(checker, { projectId: project.id,
    nodeId: 'source', workId: source1.id, decision: 'approve', reason: 'Source checked.',
  }), /superseded/)
  const source2 = (await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'source' })).work
  assert.equal(source2.workflowAttempt, 2)
  await service.acceptWork(lead, source2.id)
  await service.completeWork(lead, { workId: source2.id, subject: 'Revised source', body: 'Second version.',
    artifactRefs: ['artifacts/source.md'] })
  await service.reviewProjectNode(checker, { projectId: project.id, nodeId: 'source',
    workId: source2.id, decision: 'approve', reason: 'Revised source checked.' })
  const summary2 = (await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'summary' })).work
  assert.equal(summary2.workflowAttempt, 2)
  await service.acceptWork(lead, summary2.id)
  await service.completeWork(lead, { workId: summary2.id, subject: 'Revised summary', body: 'Summarized second version.' })
  const beforeHumanReopen = (await service.readProject(lead, project.id)).project
  let humanGrant = false
  const authorizeHuman = (principal, current) => humanGrant
    && principal === 'alice' && current.lead === 'personal:alice'
  const humanReopenInput = { projectId: project.id, nodeId: 'summary',
    reason: 'Check the summary wording once more.', expectedRevision: beforeHumanReopen.revision }
  await assert.rejects(() => service.reopenProjectNodeAsHuman('alice', humanReopenInput,
    authorizeHuman), /not authorized/)
  humanGrant = true
  await assert.rejects(() => service.reopenProjectNodeAsHuman('alice', {
    ...humanReopenInput, expectedRevision: beforeHumanReopen.revision + 1,
  }, authorizeHuman), /revision conflict/)
  const humanReopen = await service.reopenProjectNodeAsHuman('alice', humanReopenInput,
    authorizeHuman)
  assert.deepEqual(humanReopen.reopens.map(item => item.nodeId), ['summary'])
  assert.equal(humanReopen.reopens[0].reopenedByPrincipal, 'alice')
  assert.equal(FormalProjectSchema.safeParse({ ...humanReopen.project,
    nodeReopens: humanReopen.project.nodeReopens.map((item, index) =>
      index === humanReopen.project.nodeReopens.length - 1
        ? { ...item, reopenedBySessionId: 'forged-session' } : item),
  }).success, false)
  const summary3 = (await service.dispatchProjectNode(lead, { projectId: project.id, nodeId: 'summary' })).work
  await service.acceptWork(lead, summary3.id)
  await service.completeWork(lead, { workId: summary3.id,
    subject: 'Final summary', body: 'Summarized and checked second version.' })
  const submitted = await service.submitProject(lead, claim)
  await writeFile(sourcePath, 'Changed after submission\n')
  await assert.rejects(() => service.reviewProjectAsHuman('alice', { projectId: project.id,
    claimId: submitted.claim.id, decision: 'accept', reason: 'Checked.',
    expectedRevision: submitted.project.revision,
  }, authorizeHuman), /approved Workflow node source is stale/)
  await writeFile(sourcePath, 'Second version\n')
  assert.equal((await service.reviewProjectAsHuman('alice', { projectId: project.id,
    claimId: submitted.claim.id, decision: 'accept', reason: 'Checked.',
    expectedRevision: submitted.project.revision,
  }, authorizeHuman)).project.status, 'accepted')
  const resumed = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, await runtime.reopenWorkLedger(), await runtime.reopenProjectLedger())
  await resumed.initialize()
  const persisted = await resumed.readProject(lead, project.id)
  assert.equal(persisted.project.nodeReopens.length, 3)
  assert.equal(persisted.project.nodeReopens.at(-1).reopenedByPrincipal, 'alice')
  assert.deepEqual(persisted.workflow.nodes.map(node => node.status), ['done', 'done'])
})
