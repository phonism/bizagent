import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { InboxReturnNotifier } from '../lib/inbox-return-notifier.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { InboxStalledEscalationRunner } from '../lib/inbox-stalled-escalation-runner.js'
import { HumanNotificationRunner } from '../lib/human-notification-runner.js'
import { createHumanInboxHttpHandler } from '../lib/human-inbox-transport.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

async function setup(t) {
  const root = await makeTempDir('bizagent-human-inbox-')
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
  return { root, reviewerCwd, runtime, store, config, service,
    alice: runtime.agent('human-alice-agent', root, 'Send mail.'),
    reviewer: runtime.agent('human-reviewer-agent', reviewerCwd, 'Review mail.') }
}

async function escalation(service, runtime, alice, reviewer) {
  const first = await service.sendInboxMessage(alice, 'human-topic', {
    to: ['role:reviewer'], subject: 'Decide', body: 'Review the question.',
  })
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.id, hop: 6,
    wakePlanId: 'human-topic-wake', createdAt: first.message.sentAt })
  const input = {
    to: ['user:alice'], cc: ['personal:alice'], subject: 'Human decision needed',
    body: 'The agents cannot decide.', kind: 'escalation',
    due: new Date(Date.now() + 60_000).toISOString(), replyTo: first.message.id,
    humanAction: { request: 'Choose the final answer.', reason: 'The evidence conflicts.',
      href: '/inbox/decision', label: 'Review' },
  }
  const sent = await service.sendInboxMessage(reviewer, 'human-escalation', input)
  return { first, input, sent }
}

test('escalation requires a responsible user and due; authenticated human reply resets the topic', async t => {
  const { runtime, service, alice, reviewer } = await setup(t)
  const initial = await service.sendInboxMessage(alice, 'gate-topic', {
    to: ['role:reviewer'], subject: 'Gate', body: 'Review.',
  })
  const base = { to: ['personal:alice'], subject: 'Escalate', body: 'Need a decision.',
    kind: 'escalation', replyTo: initial.message.id,
    humanAction: { request: 'Choose.', reason: 'Conflict.' } }
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'no-user', {
    ...base, due: new Date().toISOString(), cc: ['user:alice'],
  }), /primary user/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'no-due', {
    ...base, to: ['user:alice'],
  }), /primary user.*due/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'no-action', {
    ...base, to: ['user:alice'], due: new Date().toISOString(), humanAction: undefined,
  }), /human_action/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'external-link', {
    ...base, to: ['user:alice'], due: new Date().toISOString(),
    humanAction: { request: 'Choose.', reason: 'Conflict.', href: 'https://evil.example/decide' },
  }), /human action href/)

  const { first, input, sent } = await escalation(service, runtime, alice, reviewer)
  assert.equal(sent.message.topicId, first.message.id)
  assert.equal(sent.message.hop, 7)
  assert.equal(sent.deliveries.find(item => item.recipient === 'user:alice').status, 'delivered')
  assert.equal(sent.deliveries.find(item => item.recipient === 'user:alice').wakeAt, undefined)
  assert.equal(service.listHumanInbox('alice').messages[0].id, sent.message.id)
  assert.throws(() => service.readHumanInbox('bob', sent.message.id), /not visible/)
  await assert.rejects(() => service.handleHumanInbox('bob', sent.message.id), /not delivered/)
  await assert.rejects(() => service.replyHumanInbox('bob', {
    replyTo: sent.message.id, subject: 'Spoofed decision', body: 'No.', idempotencyKey: 'spoof',
  }), /not a delivered Agent message/)
  await assert.rejects(() => service.sendInboxMessage(reviewer, 'closed-topic', {
    to: ['personal:alice'], subject: 'More', body: 'Should stop.',
  }), /already closed/)
  assert.equal((await service.sendInboxMessage(reviewer, 'human-escalation', input)).idempotentReplay, true)

  const replyInput = { replyTo: sent.message.id, subject: 'My decision', body: 'Choose option A.',
    idempotencyKey: 'alice-decision' }
  const reply = await service.replyHumanInbox('alice', replyInput)
  assert.equal(reply.message.fromAddress, 'user:alice')
  assert.equal(reply.message.to[0], 'role:reviewer')
  assert.equal(reply.message.hop, 0)
  assert.equal(reply.message.topicId, reply.message.id)
  assert.equal((await service.replyHumanInbox('alice', replyInput)).idempotentReplay, true)
  await assert.rejects(() => service.replyHumanInbox('alice', { ...replyInput, body: 'Different.' }),
    /idempotency key conflicts/)
  assert.equal(service.listHumanInbox('alice', { pendingOnly: true }).messages.length, 1)
  await service.handleHumanInbox('alice', sent.message.id)
  assert.equal(service.listHumanInbox('alice', { pendingOnly: true }).messages.length, 0)
  assert.equal(runtime.ledger.getInboxDelivery(sent.message.id, 'user:alice').handledByUserId, 'alice')

  const queued = []
  reviewer.inbox = { nextTurn: [], nextStep: [] }
  reviewer.followup = message => { queued.push(message); reviewer.inbox.nextTurn.push(message) }
  const notifier = new InboxReturnNotifier({
    get(id) { return String(id) === reviewer.id ? reviewer : undefined },
    async resume() { throw new Error('unexpected resume') },
  }, runtime.sessionQuery, runtime.ledger)
  const pass = await notifier.recoverBatch()
  assert.deepEqual(pass.queued, [reply.message.id])
  assert.match(queued[0].content[0].text, /Choose option A/)
  assert.equal(runtime.ledger.getInboxReturnRoute(reply.message.id, 'role:reviewer').sessionId, reviewer.id)
  await notifier.close()

  const continued = await service.sendInboxMessage(reviewer, 'after-human', {
    to: ['user:alice'], subject: 'Acknowledged', body: 'Proceeding with A.', replyTo: reply.message.id,
  })
  assert.equal(continued.message.topicId, reply.message.id)
  assert.equal(continued.message.hop, 1)
})

