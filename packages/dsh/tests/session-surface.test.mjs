import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { resolveConfig } from '../lib/config.js'
import { sessionActivity, sessionCatalog, sessionContext } from '../lib/session-surface.js'

test('Session surfaces separate live runtime from durable Work status and isolate unrelated Sessions', async t => {
  const root = await makeTempDir('bizagent-session-surface-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'owner' })
  await store.createHome({ address: 'role:analyst', owner: 'owner', displayName: 'Analyst' })
  await store.createHome({ address: 'capability:metrics', owner: 'owner', displayName: 'Metrics' })
  const config = resolveConfig({ homeRoot: root, defaultHome: 'personal:alice',
    workspaceHomes: { [store.homeWorkspacePath('role:analyst')]: 'role:analyst' } }, root)
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery, undefined,
    undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
  await service.initialize()
  t.after(() => service.close())
  const requester = runtime.agent('requester', root, 'Verify GMV')
  await service.openFrame(requester, { address: 'role:analyst', forceSnapshot: true })
  await service.openFrame(requester, { address: 'capability:metrics', forceSnapshot: true })
  assert.deepEqual((await service.frameStatus(requester)).staleFrames, [], 'admitting another reference preserves fresh Frames')
  assert.match((await service.openFrame(requester, { address: 'role:analyst', forceSnapshot: true })).context,
    /BizAgent Read-only Agent Frame/, 'an admission retry receives a complete snapshot')
  const stranger = runtime.agent('unrelated', root, 'Other work')
  await service.homeStatus(stranger)
  const { project } = await service.createProject(requester, { title: 'GMV check', goal: 'Verify GMV',
    doneWhen: 'An evidence-backed result', idempotencyKey: 'project' })
  const { work } = await service.dispatchWork(requester, { toAddress: 'role:analyst', goal: 'Compute GMV',
    acceptanceCriteria: 'Exclude cancelled orders', idempotencyKey: 'work', projectId: project.id })
  const worker = runtime.agent('worker', store.homeWorkspacePath('role:analyst'), 'Compute GMV')
  await service.acceptWork(worker, work.id)
  const status = id => id === 'worker' ? 'idle' : 'unloaded'
  const summary = sessionCatalog(service, status).find(item => item.sessionId === 'worker')
  assert.equal(summary.kind, 'work')
  assert.equal(summary.workStatus, 'accepted')
  assert.equal(summary.runtime, 'idle')
  const context = await sessionContext(service, 'requester', root, requester.session.snapshotEvents(), status)
  assert.equal(context.work[0].runtime, 'idle')
  assert.equal(context.work[0].status, 'accepted')
  assert.equal(context.projects[0].id, project.id)
  const workerContext = await sessionContext(service, 'worker', store.homeWorkspacePath('role:analyst'),
    worker.session.snapshotEvents(), status)
  assert.equal(workerContext.work[0].projectId, project.id)
  assert.deepEqual(workerContext.projects, [], 'an assigned Work alone does not grant access to its Project')
  const other = await sessionContext(service, 'unrelated', root, stranger.session.snapshotEvents(), status)
  assert.deepEqual(other.work, [])
  assert.deepEqual(other.projects, [])
})

test('activity cards require matching successful tool results and remain scoped to their original turn', () => {
  const call = (seq, id, turn = 1) => ({ seq, type: 'tool/call', data: {
    callId: id, turn, name: 'bizagent_memory_remember', arguments: '{}' } })
  const result = (seq, id, options = {}) => ({ seq, type: 'tool/result', data: {
    message: { toolCallId: id, content: [{ type: 'text', text: JSON.stringify({
      asset: { id: 'memory', description: 'Exclude cancelled orders', status: 'candidate' } }) }], ...options } } })
  const activity = sessionActivity([call(1, 'pending'), call(2, 'failed'), result(3, 'failed', { isError: true }),
    result(4, 'foreign'), call(5, 'saved', 2), result(6, 'saved'), result(7, 'saved')])
  assert.equal(activity.length, 1)
  assert.equal(activity[0].turn, 2)
  assert.equal(activity[0].seq, 6)
  assert.equal(activity[0].title, 'Exclude cancelled orders')
  assert.equal(activity[0].status, 'candidate')
})
