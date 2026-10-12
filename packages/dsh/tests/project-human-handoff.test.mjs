import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { FormalProjectSchema } from '../lib/project-ledger.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { registerTools } from '../lib/tools.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('Project human handoff blocks autonomy until the assigned person replies', async t => {
  const root = await makeTempDir('bizagent-project-human-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:analyst' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('human-lead', root, 'Lead the Project.')
  const tools = new Map()
  registerTools({ tools: { register(tool) { tools.set(tool.name, tool) } },
    agents: { get() {} }, sessionQuery: runtime.sessionQuery }, service, {}, {}, {}, {})
  const project = (await service.createProject(lead, { title: 'Audience',
    goal: 'Choose an initial audience.', doneWhen: 'The choice is recorded.',
    idempotencyKey: 'audience' })).project
  const request = { projectId: project.id, expectedProjectRevision: project.revision,
    requestId: 'audience-choice', question: 'Which audience should we test first?',
    reason: 'The product owner must choose before the team can schedule the test.',
    options: [{ label: 'New users', detail: 'Recruit next week.' },
      { label: 'Returning users' }, { label: 'New users' }] }
  await assert.rejects(() => service.requestProjectHuman(lead, { ...request,
    assignee: 'role:analyst' }), /no active Seat and confirmed principal/)
  const pending = await tools.get('bizagent_project_request_human').execute({
    project_id: request.projectId, expected_project_revision: request.expectedProjectRevision,
    request_id: request.requestId, question: request.question, reason: request.reason,
    options: request.options,
  }, { agent: lead })
  assert.equal(pending.notification, 'delivered')
  assert.equal(pending.project.status, 'blocked')
  assert.deepEqual(pending.handoff.options.map(item => item.label), ['New users', 'Returning users'])
  const notice = runtime.ledger.getInboxMessage(pending.handoff.messageId)
  assert.equal(notice.to[0], 'user:alice')
  assert.equal(notice.returnToSessionId, String(lead.id))
  assert.deepEqual(notice.humanAction.options, pending.handoff.options)
  assert.equal((await service.listProjects(lead, { status: 'blocked' })).projects[0].id, project.id)
  assert.equal((await service.requestProjectHuman(lead, request)).idempotentReplay, true)
  await assert.rejects(() => service.requestProjectHuman(lead, { ...request,
    requestId: 'another', expectedProjectRevision: pending.project.revision }), /current open Project/)
  await assert.rejects(() => service.resumeProjectAutonomy(lead, { projectId: project.id,
    handoffId: pending.handoff.id, replyMessageId: 'fabricated',
    expectedProjectRevision: pending.project.revision }), /not a delivered reply/)
  await assert.rejects(() => service.replyHumanInbox('mallory', { replyTo: notice.id,
    subject: 'Decision', body: 'New users', idempotencyKey: 'mallory-decision' }), /not a delivered Agent message/)
  const paused = await service.pauseProject(lead, { projectId: project.id,
    expectedProjectRevision: pending.project.revision, reason: 'Wait for a human choice.' })
  assert.equal(paused.project.status, 'blocked')
  assert.equal(paused.project.intervention.paused, true)
  const answered = await service.replyHumanInbox('alice', { replyTo: notice.id,
    subject: 'Audience decision', body: 'New users', idempotencyKey: 'audience-answer' })
  assert.equal(service.projectHumanAnswerMessage(answered.message, project.lead), true)
  assert.equal(service.projectLeadWakeBlocked(answered.message, project.lead), false)
  assert.equal(service.projectLeadWakeBlocked({ ...answered.message,
    replyTo: 'another-message' }, project.lead), true)
  const resumed = await tools.get('bizagent_project_resume_autonomy').execute({
    project_id: project.id, handoff_id: pending.handoff.id,
    reply_message_id: answered.message.id,
    expected_project_revision: paused.project.revision,
  }, { agent: lead })
  assert.equal(resumed.project.status, 'open')
  assert.equal(resumed.executionPaused, true)
  assert.equal(resumed.handoff.resolution.decision, 'New users')
  assert.equal(resumed.handoff.resolution.byUser, 'user:alice')
  assert.equal((await service.resumeProjectAutonomy(lead, { projectId: project.id,
    handoffId: pending.handoff.id, replyMessageId: answered.message.id,
    expectedProjectRevision: paused.project.revision })).idempotentReplay, true)
  FormalProjectSchema.parse(resumed.project)
  const execution = await service.resumeProject(lead, { projectId: project.id,
    expectedProjectRevision: resumed.project.revision }, async () => ({ status: 'quiet', sessionIds: [] }))
  assert.equal(execution.project.intervention.paused, false)

  const originalPut = runtime.ledger.putInboxMessage.bind(runtime.ledger)
  runtime.ledger.putInboxMessage = async () => { throw new Error('Inbox write interrupted') }
  const second = await service.requestProjectHuman(lead, {
    projectId: project.id, expectedProjectRevision: execution.project.revision,
    requestId: 'material', question: 'Which customer list is approved?',
    reason: 'Only the owner can provide the approved list.' })
  assert.equal(second.project.status, 'blocked')
  assert.equal(second.notification, 'pending')
  runtime.ledger.putInboxMessage = originalPut
  const recovered = await service.reconcileProjectHumanHandoffs()
  assert.deepEqual(recovered.delivered, [second.handoff.id])
  assert.equal(recovered.failed.length, 0)
  assert.equal(runtime.ledger.getInboxDelivery(second.handoff.messageId, 'user:alice').status, 'delivered')
  await service.close()
})

test('confirmed Role assignee can answer across Home owners and wake the blocked lead', async t => {
  const root = await makeTempDir('bizagent-project-role-human-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'personal:bob', owner: 'bob' })
  await store.createHome({ address: 'role:analyst' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('role-human-lead', root, 'Lead the Project.')
  const project = (await service.createProject(lead, { title: 'Data source',
    goal: 'Choose an approved source.', doneWhen: 'A source is selected.',
    idempotencyKey: 'data-source' })).project
  const invited = await service.inviteProjectSeat(lead, { projectId: project.id,
    homeAddress: 'role:analyst', responsibility: 'Advise on the source.' })
  const assigned = await service.decideProjectRoleAsHuman('alice', {
    projectId: project.id, roleHome: 'role:analyst', action: 'assign', targetPrincipal: 'bob',
    expectedProjectRevision: invited.projectRevision, expectedBindingRevision: 0,
    idempotencyKey: 'assign-bob', reason: 'Bob owns the source decision.' },
  (actor, current) => actor === 'alice' && current.lead === project.lead,
  target => target === 'bob')
  const handoff = await service.requestProjectHuman(lead, {
    projectId: project.id, expectedProjectRevision: assigned.project.revision,
    requestId: 'source-choice', question: 'Which source is approved?',
    reason: 'The analyst must confirm the source.', assignee: 'role:analyst',
    options: [{ label: 'CRM' }, { label: 'Warehouse' }] })
  assert.equal(handoff.handoff.recipient, 'user:bob')
  assert.equal(handoff.handoff.fallbackRecipient, 'user:alice')
  assert.deepEqual(runtime.ledger.getInboxMessage(handoff.handoff.messageId).cc, ['user:alice'])
  assert.equal(runtime.ledger.getInboxDelivery(handoff.handoff.messageId, 'user:alice').status, 'delivered')
  const otherId = 'other-project-note'
  const sentAt = new Date().toISOString()
  await runtime.ledger.putInboxMessage({ schemaVersion: 1, id: otherId,
    idempotencyKey: otherId, fromAddress: 'user:alice', to: ['personal:alice'], cc: [],
    projectId: project.id, subject: 'Other update', body: 'Wait for the analyst.',
    kind: 'ordinary', priority: 'urgent', contextRefs: [], rootId: otherId,
    chain: 0, topicId: otherId, hop: 0, sentAt })
  await runtime.ledger.putInboxDelivery({ schemaVersion: 1, messageId: otherId,
    recipient: 'personal:alice', status: 'delivered', updatedAt: sentAt })
  const reply = await service.replyHumanInbox('bob', {
    replyTo: handoff.handoff.messageId, subject: 'Source choice', body: 'Warehouse',
    idempotencyKey: 'source-answer' })
  await runtime.ledger.putInboxReturnRoute({ schemaVersion: 1,
    messageId: reply.message.id, recipient: 'personal:alice', sessionId: String(lead.id),
    status: 'fallback', reason: 'Original Session is unavailable', updatedAt: new Date().toISOString() })
  const live = new Map()
  const prompts = []
  const agents = { get(id) { return live.get(String(id)) },
    async create(options) {
      const agent = runtime.agent(String(options.sessionId), options.meta.cwd, 'Wake the lead.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = prompt => { prompts.push(prompt); agent.inbox.nextTurn.push(prompt) }
      agent.whenIdle = async () => {}
      live.set(String(agent.id), agent)
      return { agent, async dispose() { live.delete(String(agent.id)) } }
    },
    async resume() { throw new Error('wake must create one new lead Session') } }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const wake = await runner.recoverBatch(4)
  assert.equal(wake.failed.length, 0)
  assert.equal(wake.started.length, 1)
  assert.deepEqual(runtime.ledger.getInboxWakePlan(wake.started[0]).messageIds, [reply.message.id])
  assert.match(prompts[0].content[0].text, new RegExp(reply.message.id))
  await runner.close()
  const bobDecision = await service.resumeProjectAutonomy(lead, { projectId: project.id,
    handoffId: handoff.handoff.id, replyMessageId: reply.message.id,
    expectedProjectRevision: handoff.project.revision })
  assert.equal(bobDecision.handoff.resolution.byUser, 'user:bob')
  const ownerHandoff = await service.requestProjectHuman(lead, {
    projectId: project.id, expectedProjectRevision: bobDecision.project.revision,
    requestId: 'source-owner-choice', question: 'May we use this source now?',
    reason: 'The analyst is unavailable; the owner can confirm.', assignee: 'role:analyst' })
  const ownerReply = await service.replyHumanInbox('alice', {
    replyTo: ownerHandoff.handoff.messageId, subject: 'Owner decision', body: 'Yes, use it.',
    idempotencyKey: 'owner-source-answer' })
  assert.equal(service.projectHumanAnswerMessage(ownerReply.message, project.lead), true)
  const ownerDecision = await service.resumeProjectAutonomy(lead, { projectId: project.id,
    handoffId: ownerHandoff.handoff.id, replyMessageId: ownerReply.message.id,
    expectedProjectRevision: ownerHandoff.project.revision })
  assert.equal(ownerDecision.project.status, 'open')
  assert.equal(ownerDecision.handoff.resolution.byUser, 'user:alice')
  assert.equal(ownerDecision.handoff.resolution.decision, 'Yes, use it.')
  await service.close()
})
