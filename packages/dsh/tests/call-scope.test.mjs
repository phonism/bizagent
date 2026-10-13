import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

// Providers may reuse tool-call IDs across responses (DSH falls back to `call-<index>`), so every
// record derived from a call ID must stay scoped to the calling Session and call.
async function setup(t) {
  const root = await makeTempDir('bizagent-call-scope-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const bobCwd = join(root, 'bob')
  await mkdir(bobCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:bob', owner: 'alice' })
  await store.createHome({ address: 'role:target', owner: 'alice' })
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: bobCwd, address: 'role:bob' }, { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery)
  await service.initialize()
  return { runtime, store, service, root, bobCwd }
}

function toolCall(agent, callId, name) {
  const events = agent.session.events
  events.push({ seq: events.length, time: Date.now(), type: 'tool/call',
    data: { turn: 1, callId, name, arguments: '{}' } })
}

test('the same provider call ID in two Sessions of one Home creates two memories', async t => {
  const { runtime, service, root } = await setup(t)
  const first = runtime.agent('session-one', root, 'First Session.')
  const second = runtime.agent('session-two', root, 'Second Session.')
  const a = await service.remember(first, 'call-0', { description: 'Rule A', body: 'GMV excludes refunds.' })
  const b = await service.remember(second, 'call-0', { description: 'Rule B', body: 'WAU counts distinct users.' })
  assert.notEqual(a.asset.id, b.asset.id)
  assert.match((await service.readMemory(second, 'call-0', b.asset.id)).asset.body, /distinct users/)
  // A read in another Session with the same call ID does not collide with the first receipt.
  await service.readMemory(first, 'call-0', b.asset.id)
})

test('the same call ID within one Session but different calls creates different records', async t => {
  const { runtime, service, root } = await setup(t)
  const agent = runtime.agent('session-repeat', root, 'One Session.')
  toolCall(agent, 'call-0', 'bizagent_memory_remember')
  const a = await service.remember(agent, 'call-0', { description: 'Turn one rule', body: 'First rule.' })
  toolCall(agent, 'call-0', 'bizagent_memory_remember')
  const b = await service.remember(agent, 'call-0', { description: 'Turn two rule', body: 'Second rule.' })
  assert.notEqual(a.asset.id, b.asset.id)
  // Retrying the same call (same tool/call event) stays idempotent.
  const retry = await service.remember(agent, 'call-0', { description: 'Turn two rule', body: 'Second rule.' })
  assert.equal(retry.asset.id, b.asset.id)
})

test('proposals from two Homes with the same call ID stay independent', async t => {
  const { runtime, service, root, bobCwd } = await setup(t)
  const alice = runtime.agent('session-alice', root, 'Alice proposes.')
  const bob = runtime.agent('session-bob', bobCwd, 'Bob proposes.')
  const fromAlice = await service.proposeMemory(alice, 'call-0', {
    toAddress: 'role:target', description: 'Alice rule', body: 'Private to Alice until accepted.' })
  const fromBob = await service.proposeMemory(bob, 'call-0', {
    toAddress: 'role:target', description: 'Bob rule', body: 'Bob evidence.' })
  assert.notEqual(fromAlice.proposal.id, fromBob.proposal.id)
  assert.equal(fromBob.idempotentReplay, undefined)
  assert.equal(fromBob.proposal.fromAddress, 'role:bob')
  assert.doesNotMatch(JSON.stringify(fromBob), /Private to Alice/)
})