test('human HTTP inbox derives identity from the host and requires mutation authorization', async t => {
  const { runtime, service, alice, reviewer } = await setup(t)
  const { sent } = await escalation(service, runtime, alice, reviewer)
  const handler = createHumanInboxHttpHandler(service, {
    authenticateUser(req) {
      const token = String(req.headers.authorization ?? '')
      return token === 'Bearer alice' ? { userId: 'alice' }
        : token === 'Bearer bob' ? { userId: 'bob' } : null
    },
    authorizeMutation(req) { return req.headers['x-csrf'] === 'ok' },
  })
  const base = 'http://bizagent.local/api/bizagent/human-inbox'
  const request = async (url, init = {}) => {
    const headers = new Headers(init.headers)
    const req = Readable.from(init.body ? [init.body] : [])
    req.url = new URL(url).pathname + new URL(url).search
    req.method = init.method ?? 'GET'
    req.headers = Object.fromEntries(headers.entries())
    const responseHeaders = new Headers()
    const res = { statusCode: 200, setHeader(key, value) { responseHeaders.set(key, value) },
      end(value) { this.body = value } }
    await handler(req, res)
    return new Response(res.body, { status: res.statusCode, headers: responseHeaders })
  }
  const unauthenticated = await request(base)
  assert.equal(unauthenticated.status, 401)
  const forbidden = await request(`${base}?messageId=${sent.message.id}`, {
    headers: { authorization: 'Bearer bob' },
  })
  assert.equal(forbidden.status, 409)
  const visible = await request(base, { headers: { authorization: 'Bearer alice' } })
  assert.equal(visible.status, 200)
  const listed = await visible.json()
  assert.equal(listed.messages[0].id, sent.message.id)
  assert.deepEqual(listed.notificationPreference, { recipient: 'user:alice', enabled: true, revision: 0 })
  const preferenceAction = { action: 'notification-preference', enabled: false, expectedRevision: 0 }
  const deniedPreference = await request(base, { method: 'POST',
    headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: JSON.stringify(preferenceAction) })
  assert.equal(deniedPreference.status, 403)
  const forgedPreference = await request(base, { method: 'POST',
    headers: { authorization: 'Bearer alice', 'x-csrf': 'ok', 'content-type': 'application/json' },
    body: JSON.stringify({ ...preferenceAction, userId: 'bob' }) })
  assert.equal(forgedPreference.status, 400)
  const savedPreference = await request(base, { method: 'POST',
    headers: { authorization: 'Bearer alice', 'x-csrf': 'ok', 'content-type': 'application/json' },
    body: JSON.stringify(preferenceAction) })
  assert.equal(savedPreference.status, 200)
  assert.deepEqual((await savedPreference.json()).preference.enabled, false)
  assert.equal(service.listHumanInbox('alice').notificationPreference.revision, 1)
  assert.equal(service.listHumanInbox('bob').notificationPreference.enabled, true)
  const stalePreference = await request(base, { method: 'POST',
    headers: { authorization: 'Bearer alice', 'x-csrf': 'ok', 'content-type': 'application/json' },
    body: JSON.stringify(preferenceAction) })
  assert.equal(stalePreference.status, 409)
  const opened = await request(`${base}?messageId=${sent.message.id}`, {
    headers: { authorization: 'Bearer alice' },
  })
  assert.equal((await opened.json()).message.humanAction.request, 'Choose the final answer.')
  const action = { action: 'reply', messageId: sent.message.id,
    subject: 'Decision', body: 'Proceed.', idempotencyKey: 'http-decision' }
  const denied = await request(base, {
    method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: JSON.stringify(action),
  })
  assert.equal(denied.status, 403)
  const forged = await request(base, {
    method: 'POST', headers: { authorization: 'Bearer alice', 'x-csrf': 'ok',
      'content-type': 'application/json' }, body: JSON.stringify({ ...action, userId: 'bob' }),
  })
  assert.equal(forged.status, 400)
  const accepted = await request(base, {
    method: 'POST', headers: { authorization: 'Bearer alice', 'x-csrf': 'ok',
      'content-type': 'application/json' }, body: JSON.stringify(action),
  })
  assert.equal(accepted.status, 200)
  const result = await accepted.json()
  assert.equal(result.message.fromAddress, 'user:alice')
  assert.equal(result.message.topicId, result.message.id)
  const replay = await request(base, {
    method: 'POST', headers: { authorization: 'Bearer alice', 'x-csrf': 'ok',
      'content-type': 'application/json' }, body: JSON.stringify(action),
  })
  assert.equal((await replay.json()).idempotentReplay, true)
  const handled = await request(base, {
    method: 'POST', headers: { authorization: 'Bearer alice', 'x-csrf': 'ok',
      'content-type': 'application/json' }, body: JSON.stringify({ action: 'handle', messageId: sent.message.id }),
  })
  assert.equal((await handled.json()).delivery.handledByUserId, 'alice')
  const pending = await request(`${base}?pendingOnly=true`, {
    headers: { authorization: 'Bearer alice' },
  })
  assert.deepEqual((await pending.json()).messages, [])
})

