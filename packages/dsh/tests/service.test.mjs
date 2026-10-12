import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { loadActiveOrganizationLocation } from '../lib/organization-location.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

class MemoryLedger {
  learningBatchTail = Promise.resolve()
  learningBatches = new Map()
  learningLaunches = new Map()
  bindings = new Map()
  proposalsMap = new Map()
  receipts = new Map()
  checkpoints = new Map()
  materialObservations = new Map()
  materialReviews = new Map()
  frameStates = new Map()
  inboxMessages = new Map()
  inboxDeliveries = new Map()
  inboxWakeOrigins = new Map()
  inboxReturnRoutes = new Map()
  inboxTail = Promise.resolve()

  async withInboxWrite(update) {
    const task = this.inboxTail.catch(() => undefined).then(update)
    this.inboxTail = task
    return task
  }
  getInboxMessage(id) { return structuredClone(this.inboxMessages.get(id)) }
  listInboxMessages() {
    return [...this.inboxMessages.values()].map(item => structuredClone(item))
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id))
  }
  async putInboxMessage(message) {
    if (this.inboxMessages.has(message.id)) throw new Error('Inbox message already exists')
    this.inboxMessages.set(message.id, structuredClone(message))
  }
  getInboxDelivery(messageId, recipient) {
    return structuredClone(this.inboxDeliveries.get(`${messageId}:${recipient}`))
  }
  async putInboxDelivery(delivery) {
    this.inboxDeliveries.set(`${delivery.messageId}:${delivery.recipient}`, structuredClone(delivery))
  }
  getInboxWakeOrigin(sessionId) { return structuredClone(this.inboxWakeOrigins.get(sessionId)) }
  async putInboxWakeOrigin(origin) {
    const prior = this.inboxWakeOrigins.get(origin.sessionId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(origin)) throw new Error('Inbox wake origin conflict')
    this.inboxWakeOrigins.set(origin.sessionId, structuredClone(origin))
    return structuredClone(origin)
  }
  getInboxReturnRoute(messageId, recipient) {
    return structuredClone(this.inboxReturnRoutes.get(`${messageId}:${recipient}`))
  }

  getBinding(id) { return this.bindings.get(id) }
  async putBinding(binding) {
    const current = this.bindings.get(binding.sessionId)
    if (current && current.homeAddress !== binding.homeAddress) throw new Error('rebind denied')
    this.bindings.set(binding.sessionId, structuredClone(binding))
  }
  listBindings(homeAddress) {
    return [...this.bindings.values()].filter(binding => !homeAddress || binding.homeAddress === homeAddress)
  }
  getFrameState(id) { return structuredClone(this.frameStates.get(id)) }
  async updateFrameState(id, update) {
    const state = update(this.getFrameState(id))
    this.frameStates.set(id, structuredClone(state))
    return structuredClone(state)
  }
  getMaterialObservation(id) { return this.materialObservations.get(id) }
  async putMaterialObservation(item) {
    if (!this.materialObservations.has(item.id)) this.materialObservations.set(item.id, structuredClone(item))
    return this.materialObservations.get(item.id)
  }
  getMaterialReview(id) { return this.materialReviews.get(id) }
  getLearningBatch(id) { return this.learningBatches.get(id) }
  getLearningLaunch(id) { return this.learningLaunches.get(id) }
  listLearningLaunches(homeAddress) {
    return [...this.learningLaunches.values()].filter(item => !homeAddress || item.homeAddress === homeAddress)
  }
  async putLearningLaunch(item) { this.learningLaunches.set(item.id, structuredClone(item)); return structuredClone(item) }
  listLearningBatches(homeAddress) {
    return [...this.learningBatches.values()].filter(run => run.homeAddress === homeAddress)
  }
  async putLearningBatch(run) { this.learningBatches.set(run.id, structuredClone(run)); return structuredClone(run) }
  async withLearningBatchWrite(update) {
    const task = this.learningBatchTail.catch(() => undefined).then(update)
    this.learningBatchTail = task
    return task
  }
  async putMaterialReview(item) {
    if (!this.materialReviews.has(item.materialId)) this.materialReviews.set(item.materialId, structuredClone(item))
    return this.materialReviews.get(item.materialId)
  }
  getProposal(id) { return this.proposalsMap.get(id) }
  async putProposal(proposal) { this.proposalsMap.set(proposal.id, structuredClone(proposal)) }
  listProposals(options = {}) {
    return [...this.proposalsMap.values()]
      .filter(item => !options.fromAddress || item.fromAddress === options.fromAddress)
      .filter(item => !options.toAddress || item.toAddress === options.toAddress)
      .filter(item => !options.status || item.status === options.status)
  }
  async putReceipt(receipt) {
    const previous = this.receipts.get(receipt.id)
    if (previous) {
      const { createdAt: _oldTime, ...oldValue } = previous
      const { createdAt: _newTime, ...newValue } = receipt
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) throw new Error('fitness receipt conflict')
      return false
    }
    this.receipts.set(receipt.id, structuredClone(receipt))
    return true
  }
  listReceipts(assetId) {
    return [...this.receipts.values()].filter(item => !assetId || item.assetId === assetId)
  }
  getCheckpoint(id) { return this.checkpoints.get(id) }
  async putCheckpoint(checkpoint) { this.checkpoints.set(checkpoint.id, structuredClone(checkpoint)) }
  listCheckpoints(options = {}) {
    return [...this.checkpoints.values()]
      .filter(item => !options.sessionId || item.sessionId === options.sessionId)
      .filter(item => !options.homeAddress || item.homeAddress === options.homeAddress)
      .filter(item => !options.status || item.status === options.status)
  }
  async close() {}
}

function agent(id, cwd) {
  return {
    id,
    session: {
      header: { id, cwd },
      events: [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Analyze the campaign.' }] } },
        { seq: 2, type: 'tool/call', data: { callId: `${id}-call` } },
      ],
    },
  }
}

