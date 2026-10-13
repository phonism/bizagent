import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { InboxWakeRunner } from '../lib/inbox-wake-runner.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('an archived Home neither blocks Session binding nor breaks Inbox wake passes', async t => {
  const root = await makeTempDir('bizagent-archived-home-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const aliceCwd = join(root, 'alice-work')
  const oldCwd = join(root, 'old-work')
  await mkdir(aliceCwd)
  await mkdir(oldCwd)
  const runtime = await createDemoRuntime()
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: aliceCwd, address: 'personal:alice' }, { root: oldCwd, address: 'role:old' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:old', owner: 'alice' })
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery)
  await service.initialize()
  const old = runtime.agent('session-old', oldCwd, 'Write to Alice.')
  await service.sendInboxMessage(old, 'call-letter', { to: ['personal:alice'], subject: 'Status',
    body: 'Old team status.', priority: 'urgent' })

  // Archive role:old, then restart.
  const homeFile = join(root, 'homes', store.getHome('role:old').id, 'home.yaml')
  await writeFile(homeFile, (await readFile(homeFile, 'utf8')).replace(/^status: active$/m, 'status: archived'))
  const restartedStore = new HomeStore(root)
  await restartedStore.initialize()
  assert.equal(restartedStore.findHome('role:old')?.status, 'archived')
  const restarted = new BizAgentService(restartedStore, runtime.ledger, config, runtime.sessionQuery)
  await restarted.initialize()

  // A new unbound Session in Alice's Workspace still binds to Alice.
  const fresh = runtime.agent('session-fresh', aliceCwd, 'New work.')
  const remembered = await restarted.remember(fresh, 'call-remember', { description: 'Rule', body: 'Still works.' })
  assert.equal(remembered.homeAddress, 'personal:alice')

  // The letter from the archived Home is simply not eligible for a wake; the pass does not throw.
  const agents = { get() { return undefined },
    async create() { throw new Error('no wake should start for an archived sender') },
    async resume() { throw new Error('no wake should resume') } }
  const runner = new InboxWakeRunner(agents, runtime.sessionQuery, restarted, config)
  const pass = await runner.recoverBatch(4, Date.now() + 60 * 60_000)
  assert.deepEqual(pass.started, [])
  assert.deepEqual(pass.failed, [])
  await runner.close()
})