test('unavailable original Session falls back to one owned Agent wake for a human reply', async t => {
  const { runtime, service, alice, reviewer } = await setup(t)
  const { sent } = await escalation(service, runtime, alice, reviewer)
  const reply = await service.replyHumanInbox('alice', {
    replyTo: sent.message.id, subject: 'Decision', body: 'Please proceed.',
    idempotencyKey: 'fallback-decision',
  })
  const unavailable = { async listSessions() { return [] },
    async readSession() { throw new Error('missing') } }
  const notifier = new InboxReturnNotifier({ get() { return undefined },
    async resume() { throw new Error('missing') } }, unavailable, runtime.ledger)
  const returned = await notifier.recoverBatch()
  assert.deepEqual(returned.fallback, [reply.message.id])
  await notifier.close()

  const prompts = []
  const live = new Map()
  const runner = new InboxWakeRunner({
    get(id) { return live.get(String(id)) },
    async create({ sessionId, meta }) {
      const agent = runtime.agent(String(sessionId), meta.cwd, 'Human reply fallback.')
      agent.inbox = { nextTurn: [], nextStep: [] }
      agent.followup = message => { prompts.push(message.content[0].text); agent.inbox.nextTurn.push(message) }
      agent.whenIdle = () => new Promise(() => {})
      live.set(String(sessionId), agent)
      return { agent, async dispose() { live.delete(String(sessionId)) } }
    },
    async resume() { throw new Error('unexpected resume') },
  }, unavailable, service, service.config)
  const wake = await runner.recoverBatch(4, Date.now() + 1_000)
  assert.equal(wake.started.length, 1)
  assert.deepEqual(runtime.ledger.getInboxWakePlan(wake.started[0]).messageIds, [reply.message.id])
  assert.match(prompts[0], new RegExp(reply.message.id))
  await runner.close()
})