test('Inbox persists bound sender, per-recipient results, replies, and explicit handling', async (t) => {
  const root = await makeTempDir('bizagent-inbox-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  await store.createHome({ address: 'capability:analyst' })
  await store.createHome({ address: 'business:store' })
  const ledger = new MemoryLedger()
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [
      { root: `${root}/reviewer`, address: 'role:reviewer' },
      { root: `${root}/analyst`, address: 'capability:analyst' },
      { root: `${root}/store`, address: 'business:store' },
    ],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, ledger, config)
  await service.initialize()
  const alice = agent('alice-session', root)
  const reviewer = agent('reviewer-session', `${root}/reviewer`)
  const analyst = agent('analyst-session', `${root}/analyst`)
  const stranger = agent('store-session', `${root}/store`)
  const input = {
    to: ['role:reviewer', 'role:missing'], cc: ['capability:analyst'],
    subject: 'Check cohort definitions', body: 'Please inspect the acquisition cohort.',
    idempotencyKey: 'cohort-1',
  }
  const sent = await service.sendInboxMessage(alice, 'call-1', input)
  assert.equal(sent.message.fromAddress, 'personal:alice')
  assert.equal(sent.message.returnToSessionId, 'alice-session')
  assert.deepEqual(sent.deliveries.map(item => item.status), ['delivered', 'bounced', 'delivered'])
  assert.equal((await service.listInbox(reviewer)).messages.length, 1)
  assert.equal((await service.listInbox(reviewer, { pendingOnly: true })).messages.length, 1)
  assert.equal((await service.readInboxMessage(reviewer, sent.message.id)).message.body, input.body)
  assert.equal((await service.readInboxMessage(alice, sent.message.id)).deliveries.length, 3)
  assert.equal((await service.readInboxMessage(analyst, sent.message.id)).message.id, sent.message.id)
  await assert.rejects(() => service.readInboxMessage(stranger, sent.message.id), /not visible/)
  await assert.rejects(() => service.handleInboxMessage(stranger, sent.message.id), /not delivered/)
  const replay = await service.sendInboxMessage(alice, 'different-call', input)
  assert.equal(replay.idempotentReplay, true)
  assert.equal(replay.message.id, sent.message.id)
  await assert.rejects(() => service.sendInboxMessage(alice, 'another', { ...input, body: 'Changed' }), /conflicts/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'cross', { to: ['personal:alice'], subject: 'Hijack', body: 'x', replyTo: 'missing' }), /reply target not found/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'cross', { to: ['role:other'], subject: 'Hijack', body: 'x', replyTo: sent.message.id }), /visible thread participants/)
  const reply = await service.sendInboxMessage(reviewer, 'reply', {
    to: ['personal:alice'], subject: 'Re: Check cohort definitions', body: 'Cohort fields are consistent.',
    replyTo: sent.message.id,
  })
  assert.equal(reply.message.rootId, sent.message.id)
  assert.equal(reply.message.chain, 1)
  assert.equal((await service.listInbox(alice)).messages.length, 1)
  const concurrent = await Promise.all([
    service.sendInboxMessage(alice, 'parallel-a', { to: ['role:reviewer'], subject: 'One', body: 'Same', idempotencyKey: 'parallel' }),
    service.sendInboxMessage(alice, 'parallel-b', { to: ['role:reviewer'], subject: 'One', body: 'Same', idempotencyKey: 'parallel' }),
  ])
  assert.equal(concurrent[0].message.id, concurrent[1].message.id)
  assert.equal(ledger.listInboxMessages().filter(item => item.id === concurrent[0].message.id).length, 1)
  const handled = await service.handleInboxMessage(reviewer, sent.message.id)
  assert.equal(handled.delivery.handledBySessionId, 'reviewer-session')
  assert.equal((await service.listInbox(reviewer, { pendingOnly: true })).messages.length, 1)
  const digest = service.pendingInboxDigestForSession(reviewer.id, `${root}/reviewer`)
  assert.equal(digest.total, 1)
  assert.deepEqual(digest.messages.map(item => item.id), [concurrent[0].message.id])
  assert.equal(digest.messages[0].body, undefined)
  assert.equal((await service.handleInboxMessage(reviewer, sent.message.id)).idempotentReplay, true)
  await assert.rejects(() => service.handleInboxMessage(alice, sent.message.id), /not delivered/)

  const resumed = new BizAgentService(store, ledger, config)
  await resumed.initialize()
  assert.equal((await resumed.readInboxMessage(reviewer, sent.message.id)).delivery.handledBySessionId, 'reviewer-session')
  assert.equal((await resumed.listInbox(alice, { direction: 'outgoing' })).messages.length, 2)
  assert.equal(ledger.listProposals().length, 0)
  for (let index = 0; index < 10; index += 1) {
    await resumed.sendInboxMessage(reviewer, `thread-${index}`, {
      to: ['personal:alice'], subject: `Follow-up ${index}`, body: 'One thread update.',
      replyTo: sent.message.id,
    })
  }
  await assert.rejects(() => resumed.sendInboxMessage(reviewer, 'thread-overflow', {
    to: ['personal:alice'], subject: 'One more', body: 'Too many.', replyTo: sent.message.id,
  }), /12-message limit/)
  assert.equal(ledger.listInboxMessages().filter(item => item.rootId === sent.message.id).length, 12)
})

test('Inbox wake origin preserves topic limits even when replies omit reply_to', async t => {
  const root = await makeTempDir('bizagent-inbox-topic-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  const ledger = new MemoryLedger()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/reviewer`, address: 'role:reviewer' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, ledger, config)
  await service.initialize()
  const alice = agent('alice-topic', root)
  const reviewer = agent('reviewer-topic', `${root}/reviewer`)
  const first = await service.sendInboxMessage(alice, 'topic-start', {
    to: ['role:reviewer'], subject: 'Review the source', body: 'Inspect the source.',
  })
  assert.equal(first.message.topicId, first.message.id)
  assert.equal(first.message.hop, 0)
  await ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.topicId, hop: first.message.hop,
    wakePlanId: 'wake-review', createdAt: '2026-09-25T00:00:00Z' })
  const reopened = new BizAgentService(store, ledger, config)
  await reopened.initialize()
  for (let index = 0; index < 11; index++) {
    const sent = await reopened.sendInboxMessage(reviewer, `topic-${index}`, {
      to: ['personal:alice'], subject: `Reply ${index}`, body: 'Checked.',
    })
    assert.equal(sent.message.rootId, sent.message.id)
    assert.equal(sent.message.chain, 0)
    assert.equal(sent.message.topicId, first.message.id)
    assert.equal(sent.message.hop, 1)
  }
  await assert.rejects(() => reopened.sendInboxMessage(reviewer, 'topic-overflow', {
    to: ['personal:alice'], subject: 'One more', body: 'Should stop.',
  }), /topic exceeds the 12-message limit/)
  assert.equal(ledger.listInboxMessages().length, 12)
  const otherTopic = await reopened.sendInboxMessage(alice, 'other-topic-start', {
    to: ['role:reviewer'], subject: 'Separate request', body: 'Different topic.',
  })
  const crossTopic = await reopened.sendInboxMessage(reviewer, 'cross-topic-reply', {
    to: ['personal:alice'], subject: 'Other thread', body: 'Follow the parent topic.',
    replyTo: otherTopic.message.id,
  })
  assert.equal(crossTopic.message.topicId, otherTopic.message.id)
  assert.equal(crossTopic.message.hop, 1)
  const deep = agent('reviewer-deep', `${root}/reviewer`)
  await ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: deep.id,
    homeAddress: 'role:reviewer', topicId: 'other-topic', hop: 6,
    wakePlanId: 'wake-deep', createdAt: '2026-09-25T00:00:01Z' })
  await assert.rejects(() => reopened.sendInboxMessage(deep, 'deep-overflow', {
    to: ['personal:alice'], subject: 'Too deep', body: 'Should stop.',
  }), /6-hop machine relay limit/)
})

