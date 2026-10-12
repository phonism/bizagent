import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { HumanNotificationWebhook } from '../lib/human-notification-webhook.js'

const request = {
  notificationId: 'notice-1', messageId: 'letter-1', recipient: 'user:alice', role: 'to',
  fromAddress: 'role:reviewer', subject: 'Decision', body: 'Please decide.',
  priority: 'urgent', due: '2026-09-26T10:00:00.000Z',
  humanAction: { request: 'Choose A or B.', reason: 'Evidence conflicts.' },
}

test('webhook requires secure endpoint and explicit provider proof for sent or rejected', async () => {
  assert.throws(() => new HumanNotificationWebhook({ endpoint: 'http://example.com/push',
    authorization: () => 'Bearer secret' }), /HTTPS or loopback/)
  assert.throws(() => new HumanNotificationWebhook({ endpoint: 'https://user:pass@example.com/push',
    authorization: () => 'Bearer secret' }), /credentials/)
  const captured = []
  const replies = [
    new Response(JSON.stringify({ status: 'sent', receiptId: 'provider-confirmed-1' })),
    new Response(JSON.stringify({ status: 'rejected', reason: 'unknown user' })),
    new Response(JSON.stringify({ status: 'sent' })),
    new Response(JSON.stringify({ status: 'sent', receiptId: 'untrusted-error' }), { status: 503 }),
    new Response('x'.repeat(65_537)),
  ]
  const webhook = new HumanNotificationWebhook({
    endpoint: 'https://notify.example/push', authorization: () => 'Bearer secret',
    fetch: async (url, init) => { captured.push({ url: String(url), init }); return replies.shift() },
  })
  assert.deepEqual(await webhook.notify(request),
    { status: 'sent', providerReceipt: 'provider-confirmed-1' })
  assert.deepEqual(await webhook.notify(request), { status: 'rejected', reason: 'unknown user' })
  assert.deepEqual(await webhook.notify(request), { status: 'unknown' })
  assert.deepEqual(await webhook.notify(request), { status: 'unknown' })
  assert.deepEqual(await webhook.notify(request), { status: 'unknown' })
  assert.equal(captured[0].url, 'https://notify.example/push')
  assert.equal(captured[0].init.headers.authorization, 'Bearer secret')
  assert.equal(captured[0].init.redirect, 'error')
  assert.deepEqual(JSON.parse(captured[0].init.body), { schemaVersion: 1, ...request })
})

test('webhook treats network errors and unverifiable credentials as unknown outcomes', async () => {
  const webhook = new HumanNotificationWebhook({
    endpoint: 'http://127.0.0.1/push', authorization: () => 'Bearer secret',
    fetch: async () => { throw new Error('timeout after possible send') },
  })
  assert.deepEqual(await webhook.notify(request), { status: 'unknown' })
  const unavailable = new HumanNotificationWebhook({
    endpoint: 'https://notify.example/push', authorization: () => '',
    fetch: async () => { throw new Error('must not call provider without credentials') },
  })
  await assert.rejects(() => unavailable.notify(request), /credential is unavailable/)
})

test('webhook never follows a redirect, so the credential cannot reach another target', async t => {
  const redirectedRequests = []
  const target = createServer((req, res) => {
    redirectedRequests.push(req.headers.authorization)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'sent', receiptId: 'from-redirect-target' }))
  })
  const endpoint = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/collect` })
    res.end()
  })
  await Promise.all([target, endpoint].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  t.after(() => Promise.all([target, endpoint].map(server => new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  }))))
  const webhook = new HumanNotificationWebhook({
    endpoint: `http://127.0.0.1:${endpoint.address().port}/push`, authorization: () => 'Bearer secret',
  })
  assert.deepEqual(await webhook.notify(request), { status: 'unknown' })
  assert.deepEqual(redirectedRequests, [])
})