test('human escalation, reply, and handling survive a ledger reopen', async t => {
  const { runtime, store, config, service, alice, reviewer } = await setup(t)
  const { sent } = await escalation(service, runtime, alice, reviewer)
  const reply = await service.replyHumanInbox('alice', {
    replyTo: sent.message.id, subject: 'Decision', body: 'Use A.', idempotencyKey: 'durable-decision',
  })
  await service.handleHumanInbox('alice', sent.message.id)
  const reopened = await runtime.reopenLedger()
  const resumed = new BizAgentService(store, reopened, config, runtime.sessionQuery)
  await resumed.initialize()
  assert.equal(resumed.readHumanInbox('alice', sent.message.id).message.humanAction.reason,
    'The evidence conflicts.')
  assert.equal(resumed.listHumanInbox('alice', { pendingOnly: true }).messages.length, 0)
  assert.equal(resumed.listHumanInbox('alice', { direction: 'outgoing' }).messages[0].id, reply.message.id)
  assert.equal(reopened.getInboxDelivery(sent.message.id, 'user:alice').handledByUserId, 'alice')
})

test('human push records confirmed success and definite rejection separately from Inbox delivery', async t => {
  const { runtime, service, reviewer } = await setup(t)
  const sent = await service.sendInboxMessage(reviewer, 'human-push-both', {
    to: ['user:alice'], cc: ['user:bob'], subject: 'Decision needed', body: 'Please review.',
    kind: 'escalation', due: new Date(Date.now() + 60_000).toISOString(),
    humanAction: { request: 'Decide.', reason: 'Agents disagree.' },
  })
  const calls = []
  const provider = { async notify(request) {
    calls.push(request)
    return request.recipient === 'user:alice'
      ? { status: 'sent', providerReceipt: 'verified-provider-42' }
      : calls.filter(call => call.recipient === 'user:bob').length === 1
        ? { status: 'rejected', reason: 'recipient unavailable' }
        : { status: 'sent', providerReceipt: 'verified-provider-retry-43' }
  } }
  const runner = new HumanNotificationRunner(runtime.ledger, provider)
  const pass = await runner.recoverBatch()
  assert.deepEqual(pass.sent, [{ messageId: sent.message.id, recipient: 'user:alice' }])
  assert.deepEqual(pass.rejected, [{ messageId: sent.message.id, recipient: 'user:bob' }])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.role), ['to', 'cc'])
  assert.equal(calls[0].humanAction.request, 'Decide.')
  assert.equal(runtime.ledger.getInboxHumanNotification(sent.message.id, 'user:alice').providerReceipt,
    'verified-provider-42')
  assert.equal(runtime.ledger.getInboxHumanNotification(sent.message.id, 'user:bob').status, 'rejected')
  assert.equal(runtime.ledger.getInboxDelivery(sent.message.id, 'user:bob').status, 'delivered')
  assert.equal(service.readHumanInbox('alice', sent.message.id).notification.status, 'sent')
  assert.equal((await service.readInboxMessage(reviewer, sent.message.id)).humanNotifications.length, 2)
  assert.deepEqual((await runner.recoverBatch()).sent, [])
  assert.equal(calls.length, 2)
  await service.setHumanNotificationPreference('bob', false, 0)
  await assert.rejects(() => runner.retryRejected(sent.message.id, 'user:bob'), /opted out/)
  assert.equal(calls.length, 2)
  await service.setHumanNotificationPreference('bob', true, 1)
  assert.equal(await runner.retryRejected(sent.message.id, 'user:bob'), 'sent')
  const retried = runtime.ledger.getInboxHumanNotification(sent.message.id, 'user:bob')
  assert.equal(retried.attempt, 2)
  assert.equal(retried.priorRejections[0].reason, 'recipient unavailable')
  assert.equal(retried.providerReceipt, 'verified-provider-retry-43')
  assert.notEqual(calls[1].notificationId, calls[2].notificationId)
  await assert.rejects(() => runner.retryRejected(sent.message.id, 'user:bob'), /not a pending, definitely rejected/)
  await runner.close()

  const reopened = await runtime.reopenLedger()
  const resumed = new HumanNotificationRunner(reopened, {
    async notify() { throw new Error('notification must not repeat after reopen') },
  })
  assert.deepEqual((await resumed.recoverBatch()).failed, [])
  assert.equal(reopened.getInboxHumanNotification(sent.message.id, 'user:alice').status, 'sent')
  await resumed.close()
})

