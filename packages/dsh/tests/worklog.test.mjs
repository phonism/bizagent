import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { worklogSnapshotPath } from '../lib/worklog-snapshot.js'
import { makeTempDir } from './temp-dir.mjs'

test('Worklog revisions retain Session evidence, file hashes, and Home boundaries', async (t) => {
  const root = await makeTempDir('bizagent-worklog-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const aliceCwd = join(root, 'alice-work')
  const bobCwd = join(root, 'bob-work')
  await mkdir(aliceCwd)
  await mkdir(bobCwd)
  await writeFile(join(aliceCwd, 'result.txt'), 'first result\n')
  await symlink(join(root, 'outside.txt'), join(aliceCwd, 'link.txt'))
  await writeFile(join(root, 'outside.txt'), 'outside')
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const config = {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: bobCwd, address: 'personal:bob' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
  await service.initialize()
  const alice = runtime.agent('alice-log', aliceCwd, 'Produce a result.')
  const bob = runtime.agent('bob-log', bobCwd, 'Review private work.')
  const input = {
    description: 'Result prepared', body: 'The first result is in result.txt.',
    status: 'completed', idempotencyKey: 'result-v1', files: ['result.txt'],
  }
  const first = (await service.recordWorklog(alice, input)).worklog
  assert.equal(first.revision, 1)
  assert.equal(first.files[0].bytes, 13)
  assert.equal(first.files[0].snapshot, true)
  const firstPage = await service.readWorklogFile(alice, {
    sessionId: alice.id, revision: 1, path: 'result.txt', limit: 5,
  })
  assert.equal(Buffer.from(firstPage.contentBase64, 'base64').toString(), 'first')
  assert.equal(firstPage.nextOffset, 5)
  const secondPage = await service.readWorklogFile(alice, {
    sessionId: alice.id, revision: 1, path: 'result.txt', offset: 5,
  })
  assert.equal(Buffer.from(secondPage.contentBase64, 'base64').toString(), ' result\n')
  assert.equal((await service.recordWorklog(alice, input)).idempotentReplay, true)
  await assert.rejects(() => service.recordWorklog(alice, { ...input, body: 'Changed' }), /conflicts/)
  assert.deepEqual((await service.searchWorklogs(alice, { query: 'result.txt' })).worklogs.map(item => item.sessionId), [alice.id])
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).source.status, 'verified')
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).files[0].status, 'current')
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).files[0].snapshot, 'retained')
  assert.equal((await service.listEpisodes(alice)).episodes[0].worklog.description, input.description)
  await assert.rejects(() => service.readWorklog(bob, { sessionId: alice.id }), /not visible/)
  await assert.rejects(() => service.readWorklogFile(bob, {
    sessionId: alice.id, path: 'result.txt',
  }), /not visible/)
  assert.equal((await service.searchWorklogs(bob)).worklogs.length, 0)
  await assert.rejects(() => service.recordWorklog(alice, { ...input, idempotencyKey: 'bad-path', files: ['../outside.txt'] }), /canonical relative/)
  await assert.rejects(() => service.recordWorklog(alice, { ...input, idempotencyKey: 'bad-link', files: ['link.txt'] }), /symlink/)

  await writeFile(join(aliceCwd, 'result.txt'), 'revised result\n')
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).files[0].status, 'changed')
  alice.session.events[1].data.content[0].text = 'A revised Session message.'
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).source.status, 'changed')
  const second = (await service.recordWorklog(alice, {
    description: 'Result revised', body: 'The file and the Session now contain the revision.',
    status: 'completed', idempotencyKey: 'result-v2', files: ['result.txt'],
  })).worklog
  assert.equal(second.revision, 2)
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).source.status, 'verified')
  const old = await service.readWorklog(alice, { sessionId: alice.id, revision: 1 })
  assert.equal(old.worklog.id, first.id)
  assert.equal(old.files[0].status, 'changed')
  assert.equal(old.files[0].snapshot, 'retained')
  assert.equal(Buffer.from((await service.readWorklogFile(alice, {
    sessionId: alice.id, revision: 1, path: 'result.txt',
  })).contentBase64, 'base64').toString(), 'first result\n')
  assert.equal((await service.searchWorklogs(alice, { query: 'prepared' })).worklogs.length, 0)
  assert.deepEqual((await service.searchWorklogs(alice, { status: 'completed' })).worklogs.map(item => item.revision), [2])

  const reopened = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, await runtime.reopenWorklogLedger())
  assert.equal((await reopened.readWorklog(alice, { sessionId: alice.id })).worklog.id, second.id)
  assert.equal(Buffer.from((await reopened.readWorklogFile(alice, {
    sessionId: alice.id, revision: 1, path: 'result.txt',
  })).contentBase64, 'base64').toString(), 'first result\n')
  await writeFile(join(root, worklogSnapshotPath(first.files[0].sha256)), 'tampered')
  await assert.rejects(() => reopened.readWorklogFile(alice, {
    sessionId: alice.id, revision: 1, path: 'result.txt',
  }), /missing, oversized, or changed|checksum mismatch/)
  assert.equal((await reopened.readWorklog(alice, { sessionId: alice.id, revision: 1 })).files[0].snapshot,
    'unavailable')
  await reopened.worklogLedger.close()
  await service.close()
})