test('Inbox wake origin is durable and a Session cannot change its trusted topic', async () => {
  const runtime = await createDemoRuntime()
  const origin = { schemaVersion: 1, sessionId: 'wake-session', homeAddress: 'role:reviewer',
    topicId: 'topic-a', hop: 2, wakePlanId: 'plan-a', createdAt: '2026-09-25T00:00:00Z' }
  await runtime.ledger.putInboxWakeOrigin(origin)
  const reopened = await runtime.reopenLedger()
  assert.deepEqual(reopened.getInboxWakeOrigin(origin.sessionId), origin)
  assert.deepEqual(await reopened.putInboxWakeOrigin(origin), origin)
  await assert.rejects(() => reopened.putInboxWakeOrigin({ ...origin, topicId: 'topic-b' }),
    /another origin/)
})

test('episodes expose bounded raw Session evidence only within the current Home', async (t) => {
  const root = await makeTempDir('bizagent-episodes-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  const ledger = new MemoryLedger()
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/reviewer`, address: 'role:reviewer' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const sessions = new Map([
    ['first', { session: { id: 'first', cwd: root }, events: Array.from({ length: 5 }, (_, seq) => ({
      seq, time: seq, type: 'user/message', data: { content: [{ type: 'text', text: `event ${seq}` }] },
    })) }],
    ['other', { session: { id: 'other', cwd: `${root}/reviewer` }, events: [] }],
  ])
  const service = new BizAgentService(store, ledger, config, {
    async readSession(id) { return sessions.get(String(id)) },
  })
  await service.initialize()
  await ledger.putBinding({ sessionId: 'first', homeAddress: 'personal:alice', boundAt: '2026-01-01T00:00:00Z' })
  await ledger.putBinding({ sessionId: 'other', homeAddress: 'role:reviewer', boundAt: '2026-01-01T00:00:01Z' })
  const alice = agent('current', root)
  const reviewer = agent('reviewer-session', `${root}/reviewer`)
  const firstPage = await service.listEpisodes(alice, { limit: 1 })
  assert.equal(firstPage.episodes.length, 1)
  assert.equal(firstPage.episodes[0].sessionId, 'current')
  assert.equal(firstPage.nextBeforeSessionId, 'current')
  const secondPage = await service.listEpisodes(alice, { limit: 1, beforeSessionId: 'current' })
  assert.equal(secondPage.episodes[0].sessionId, 'first')
  assert.equal(secondPage.nextBeforeSessionId, undefined)
  await assert.rejects(() => service.listEpisodes(alice, { beforeSessionId: 'other' }), /cursor not found/)

  const events = await service.readEpisode(alice, { sessionId: 'first', limit: 2 })
  assert.deepEqual(events.events.map(event => event.text), ['event 0', 'event 1'])
  assert.equal(events.nextAfterSeq, 1)
  const next = await service.readEpisode(alice, { sessionId: 'first', afterSeq: events.nextAfterSeq, limit: 2 })
  assert.deepEqual(next.events.map(event => event.seq), [2, 3])
  await assert.rejects(() => service.readEpisode(alice, { sessionId: 'other' }), /not bound to current Home/)
  await assert.rejects(() => service.readEpisode(reviewer, { sessionId: 'first' }), /not bound to current Home/)
  await assert.rejects(() => service.readEpisode(alice, { sessionId: 'first', limit: 25 }), /limit must/)
  await assert.rejects(() => service.readEpisode(alice, { sessionId: 'missing' }), /not bound to current Home/)
})

test('learning material progress is explicit, Home-bound, and pinned to the observed Session content', async (t) => {
  const root = await makeTempDir('bizagent-learning-materials-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  const ledger = new MemoryLedger()
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/reviewer`, address: 'role:reviewer' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const sessions = new Map([['ordinary', {
    session: { id: 'ordinary', cwd: root },
    events: [{ seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'The analysis is complete.' }] } }],
  }]])
  const query = { async readSession(id) {
    const snapshot = sessions.get(String(id))
    if (!snapshot) throw new Error(`missing Session ${id}`)
    return structuredClone(snapshot)
  } }
  const service = new BizAgentService(store, ledger, config, query)
  await service.initialize()
  await ledger.putBinding({ sessionId: 'ordinary', homeAddress: 'personal:alice', boundAt: '2026-01-01T00:00:00Z' })
  await ledger.putBinding({ sessionId: 'missing', homeAddress: 'personal:alice', boundAt: '2026-01-02T00:00:00Z' })
  await ledger.putBinding({ sessionId: 'other', homeAddress: 'role:reviewer', boundAt: '2026-01-03T00:00:00Z' })
  const alice = agent('learning-session', root)
  const reviewer = agent('role-session', `${root}/reviewer`)

  const first = await service.scanLearningMaterials(alice)
  assert.deepEqual(first.materials.map(item => item.sessionId), ['ordinary'])
  assert.deepEqual(first.unavailable.map(item => item.sessionId), ['missing'])
  assert.equal(first.alreadyReviewed, 0)
  const oldMaterial = first.materials[0]
  assert.equal((await service.scanLearningMaterials(alice)).materials[0].id, oldMaterial.id)
  await assert.rejects(() => service.reviewLearningMaterial(reviewer, {
    materialId: oldMaterial.id, summary: 'Reviewed.',
  }), /not owned by current Home/)
  await assert.rejects(() => service.reviewLearningMaterial(alice, {
    materialId: oldMaterial.id, summary: '  ',
  }), /summary must contain/)

  sessions.get('ordinary').events.push({
    seq: 1, time: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'A new outcome arrived.' }] },
  })
  const reviewed = await service.reviewLearningMaterial(alice, {
    materialId: oldMaterial.id, summary: 'The original analysis needs no durable rule.',
  })
  assert.equal(reviewed.review.materialId, oldMaterial.id)
  assert.equal((await service.reviewLearningMaterial(alice, {
    materialId: oldMaterial.id, summary: 'Duplicate call.',
  })).idempotentReplay, true)

  const second = await service.scanLearningMaterials(alice)
  assert.equal(second.materials.length, 1)
  assert.notEqual(second.materials[0].id, oldMaterial.id)
  assert.notEqual(second.materials[0].fingerprint, oldMaterial.fingerprint)
  await service.reviewLearningMaterial(alice, {
    materialId: second.materials[0].id, summary: 'The appended outcome changes the conclusion.',
  })
  const resumed = new BizAgentService(store, ledger, config, query)
  await resumed.initialize()
  assert.equal((await resumed.scanLearningMaterials(alice)).materials.length, 0)
  assert.equal((await resumed.scanLearningMaterials(alice)).alreadyReviewed, 1)
  await assert.rejects(() => resumed.reviewLearningMaterial(alice, {
    materialId: 'made-up', summary: 'No source.',
  }), /not owned by current Home/)
})