test('external notification opt-out and host attention policy survive reopen without backfill', async t => {
  const { runtime, service, reviewer } = await setup(t)
  const optedOut = await service.sendInboxMessage(reviewer, 'human-opted-out', {
    to: ['user:alice'], subject: 'Quiet inbox', body: 'Keep this in the site Inbox.',
  })
  assert.equal((await service.setHumanNotificationPreference('alice', false, 0)).preference.revision, 1)
  let calls = 0
  const provider = { async notify() { calls++; return { status: 'sent', providerReceipt: `receipt-${calls}` } } }
  const runner = new HumanNotificationRunner(runtime.ledger, provider, {
    decide: () => ({ action: 'defer' }),
  })
  const muted = await runner.recoverBatch()
  assert.deepEqual(muted.suppressed, [{ messageId: optedOut.message.id, recipient: 'user:alice' }])
  assert.equal(calls, 0)
  assert.equal(service.readHumanInbox('alice', optedOut.message.id).notification.status, 'suppressed')
  assert.equal(runtime.ledger.getInboxHumanNotification(optedOut.message.id, 'user:alice').attempt, 0)
  await runner.close()

  const reopened = await runtime.reopenLedger()
  assert.equal(reopened.getHumanNotificationPreference('user:alice').enabled, false)
  await service.setHumanNotificationPreference('alice', true, 1)
  const afterOptIn = new HumanNotificationRunner(reopened, provider)
  assert.deepEqual((await afterOptIn.recoverBatch()).sent, [])
  assert.equal(calls, 0)
  const fresh = await service.sendInboxMessage(reviewer, 'human-new-after-optin', {
    to: ['user:alice'], subject: 'New message', body: 'May notify.',
  })
  assert.deepEqual((await afterOptIn.recoverBatch()).sent,
    [{ messageId: fresh.message.id, recipient: 'user:alice' }])
  assert.equal(calls, 1)
  await afterOptIn.close()

  const deferred = await service.sendInboxMessage(reviewer, 'human-deferred', {
    to: ['user:bob'], subject: 'Wait until morning', body: 'Quiet hours.',
  })
  let action = 'defer'
  const policy = new HumanNotificationRunner(reopened, provider, {
    decide: () => action === 'suppress' ? { action, reason: 'host-attention-budget' } : { action },
  })
  assert.deepEqual((await policy.recoverBatch()).deferred,
    [{ messageId: deferred.message.id, recipient: 'user:bob' }])
  assert.equal(reopened.getInboxHumanNotification(deferred.message.id, 'user:bob'), undefined)
  action = 'suppress'
  assert.deepEqual((await policy.recoverBatch()).suppressed,
    [{ messageId: deferred.message.id, recipient: 'user:bob' }])
  assert.equal(reopened.getInboxHumanNotification(deferred.message.id, 'user:bob').reason,
    'host-attention-budget')
  assert.equal(calls, 1)
  await policy.close()
})