test('completed Work yields one source-verified Worklog after its turn is durable and recovers a failed write', async t => {
  const root = await makeTempDir('bizagent-worklog-auto-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workerCwd = join(root, 'worker')
  await mkdir(join(workerCwd, 'artifacts'), { recursive: true })
  await writeFile(join(workerCwd, 'artifacts', 'result.md'), 'Frozen result\n')
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:worker' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: workerCwd, address: 'role:worker' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
  await service.initialize()
  t.after(() => service.close())
  const lead = runtime.agent('auto-log-lead', root, 'Delegate the result.')
  const worker = runtime.agent('auto-log-worker', workerCwd, 'Deliver the result.')
  const work = (await service.dispatchWork(lead, { toAddress: 'role:worker',
    goal: 'Write a result', acceptanceCriteria: 'A reviewed file exists.',
    idempotencyKey: 'auto-log-work' })).work
  await service.acceptWork(worker, work.id)
  await service.completeWork(worker, { workId: work.id, subject: 'Result delivered',
    body: 'The file contains the checked result.', artifactRefs: ['artifacts/result.md'] })
  assert.deepEqual((await service.reconcileCompletedWorklogs(20, worker.id)).deferred, [work.id])
  assert.equal(runtime.worklogLedger.listVersions(worker.id).length, 0)
  runtime.appendSessionEvent(worker.id, { seq: 2, type: 'tool/call', data: { turn: 1, step: 1,
    callId: 'complete-call', name: 'bizagent_work_complete',
    arguments: JSON.stringify({ work_id: work.id }) } })
  runtime.appendSessionEvent(worker.id, { seq: 3, type: 'tool/result', data: {
    turn: 1, message: { content: [{ type: 'tool-result', toolCallId: 'complete-call', content: [] }] },
  } })
  runtime.appendSessionEvent(worker.id, { seq: 4, type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } } })
  const originalPut = runtime.worklogLedger.put.bind(runtime.worklogLedger)
  let failOnce = true
  runtime.worklogLedger.put = async revision => {
    if (failOnce) { failOnce = false; throw new Error('simulated Worklog write failure') }
    return originalPut(revision)
  }
  const failed = await service.reconcileCompletedWorklogs(20, worker.id)
  assert.match(String(failed.failed[0]?.error), /simulated Worklog write failure/)
  assert.equal(runtime.worklogLedger.listVersions(worker.id).length, 0)
  const recovered = await service.reconcileCompletedWorklogs(20, worker.id)
  assert.deepEqual(recovered.created, [work.id])
  assert.deepEqual(recovered.failed, [])
  assert.deepEqual((await service.reconcileCompletedWorklogs(20, worker.id)).created, [])
  const log = runtime.worklogLedger.listVersions(worker.id)[0]
  assert.equal(log.origin, 'work-result')
  assert.equal(log.workId, work.id)
  assert.equal(log.status, 'completed')
  assert.equal(log.description, 'Result delivered')
  assert.equal((await service.reconcileSessionWorklogs(20, worker.id)).created.length, 0)
  assert.equal((await service.readWorklog(worker, { sessionId: worker.id })).source.status, 'verified')
  await writeFile(join(workerCwd, 'artifacts', 'result.md'), 'Changed after completion\n')
  const read = await service.readWorklog(worker, { sessionId: worker.id })
  assert.equal(read.files[0].status, 'changed')
  assert.equal(read.files[0].snapshot, 'retained')
  assert.equal(Buffer.from((await service.readWorklogFile(worker, {
    sessionId: worker.id, path: 'artifacts/result.md',
  })).contentBase64, 'base64').toString(), 'Frozen result\n')
  await assert.rejects(() => service.readWorklog(lead, { sessionId: worker.id }), /not visible/)
  const reopenedLedger = await runtime.reopenWorklogLedger()
  const restarted = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, reopenedLedger)
  assert.deepEqual((await restarted.reconcileCompletedWorklogs()).created, [])
  assert.equal(reopenedLedger.listVersions(worker.id).length, 1)
  await reopenedLedger.close()
})

