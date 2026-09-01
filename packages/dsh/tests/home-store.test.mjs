import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'

test('HomeStore persists index-first memory and revisions across reloads', async (t) => {
  const root = await mkdtemp('/private/tmp/bizagent-home-store-')
  t.after(() => rm(root, { recursive: true, force: true }))

  const store = new HomeStore(root)
  await store.initialize()
  const created = await store.createHome({
    address: 'personal:alice',
    displayName: 'Alice',
    identity: 'Respect Alice preferences and keep evidence.',
  })
  assert.equal(created.revision, 1)

  const asset = await store.createAsset({
    id: 'mem-test-1',
    ownerAddress: 'personal:alice',
    kind: 'memory',
    description: 'Use weekly cohorts for retention reviews.',
    body: 'Compare acquisition cohorts by ISO week and keep D0 out of retained-user counts.',
    tags: ['retention', 'cohort'],
    sourceRefs: [{ type: 'session-events', sessionId: 'session-a', fromSeq: 1, toSeq: 4 }],
  })
  assert.equal(asset.revision, 1)
  assert.equal(store.getHome('personal:alice').revision, 2)

  const context = store.contextFor('personal:alice', { identityMaxBytes: 1024, indexMaxBytes: 4096 }, 1)
  assert.match(context, /Use weekly cohorts/)
  assert.doesNotMatch(context, /Compare acquisition cohorts/)
  assert.match(context, /Known DSH episodes: 1/)

  const reloaded = new HomeStore(root)
  await reloaded.initialize()
  assert.equal(reloaded.readAsset('personal:alice', 'mem-test-1').body, asset.body)
  assert.equal(reloaded.searchAssets('personal:alice', { query: 'ISO week' }).length, 1)

  await reloaded.updateAsset('personal:alice', 'mem-test-1', { status: 'retired' })
  const retiredContext = reloaded.contextFor(
    'personal:alice',
    { identityMaxBytes: 1024, indexMaxBytes: 4096 },
  )
  assert.doesNotMatch(retiredContext, /Use weekly cohorts/)
  assert.equal(reloaded.searchAssets('personal:alice', { status: 'retired' }).length, 1)

  const report = await reloaded.doctor()
  assert.deepEqual(report.issues, [])
  assert.equal(report.assetCount, 1)
})

test('HomeStore rejects duplicate addresses and cross-owner files', async (t) => {
  const root = await mkdtemp('/private/tmp/bizagent-home-owner-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  const first = await store.createHome({ address: 'role:growth-strategy' })
  const second = await store.createHome({ address: 'role:growth-strategy' })
  assert.equal(second.id, first.id)

  await assert.rejects(() => store.createAsset({
    id: 'bad-owner',
    ownerAddress: 'personal:missing',
    kind: 'memory',
    description: 'Should fail.',
    body: 'There is no owner Home.',
    sourceRefs: [{ type: 'session-events', sessionId: 's', fromSeq: 0, toSeq: 0 }],
  }), /Agent Home not found/)
})
