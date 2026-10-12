import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { inboxWakeSchedule } from '../lib/inbox-wake-policy.js'
import { nextCronAt } from '../lib/cron.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('recipient Inbox policies freeze immediate, batch, scheduled, and carried wake decisions', async t => {
  const root = await makeTempDir('bizagent-inbox-policy-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  const policies = new Map([
    ['role:instant', { policy: 'immediate' }],
    ['role:batch', { policy: 'batch', batchMinutes: 7 }],
    ['role:scheduled', { policy: 'scheduled', cron: '0 0 1 1 *' }],
    ['role:carried', { policy: 'carried' }],
  ])
  const mappings = []
  for (const [address, policy] of policies) {
    const home = await store.createHome({ address, owner: 'alice' })
    await writeFile(join(store.homesRoot, home.id, 'inbox.json'), JSON.stringify(policy))
    const cwd = join(root, address.replace(':', '-'))
    await mkdir(cwd)
    mappings.push({ root: cwd, address })
  }
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: mappings,
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const alice = runtime.agent('policy-sender', root, 'Send scheduled mail.')
  const sent = new Map()
  for (const address of policies.keys()) {
    const result = await service.sendInboxMessage(alice, address, {
      to: [address], subject: `Policy ${address}`, body: 'Read later.',
    })
    sent.set(address, result.message)
  }
  const instant = runtime.ledger.getInboxDelivery(sent.get('role:instant').id, 'role:instant')
  const batch = runtime.ledger.getInboxDelivery(sent.get('role:batch').id, 'role:batch')
  const scheduled = runtime.ledger.getInboxDelivery(sent.get('role:scheduled').id, 'role:scheduled')
  const carried = runtime.ledger.getInboxDelivery(sent.get('role:carried').id, 'role:carried')
  assert.equal(instant.wakePolicy, 'immediate')
  assert.equal(instant.wakeAt, sent.get('role:instant').sentAt)
  assert.equal(batch.wakePolicy, 'batch')
  assert.equal(Date.parse(batch.wakeAt) - Date.parse(sent.get('role:batch').sentAt), 7 * 60_000)
  assert.equal(scheduled.wakePolicy, 'scheduled')
  assert.equal(Date.parse(scheduled.wakeAt), nextCronAt('0 0 1 1 *',
    Date.parse(sent.get('role:scheduled').sentAt)))
  assert.equal(carried.wakePolicy, 'carried')
  assert.equal(carried.wakeAt, undefined)
  assert.equal(inboxWakeSchedule({ policy: 'scheduled', cron: 'invalid', batchMinutes: 3 },
    'normal', '2026-09-25T00:00:00.000Z').wakeAt, '2026-09-25T00:03:00.000Z')

  const batchHome = store.getHome('role:batch')
  await writeFile(join(store.homesRoot, batchHome.id, 'inbox.json'),
    JSON.stringify({ policy: 'batch', batchMinutes: 30 }))
  const laterBatchMessage = await service.sendInboxMessage(alice, 'later-batch-topic', {
    to: ['role:batch'], subject: 'Another topic', body: 'Share one batch with the earlier letter.',
  })
  const laterBatchDelivery = runtime.ledger.getInboxDelivery(laterBatchMessage.message.id, 'role:batch')
  assert.ok(Date.parse(laterBatchDelivery.wakeAt) > Date.parse(batch.wakeAt))
  await writeFile(join(store.homesRoot, batchHome.id, 'inbox.json'), JSON.stringify({ policy: 'immediate' }))
  const live = new Map()
  const agents = {
    get(id) { return live.get(String(id)) },
    async create({ sessionId, meta }) {
      const agent = runtime.agent(String(sessionId), meta.cwd, 'Inbox wake.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => { agent.inbox.nextTurn.push(message) }
      agent.whenIdle = () => new Promise(() => {})
      live.set(String(sessionId), agent)
      return { agent, async dispose() { live.delete(String(sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, service, config)
  const early = await runner.recoverBatch(4, Date.parse(sent.get('role:instant').sentAt) + 5 * 60_000)
  assert.deepEqual(early.started.map(id => runtime.ledger.getInboxWakePlan(id).recipient), ['role:instant'])
  const later = await runner.recoverBatch(4, Date.parse(batch.wakeAt) + 1)
  assert.deepEqual(later.started.map(id => runtime.ledger.getInboxWakePlan(id).recipient), ['role:batch'])
  const batchPlan = runtime.ledger.getInboxWakePlan(later.started[0])
  assert.equal(batchPlan.scope, 'owner')
  assert.deepEqual(new Set(batchPlan.messageIds), new Set([sent.get('role:batch').id, laterBatchMessage.message.id]))
  const annual = await runner.recoverBatch(4, Date.parse(scheduled.wakeAt) + 1)
  assert.deepEqual(annual.started.map(id => runtime.ledger.getInboxWakePlan(id).recipient), ['role:scheduled'])
  assert.equal(runtime.ledger.listInboxWakePlans().some(plan => plan.recipient === 'role:carried'), false)
  const urgent = await service.sendInboxMessage(alice, 'urgent-carried', {
    to: ['role:carried'], subject: 'Urgent', body: 'Read now.', priority: 'urgent',
  })
  const urgentDelivery = runtime.ledger.getInboxDelivery(urgent.message.id, 'role:carried')
  assert.equal(urgentDelivery.wakePolicy, 'immediate')
  assert.equal(urgentDelivery.wakeAt, urgent.message.sentAt)
  const urgentPass = await runner.recoverBatch()
  assert.deepEqual(urgentPass.started.map(id => runtime.ledger.getInboxWakePlan(id).recipient), ['role:carried'])
  const copy = await service.sendInboxMessage(alice, 'policy-copy', {
    to: ['role:instant'], cc: ['role:carried'], subject: 'Copy', body: 'For information only.',
  })
  assert.equal(runtime.ledger.getInboxDelivery(copy.message.id, 'role:carried').wakePolicy, undefined)
  await runner.close()
})

test('missing, malformed, and linked Home policy files use the default batch', async t => {
  const root = await makeTempDir('bizagent-inbox-policy-file-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  const home = await store.createHome({ address: 'role:reader', owner: 'alice' })
  const file = join(store.homesRoot, home.id, 'inbox.json')
  assert.deepEqual(await store.readInboxWakePolicy(home.address), { policy: 'batch', batchMinutes: 15 })
  await writeFile(file, '{broken')
  assert.deepEqual(await store.readInboxWakePolicy(home.address), { policy: 'batch', batchMinutes: 15 })
  await rm(file)
  await symlink(join(root, 'missing.json'), file)
  assert.deepEqual(await store.readInboxWakePolicy(home.address), { policy: 'batch', batchMinutes: 15 })
})