test('ordinary substantive Session turns create an evolving Worklog and recover idempotently', async t => {
  const root = await makeTempDir('bizagent-session-worklog-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [], budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
  const alice = runtime.agent('ordinary-alice', root, 'Inspect the data.')
  const bob = runtime.agent('ordinary-bob', root, 'Private task.')
  await runtime.ledger.putBinding({ sessionId: alice.id, homeAddress: 'personal:alice',
    cwd: root, boundAt: new Date().toISOString() })
  await runtime.ledger.putBinding({ sessionId: bob.id, homeAddress: 'personal:bob',
    cwd: root, boundAt: new Date().toISOString() })
  runtime.appendSessionEvent(alice.id, { seq: 2, type: 'tool/call', data: {
    turn: 1, step: 1, callId: 'inspect', name: 'inspect_data', arguments: '{}',
  } })
  runtime.appendSessionEvent(alice.id, { seq: 3, type: 'tool/result', data: {
    turn: 1, message: { content: [{ type: 'tool-result', toolCallId: 'inspect', content: [] }] },
  } })
  runtime.appendSessionEvent(alice.id, { seq: 4, type: 'assistant/message', data: {
    turn: 1, message: { content: [{ type: 'text', text: 'The data has three rows.' }] },
  } })
  runtime.appendSessionEvent(alice.id, { seq: 5, type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } } })
  const first = await service.reconcileSessionWorklogs(20, alice.id)
  assert.equal(first.created.length, 1)
  assert.equal((await service.readWorklog(alice, { sessionId: alice.id })).source.status, 'verified')
  assert.match((await service.readWorklog(alice, { sessionId: alice.id })).worklog.body,
    /inspect_data: succeeded/)
  assert.equal((await service.reconcileSessionWorklogs(20, alice.id)).created.length, 0)
  runtime.appendSessionEvent(alice.id, { seq: 6, type: 'turn/start', data: { turn: 2 } })
  runtime.appendSessionEvent(alice.id, { seq: 7, type: 'user/message', data: {
    content: [{ type: 'text', text: 'Thanks.' }],
  } })
  runtime.appendSessionEvent(alice.id, { seq: 8, type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal((await service.reconcileSessionWorklogs(20, alice.id)).created.length, 0)
  runtime.appendSessionEvent(alice.id, { seq: 9, type: 'turn/start', data: { turn: 3 } })
  runtime.appendSessionEvent(alice.id, { seq: 10, type: 'user/message', data: {
    content: [{ type: 'text', text: 'Check totals.' }],
  } })
  runtime.appendSessionEvent(alice.id, { seq: 11, type: 'tool/call', data: {
    turn: 3, step: 1, callId: 'totals', name: 'calculate_totals', arguments: '{}',
  } })
  runtime.appendSessionEvent(alice.id, { seq: 12, type: 'assistant/message', data: {
    turn: 3, message: { content: [{ type: 'text', text: 'The total is six.' }] },
  } })
  runtime.appendSessionEvent(alice.id, { seq: 13, type: 'turn/end',
    data: { turn: 3, reason: { kind: 'completed' } } })
  const restarted = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger, await runtime.reopenWorklogLedger())
  assert.equal((await restarted.reconcileSessionWorklogs(20, alice.id)).created.length, 1)
  const latest = (await restarted.readWorklog(alice, { sessionId: alice.id })).worklog
  assert.equal(latest.origin, 'session-activity')
  assert.equal(latest.revision, 2)
  assert.match(latest.body, /The data has three rows/)
  assert.match(latest.body, /The total is six/)
  assert.equal((await restarted.readWorklog(alice, { sessionId: alice.id })).source.status, 'verified')
  assert.equal((await restarted.reconcileSessionWorklogs(20, alice.id)).created.length, 0)
  await restarted.recordWorklog(alice, { description: 'Reviewed totals',
    body: 'Agent confirmed the business conclusion.', status: 'completed',
    idempotencyKey: 'agent-conclusion' })
  runtime.appendSessionEvent(alice.id, { seq: 14, type: 'turn/start', data: { turn: 4 } })
  runtime.appendSessionEvent(alice.id, { seq: 15, type: 'tool/call', data: {
    turn: 4, step: 1, callId: 'review', name: 'review_totals', arguments: '{}',
  } })
  runtime.appendSessionEvent(alice.id, { seq: 16, type: 'turn/end',
    data: { turn: 4, reason: { kind: 'completed' } } })
  assert.equal((await restarted.reconcileSessionWorklogs(20, alice.id)).created.length, 0)
  assert.equal((await restarted.readWorklog(alice, { sessionId: alice.id })).worklog.description,
    'Reviewed totals')
  await assert.rejects(() => restarted.readWorklog(bob, { sessionId: alice.id }), /not visible/)
  await restarted.worklogLedger.close()
  await service.close()
})
