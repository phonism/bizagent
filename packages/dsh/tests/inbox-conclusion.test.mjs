import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

async function setup(t) {
  const root = await makeTempDir('bizagent-inbox-conclusion-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewerCwd = join(root, 'reviewer')
  await mkdir(reviewerCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:reviewer', owner: 'alice' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: reviewerCwd, address: 'role:reviewer' },
      { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  return { root, reviewerCwd, runtime, store, service, config,
    alice: runtime.agent('conclusion-alice', root, 'Send mail.'),
    reviewer: runtime.agent('conclusion-reviewer', reviewerCwd, 'Review mail.') }
}

test('conclusion uses an existing Workspace file and closes a topic after its message cap', async t => {
  const { root, reviewerCwd, runtime, store, service, config, alice, reviewer } = await setup(t)
  const first = await service.sendInboxMessage(alice, 'topic-start', {
    to: ['role:reviewer'], subject: 'Review', body: 'Inspect the source.',
  })
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.topicId, hop: 0,
    wakePlanId: 'topic-wake', createdAt: first.message.sentAt })
  for (let index = 0; index < 11; index++) {
    await service.sendInboxMessage(reviewer, `topic-${index}`, {
      to: ['personal:alice'], subject: `Finding ${index}`, body: 'Reviewed.',
    })
  }
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'overflow', {
    to: ['personal:alice'], subject: 'More', body: 'Overflow.',
  }), /12-message limit/)

  const outside = await makeTempDir('bizagent-conclusion-outside-')
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'external.md'), 'External evidence')
  await symlink(join(outside, 'external.md'), join(reviewerCwd, 'linked.md'))
  const linkedCwd = join(root, 'linked-cwd')
  await symlink(outside, linkedCwd)
  const linkedService = new BizAgentService(store, runtime.ledger, {
    ...config, workspaceHomes: [{ root: linkedCwd, address: 'role:reviewer' }, ...config.workspaceHomes],
  }, runtime.sessionQuery)
  await linkedService.initialize()
  await assert.rejects(() => linkedService.sendInboxMessage(
    runtime.agent('linked-reviewer', linkedCwd, 'Review mail.'), 'linked-root', {
      to: ['personal:alice'], subject: 'Invalid root', body: 'Outside Workspace.',
      kind: 'conclusion', contextRefs: ['external.md'],
    }), /Workspace must be a real directory path/)
  for (const ref of ['missing.md', '../external.md', join(outside, 'external.md'), 'linked.md']) {
    await assert.rejects(() => service.sendInboxMessage(reviewer, `bad-${ref}`, {
      to: ['personal:alice'], subject: 'Invalid conclusion', body: 'No local file.',
      kind: 'conclusion', contextRefs: [ref],
    }), /context_refs file inside the bound Workspace/)
  }

  await writeFile(join(reviewerCwd, 'finding.md'), '# Conclusion\nReviewed.')
  const input = {
    to: ['personal:alice'], subject: 'Final finding', body: 'See finding.md.',
    kind: 'conclusion', contextRefs: ['missing.md', 'finding.md'],
  }
  const final = await service.sendInboxMessage(reviewer, 'final', input)
  assert.equal(final.message.topicId, first.message.id)
  assert.equal(final.message.conclusionArtifact, 'finding.md')
  assert.equal(final.message.hop, 1)
  assert.equal(runtime.ledger.getInboxDelivery(final.message.id, 'personal:alice').wakeAt, undefined)
  await rm(join(reviewerCwd, 'finding.md'))
  assert.equal((await service.sendInboxMessage(reviewer, 'final', input)).idempotentReplay, true)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'after-close', {
    to: ['personal:alice'], subject: 'More', body: 'Should stop.',
  }), /already closed/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'second-final', input), /already closed/)
  const separate = await service.sendInboxMessage(alice, 'separate-topic', {
    to: ['role:reviewer'], subject: 'New topic', body: 'Independent.',
  })
  assert.notEqual(separate.message.topicId, first.message.topicId)
  assert.equal(runtime.ledger.listInboxMessages().length, 14)
})

test('conclusion can end a six-reply thread at chain seven', async t => {
  const { reviewerCwd, service, alice, reviewer } = await setup(t)
  let parent = (await service.sendInboxMessage(alice, 'chain-start', {
    to: ['role:reviewer'], subject: 'Start', body: 'Review.',
  })).message
  for (let chain = 1; chain <= 6; chain++) {
    const sender = chain % 2 === 1 ? reviewer : alice
    parent = (await service.sendInboxMessage(sender, `chain-${chain}`, {
      to: [chain % 2 === 1 ? 'personal:alice' : 'role:reviewer'],
      subject: `Reply ${chain}`, body: 'Continuing.', replyTo: parent.id,
    })).message
  }
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'chain-overflow', {
    to: ['personal:alice'], subject: 'Further reply', body: 'Too deep.', replyTo: parent.id,
  }), /6-hop relay limit/)
  await writeFile(join(reviewerCwd, 'thread-final.md'), 'Concluded.')
  const final = await service.sendInboxMessage(reviewer, 'chain-final', {
    to: ['personal:alice'], subject: 'Final', body: 'See attached file.',
    replyTo: parent.id, kind: 'conclusion', contextRefs: ['thread-final.md'],
  })
  assert.equal(final.message.chain, 7)
  assert.equal(final.message.hop, 7)
  assert.equal(final.message.rootId, parent.rootId)
})