test('read-only Agent Frames combine shared Homes without changing the Session owner or exposing drafts', async (t) => {
  const root = await makeTempDir('bizagent-frames-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  for (const address of ['personal:alice', 'personal:bob', 'business:shop', 'role:analyst', 'capability:research']) {
    await store.createHome({ address })
  }
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const sourceRefs = [{ type: 'document', uri: 'demo://source', digest: 'sha256:demo' }]
  const active = await store.createAsset({
    id: 'shared-active', ownerAddress: 'role:analyst', kind: 'method',
    description: 'Compare cohorts with matching windows', body: 'Use matching windows and report the sample sizes.',
    sourceRefs, status: 'active',
  })
  await store.createAsset({
    id: 'shared-draft', ownerAddress: 'role:analyst', kind: 'insight',
    description: 'Unverified campaign explanation', body: 'This needs more evidence.',
    sourceRefs, status: 'candidate',
  })
  const ledger = new MemoryLedger()
  const service = new BizAgentService(store, ledger, config)
  await service.initialize()
  const alice = agent('frame-session', root)

  await assert.rejects(() => service.searchFrame(alice, {}), /not open/)
  await assert.rejects(() => service.openFrame(alice, { address: 'personal:bob' }), /not found or inaccessible/)
  await assert.rejects(() => service.openFrame(alice, { address: 'personal:alice' }), /primary Home is already present/)
  const role = await service.openFrame(alice, { address: 'role:analyst', mode: 'lead' })
  assert.equal(role.state.primaryHome, 'personal:alice')
  assert.equal(role.state.frames[0].mode, 'lead')
  assert.match(role.context, /BizAgent Read-only Agent Frame/)
  assert.match(role.context, /mode: lead/)
  assert.match(role.context, /lead the domain reasoning/)
  assert.match(role.context, /cannot override the user request or platform policy/)
  assert.match(role.context, /Compare cohorts with matching windows/)
  assert.doesNotMatch(role.context, /Unverified campaign explanation/)
  assert.doesNotMatch(role.context, /Write reusable learning to this Home only/)
  assert.equal(role.status, 'opened')
  assert.equal(role.state.contextEpoch, 1)
  const unchanged = await service.openFrame(alice, { address: 'role:analyst', mode: 'lead' })
  assert.equal(unchanged.status, 'unchanged')
  assert.doesNotMatch(unchanged.context, /Compare cohorts with matching windows/)
  const contributor = await service.openFrame(alice, { address: 'role:analyst', mode: 'contribute' })
  assert.equal(contributor.status, 'unchanged')
  assert.equal(contributor.state.frames[0].mode, 'contribute')
  assert.match(contributor.context, /mode: contribute/)
  assert.match(contributor.context, /participating specialist/)
  assert.doesNotMatch(contributor.context, /Compare cohorts with matching windows/)
  const reference = await service.openFrame(alice, { address: 'role:analyst', mode: 'reference' })
  assert.equal(reference.status, 'unchanged')
  assert.match(reference.context, /mode: reference/)
  assert.match(reference.context, /does not mean that this Agent participated/)
  const leadAgain = await service.openFrame(alice, { address: 'role:analyst', mode: 'lead' })
  assert.equal(leadAgain.status, 'unchanged')
  const hits = await service.searchFrame(alice, { query: 'cohorts' })
  assert.deepEqual(hits.assets.map(item => item.id), [active.id])
  await assert.rejects(() => service.readFrame(alice, 'read-draft', { assetId: 'shared-draft' }), /not active/)
  const read = await service.readFrame(alice, 'read-shared', { assetId: active.id })
  assert.match(read.asset.body, /sample sizes/)
  assert.equal(ledger.listReceipts(active.id)[0].ownerAddress, 'role:analyst')
  await store.updateAsset('role:analyst', active.id, {
    expectedRevision: active.revision, description: 'Compare cohorts with matching windows and sample sizes',
  })
  const refreshed = await service.openFrame(alice, { address: 'role:analyst', mode: 'lead' })
  assert.equal(refreshed.status, 'delta')
  assert.notEqual(refreshed.state.frames[0].digest, role.state.frames[0].digest)
  assert.match(refreshed.context, /matching windows and sample sizes/)
  const forced = await service.openFrame(alice, { address: 'role:analyst', mode: 'lead', refresh: true })
  assert.equal(forced.status, 'delta')
  assert.equal(forced.state.contextEpoch, 2)
  assert.match(forced.context, /matching windows and sample sizes/)

  const capability = await service.openFrame(alice, { address: 'capability:research', mode: 'contribute' })
  assert.equal(capability.state.focusAddress, 'capability:research')
  assert.equal(capability.state.frames.length, 2)
  assert.equal(capability.state.frames.find(item => item.address === 'role:analyst').mode, 'lead')
  const newEpoch = await service.openFrame(alice, { address: 'role:analyst', mode: 'lead', refresh: true })
  assert.equal(newEpoch.state.contextEpoch, 3)
  const staleCapability = await service.openFrame(alice, { address: 'capability:research', mode: 'contribute' })
  assert.equal(staleCapability.status, 'delta')
  assert.equal(staleCapability.state.frames.find(item => item.address === 'capability:research').contextEpoch, 3)
  const business = await service.openFrame(alice, { address: 'business:shop', mode: 'lead' })
  assert.equal(business.state.frames.find(item => item.address === 'role:analyst').mode, 'reference')
  assert.equal(business.state.frames.find(item => item.address === 'business:shop').mode, 'lead')
  assert.equal((await service.frameStatus(alice)).state.frames.length, 3)

  const own = await service.remember(alice, 'after-frame', {
    description: 'Personal observation after using a shared method', body: 'I needed to verify sample sizes.',
  })
  assert.equal(own.asset.sourceRefs[0].sessionId, alice.id)
  assert.equal(store.listAssets('personal:alice').length, 1)
  assert.equal(store.listAssets('role:analyst').length, 2)

  const resumed = new BizAgentService(store, ledger, config)
  await resumed.initialize()
  assert.equal((await resumed.frameStatus(alice)).state.focusAddress, 'business:shop')
  assert.equal((await resumed.frameStatus(alice)).state.contextEpoch, 3)
  const closed = await resumed.closeFrame(alice)
  assert.equal(closed.state.focusAddress, 'capability:research')
  await resumed.closeFrame(alice, 'role:analyst')
  await assert.rejects(() => resumed.searchFrame(alice, { address: 'role:analyst' }), /not open/)
  await resumed.closeFrame(alice, 'capability:research')
  assert.equal((await resumed.frameStatus(alice)).state.focusAddress, undefined)
  assert.equal((await resumed.frameStatus(alice)).state.primaryHome, 'personal:alice')
})