test('unknown channel outcome or lost settlement never causes blind resend', async t => {
  const { runtime, service, reviewer } = await setup(t)
  const first = await service.sendInboxMessage(reviewer, 'human-push-unknown', {
    to: ['user:alice'], subject: 'Unknown push', body: 'Review.',
  })
  let calls = 0
  const runner = new HumanNotificationRunner(runtime.ledger, {
    async notify() { calls++; throw new Error('channel timeout after possible acceptance') },
  })
  const [passA, passB] = await Promise.all([runner.recoverBatch(), runner.recoverBatch()])
  assert.equal(calls, 1)
  assert.deepEqual(passA, passB)
  assert.equal(passA.failed.length, 1)
  assert.equal(runtime.ledger.getInboxHumanNotification(first.message.id, 'user:alice').status, 'unknown')
  await assert.rejects(() => runner.retryRejected(first.message.id, 'user:alice'),
    /not a pending, definitely rejected/)
  await runner.close()

  const second = await service.sendInboxMessage(reviewer, 'human-push-lost-receipt', {
    to: ['user:bob'], subject: 'Lost receipt', body: 'Review.',
  })
  const settle = runtime.ledger.settleInboxHumanNotification.bind(runtime.ledger)
  runtime.ledger.settleInboxHumanNotification = async () => { throw new Error('receipt write failed') }
  const failing = new HumanNotificationRunner(runtime.ledger, {
    async notify() { calls++; return { status: 'sent', providerReceipt: 'confirmed-then-lost' } },
  })
  assert.equal((await failing.recoverBatch()).failed.length, 1)
  assert.equal(runtime.ledger.getInboxHumanNotification(second.message.id, 'user:bob').status, 'unknown')
  runtime.ledger.settleInboxHumanNotification = settle
  await failing.close()

  const reopened = await runtime.reopenLedger()
  const resumed = new HumanNotificationRunner(reopened, {
    async notify() { calls++; throw new Error('must not resend unknown outcome') },
  })
  assert.deepEqual((await resumed.recoverBatch()).failed, [])
  assert.equal(calls, 2)
  await resumed.close()
})