test('conclusion is allowed at hop seven and suppresses pending wake and nudge', async t => {
  const { reviewerCwd, runtime, service, config, alice, reviewer } = await setup(t)
  const due = new Date(Date.now() + 60_000).toISOString()
  const first = await service.sendInboxMessage(alice, 'urgent-start', {
    to: ['role:reviewer'], subject: 'Please review', body: 'Review.', priority: 'urgent', due,
  })
  let creations = 0
  const runner = new InboxWakeRunner({
    get() { return undefined },
    async create() { creations += 1; throw new Error('factory unavailable') },
    async resume() { throw new Error('unexpected resume') },
  }, runtime.sessionQuery, service, config)
  const now = Date.now() + 1_000
  const failed = await runner.recoverBatch(4, now)
  assert.equal(failed.failed.length, 1)
  const planId = failed.failed[0].planId

  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.topicId, hop: 6,
    wakePlanId: 'deep-wake', createdAt: first.message.sentAt })
  await writeFile(join(reviewerCwd, 'final.md'), 'Concluded.')
  const final = await service.sendInboxMessage(reviewer, 'deep-final', {
    to: ['personal:alice'], subject: 'Conclusion', body: 'See final.md.',
    kind: 'conclusion', contextRefs: ['final.md'],
  })
  assert.equal(final.message.hop, 7)
  assert.equal(final.message.topicId, first.message.id)
  assert.equal(runtime.ledger.getInboxDelivery(final.message.id, 'personal:alice').wakeAt, undefined)
  const pass = await runner.recoverBatch(4, now + 5 * 60_000 + 1)
  assert.deepEqual(pass.started, [])
  assert.deepEqual(pass.skipped, [planId])
  assert.equal(creations, 1)
  assert.ok(runtime.ledger.getInboxWakePlan(planId).dispatchedAt)
  assert.deepEqual(await runner.scanNudges(20, Date.parse(due) + 1), [])
  assert.equal(runtime.ledger.getInboxDelivery(first.message.id, 'role:reviewer').nudgedAt, undefined)
  await runner.close()
})

test('ordinary wake and new-session digest warn before a topic reaches either limit', async t => {
  const { root, reviewerCwd, runtime, service, config, alice, reviewer } = await setup(t)
  const first = await service.sendInboxMessage(alice, 'converge-start', {
    to: ['role:reviewer'], subject: 'Review', body: 'Review together.',
  })
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.id, hop: 0,
    wakePlanId: 'converge-wake', createdAt: first.message.sentAt })
  for (let index = 0; index < 7; index++) {
    await service.sendInboxMessage(reviewer, `converge-${index}`, {
      to: ['personal:alice'], subject: `Check ${index}`, body: 'A finding.',
    })
  }
  assert.equal(service.pendingInboxDigestForSession('reader-alice', root).messages[0].convergence, undefined)
  await service.sendInboxMessage(reviewer, 'converge-eighth', {
    to: ['personal:alice'], subject: 'Check 8', body: 'Another finding.',
  })
  const digest = service.pendingInboxDigestForSession('reader-alice', root)
  assert.deepEqual(digest.messages[0].convergence,
    { topicId: first.message.id, hop: 1, topicCount: 9 })

  const another = await service.sendInboxMessage(alice, 'hop-start', {
    to: ['role:reviewer'], subject: 'Second topic', body: 'Review separately.',
  })
  const deep = runtime.agent('converge-deep', reviewerCwd, 'Review.')
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: deep.id,
    homeAddress: 'role:reviewer', topicId: another.message.id, hop: 3,
    wakePlanId: 'deep-converge-wake', createdAt: another.message.sentAt })
  const deepReply = await service.sendInboxMessage(deep, 'hop-four', {
    to: ['personal:alice'], subject: 'Fourth hop', body: 'One reply.',
  })
  assert.deepEqual(service.pendingInboxDigestForSession('reader-alice', root).messages[0].convergence,
    { topicId: another.message.id, hop: 4, topicCount: 2 })

  const live = new Map()
  const prompts = []
  const runner = new InboxWakeRunner({
    get(id) { return live.get(String(id)) },
    async create({ sessionId, meta }) {
      const agent = runtime.agent(String(sessionId), meta.cwd, 'Wake.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => { prompts.push(message.content[0].text); agent.inbox.nextTurn.push(message) }
      agent.whenIdle = () => new Promise(() => {})
      live.set(String(sessionId), agent)
      return { agent, async dispose() { live.delete(String(sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }, runtime.sessionQuery, service, config)
  const pass = await runner.recoverBatch(4, Date.now() + 16 * 60_000)
  assert.deepEqual(pass.failed, [])
  assert.ok(prompts.some(prompt => prompt.includes(`Topic ${first.message.id} is at 9/12`)))
  assert.ok(prompts.some(prompt => prompt.includes(`Topic ${another.message.id} is at 2/12 ordinary messages and hop 4/6`)))
  assert.equal(deepReply.message.hop, 4)
  await runner.close()
})
