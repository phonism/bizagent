import assert from 'node:assert/strict'
import { readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { safeHomeId } from '../lib/domain.js'
import { makeTempDir } from './temp-dir.mjs'

test('HomeStore persists index-first memory and revisions across reloads', async (t) => {
  const root = await makeTempDir('bizagent-home-store-')
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
  const root = await makeTempDir('bizagent-home-owner-')
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

test('HomeStore rejects stale concurrent edits and same-id content collisions', async (t) => {
  const root = await makeTempDir('bizagent-asset-revision-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const input = {
    id: 'mem-review', ownerAddress: 'personal:alice', kind: 'memory',
    description: 'Review backups', body: 'Verify a backup by restoring it.',
    sourceRefs: [{ type: 'session-events', sessionId: 's', fromSeq: 0, toSeq: 1 }],
  }
  const asset = await store.createAsset(input)
  assert.deepEqual(await store.createAsset(input), asset)
  await assert.rejects(() => store.createAsset({ ...input, body: 'A different observation.' }), /collision/)
  const results = await Promise.allSettled([
    store.updateAsset(input.ownerAddress, input.id, { expectedRevision: 1, body: 'First reviewed update.' }),
    store.updateAsset(input.ownerAddress, input.id, { expectedRevision: 1, body: 'Stale competing update.' }),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /revision conflict/)
  const reloaded = new HomeStore(root)
  await reloaded.initialize()
  assert.equal(reloaded.readAsset(input.ownerAddress, input.id).body, 'First reviewed update.')
  assert.equal(reloaded.readAsset(input.ownerAddress, input.id).revision, 2)
  assert.deepEqual((await reloaded.doctor()).issues, [])
})

test('HomeStore creates and reloads a complete organization graph', async (t) => {
  const root = await makeTempDir('bizagent-organization-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()

  const created = await store.createOrganization({
    id: 'northstar-lab',
    name: 'Northstar Lab',
    mission: 'turn verified customer needs into reliable software.',
    members: [
      {
        id: 'alice',
        displayName: 'Alice',
        roleId: 'product-lead',
        roleName: 'Product Lead',
        responsibility: 'Own product direction and user value.',
      },
      {
        id: 'builder',
        displayName: 'Builder',
        roleId: 'engineering',
        roleName: 'Engineering',
        responsibility: 'Deliver and maintain reliable software.',
      },
    ],
    capabilities: [{
      id: 'research',
      displayName: 'Research',
      responsibility: 'Retain evidence-backed research methods and findings.',
    }],
  })

  assert.equal(created.businessHome, 'business:northstar-lab')
  assert.equal(created.lineHome, 'line:northstar-lab')
  assert.equal(created.members.length, 2)
  assert.equal(created.links.length, 11)
  assert.equal(store.listHomes().length, 7)
  assert.equal(store.getHome('line:northstar-lab').owner, 'alice')
  assert.equal(store.getHome('personal:alice').owner, 'alice')
  assert.match(store.getIdentity('personal:alice'), /Product Lead/)

  const reloaded = new HomeStore(root)
  await reloaded.initialize()
  assert.deepEqual(reloaded.getOrganization(), created)
  assert.equal(reloaded.getHome('capability:research').displayName, 'Research')

  const retried = await reloaded.createOrganization({
    id: 'northstar-lab',
    name: 'Northstar Lab',
    mission: 'ignored on idempotent retry',
    members: [{
      id: 'ignored',
      displayName: 'Ignored',
      roleId: 'ignored',
      roleName: 'Ignored',
      responsibility: 'Ignored',
    }],
    capabilities: [],
  })
  assert.deepEqual(retried, created)
})

test('HomeStore keeps the recorded owner when an Agent edits home.yaml', async (t) => {
  const root = await makeTempDir('bizagent-home-owner-record-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'role:reviewer', owner: 'alice' })
  await store.createHome({ address: 'role:unowned' })
  const reviewerFile = join(root, 'homes', safeHomeId('role:reviewer'), 'home.yaml')
  const unownedFile = join(root, 'homes', safeHomeId('role:unowned'), 'home.yaml')
  await writeFile(reviewerFile, (await readFile(reviewerFile, 'utf8')).replace('owner: alice', 'owner: mallory'))
  await writeFile(unownedFile, `${await readFile(unownedFile, 'utf8')}owner: alice\n`)

  const reloaded = new HomeStore(root)
  await reloaded.initialize()
  assert.equal(reloaded.getHome('role:reviewer').owner, 'alice')
  assert.equal(reloaded.getHome('role:unowned').owner, undefined)
  const report = await reloaded.doctor()
  assert.equal(report.ok, false)
  assert.equal(report.issues.filter(issue => /owner differs from the recorded owner/.test(issue)).length, 2)
  // The refused owner is not written back into the authoritative record.
  const again = new HomeStore(root)
  await again.initialize()
  assert.equal(again.getHome('role:reviewer').owner, 'alice')
})

test('HomeStore accepts home.yaml owners from a directory written before owners were recorded', async (t) => {
  const root = await makeTempDir('bizagent-home-owner-legacy-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'role:reviewer', owner: 'alice' })
  const directoryFile = join(root, 'directory.yaml')
  const legacy = (await readFile(directoryFile, 'utf8')).split('\n').filter(line => !/^\s*owner:/.test(line)).join('\n')
  await writeFile(directoryFile, legacy)
  const reloaded = new HomeStore(root)
  await reloaded.initialize()
  assert.equal(reloaded.getHome('role:reviewer').owner, 'alice')
  assert.deepEqual((await reloaded.doctor()).issues, [])
  assert.match(await readFile(directoryFile, 'utf8'), /owner: alice/)
})

test('HomeStore rejects home.yaml identity fields that do not match the Home address', async (t) => {
  for (const [label, tamper] of [
    ['type', text => text.replace('type: role', 'type: business')],
    ['id', text => text.replace(/^id: .*$/m, 'id: role--other-00000000')],
    ['address', text => text.replace('address: role:reviewer', 'address: role:other')],
  ]) {
    const root = await makeTempDir(`bizagent-home-identity-${label}-`)
    t.after(() => rm(root, { recursive: true, force: true }))
    const store = new HomeStore(root)
    await store.initialize()
    await store.createHome({ address: 'role:reviewer', owner: 'alice' })
    const file = join(root, 'homes', safeHomeId('role:reviewer'), 'home.yaml')
    const original = await readFile(file, 'utf8')
    const tampered = tamper(original)
    assert.notEqual(tampered, original, label)
    await writeFile(file, tampered)
    await assert.rejects(() => new HomeStore(root).initialize(), /does not match/, label)
  }

  const root = await makeTempDir('bizagent-home-identity-dir-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'role:reviewer' })
  await rename(join(root, 'homes', safeHomeId('role:reviewer')), join(root, 'homes', 'renamed-home'))
  await assert.rejects(() => new HomeStore(root).initialize(), /directory name does not match/)
})

test('HomeStore does not follow a symlink for managed Home files', async (t) => {
  const root = await makeTempDir('bizagent-home-symlink-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'role:reviewer', identity: 'Reviewer identity.' })
  const outside = join(root, 'outside-identity.md')
  await writeFile(outside, 'Injected identity from outside the Home.\n')
  const identityFile = join(root, 'homes', safeHomeId('role:reviewer'), 'identity.md')
  await rm(identityFile)
  await symlink(outside, identityFile)
  await assert.rejects(() => new HomeStore(root).initialize(), /symlink/)
})