test('a successful DSH compaction automatically refreshes open Frame context', async (t) => {
  const root = await makeTempDir('bizagent-frame-compaction-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:analyst' })
  const ledger = new MemoryLedger()
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, ledger, config)
  await service.initialize()
  const alice = agent('frame-compaction-session', root)
  const initial = await service.openFrame(alice, { address: 'role:analyst' })
  assert.equal(initial.state.contextEpoch, 1)
  assert.equal((await service.frameStatus(alice)).refreshRequired, false)

  alice.session.events.push({ seq: 3, type: 'compaction/end', data: { error: 'provider failed' } })
  assert.equal((await service.frameStatus(alice)).refreshRequired, false)
  alice.session.events.push({ seq: 4, type: 'compaction/end', data: {} })
  assert.deepEqual((await service.frameStatus(alice)).staleFrames, ['role:analyst'])
  const refreshed = await service.openFrame(alice, { address: 'role:analyst' })
  assert.equal(refreshed.status, 'delta')
  assert.equal(refreshed.state.contextEpoch, 2)
  assert.equal(refreshed.state.lastCompactionSeq, 4)
  assert.match(refreshed.context, /BizAgent Read-only Agent Frame/)
  assert.equal((await service.frameStatus(alice)).refreshRequired, false)
  assert.equal((await service.openFrame(alice, { address: 'role:analyst' })).status, 'unchanged')

  alice.session.events.push({ seq: 5, type: 'compaction/end', data: {} })
  const resumed = new BizAgentService(store, ledger, config)
  await resumed.initialize()
  assert.equal((await resumed.frameStatus(alice)).refreshRequired, true)
  const afterResume = await resumed.openFrame(alice, { address: 'role:analyst' })
  assert.equal(afterResume.state.contextEpoch, 3)
  assert.equal(afterResume.state.lastCompactionSeq, 5)
})

test('Home directory limits visibility and Frame display names resolve only when unique', async (t) => {
  const root = await makeTempDir('bizagent-directory-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  for (const [address, displayName] of [
    ['personal:alice', 'Alice'], ['personal:bob', 'Bob'],
    ['role:analyst', 'Analyst'], ['role:reporter', 'Analyst'],
    ['capability:research', 'Research'],
  ]) await store.createHome({ address, displayName })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, new MemoryLedger(), config)
  await service.initialize()
  const alice = agent('directory-session', root)

  const all = await service.searchHomes(alice)
  assert.deepEqual(all.homes.map(home => home.address), [
    'capability:research', 'personal:alice', 'role:analyst', 'role:reporter',
  ])
  assert.deepEqual(Object.keys(all.homes[0]), ['address', 'type', 'displayName'])
  assert.deepEqual((await service.searchHomes(alice, { query: 'ANALYST', limit: 1 })).homes
    .map(home => home.address), ['role:analyst'])
  await assert.rejects(() => service.searchHomes(alice, { limit: 51 }), /limit/)
  await assert.rejects(() => service.openFrame(alice, { address: 'Bob' }), /not found or inaccessible/)
  await assert.rejects(() => service.openFrame(alice, { address: 'personal:bob' }), /not found or inaccessible/)
  await assert.rejects(() => service.openFrame(alice, { address: 'Analyst' }),
    /ambiguous Home name.*role:analyst, role:reporter/)
  const frame = await service.openFrame(alice, { address: ' research ' })
  assert.equal(frame.state.focusAddress, 'capability:research')
  assert.equal(frame.state.frames[0].mode, 'lead')
  const ledger = service.ledger
  const legacy = ledger.getFrameState(String(alice.id))
  delete legacy.contextEpoch
  delete legacy.frames[0].contextEpoch
  ledger.frameStates.set(String(alice.id), legacy)
  const upgraded = await service.openFrame(alice, { address: 'Research' })
  assert.equal(upgraded.status, 'delta')
  assert.equal(upgraded.state.contextEpoch, 1)
  assert.match(upgraded.context, /BizAgent Read-only Agent Frame/)
  assert.equal((await service.openFrame(alice, { address: 'role:analyst' })).state.focusAddress, 'role:analyst')
})