test('stalled topic escalates once after 24 hours with trusted owner evidence and human return route', async t => {
  const { runtime, service, alice, reviewer } = await setup(t)
  const first = await service.sendInboxMessage(alice, 'stalled-topic-start', {
    to: ['role:reviewer'], subject: 'Unresolved question', body: 'Please discuss.',
  })
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.id, hop: 5,
    wakePlanId: 'stalled-wake', createdAt: first.message.sentAt })
  const last = await service.sendInboxMessage(reviewer, 'stalled-final-ordinary', {
    to: ['personal:alice'], subject: 'Still unresolved', body: 'No conclusion yet.',
  })
  assert.equal(last.message.hop, 6)
  const before = Date.parse(last.message.sentAt) + 24 * 60 * 60_000 - 1
  let resolutions = 0
  const runner = new InboxStalledEscalationRunner(service, () => {
    resolutions++
    return { userId: 'alice', authorityRef: 'verified-grant:discussion-owner' }
  })
  assert.deepEqual((await runner.recoverBatch(4, before)).escalated, [])
  assert.equal(resolutions, 0)
  const now = before + 2
  const pass = await runner.recoverBatch(4, now)
  assert.equal(pass.escalated.length, 1)
  assert.equal(resolutions, 1)
  const automatic = runtime.ledger.getInboxMessage(pass.escalated[0].messageId)
  assert.equal(automatic.fromAddress, 'engine:inbox')
  assert.equal(automatic.topicId, first.message.id)
  assert.equal(automatic.returnAddress, 'role:reviewer')
  assert.equal(automatic.returnToSessionId, reviewer.id)
  assert.equal(automatic.automaticEscalation.authorityRef, 'verified-grant:discussion-owner')
  assert.equal(automatic.hop, 7)
  assert.equal(runtime.ledger.getInboxDelivery(automatic.id, 'user:alice').status, 'delivered')
  assert.equal(service.readHumanInbox('alice', automatic.id).message.humanAction.request.includes('Decide'), true)
  assert.deepEqual((await runner.recoverBatch(4, now + 1)).escalated, [])
  assert.equal(runtime.ledger.listInboxMessages().filter(message => message.kind === 'escalation').length, 1)
  assert.equal((await service.createAutomaticTopicEscalation({
    topicId: first.message.id, userId: 'alice', authorityRef: 'verified-grant:discussion-owner', now,
  })).message.id, automatic.id)
  await assert.rejects(() => service.createAutomaticTopicEscalation({
    topicId: first.message.id, userId: 'bob', authorityRef: 'different-grant', now,
  }), /different owner decision/)

  const reply = await service.replyHumanInbox('alice', {
    replyTo: automatic.id, subject: 'Proceed', body: 'Take option A.', idempotencyKey: 'auto-response',
  })
  assert.deepEqual(reply.message.to, ['role:reviewer'])
  reviewer.inbox = { nextTurn: [], nextStep: [] }
  const prompts = []
  reviewer.followup = message => { prompts.push(message.content[0].text); reviewer.inbox.nextTurn.push(message) }
  const notifier = new InboxReturnNotifier({
    get(id) { return String(id) === reviewer.id ? reviewer : undefined },
    async resume() { throw new Error('unexpected resume') },
  }, runtime.sessionQuery, runtime.ledger)
  assert.deepEqual((await notifier.recoverBatch()).queued, [reply.message.id])
  assert.match(prompts[0], /Take option A/)
  await notifier.close()
  await runner.close()
  const reopened = await runtime.reopenLedger()
  assert.equal(reopened.getInboxMessage(automatic.id).automaticEscalation.authorityRef,
    'verified-grant:discussion-owner')
  assert.equal(reopened.getInboxDelivery(automatic.id, 'user:alice').status, 'delivered')
})

test('12-message topic waits for a verified owner and excludes formal Work notices', async t => {
  const { runtime, service, alice, reviewer } = await setup(t)
  const first = await service.sendInboxMessage(alice, 'count-topic-start', {
    to: ['role:reviewer'], subject: 'Long discussion', body: 'Start.',
  })
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.id, hop: 0,
    wakePlanId: 'count-wake', createdAt: first.message.sentAt })
  let latest
  for (let index = 0; index < 11; index++) {
    latest = await service.sendInboxMessage(reviewer, `count-${index}`, {
      to: ['personal:alice'], subject: `Update ${index}`, body: 'Still working.',
    })
  }
  await service.sendInboxMessage(alice, 'unrelated-work-notice', {
    to: ['role:reviewer'], subject: 'Formal Work', body: 'Separate.', kind: 'work-notice',
  })
  const now = Date.parse(latest.message.sentAt) + 24 * 60 * 60_000 + 1
  const unverified = new InboxStalledEscalationRunner(service, () => null)
  const held = await unverified.recoverBatch(4, now)
  assert.deepEqual(held.escalated, [])
  assert.deepEqual(held.skipped, [first.message.id])
  await unverified.close()
  const verified = new InboxStalledEscalationRunner(service, topic => {
    assert.equal(topic.ordinaryCount, 12)
    assert.equal(topic.maxHop, 1)
    return { userId: 'alice', authorityRef: 'verified-grant:count-topic' }
  })
  const pass = await verified.recoverBatch(4, now)
  assert.equal(pass.escalated.length, 1)
  assert.equal(runtime.ledger.getInboxMessage(pass.escalated[0].messageId).automaticEscalation.authorityRef,
    'verified-grant:count-topic')
  await verified.close()
})

