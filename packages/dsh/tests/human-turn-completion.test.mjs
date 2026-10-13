import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { HumanTurnCompletionNotifier, humanTurnInboxMessageId } from '../lib/human-turn-completion.js'
import { HumanNotificationRunner } from '../lib/human-notification-runner.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'

test('a persisted human turn reaches only its verified asker and opt-out keeps it inside Inbox', async () => {
  const runtime = await createDemoRuntime()
  const sessionId = 'human-completion-session'
  const cwd = '/tmp/human-completion'
  const now = Date.now()
  await runtime.ledger.putBinding({ sessionId, homeAddress: 'personal:alice', cwd,
    boundAt: new Date(now - 60_000).toISOString() })
  const events = [
    { seq: 0, time: now - 5_000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: now - 4_000, type: 'user/message', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: 'How is the launch?' }] } },
    { seq: 2, time: now - 3_000, type: 'assistant/message', data: { turn: 1 } },
    { seq: 3, time: now - 2_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 4, time: now - 1_500, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, time: now - 1_400, type: 'user/message', data: {
      source: { kind: 'scheduler' }, content: [{ type: 'text', text: 'Auto report' }] } },
    { seq: 6, time: now - 1_200, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    { seq: 7, time: now - 900, type: 'turn/start', data: { turn: 3 } },
    { seq: 8, time: now - 800, type: 'user/message', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Still running' }] } },
  ]
  const persisted = { meta: { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: now - 60_000 }, events }
  const sessions = { async inspect(id) {
    assert.equal(id, sessionId)
    return structuredClone(persisted)
  } }
  const authorized = []
  const source = {
    async listCandidates(after, limit) {
      assert.equal(after, undefined)
      assert.equal(limit, 20)
      return { candidates: [1, 2, 3].map(turn => ({ sessionId, turn })) }
    },
    authorize(candidate) {
      authorized.push(candidate.turn)
      return { recipient: 'user:alice', authorityRef: 'verified-web-turn:alice',
        pagePath: `/conversations/${sessionId}`, summary: 'How is the launch?' }
    },
  }
  const notifier = new HumanTurnCompletionNotifier(runtime.ledger, sessions, source)
  const pass = await notifier.recoverBatch()
  const id = humanTurnInboxMessageId(sessionId, 1)
  assert.deepEqual(pass.delivered, [id])
  assert.deepEqual(pass.skipped, [humanTurnInboxMessageId(sessionId, 2)])
  assert.deepEqual(pass.held, [humanTurnInboxMessageId(sessionId, 3)])
  assert.deepEqual(authorized, [1])
  assert.equal(runtime.ledger.getInboxMessage(id).humanTurn.recipient, 'user:alice')
  assert.equal(runtime.ledger.getInboxDelivery(id, 'user:alice').status, 'delivered')
  assert.equal(runtime.ledger.getInboxDelivery(id, 'user:bob'), undefined)
  assert.deepEqual((await notifier.recoverBatch()).existing, [id])

  await runtime.ledger.setHumanNotificationPreference('user:alice', false, 0)
  let channelCalls = 0
  const push = new HumanNotificationRunner(runtime.ledger, {
    async notify() { channelCalls++; throw new Error('opted-out channel must not run') },
  })
  assert.deepEqual((await push.recoverBatch()).suppressed, [{ messageId: id, recipient: 'user:alice' }])
  assert.equal(channelCalls, 0)
  assert.equal(runtime.ledger.getInboxHumanNotification(id, 'user:alice').status, 'suppressed')
  await push.close()
  const reopened = await runtime.reopenLedger()
  assert.deepEqual((await new HumanTurnCompletionNotifier(reopened, sessions, source).recoverBatch()).existing, [id])
  assert.equal(reopened.getInboxHumanNotification(id, 'user:alice').attempt, 0)
})

test('completion notice repairs a failed message write and rejects changed authority or unsafe links', async () => {
  const runtime = await createDemoRuntime()
  const sessionId = 'human-completion-repair'
  const cwd = '/tmp/human-completion-repair'
  const now = Date.now()
  await runtime.ledger.putBinding({ sessionId, homeAddress: 'business:launch', cwd,
    boundAt: new Date(now - 5_000).toISOString() })
  const events = [
    { seq: 0, time: now - 3_000, type: 'turn/start', data: { turn: 0 } },
    { seq: 1, time: now - 2_000, type: 'user/message', data: {
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize' }] } },
    { seq: 2, time: now - 1_000, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  const sessions = { async inspect() {
    return structuredClone({ meta: { version: SESSION_FORMAT_VERSION, id: sessionId, cwd, createdAt: now - 5_000 }, events })
  } }
  let pagePath = '//unsafe.example'
  let recipient = 'user:alice'
  const source = { async listCandidates() { return { candidates: [{ sessionId, turn: 0 }] } },
    authorize() { return { recipient, authorityRef: 'verified-turn:0', pagePath } } }
  const notifier = new HumanTurnCompletionNotifier(runtime.ledger, sessions, source)
  const candidate = { sessionId, turn: 0 }
  await assert.rejects(() => notifier.notify(candidate), /human action href/)
  const id = humanTurnInboxMessageId(sessionId, 0)
  assert.equal(runtime.ledger.getInboxMessage(id), undefined)
  pagePath = '/business/launch/session'
  const originalPut = runtime.ledger.putInboxMessage.bind(runtime.ledger)
  runtime.ledger.putInboxMessage = async () => { throw new Error('message write interrupted') }
  await assert.rejects(() => notifier.notify(candidate), /message write interrupted/)
  assert.equal(runtime.ledger.getInboxMessage(id), undefined)
  assert.equal(runtime.ledger.getInboxDelivery(id, 'user:alice').status, 'delivered')
  runtime.ledger.putInboxMessage = originalPut
  assert.equal(await notifier.notify(candidate), 'delivered')
  assert.equal(await notifier.notify(candidate), 'existing')
  recipient = 'user:bob'
  await assert.rejects(() => notifier.notify(candidate), /conflicts with its verified Session source/)
  assert.equal(runtime.ledger.getInboxDelivery(id, 'user:bob'), undefined)
})