test('candidate learning is reviewed and published without activating drafts or retired assets on edit', async (t) => {
  const root = await makeTempDir('bizagent-candidate-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  const ledger = new MemoryLedger()
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/reviewer`, address: 'role:reviewer' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, ledger, config)
  await service.initialize()
  const alice = agent('candidate-session', root)
  const initialHome = store.getHome('personal:alice')
  for (const kind of ['memory', 'insight', 'knowledge', 'method']) {
    const result = await service.remember(alice, `draft-${kind}`, {
      kind, status: 'candidate', description: `Review ${kind} backup learning`,
      body: 'Validate a recoverable backup before editing configuration.',
    })
    assert.equal(result.asset.kind, kind)
    assert.equal(result.asset.status, 'candidate')
    assert.equal(result.asset.sourceRefs[0].sessionId, alice.id)
  }
  assert.equal((await service.homeStatus(alice)).candidateAssets, 4)
  assert.equal((await service.searchMemory(alice, {})).count, 0)
  assert.deepEqual(store.getHome('personal:alice'), initialHome)
  assert.doesNotMatch(service.contextForSession(alice.id, root), /Review method backup learning/)

  const drafts = await service.searchMemory(alice, { kind: 'method', status: 'candidate' })
  const assetId = drafts.assets[0].id
  const revised = await service.updateMemory(alice, {
    assetId, action: 'revise', expectedRevision: 1, body: 'Run an isolated restore and verify the result.',
  })
  assert.equal(revised.asset.status, 'candidate')
  assert.equal(revised.asset.revision, 2)
  await assert.rejects(() => service.updateMemory(alice, { assetId, action: 'publish' }), /expectedRevision/)
  await assert.rejects(() => service.updateMemory(alice, {
    assetId, action: 'publish', expectedRevision: 1,
  }), /revision conflict/)
  await assert.rejects(() => service.updateMemory(agent('outsider', `${root}/reviewer`), {
    assetId, action: 'publish', expectedRevision: 2,
  }), /asset not found/)

  const reloaded = new HomeStore(root)
  await reloaded.initialize()
  const resumed = new BizAgentService(reloaded, ledger, config)
  await resumed.initialize()
  const read = await resumed.readMemory(alice, 'read-reviewed', assetId)
  const published = await resumed.updateMemory(alice, {
    assetId, action: 'publish', expectedRevision: read.asset.revision,
  })
  assert.equal(published.asset.status, 'active')
  assert.equal(published.home.revision, initialHome.revision + 1)
  const context = resumed.contextForSession('future-session', root)
  assert.match(context, /Review method backup learning/)
  assert.doesNotMatch(context, /Run an isolated restore/)
  assert.equal((await resumed.searchMemory(alice, {})).count, 1)
  await assert.rejects(() => resumed.updateMemory(alice, {
    assetId, action: 'publish', expectedRevision: published.asset.revision,
  }), /only a candidate/)

  await resumed.updateMemory(alice, { assetId, action: 'retire' })
  const retiredEdit = await resumed.updateMemory(alice, { assetId, action: 'revise', body: 'Keep for historical review.' })
  assert.equal(retiredEdit.asset.status, 'retired')
  assert.equal((await resumed.searchMemory(alice, {})).count, 0)
  assert.doesNotMatch(resumed.contextForSession('future-session', root), /Review method backup learning/)
  assert.deepEqual((await reloaded.doctor()).issues, [])
})

test('single-agent learning and governed cross-Home learning form one closed loop', async (t) => {
  const root = await makeTempDir('bizagent-service-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const personalCwd = `${root}/work/personal`
  const roleCwd = `${root}/work/role`
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', identity: 'Learn Alice preferences.' })
  await store.createHome({ address: 'role:growth-strategy', identity: 'Own reusable growth strategy methods.' })
  const ledger = new MemoryLedger()
  const service = new BizAgentService(store, ledger, {
    homeRoot: root,
    defaultHome: 'personal:alice',
    autoCreateDefaultHome: false,
    workspaceHomes: [{ root: roleCwd, address: 'role:growth-strategy' }],
    budget: { identityMaxBytes: 2048, indexMaxBytes: 4096 },
  })
  await service.initialize()

  const alice = agent('session-alice', personalCwd)
  const remembered = await service.remember(alice, 'call-remember', {
    description: 'Exclude D0 when reporting next-day retention.',
    body: 'Next-day retention is D1 active users divided by D0 new users; registration-day activity is not retained usage.',
    tags: ['retention'],
  })
  assert.equal(remembered.homeAddress, 'personal:alice')
  const personalContext = service.contextForSession(alice.id, personalCwd)
  assert.match(personalContext, /Exclude D0/)
  assert.doesNotMatch(personalContext, /registration-day activity/)

  const proposed = await service.proposeMemory(alice, 'call-propose', {
    toAddress: 'role:growth-strategy',
    proposedKind: 'method',
    description: 'Standardize retention comparisons by acquisition cohort.',
    body: 'Always compare like-for-like acquisition cohorts before attributing a retention change to product behavior.',
    tags: ['retention', 'analysis'],
  })
  assert.equal(proposed.proposal.status, 'pending')

  await assert.rejects(
    () => service.acceptProposal(alice, { proposalId: proposed.proposal.id }),
    /host-authenticated human review/,
  )

  const role = agent('session-role', roleCwd)
  await assert.rejects(() => service.acceptProposal(role, { proposalId: proposed.proposal.id }),
    /host-authenticated human review/)
  const accepted = await service.decideProposalAsHuman({
    ownerAddress: 'role:growth-strategy', proposalId: proposed.proposal.id, action: 'accept',
    reviewerId: 'reviewer-1', authorityRef: 'role-owner:reviewer-1',
    decision: 'Evidence is specific and reusable.',
  })
  assert.equal(accepted.proposal.status, 'accepted')
  assert.equal(accepted.asset.kind, 'method')
  const roleContext = service.contextForSession(role.id, roleCwd)
  assert.match(roleContext, /Standardize retention comparisons/)
  assert.doesNotMatch(roleContext, /Always compare like-for-like/)

  const replay = await service.decideProposalAsHuman({
    ownerAddress: 'role:growth-strategy', proposalId: proposed.proposal.id, action: 'accept',
    reviewerId: 'reviewer-1', authorityRef: 'role-owner:reviewer-1',
    decision: 'Evidence is specific and reusable.',
  })
  assert.equal(replay.idempotentReplay, true)
  assert.equal(store.listAssets('role:growth-strategy').length, 1)

  const feedback = await service.feedback(role, 'call-feedback', {
    assetId: accepted.asset.id,
    signal: 'confirmed',
    outcome: 'Prevented a false week-over-week conclusion.',
  })
  assert.equal(feedback.receipt.signal, 'confirmed')
  assert.equal(feedback.asset.fitness, 0.2)
  const feedbackReplay = await service.feedback(role, 'call-feedback', {
    assetId: accepted.asset.id, signal: 'confirmed',
    outcome: 'Prevented a false week-over-week conclusion.',
  })
  assert.equal(feedbackReplay.idempotentReplay, true)
  assert.equal(feedbackReplay.asset.fitness, 0.2)

  const applied = await service.feedback(role, 'call-applied', {
    assetId: accepted.asset.id,
    signal: 'applied',
  })
  assert.equal(applied.asset.fitness, 0.2)

  const contradicted = await service.feedback(role, 'call-contradicted', {
    assetId: accepted.asset.id,
    signal: 'contradicted',
    outcome: 'The method did not hold for a mixed acquisition cohort.',
  })
  assert.equal(contradicted.reviewRequired, false)
  const failed = await service.feedback(role, 'call-failed', {
    assetId: accepted.asset.id,
    signal: 'failed',
    outcome: 'A second application produced a misleading comparison.',
  })
  assert.equal(failed.reviewRequired, true)
})

test('cross-Home replacement proposal freezes a baseline, rejects drift, and recovers an applied revision', async t => {
  const root = await makeTempDir('bizagent-proposal-replace-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:analyst' })
  const ledger = new MemoryLedger()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/analyst`, address: 'role:analyst' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, ledger, config)
  await service.initialize()
  const alice = agent('proposal-alice', root)
  const analyst = agent('proposal-analyst', `${root}/analyst`)
  const target = await store.createAsset({ id: 'method-cohort', ownerAddress: 'role:analyst',
    kind: 'method', description: 'Compare acquisition cohorts.', body: 'Compare weekly cohorts.',
    sourceRefs: [{ type: 'artifact', uri: 'test:baseline', digest: 'baseline' }] })
  const proposalInput = { toAddress: 'role:analyst', targetAssetId: target.id,
    description: 'Compare matched acquisition cohorts.', body: 'Match cohorts by acquisition week.' }
  await assert.rejects(() => service.proposeMemory(alice, 'proposal-no-frame', proposalInput), /Frame is not open/)
  await service.openFrame(alice, { address: 'role:analyst' })
  const stale = await service.proposeMemory(alice, 'proposal-stale', proposalInput)
  assert.equal(stale.proposal.baseAsset.revision, 1)
  assert.equal(stale.proposal.proposedKind, 'method')
  await store.updateAsset('role:analyst', target.id, { expectedRevision: 1, body: 'Use a revised baseline.' })
  await assert.rejects(() => service.decideProposalAsHuman({
    ownerAddress: 'role:analyst', proposalId: stale.proposal.id, action: 'accept',
    reviewerId: 'reviewer-1', authorityRef: 'role-owner:reviewer-1', decision: 'Approve',
  }), /changed since proposal/)
  assert.equal(ledger.getProposal(stale.proposal.id).status, 'pending')
  assert.equal(store.readAsset('role:analyst', target.id).body, 'Use a revised baseline.')

  const current = await service.proposeMemory(alice, 'proposal-current', proposalInput)
  const accepted = await service.decideProposalAsHuman({ ownerAddress: 'role:analyst',
    proposalId: current.proposal.id, action: 'accept', reviewerId: 'reviewer-1',
    authorityRef: 'role-owner:reviewer-1', decision: 'Reviewed the current baseline.' })
  assert.equal(accepted.asset.id, target.id)
  assert.equal(accepted.asset.revision, 3)
  assert.equal(accepted.asset.body, proposalInput.body)
  assert.equal(accepted.proposal.appliedAssetRevision, 3)
  assert.equal(accepted.proposal.appliedBodySha256,
    createHash('sha256').update(proposalInput.body).digest('hex'))
  assert.equal(store.listAssets('role:analyst').length, 1)

  const interrupted = await service.proposeMemory(alice, 'proposal-interrupted', {
    ...proposalInput, body: 'Match cohorts and document exceptions.' })
  const originalPut = ledger.putProposal.bind(ledger)
  let failSettlement = true
  ledger.putProposal = async proposal => {
    if (proposal.id === interrupted.proposal.id && proposal.status === 'accepted' && failSettlement) {
      failSettlement = false
      throw new Error('simulated proposal settlement interruption')
    }
    return originalPut(proposal)
  }
  await assert.rejects(() => service.decideProposalAsHuman({ ownerAddress: 'role:analyst',
    proposalId: interrupted.proposal.id, action: 'accept', reviewerId: 'reviewer-2',
    authorityRef: 'role-owner:reviewer-2', decision: 'Reviewed the replacement.'
  }), /settlement interruption/)
  assert.equal(ledger.getProposal(interrupted.proposal.id).status, 'pending')
  assert.equal(ledger.getProposal(interrupted.proposal.id).humanReview.reviewerId, 'reviewer-2')
  assert.equal(store.readAsset('role:analyst', target.id).revision, 4)
  const reopenedStore = new HomeStore(root)
  await reopenedStore.initialize()
  const resumed = new BizAgentService(reopenedStore, ledger, config)
  await resumed.initialize()
  assert.equal(ledger.getProposal(interrupted.proposal.id).status, 'accepted')
  assert.equal(ledger.getProposal(interrupted.proposal.id).appliedAssetRevision, 4)
  assert.equal(ledger.getProposal(interrupted.proposal.id).decision, 'Reviewed the replacement.')
  assert.equal((await resumed.decideProposalAsHuman({ ownerAddress: 'role:analyst',
    proposalId: interrupted.proposal.id, action: 'accept', reviewerId: 'reviewer-2',
    authorityRef: 'role-owner:reviewer-2', decision: 'Reviewed the replacement.' })).idempotentReplay, true)
  assert.equal(reopenedStore.readAsset('role:analyst', target.id).revision, 4)
  await reopenedStore.updateAsset('role:analyst', target.id, { expectedRevision: 4,
    body: 'A later reviewed edit.' })
  const secondRestart = new BizAgentService(reopenedStore, ledger, config)
  await secondRestart.initialize()
  assert.deepEqual((await secondRestart.homeStatus(analyst)).persistenceErrors, [])
})

