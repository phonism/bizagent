import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('ordinary Inbox wakes only owned primary recipients, batches a topic, and survives factory failure', async (t) => {
  const root = await makeTempDir('bizagent-inbox-wake-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewerCwd = `${root}/reviewer`
  const observerCwd = `${root}/observer`
  const otherCwd = `${root}/other`
  await Promise.all([mkdir(reviewerCwd), mkdir(observerCwd), mkdir(otherCwd)])
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:reviewer', owner: 'alice' })
  await store.createHome({ address: 'role:observer', owner: 'alice' })
  await store.createHome({ address: 'role:other', owner: 'bob' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [
      { root: reviewerCwd, address: 'role:reviewer' },
      { root: observerCwd, address: 'role:observer' },
      { root: otherCwd, address: 'role:other' },
    ],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const sender = runtime.agent('inbox-sender', root, 'Send messages.')
  const first = await service.sendInboxMessage(sender, 'batch-1', {
    to: ['role:reviewer'], cc: ['role:observer'],
    subject: 'Review one', body: 'First letter.',
  })
  const second = await service.sendInboxMessage(sender, 'batch-2', {
    to: ['role:reviewer'], subject: 'Review two', body: 'Second letter.',
    replyTo: first.message.id,
  })
  const urgent = await service.sendInboxMessage(sender, 'urgent-other', {
    to: ['role:other'], subject: 'Cross owner', body: 'Do not auto wake.', priority: 'urgent',
  })
  const urgentReview = await service.sendInboxMessage(sender, 'urgent-review', {
    to: ['role:reviewer'], subject: 'Urgent review', body: 'Please read.', priority: 'urgent',
  })
  const live = new Map()
  const idleResolvers = new Map()
  const prompts = []
  let failCreateOnce = true
  let creations = 0
  const agents = {
    get(id) { return live.get(String(id)) },
    async create(options) {
      creations += 1
      if (failCreateOnce) {
        failCreateOnce = false
        throw new Error('factory failed before Session creation')
      }
      const id = String(options.sessionId)
      const agent = runtime.agent(id, options.meta.cwd, 'Wake Session created.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => {
        prompts.push(message)
        agent.inbox.nextTurn.push(message)
        agent.session.events.push({
          seq: agent.session.events.length, time: Date.now(), type: 'agent/inbox/spliced',
          data: { target: 'next-turn', start: 0, inserted: [message] },
        })
      }
      agent.whenIdle = () => new Promise(resolve => idleResolvers.set(id, resolve))
      live.set(id, agent)
      return { agent, async dispose() { live.delete(id) } }
    },
    async resume() { throw new Error('resume not expected in this test') },
  }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const beforeNormalDue = Date.parse(first.message.sentAt) + 14 * 60_000
  const firstPass = await runner.recoverBatch(4, beforeNormalDue)
  assert.deepEqual(firstPass.started, [])
  assert.equal(firstPass.failed.length, 1)
  assert.match(String(firstPass.failed[0].error), /factory failed/)
  const reserved = runtime.ledger.getInboxWakePlan(firstPass.failed[0].planId)
  assert.deepEqual(reserved.messageIds, [urgentReview.message.id])
  assert.equal(runtime.ledger.getBinding(reserved.sessionId).homeAddress, 'role:reviewer')
  assert.equal(runtime.ledger.getInboxWakeOrigin(reserved.sessionId).topicId, urgentReview.message.id)
  assert.deepEqual(service.pendingInboxDigestForSession(reserved.sessionId, reviewerCwd)?.messages.map(item => item.id),
    [urgentReview.message.id])
  assert.equal(runtime.ledger.getInboxWakePlan(reserved.id).dispatchedAt, undefined)
  const reopened = await runtime.reopenLedger()
  const resumedService = new BizAgentService(store, reopened, config, runtime.sessionQuery)
  await resumedService.initialize()
  await runner.close()
  const resumedRunner = new InboxWakeRunner(agents, runtime.sessionQuery, resumedService, config)
  const secondPass = await resumedRunner.recoverBatch(4, beforeNormalDue)
  assert.deepEqual(secondPass.started, [reserved.id])
  assert.deepEqual(secondPass.failed, [])
  assert.equal(creations, 2)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, new RegExp(urgentReview.message.id))
  assert.equal(prompts[0].content[0].text.includes('Please read.'), false)
  assert.ok(reopened.getInboxWakePlan(reserved.id).dispatchedAt)
  idleResolvers.get(reserved.sessionId)()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumedRunner.handles.size, 0)
  const afterNormalDue = Date.parse(first.message.sentAt) + 16 * 60_000
  const normalPass = await resumedRunner.recoverBatch(4, afterNormalDue)
  assert.deepEqual(normalPass.failed, [])
  assert.equal(normalPass.started.length, 1)
  const normalPlan = reopened.getInboxWakePlan(normalPass.started[0])
  assert.deepEqual(normalPlan.messageIds, [first.message.id, second.message.id])
  assert.equal(reopened.getInboxWakeOrigin(normalPlan.sessionId).topicId, first.message.id)
  assert.equal(reopened.getInboxWakeOrigin(normalPlan.sessionId).hop, 1)
  assert.equal(prompts.length, 2)
  assert.deepEqual((await resumedRunner.recoverBatch(4, afterNormalDue)).started, [])
  assert.equal(reopened.listInboxWakePlans().length, 2)
  assert.equal(reopened.getInboxDelivery(first.message.id, 'role:observer').status, 'delivered')
  assert.equal(reopened.getInboxWakePlan(urgent.message.id), undefined)
  assert.equal(reopened.listInboxWakePlans().some(plan => plan.recipient === 'role:observer'), false)
  assert.equal(reopened.listInboxWakePlans().some(plan => plan.recipient === 'role:other'), false)
  idleResolvers.get(normalPlan.sessionId)()
  await new Promise(resolve => setImmediate(resolve))
  const dual = await resumedService.sendInboxMessage(sender, 'dual-recipient', {
    to: ['role:reviewer', 'role:observer'], subject: 'Both roles', body: 'Read separately.', priority: 'urgent',
  })
  const dualPass = await resumedRunner.recoverBatch(4, Date.now())
  assert.deepEqual(dualPass.failed, [])
  assert.equal(dualPass.started.length, 2)
  const dualPlans = dualPass.started.map(id => reopened.getInboxWakePlan(id))
  assert.deepEqual(new Set(dualPlans.map(plan => plan.recipient)), new Set(['role:reviewer', 'role:observer']))
  assert.ok(dualPlans.every(plan => plan.messageIds.length === 1 && plan.messageIds[0] === dual.message.id))
  await resumedRunner.close()
})

test('wake retry does not send a duplicate prompt after a dispatched receipt write fails', async (t) => {
  const root = await makeTempDir('bizagent-inbox-retry-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const recipientCwd = `${root}/recipient`
  await mkdir(recipientCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:recipient', owner: 'alice' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: recipientCwd, address: 'role:recipient' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  await service.sendInboxMessage(runtime.agent('retry-sender', root, 'Send.'), 'retry-message', {
    to: ['role:recipient'], subject: 'Urgent', body: 'Inspect this.', priority: 'urgent',
  })
  const live = new Map()
  let prompts = 0
  const agents = {
    get(id) { return live.get(String(id)) },
    async create(options) {
      const agent = runtime.agent(String(options.sessionId), options.meta.cwd, 'Created.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => {
        prompts += 1
        agent.inbox.nextTurn.push(message)
      }
      agent.whenIdle = () => new Promise(() => {})
      live.set(String(options.sessionId), agent)
      return { agent, async dispose() { live.delete(String(options.sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }
  const originalMark = runtime.ledger.markInboxWakeDispatched.bind(runtime.ledger)
  let failOnce = true
  runtime.ledger.markInboxWakeDispatched = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error('receipt write failed') }
    return originalMark(...args)
  }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const failed = await runner.recoverBatch()
  assert.equal(failed.failed.length, 1)
  assert.equal(prompts, 1)
  const recovered = await runner.recoverBatch(4, Date.now() + 6 * 60_000)
  assert.deepEqual(recovered.started, [failed.failed[0].planId])
  assert.equal(prompts, 1)
  await runner.close()
})

test('one recipient drains a 21-message owner batch after its first Session becomes idle', async t => {
  const root = await makeTempDir('bizagent-inbox-drain-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const recipientCwd = `${root}/recipient`
  await mkdir(recipientCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:recipient', owner: 'alice' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: recipientCwd, address: 'role:recipient' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const sender = runtime.agent('batch-sender', root, 'Send many topics.')
  const ids = []
  for (let i = 0; i < 21; i++) {
    const sent = await service.sendInboxMessage(sender, `batch-${i}`, {
      to: ['role:recipient'], subject: `Topic ${i}`, body: 'Review later.',
    })
    ids.push(sent.message.id)
  }
  const live = new Map()
  const idleResolvers = new Map()
  const agents = {
    get(id) { return live.get(String(id)) },
    async create({ sessionId, meta }) {
      const id = String(sessionId)
      const agent = runtime.agent(id, meta.cwd, 'Batch started.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => { agent.inbox.nextTurn.push(message) }
      agent.whenIdle = () => new Promise(resolve => idleResolvers.set(id, resolve))
      live.set(id, agent)
      return { agent, async dispose() { live.delete(id) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const due = Date.parse(runtime.ledger.getInboxMessage(ids[0]).sentAt) + 16 * 60_000
  const first = await runner.recoverBatch(4, due)
  assert.equal(first.started.length, 1)
  const firstPlan = runtime.ledger.getInboxWakePlan(first.started[0])
  assert.equal(firstPlan.scope, 'owner')
  assert.equal(firstPlan.messageIds.length, 20)
  assert.deepEqual((await runner.recoverBatch(4, due)).started, [])
  idleResolvers.get(firstPlan.sessionId)()
  await new Promise(resolve => setImmediate(resolve))
  const second = await runner.recoverBatch(4, due)
  assert.equal(second.started.length, 1)
  const secondPlan = runtime.ledger.getInboxWakePlan(second.started[0])
  assert.equal(secondPlan.messageIds.length, 1)
  assert.deepEqual(new Set([...firstPlan.messageIds, ...secondPlan.messageIds]), new Set(ids))
  await runner.close()
})

async function wakeSetup(t, label) {
  const root = await makeTempDir(`bizagent-inbox-wake-${label}-`)
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewerCwd = `${root}/reviewer`
  const movedCwd = `${root}/moved`
  await Promise.all([mkdir(reviewerCwd), mkdir(movedCwd)])
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:reviewer', owner: 'alice' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: reviewerCwd, address: 'role:reviewer' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const sender = runtime.agent('inbox-sender', root, 'Send.')
  const letter = await service.sendInboxMessage(sender, 'urgent-letter', {
    to: ['role:reviewer'], subject: 'Please review', body: 'Review this.', priority: 'urgent' })
  return { root, runtime, service, config, movedCwd, letter }
}

test('a wake plan that can never start as planned is retired instead of retried forever', async t => {
  const { runtime, service, config, movedCwd } = await wakeSetup(t, 'retire')
  const agents = { get() { return undefined }, async create() { throw new Error('should not create') },
    async resume() { throw new Error('should not resume') } }
  const planner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const now = Date.now() + 60 * 60_000
  // The first pass plans the wake and starts it; make creation fail transiently so the plan stays.
  const transientAgents = { ...agents, async create() { throw new Error('provider timeout') } }
  const transient = new InboxWakeRunner(transientAgents, runtime.sessionQuery, service, config)
  const first = await transient.recoverBatch(1, now)
  assert.equal(first.failed.length, 1)
  const planId = first.failed[0].planId
  await transient.close()
  await planner.close()
  // The Home's Workspace mapping then moves: that plan can never start in its recorded Workspace.
  const movedConfig = { ...config, workspaceHomes: [{ root: movedCwd, address: 'role:reviewer' }] }
  const movedService = new BizAgentService(service.store, runtime.ledger, movedConfig, runtime.sessionQuery)
  const moved = new InboxWakeRunner(agents, runtime.sessionQuery, movedService, movedConfig)
  const pass = await moved.recoverBatch(1, now)
  assert.deepEqual(pass.failed, [])
  assert.deepEqual(pass.skipped, [planId])
  const plan = service.ledger.getInboxWakePlan(planId)
  assert.ok(plan.dispatchedAt)
  assert.match(plan.retiredReason, /Workspace mapping changed/)
  assert.ok(movedService.listRuntimeIssues().some(issue => issue.message.startsWith(`Inbox wake ${planId} retired`)))
  await moved.close()
})

test('an unclassified wake failure is retired after repeated attempts', async t => {
  const { runtime, service, config } = await wakeSetup(t, 'attempts')
  const agents = { get() { return undefined }, async create() { throw new Error('provider timeout') },
    async resume() { throw new Error('should not resume') } }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  let now = Date.now() + 60 * 60_000
  let planId
  for (let attempt = 1; attempt <= 5; attempt++) {
    const pass = await runner.recoverBatch(1, now)
    assert.equal(pass.failed.length, 1, `attempt ${attempt}`)
    planId = pass.failed[0].planId
    now += 6 * 60_000
  }
  const last = await runner.recoverBatch(1, now)
  assert.deepEqual(last.failed, [])
  assert.deepEqual(last.skipped, [planId])
  assert.match(service.ledger.getInboxWakePlan(planId).retiredReason, /provider timeout/)
  await runner.close()
})