test('stalled escalation scans a bounded batch and advances past topics without an owner', async t => {
  const { service, reviewer } = await setup(t)
  let latest = 0
  for (let topic = 0; topic < 3; topic++) {
    const first = await service.sendInboxMessage(reviewer, `bounded-start-${topic}`, {
      to: ['personal:alice'], subject: `Topic ${topic}`, body: 'Start.',
    })
    for (let letter = 0; letter < 11; letter++) {
      const sent = await service.sendInboxMessage(reviewer, `bounded-${topic}-${letter}`, {
        to: ['personal:alice'], subject: `Update ${letter}`, body: 'Still open.',
        replyTo: first.message.id,
      })
      latest = Math.max(latest, Date.parse(sent.message.sentAt))
    }
  }
  const visited = []
  const runner = new InboxStalledEscalationRunner(service, candidate => {
    visited.push(candidate.topicId)
    return visited.length === 1 ? null
      : { userId: 'alice', authorityRef: `verified-grant:${candidate.topicId}` }
  })
  const now = latest + 24 * 60 * 60_000 + 1
  const first = await runner.recoverBatch(1, now)
  assert.equal(first.skipped.length, 1)
  assert.equal(visited.length, 1)
  const second = await runner.recoverBatch(1, now)
  assert.equal(second.escalated.length, 1)
  assert.equal(visited.length, 2)
  const third = await runner.recoverBatch(1, now)
  assert.equal(third.escalated.length, 1)
  assert.equal(visited.length, 3)
  assert.equal(new Set(visited).size, 3)
  await runner.close()
})

test('manual conclusion wins if a stalled topic closes while owner lookup is pending', async t => {
  const { reviewerCwd, runtime, service, alice, reviewer } = await setup(t)
  const first = await service.sendInboxMessage(alice, 'race-topic-start', {
    to: ['role:reviewer'], subject: 'Close this', body: 'Discuss.',
  })
  await runtime.ledger.putInboxWakeOrigin({ schemaVersion: 1, sessionId: reviewer.id,
    homeAddress: 'role:reviewer', topicId: first.message.id, hop: 5,
    wakePlanId: 'race-wake', createdAt: first.message.sentAt })
  const last = await service.sendInboxMessage(reviewer, 'race-last-ordinary', {
    to: ['personal:alice'], subject: 'Unresolved', body: 'Still discussing.',
  })
  let releaseOwner
  let enteredLookup
  const entered = new Promise(resolve => { enteredLookup = resolve })
  const runner = new InboxStalledEscalationRunner(service, async () => {
    enteredLookup()
    await new Promise(resolve => { releaseOwner = resolve })
    return { userId: 'alice', authorityRef: 'verified-grant:race' }
  })
  const passPromise = runner.recoverBatch(4, Date.parse(last.message.sentAt) + 24 * 60 * 60_000 + 1)
  await entered
  await writeFile(join(reviewerCwd, 'resolution.md'), 'Resolved locally.')
  await service.sendInboxMessage(reviewer, 'race-conclusion', {
    to: ['personal:alice'], subject: 'Resolved', body: 'See resolution.md.',
    kind: 'conclusion', contextRefs: ['resolution.md'],
  })
  releaseOwner()
  const pass = await passPromise
  assert.deepEqual(pass.escalated, [])
  assert.deepEqual(pass.skipped, [first.message.id])
  assert.equal(runtime.ledger.listInboxMessages().filter(message => message.fromAddress === 'engine:inbox').length, 0)
  await runner.close()
})