test('memory use outcomes verify a versioned receipt before a durable Work result', async (t) => {
  const root = await makeTempDir('bizagent-use-outcomes-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const ledger = new MemoryLedger()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'tool/call', data: { turn: 1, callId: 'read-1',
      name: 'bizagent_memory_read', arguments: '{}' } },
    { seq: 2, type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'read-1' }] } } },
    { seq: 3, type: 'tool/call', data: { turn: 1, callId: 'complete-1',
      name: 'bizagent_work_complete', arguments: '{"work_id":"work-1"}' } },
    { seq: 4, type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'complete-1' }] } } },
    { seq: 5, type: 'turn/end', data: { turn: 1 } },
  ]
  const query = { async readSession() { return { session: { id: 'worker-1', cwd: root }, events: structuredClone(events) } } }
  const work = { id: 'work-1', assignee: 'personal:alice', status: 'completed',
    workerSessionId: 'worker-1', resultSessionId: 'worker-1',
    resultSubject: 'Report delivered', resultBody: 'Used the cohort method.', completedAt: '2026-01-01T00:00:00Z' }
  const works = [work]
  const service = new BizAgentService(store, ledger, config, query, undefined, undefined,
    { list: () => works })
  await service.initialize()
  const worker = { id: 'worker-1', session: { header: { id: 'worker-1', cwd: root }, events: events.slice(0, 2) } }
  const saved = await service.remember(agent('author', root), 'remember-1', {
    description: 'Compare cohorts', body: 'Compare matching cohorts.' })
  events[1].data.arguments = JSON.stringify({ asset_id: saved.asset.id })
  const read = await service.readMemory(worker, 'read-1', saved.asset.id)
  const first = ledger.listReceipts(saved.asset.id)[0]
  assert.equal(first.assetRevision, read.asset.revision)
  assert.match(first.assetBodySha256, /^[a-f0-9]{64}$/)
  const retried = await service.readMemory(worker, 'read-1', saved.asset.id)
  assert.equal(retried.asset.id, saved.asset.id)
  assert.equal(ledger.listReceipts(saved.asset.id).length, 1)
  const found = await service.memoryUseOutcomes(agent('inspector', root), { assetId: saved.asset.id })
  assert.equal(found.outcomes.length, 1)
  assert.equal(found.outcomes[0].workSourceStatus, 'verified')
  assert.equal(found.outcomes[0].uses[0].sourceStatus, 'verified')
  assert.equal(found.outcomes[0].resultSubject, 'Report delivered')
  works.push({ ...work, id: 'work-2', resultSubject: 'Second report' })
  const firstPage = await service.memoryUseOutcomes(agent('inspector', root), {
    assetId: saved.asset.id, limit: 1,
  })
  assert.equal(firstPage.nextBeforeWorkId, 'work-1')
  const secondPage = await service.memoryUseOutcomes(agent('inspector', root), {
    assetId: saved.asset.id, limit: 1, beforeWorkId: firstPage.nextBeforeWorkId,
  })
  assert.deepEqual(secondPage.outcomes.map(item => item.workId), ['work-2'])
  const legacy = { ...first, id: 'legacy-receipt' }
  delete legacy.assetRevision
  delete legacy.assetBodySha256
  ledger.receipts.set(legacy.id, legacy)
  const withLegacy = await service.memoryUseOutcomes(agent('inspector', root), { assetId: saved.asset.id })
  assert.equal(withLegacy.outcomes[0].uses.find(item => item.receiptId === legacy.id).sourceStatus, 'changed')
  await assert.rejects(() => service.memoryUseOutcomes(agent('inspector', root), {
    assetId: saved.asset.id, beforeWorkId: 'missing',
  }), /cursor not found/)
  events[2].data.message.content[0].isError = true
  const failedRead = await service.memoryUseOutcomes(agent('inspector', root), { assetId: saved.asset.id })
  assert.equal(failedRead.outcomes[0].uses[0].sourceStatus, 'changed')
  delete events[2].data.message.content[0].isError
  events[1].data.arguments = '{"asset_id":"different"}'
  const changed = await service.memoryUseOutcomes(agent('inspector', root), { assetId: saved.asset.id })
  assert.equal(changed.outcomes[0].uses[0].sourceStatus, 'changed')
  assert.equal(changed.outcomes[0].workSourceStatus, 'verified')
})

