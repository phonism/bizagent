import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

async function setup(t) {
  const root = await makeTempDir('bizagent-inbox-nudge-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const recipientCwd = join(root, 'recipient')
  await mkdir(recipientCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  const aliceHome = await store.createHome({ address: 'personal:alice', owner: 'alice' })
  const recipientHome = await store.createHome({ address: 'role:recipient', owner: 'alice' })
  await store.createHome({ address: 'role:other', owner: 'alice' })
  for (const home of [aliceHome, recipientHome]) {
    await writeFile(join(store.homesRoot, home.id, 'inbox.json'), JSON.stringify({ policy: 'carried' }))
  }
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: recipientCwd, address: 'role:recipient' },
      { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  return { root, recipientCwd, runtime, store, config, service,
    alice: runtime.agent('nudge-alice', root, 'Send mail.'),
    recipient: runtime.agent('nudge-recipient', recipientCwd, 'Receive mail.') }
}

test('due and 24-hour stale nudges create one durable plan per unhandled primary delivery', async t => {
  const { runtime, service, alice, recipient } = await setup(t)
  const now = Date.now()
  const dueAt = new Date(now + 60_000).toISOString()
  const due = await service.sendInboxMessage(alice, 'due-letter', {
    to: ['role:recipient'], subject: 'Due soon', body: 'Please inspect.', due: dueAt,
  })
  assert.equal((await service.sendInboxMessage(alice, 'due-letter', {
    to: ['role:recipient'], subject: 'Due soon', body: 'Please inspect.', due: dueAt,
  })).idempotentReplay, true)
  await assert.rejects(() => service.sendInboxMessage(alice, 'due-letter', {
    to: ['role:recipient'], subject: 'Due soon', body: 'Please inspect.',
    due: new Date(now + 120_000).toISOString(),
  }), /idempotency key conflicts/)
  await assert.rejects(() => service.sendInboxMessage(alice, 'invalid-due', {
    to: ['role:recipient'], subject: 'Invalid due', body: 'Reject this.', due: 'tomorrow',
  }), /ISO date-time/)
  const stale = await service.sendInboxMessage(alice, 'stale-letter', {
    to: ['role:recipient'], subject: 'No deadline', body: 'Please inspect.',
  })
  const handled = await service.sendInboxMessage(alice, 'handled-letter', {
    to: ['role:recipient'], subject: 'Already handled', body: 'Done.', due: dueAt,
  })
  await service.handleInboxMessage(recipient, handled.message.id)
  const copied = await service.sendInboxMessage(alice, 'copied-letter', {
    to: ['role:other'], cc: ['role:recipient'], subject: 'Copy only', body: 'No wake.', due: dueAt,
  })
  const workNotice = await service.sendInboxMessage(alice, 'work-notice', {
    to: ['role:recipient'], subject: 'Work request', body: 'Handled by Work.',
    due: dueAt, kind: 'work-request',
  })
  const runner = new InboxWakeRunner({
    get() { return undefined }, async create() { throw new Error('start later') },
    async resume() { throw new Error('start later') },
  }, runtime.sessionQuery, service, service.config)
  assert.deepEqual(await runner.scanNudges(20, now + 59_000), [])
  const originalPut = runtime.ledger.putInboxDelivery.bind(runtime.ledger)
  let failNudgeReceipt = true
  runtime.ledger.putInboxDelivery = async delivery => {
    if (failNudgeReceipt && delivery.messageId === due.message.id && delivery.nudgedAt !== undefined) {
      failNudgeReceipt = false
      throw new Error('nudge receipt write failed')
    }
    return originalPut(delivery)
  }
  await assert.rejects(() => runner.scanNudges(20, now + 60_001), /nudge receipt write failed/)
  assert.equal(runtime.ledger.listInboxWakePlans().length, 1)
  const duePlans = await runner.scanNudges(20, now + 60_001)
  assert.equal(duePlans.length, 1)
  const duePlan = runtime.ledger.getInboxWakePlan(duePlans[0])
  assert.equal(duePlan.reason, 'nudge-due')
  assert.deepEqual(duePlan.messageIds, [due.message.id])
  assert.equal(runtime.ledger.getInboxDelivery(due.message.id, 'role:recipient').nudgeReason, 'due')
  assert.deepEqual(await runner.scanNudges(20, now + 60_002), [])
  await service.handleInboxMessage(recipient, due.message.id)
  const settled = await runner.recoverBatch(4, now + 60_002)
  assert.deepEqual(settled.started, [])
  assert.deepEqual(settled.skipped, [duePlan.id])
  assert.deepEqual(settled.failed, [])
  assert.ok(runtime.ledger.getInboxWakePlan(duePlan.id).dispatchedAt)
  const stalePlans = await runner.scanNudges(20, Date.parse(stale.message.sentAt) + 24 * 3600_000 + 1)
  assert.equal(stalePlans.length, 1)
  assert.equal(runtime.ledger.getInboxWakePlan(stalePlans[0]).reason, 'nudge-stale')
  assert.equal(runtime.ledger.getInboxDelivery(stale.message.id, 'role:recipient').nudgeReason, 'stale')
  assert.equal(runtime.ledger.getInboxDelivery(handled.message.id, 'role:recipient').nudgedAt, undefined)
  assert.equal(runtime.ledger.getInboxDelivery(copied.message.id, 'role:recipient').nudgedAt, undefined)
  assert.equal(runtime.ledger.getInboxDelivery(workNotice.message.id, 'role:recipient').nudgedAt, undefined)
  const reopened = await runtime.reopenLedger()
  assert.equal(reopened.getInboxWakePlan(duePlans[0]).reason, 'nudge-due')
  assert.equal(reopened.getInboxDelivery(stale.message.id, 'role:recipient').nudgeReason, 'stale')
  await runner.close()
})

test('a reply queued to its original Session gets one topic reminder after two hours', async t => {
  const { runtime, config, service, alice, recipient } = await setup(t)
  const original = await service.sendInboxMessage(alice, 'original', {
    to: ['role:recipient'], subject: 'Question', body: 'Please answer.',
  })
  const reply = await service.sendInboxMessage(recipient, 'reply', {
    to: ['personal:alice'], subject: 'Answer', body: 'Here it is.', replyTo: original.message.id,
  })
  const deliveredAt = Date.parse(reply.message.sentAt)
  const queuedAt = new Date(deliveredAt + 1000).toISOString()
  await runtime.ledger.putInboxReturnRoute({
    schemaVersion: 1, messageId: reply.message.id, recipient: 'personal:alice',
    sessionId: alice.id, status: 'queued', updatedAt: queuedAt,
  })
  const live = new Map()
  const prompts = []
  const agents = {
    get(id) { return live.get(String(id)) },
    async create({ sessionId, meta }) {
      const id = String(sessionId)
      const agent = runtime.agent(id, meta.cwd, 'Nudge Session.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => { prompts.push(message); agent.inbox.nextTurn.push(message) }
      agent.whenIdle = () => new Promise(() => {})
      live.set(id, agent)
      return { agent, async dispose() { live.delete(id) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  assert.deepEqual(await runner.scanNudges(20, Date.parse(queuedAt) + 2 * 3600_000 - 1), [])
  const planned = await runner.scanNudges(20, Date.parse(queuedAt) + 2 * 3600_000 + 1)
  assert.equal(planned.length, 1)
  const plan = runtime.ledger.getInboxWakePlan(planned[0])
  assert.equal(plan.recipient, 'personal:alice')
  assert.equal(plan.reason, 'nudge-stale')
  assert.equal(plan.scope, 'topic')
  assert.deepEqual(plan.messageIds, [reply.message.id])
  const started = await runner.recoverBatch(4, Date.parse(queuedAt) + 2 * 3600_000 + 1)
  assert.deepEqual(started.started, [plan.id])
  assert.match(prompts[0].content[0].text, /still unhandled/)
  assert.match(prompts[0].content[0].text, new RegExp(reply.message.id))
  assert.equal(runtime.ledger.getInboxDelivery(reply.message.id, 'personal:alice').handledAt, undefined)
  await runner.close()
})
