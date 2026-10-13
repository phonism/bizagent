import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

async function setup(t) {
  const root = await makeTempDir('bizagent-runtime-issues-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const bCwd = join(root, 'b')
  await mkdir(bCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'role:a', owner: 'alice' })
  await store.createHome({ address: 'role:b', owner: 'alice' })
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'role:a', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: bCwd, address: 'role:b' }, { root, address: 'role:a' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery)
  await service.initialize()
  return { runtime, service, root, bCwd }
}

test('runtime issues are de-duplicated with a count and bounded to the most recent 50', async t => {
  const { service } = await setup(t)
  for (let index = 0; index < 100; index++) service.recordRuntimeError('Inbox delivery tick', new Error('timeout'))
  let issues = service.listRuntimeIssues()
  assert.equal(issues.length, 1)
  assert.equal(issues[0].count, 100)
  for (let index = 0; index < 60; index++) service.recordRuntimeError(`Work recovery ${index}`, new Error('busy'))
  issues = service.listRuntimeIssues()
  assert.equal(issues.length, 50)
  assert.equal(issues[0].message, 'Work recovery 10: busy')
  assert.equal(issues.at(-1).message, 'Work recovery 59: busy')
})

test('home_status shows only the calling Home\'s runtime issues', async t => {
  const { runtime, service, root, bCwd } = await setup(t)
  const a = runtime.agent('session-a', root, 'A.')
  const b = runtime.agent('session-b', bCwd, 'B.')
  service.recordRuntimeError('Work recovery work-1', new Error('worker for role:a failed'), 'role:a')
  service.recordRuntimeError('Inbox delivery tick', new Error('unattributed'))
  const statusA = await service.homeStatus(a)
  assert.deepEqual(statusA.persistenceErrors, ['Work recovery work-1: worker for role:a failed'])
  assert.equal(statusA.otherRuntimeIssues, 1)
  const statusB = await service.homeStatus(b)
  assert.deepEqual(statusB.persistenceErrors, [])
  assert.equal(statusB.otherRuntimeIssues, 2)
})