test('a Session binding cannot drift after it is established', async (t) => {
  const root = await makeTempDir('bizagent-binding-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:growth-strategy' })
  const ledger = new MemoryLedger()
  const service = new BizAgentService(store, ledger, {
    homeRoot: root,
    defaultHome: 'personal:alice',
    autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/role`, address: 'role:growth-strategy' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  })
  await service.initialize()
  assert.equal(service.bindSession('same-session', `${root}/personal`).homeAddress, 'personal:alice')
  assert.equal(service.bindSession('same-session', `${root}/role`).homeAddress, 'personal:alice')
})

test('creating an organization places every Home under the DSH Workspace and persists its active location', async (t) => {
  const root = await makeTempDir('bizagent-organization-location-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'business:legacy' })
  const service = new BizAgentService(store, new MemoryLedger(), {
    homeRoot: root,
    defaultHome: undefined,
    autoCreateDefaultHome: false,
    workspaceHomes: [],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  })
  await service.initialize()

  await service.createOrganizationInWorkspace({
    workspacePath: workspace,
    id: 'acme',
    name: 'Acme Agents',
    mission: 'Ship useful software with evidence.',
    members: [{
      id: 'builder',
      displayName: 'Builder',
      roleId: 'engineering',
      roleName: 'Engineering',
      responsibility: 'Implement, test, and maintain the product.',
    }],
    capabilities: [{
      id: 'delivery',
      displayName: 'Product Delivery',
      responsibility: 'Retain repeatable delivery methods.',
    }],
  })

  const expectedRoot = `${workspace}/bizagent/acme`
  assert.equal(service.store.root, expectedRoot)
  assert.equal(service.store.listHomes().length, 5)
  assert.equal(store.hasHome('business:acme'), false)
  assert.equal(service.bindSession('organization-session', `${workspace}/src`).homeAddress, 'business:acme')
  assert.deepEqual(await loadActiveOrganizationLocation(root), service.getActiveOrganizationLocation())

  const reloaded = new HomeStore(expectedRoot)
  await reloaded.initialize()
  assert.equal(reloaded.getOrganization().id, 'acme')
  assert.equal(reloaded.getHome('role:engineering').displayName, 'Engineering')
})

test('Session evidence stays readable only from the Home its Session is bound to', async t => {
  const root = await makeTempDir('bizagent-evidence-home-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:growth-strategy' })
  const roleCwd = `${root}/role`
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: roleCwd, address: 'role:growth-strategy' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery)
  await service.initialize()
  t.after(() => service.close())
  const alice = runtime.agent('alice-evidence', root, 'Private detail: the customer list is in secret.csv.')
  const remembered = await service.remember(alice, 'remember-call', {
    description: 'Check cohorts weekly', body: 'Compare weekly cohorts before acting.' })
  const own = await service.readEvidence(alice, { assetId: remembered.asset.id })
  assert.match(JSON.stringify(own.events), /secret\.csv/)

  const proposed = await service.proposeMemory(alice, 'propose-call', {
    toAddress: 'role:growth-strategy', proposedKind: 'method',
    description: 'Review cohorts weekly', body: 'Run a weekly cohort review before changing strategy.' })
  await service.decideProposalAsHuman({ ownerAddress: 'role:growth-strategy', proposalId: proposed.proposal.id,
    action: 'accept', reviewerId: 'human-owner', authorityRef: 'role-owner:human-owner',
    decision: 'Accepted after review.' })
  const accepted = store.listAssets('role:growth-strategy')[0]
  assert.equal(accepted.sourceRefs[0].type, 'session-events')
  assert.equal(accepted.sourceRefs[0].sessionId, 'alice-evidence')
  const role = runtime.agent('role-evidence', roleCwd, 'Check the evidence for this method.')
  await assert.rejects(() => service.readEvidence(role, { assetId: accepted.id }),
    /not visible to the current Home/)
})
