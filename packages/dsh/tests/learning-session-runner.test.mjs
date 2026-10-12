import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { LearningSessionRunner } from '../lib/learning-session-runner.js'
import { summarizeLearningUsage } from '../lib/learning-usage.js'
import { LearningScheduler } from '../lib/learning-scheduler.js'
import { resolveConfig } from '../lib/config.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

function config(root, workspace) {
  return { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: workspace, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
}

function factory(runtime, { createFailure } = {}) {
  const live = new Map()
  const prompts = []
  const optionsUsed = []
  let creates = 0
  let resumes = 0
  let disposals = 0
  const idle = new Map()
  function handle(id, cwd, snapshot) {
    let settleIdle
    const idlePromise = new Promise(resolve => { settleIdle = resolve })
    idle.set(id, settleIdle)
    const agent = {
      id, session: { header: { id, cwd }, events: structuredClone(snapshot.events) },
      inbox: { nextTurn: [], nextStep: [] },
      followup(message) {
        prompts.push(message)
        this.inbox.nextTurn.push(message)
        const event = { seq: this.session.events.length, type: 'agent/inbox/spliced',
          data: { target: 'next-turn', start: 0, inserted: [message] } }
        this.session.events.push(event)
        runtime.appendSessionEvent(id, event)
      },
      whenIdle: () => idlePromise,
    }
    live.set(id, agent)
    return { agent, async dispose() { disposals += 1; live.delete(id) } }
  }
  const agents = {
    get(id) { return live.get(String(id)) },
    async create(options) {
      creates += 1
      optionsUsed.push(options.agentOptions)
      if (createFailure === 'before') throw new Error('factory rejected before creation')
      const snapshot = runtime.agent(String(options.sessionId), options.meta.cwd, 'Dedicated learning Session.')
      if (createFailure === 'after') throw new Error('factory response lost after creation')
      return handle(String(options.sessionId), options.meta.cwd, snapshot.session)
    },
    async resume(options) {
      resumes += 1
      optionsUsed.push(options.agentOptions)
      const snapshot = await runtime.sessionQuery.readSession(String(options.resumeSessionId))
      return handle(String(options.resumeSessionId), snapshot.session.cwd, snapshot)
    },
  }
  return { agents, live, prompts, idle, optionsUsed, counts: () => ({ creates, resumes, disposals }) }
}

test('learning usage counts durable stream reports once and keeps missing accounting visible', () => {
  const usage = summarizeLearningUsage([
    { seq: 0, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 1, type: 'assistant/chunk', data: { turn: 1, step: 1,
      chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4,
        cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 2 } } } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1,
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 20 } } },
    { seq: 3, type: 'step/start', data: { turn: 1, step: 2 } },
    { seq: 4, type: 'assistant/message', data: { turn: 1, step: 2,
      usage: { inputTokens: 5, outputTokens: 1 } } },
    { seq: 5, type: 'step/start', data: { turn: 1, step: 3 } },
  ])
  assert.deepEqual(usage, { status: 'partial', reported: { inputTokens: 15, outputTokens: 5,
    cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 2 },
    reportedSteps: 2, unreportedSteps: 1, lastEventSeq: 5, costUsd: null })
  const missing = summarizeLearningUsage([{ seq: 0, type: 'step/start',
    data: { turn: 1, step: 1 } }])
  assert.equal(missing.status, 'unavailable')
  assert.equal(missing.reported, undefined)
})

test('explicit learning launch reserves one dedicated Session and records its completed batch', async t => {
  const root = await makeTempDir('bizagent-learning-launch-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', workspace, 'Use signup date for the cohort.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-01-01T00:00:00Z' })
  const requester = runtime.agent('requester', workspace, 'Launch a learning review.')
  requester.options = { provider: 'demo-provider', model: 'default-model', maxTokens: 1234 }
  const service = new BizAgentService(store, runtime.ledger, config(root, workspace), runtime.sessionQuery)
  const fake = factory(runtime)
  const runner = new LearningSessionRunner(fake.agents, runtime.sessionQuery, service, config(root, workspace))
  const started = await runner.request(requester, 'weekly-review', 'smoke-model')
  assert.equal(started.launch.status, 'active')
  assert.equal(fake.counts().creates, 1)
  assert.equal(fake.prompts.length, 1)
  assert.deepEqual(fake.optionsUsed[0], { provider: 'demo-provider', model: 'smoke-model', maxTokens: 1234 })
  assert.equal(runtime.ledger.getBinding(started.launch.workerSessionId).homeAddress, 'personal:alice')
  runtime.appendSessionEvent(started.launch.workerSessionId, { seq: 1, type: 'step/start',
    data: { turn: 1, step: 1 } })
  runtime.appendSessionEvent(started.launch.workerSessionId, { seq: 2, type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'usage',
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 11 } } } })
  const observed = await runner.read(requester, started.launch.id)
  assert.equal(observed.usage.status, 'reported')
  assert.equal(observed.usage.reported.inputTokens, 7)
  assert.equal(observed.usage.reported.cacheReadTokens, 11)
  assert.equal(observed.usage.costUsd, null)
  assert.equal((await runner.request(requester, 'weekly-review', 'smoke-model')).launch.id, started.launch.id)
  assert.equal(fake.counts().creates, 1)
  await assert.rejects(() => runner.request(requester, 'overlap'), /unresolved learning Session launch/)

  const worker = fake.live.get(started.launch.workerSessionId)
  const batch = await service.startLearningBatch(worker, 'start-batch')
  assert.deepEqual(batch.materials.map(item => item.sessionId), ['source'])
  await service.settleLearningBatchMaterial(worker, { runId: batch.run.id,
    materialId: batch.materials[0].id, summary: 'Preserve the observed convention as a candidate.',
    candidates: [{ kind: 'knowledge', description: 'Cohort date convention',
      body: 'Use signup date for this cohort.', fromSeq: 1, toSeq: 1 }],
  })
  const finished = await service.finishLearningBatch(worker, {
    runId: batch.run.id, action: 'complete', summary: 'Reviewed one source.',
  })
  assert.equal(finished.run.status, 'completed')
  assert.equal((await runner.read(requester, started.launch.id)).launch.status, 'completed')
  fake.idle.get(started.launch.workerSessionId)()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.counts().disposals, 1)
  await runner.close()
})

test('lost factory response resumes the exact persisted learning Session without a second create', async t => {
  const root = await makeTempDir('bizagent-learning-launch-lost-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  const requester = runtime.agent('requester', workspace, 'Launch a learning review.')
  requester.options = { provider: 'demo-provider', model: 'demo-model' }
  const service = new BizAgentService(store, runtime.ledger, config(root, workspace), runtime.sessionQuery)
  const broken = factory(runtime, { createFailure: 'after' })
  const firstRunner = new LearningSessionRunner(broken.agents, runtime.sessionQuery, service, config(root, workspace))
  await assert.rejects(() => firstRunner.request(requester, 'lost-response'), /uncertain start/)
  const reserved = runtime.ledger.listLearningLaunches('personal:alice')[0]
  assert.equal(reserved.status, 'reserved')
  assert.equal(broken.counts().creates, 1)
  await firstRunner.close()

  const reopenedService = new BizAgentService(store, await runtime.reopenLedger(),
    config(root, workspace), runtime.sessionQuery)
  const healthy = factory(runtime)
  const resumed = new LearningSessionRunner(healthy.agents, runtime.sessionQuery,
    reopenedService, config(root, workspace))
  const recovery = await resumed.recoverBatch()
  assert.deepEqual(recovery.recovered, [reserved.id])
  assert.equal(healthy.counts().creates, 0)
  assert.equal(healthy.counts().resumes, 1)
  assert.equal(healthy.prompts.length, 1)
  assert.deepEqual(healthy.optionsUsed[0], { provider: 'demo-provider', model: 'demo-model' })
  assert.equal((await resumed.read(requester, reserved.id)).launch.status, 'active')
  healthy.idle.get(reserved.workerSessionId)()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await resumed.read(requester, reserved.id)).launch.status, 'needs_review')
  await resumed.abandon(requester, reserved.id, 'The recovered Session stopped without a batch receipt.')
  assert.equal((await resumed.read(requester, reserved.id)).launch.status, 'abandoned')
  await resumed.close()
})

test('an open learning batch resumes once in its persisted worker Session', async t => {
  const root = await makeTempDir('bizagent-learning-resume-batch-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', workspace, 'Preserve the original cohort definition.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-01-01T00:00:00Z' })
  const requester = runtime.agent('requester', workspace, 'Launch learning.')
  const settings = config(root, workspace)
  const service = new BizAgentService(store, runtime.ledger, settings, runtime.sessionQuery)
  const firstFactory = factory(runtime)
  const firstRunner = new LearningSessionRunner(firstFactory.agents, runtime.sessionQuery, service, settings)
  const launch = (await firstRunner.request(requester, 'resume-open-batch')).launch
  const worker = firstFactory.live.get(launch.workerSessionId)
  const started = await service.startLearningBatch(worker, 'open-before-restart')
  assert.equal(started.started, true)
  await firstRunner.close()

  const reopenedService = new BizAgentService(store, await runtime.reopenLedger(), settings, runtime.sessionQuery)
  const secondFactory = factory(runtime)
  const resumed = new LearningSessionRunner(secondFactory.agents, runtime.sessionQuery, reopenedService, settings)
  assert.deepEqual((await resumed.recoverBatch()).recovered, [launch.id])
  assert.equal(secondFactory.counts().creates, 0)
  assert.equal(secondFactory.counts().resumes, 1)
  assert.equal(secondFactory.prompts.length, 1)
  assert.match(secondFactory.prompts[0].content[0].text, /Continue the interrupted learning review/)
  assert.equal(secondFactory.prompts[0].content[0].text.includes(started.run.id), true)
  await resumed.recoverBatch()
  assert.equal(secondFactory.prompts.length, 1)
  await resumed.close()
  const thirdService = new BizAgentService(store, await runtime.reopenLedger(), settings, runtime.sessionQuery)
  const thirdFactory = factory(runtime)
  const thirdRunner = new LearningSessionRunner(thirdFactory.agents, runtime.sessionQuery, thirdService, settings)
  assert.deepEqual((await thirdRunner.recoverBatch()).recovered, [launch.id])
  assert.equal(thirdFactory.counts().creates, 0)
  assert.equal(thirdFactory.counts().resumes, 1)
  assert.equal(thirdFactory.prompts.length, 0, JSON.stringify(thirdFactory.prompts.map(item => item.id)))
  const recoveredWorker = thirdFactory.live.get(launch.workerSessionId)
  await thirdService.settleLearningBatchMaterial(recoveredWorker, { runId: started.run.id,
    materialId: started.materials[0].id, summary: 'No reusable update after checking the original evidence.' })
  await thirdService.finishLearningBatch(recoveredWorker, { runId: started.run.id,
    action: 'complete', summary: 'Finished in the resumed Session.' })
  thirdFactory.idle.get(launch.workerSessionId)()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await thirdRunner.read(requester, launch.id)).launch.status, 'completed')
  await thirdRunner.close()
})

test('factory failure with no Session is held for inspection and never created on recovery', async t => {
  const root = await makeTempDir('bizagent-learning-launch-absent-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  const requester = runtime.agent('requester', workspace, 'Launch a learning review.')
  const service = new BizAgentService(store, runtime.ledger, config(root, workspace), runtime.sessionQuery)
  const broken = factory(runtime, { createFailure: 'before' })
  const firstRunner = new LearningSessionRunner(broken.agents, runtime.sessionQuery, service, config(root, workspace))
  await assert.rejects(() => firstRunner.request(requester, 'absent'), /uncertain start/)
  const reserved = runtime.ledger.listLearningLaunches('personal:alice')[0]
  assert.equal(reserved.status, 'needs_review')
  await firstRunner.close()
  const reopenedService = new BizAgentService(store, await runtime.reopenLedger(),
    config(root, workspace), runtime.sessionQuery)
  const healthy = factory(runtime)
  const runner = new LearningSessionRunner(healthy.agents, runtime.sessionQuery,
    reopenedService, config(root, workspace))
  const recovery = await runner.recoverBatch()
  assert.equal(recovery.recovered.length, 0)
  assert.equal(recovery.needsReview.length, 0)
  assert.equal(healthy.counts().creates, 0)
  const id = reserved.id
  assert.equal((await runner.read(requester, id)).launch.status, 'needs_review')
  await assert.rejects(() => runner.request(requester, 'new-key'), /unresolved learning Session launch/)
  await runner.abandon(requester, id, 'Verified no worker Session exists in the DSH catalog.')
  const fresh = await runner.request(requester, 'new-key')
  assert.equal(fresh.launch.status, 'active')
  assert.equal(healthy.counts().creates, 1)
  await runner.close()
})

test('dedicated learning Session with no older material completes without a stranded batch', async t => {
  const root = await makeTempDir('bizagent-learning-launch-empty-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  const requester = runtime.agent('requester', workspace, 'Launch a learning review.')
  const service = new BizAgentService(store, runtime.ledger, config(root, workspace), runtime.sessionQuery)
  const fake = factory(runtime)
  const runner = new LearningSessionRunner(fake.agents, runtime.sessionQuery, service, config(root, workspace))
  const started = await runner.request(requester, 'empty')
  const worker = fake.live.get(started.launch.workerSessionId)
  const batch = await service.startLearningBatch(worker, 'scan-empty')
  assert.equal(batch.started, false)
  assert.deepEqual(batch.materials, [])
  assert.equal((await runner.read(requester, started.launch.id)).launch.status, 'completed')
  fake.idle.get(started.launch.workerSessionId)()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.counts().disposals, 1)
  await runner.close()
})

test('scheduled learning preflights material, launches once, and enforces the Shanghai daily cap', async t => {
  const root = await makeTempDir('bizagent-learning-schedule-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  let now = Date.parse('2026-09-25T00:00:10Z')
  const schedule = { home: 'personal:alice', cron: '* * * * *',
    model: 'scheduled-model', provider: 'demo-provider', maxTokens: 900, dailyRuns: 1 }
  const settings = { ...config(root, workspace), learningSchedulerEnabled: true,
    learningSchedules: [schedule] }
  const service = new BizAgentService(store, runtime.ledger, settings, runtime.sessionQuery)
  const fake = factory(runtime)
  const runner = new LearningSessionRunner(fake.agents, runtime.sessionQuery, service, settings)
  const scheduler = new LearningScheduler(service, runner, settings, () => now)
  const first = await scheduler.runDue()
  assert.equal(first[0].nextDueAt, Date.parse('2026-09-25T00:01:00Z'))
  assert.equal(fake.counts().creates, 0)
  now = first[0].nextDueAt + 1_000
  const empty = await scheduler.runDue()
  assert.equal(empty[0].lastOutcome, 'empty')
  assert.equal(fake.counts().creates, 0)

  const source = runtime.agent('source', workspace, 'Use signup date for the cohort.')
  await runtime.ledger.putBinding({ sessionId: String(source.id), homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-09-25T00:01:01Z' })
  now = empty[0].nextDueAt + 1_000
  const started = await scheduler.runDue()
  assert.equal(started[0].lastOutcome, 'launched')
  assert.equal(fake.counts().creates, 1)
  assert.deepEqual(fake.optionsUsed[0], { provider: 'demo-provider', model: 'scheduled-model', maxTokens: 900 })
  const launch = runtime.ledger.getLearningLaunch(started[0].lastLaunchId)
  assert.equal(launch.trigger, 'schedule')
  assert.equal(launch.scheduledFor, empty[0].nextDueAt)
  assert.equal((await scheduler.runDue())[0].lastLaunchId, launch.id)
  assert.equal(fake.counts().creates, 1)

  const worker = fake.live.get(launch.workerSessionId)
  const batch = await service.startLearningBatch(worker, 'scheduled-batch')
  assert.equal(batch.started, true)
  await service.settleLearningBatchMaterial(worker, { runId: batch.run.id,
    materialId: batch.materials[0].id, summary: 'No reusable change after review.' })
  await service.finishLearningBatch(worker, { runId: batch.run.id, action: 'complete',
    summary: 'Source reviewed without a new candidate.' })
  fake.idle.get(launch.workerSessionId)()
  await new Promise(resolve => setImmediate(resolve))
  runtime.agent('source-two', workspace, 'A second, later work record.')
  await runtime.ledger.putBinding({ sessionId: 'source-two', homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-09-25T00:02:01Z' })
  now = started[0].nextDueAt + 1_000
  const limited = await scheduler.runDue()
  assert.equal(limited[0].lastOutcome, 'limit')
  assert.equal(fake.counts().creates, 1)
  await runner.close()
})

test('scheduled learning restart does not create a second worker for an unresolved launch', async t => {
  const root = await makeTempDir('bizagent-learning-schedule-restart-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', workspace, 'Original learning evidence.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-09-25T00:00:00Z' })
  let now = Date.parse('2026-09-25T00:00:10Z')
  const settings = { ...config(root, workspace), learningSchedulerEnabled: true,
    learningSchedules: [{ home: 'personal:alice', cron: '* * * * *', model: 'scheduled-model', dailyRuns: 4 }] }
  const service = new BizAgentService(store, runtime.ledger, settings, runtime.sessionQuery)
  const broken = factory(runtime, { createFailure: 'after' })
  const firstRunner = new LearningSessionRunner(broken.agents, runtime.sessionQuery, service, settings)
  const scheduler = new LearningScheduler(service, firstRunner, settings, () => now)
  await scheduler.runDue()
  now = Date.parse('2026-09-25T00:01:01Z')
  const due = await scheduler.runDue()
  assert.equal(due[0].lastOutcome, 'launched')
  assert.match(due[0].lastReason, /uncertain start/)
  assert.equal(broken.counts().creates, 1)
  await firstRunner.close()
  const reopened = await runtime.reopenLedger()
  const reopenedService = new BizAgentService(store, reopened, settings, runtime.sessionQuery)
  const healthy = factory(runtime)
  const resumed = new LearningSessionRunner(healthy.agents, runtime.sessionQuery, reopenedService, settings)
  const recovered = await resumed.recoverBatch()
  assert.deepEqual(recovered.recovered, [due[0].lastLaunchId])
  assert.equal(healthy.counts().creates, 0)
  assert.equal(healthy.counts().resumes, 1)
  const restartedScheduler = new LearningScheduler(reopenedService, resumed, settings, () => now)
  assert.equal((await restartedScheduler.runDue())[0].lastLaunchId, due[0].lastLaunchId)
  now = Date.parse('2026-09-25T00:02:01Z')
  assert.equal((await restartedScheduler.runDue())[0].lastOutcome, 'deferred')
  assert.equal(healthy.counts().creates, 0)
  await resumed.close()
})

test('scheduled learning reconciles a reserved period before its cursor was advanced', async t => {
  const root = await makeTempDir('bizagent-learning-schedule-window-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', workspace, 'Earlier work with learning evidence.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-09-25T00:00:00Z' })
  let now = Date.parse('2026-09-25T00:00:10Z')
  const schedule = { home: 'personal:alice', cron: '* * * * *', model: 'scheduled-model', dailyRuns: 1 }
  const settings = { ...config(root, workspace), learningSchedulerEnabled: true, learningSchedules: [schedule] }
  const service = new BizAgentService(store, runtime.ledger, settings, runtime.sessionQuery)
  const fake = factory(runtime)
  const runner = new LearningSessionRunner(fake.agents, runtime.sessionQuery, service, settings)
  const scheduler = new LearningScheduler(service, runner, settings, () => now)
  const cursor = (await scheduler.runDue())[0]
  now = cursor.nextDueAt + 1_000
  const reserved = await runner.requestScheduled(schedule, cursor.nextDueAt, cursor.scheduleFingerprint, now)
  assert.equal(fake.counts().creates, 1)
  const reconciled = (await scheduler.runDue())[0]
  assert.equal(reconciled.lastOutcome, 'launched')
  assert.equal(reconciled.lastLaunchId, reserved.launch.id)
  assert.match(reconciled.lastReason, /already reserved/)
  assert.equal(fake.counts().creates, 1)
  await runner.close()
})

test('late scheduled learning counts against the Shanghai day when its worker actually starts', async t => {
  const root = await makeTempDir('bizagent-learning-schedule-day-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  runtime.agent('source', workspace, 'Prior work for the late period.')
  await runtime.ledger.putBinding({ sessionId: 'source', homeAddress: 'personal:alice',
    cwd: workspace, boundAt: '2026-09-25T15:58:00Z' })
  let now = Date.parse('2026-09-25T15:58:10Z')
  const settings = { ...config(root, workspace), learningSchedulerEnabled: true,
    learningSchedules: [{ home: 'personal:alice', cron: '* * * * *', model: 'scheduled-model', dailyRuns: 1 }] }
  const service = new BizAgentService(store, runtime.ledger, settings, runtime.sessionQuery)
  const fake = factory(runtime)
  const runner = new LearningSessionRunner(fake.agents, runtime.sessionQuery, service, settings)
  const scheduler = new LearningScheduler(service, runner, settings, () => now)
  await scheduler.runDue()
  now = Date.parse('2026-09-25T16:00:01Z')
  const late = (await scheduler.runDue())[0]
  assert.equal(late.lastOutcome, 'launched')
  const launch = runtime.ledger.getLearningLaunch(late.lastLaunchId)
  assert.equal(launch.scheduledFor, Date.parse('2026-09-25T15:59:00Z'))
  assert.equal(launch.createdAt, new Date(now).toISOString())
  const worker = fake.live.get(launch.workerSessionId)
  const batch = await service.startLearningBatch(worker, 'late-batch')
  await service.settleLearningBatchMaterial(worker, { runId: batch.run.id,
    materialId: batch.materials[0].id, summary: 'Reviewed the older source.' })
  await service.finishLearningBatch(worker, { runId: batch.run.id, action: 'complete',
    summary: 'Completed the late review.' })
  fake.idle.get(launch.workerSessionId)()
  await new Promise(resolve => setImmediate(resolve))
  now = Date.parse('2026-09-25T16:01:01Z')
  assert.equal((await scheduler.runDue())[0].lastOutcome, 'limit')
  assert.equal(fake.counts().creates, 1)
  await runner.close()
})

test('learning schedule configuration requires one mapped Home and a bounded cadence', () => {
  const root = '/tmp/bizagent-learning-config'
  const workspace = `${root}/workspace`
  const base = { homeRoot: root, workspaceHomes: { [workspace]: 'personal:alice' } }
  assert.equal(resolveConfig({ ...base, learningSchedules: [{ home: 'personal:alice',
    cron: '0 3 * * *', model: 'demo' }] }).learningSchedules[0].dailyRuns, 1)
  assert.throws(() => resolveConfig({ ...base, learningSchedules: [{ home: 'personal:bob',
    cron: '0 3 * * *', model: 'demo' }] }), /exactly one mapped Workspace/)
  assert.throws(() => resolveConfig({ ...base, learningSchedules: [{ home: 'personal:alice',
    cron: '* * * * *', model: 'demo', dailyRuns: 5 }] }), /dailyRuns/)
})

test('local learning policy pauses future periods, enforces host limits, and survives ledger reopen', async t => {
  const root = await makeTempDir('bizagent-learning-policy-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = `${root}/workspace`
  await mkdir(workspace)
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  const runtime = await createDemoRuntime()
  let now = Date.parse('2026-09-25T00:00:10Z')
  const settings = { ...config(root, workspace), learningSchedulerEnabled: true,
    learningSchedules: [{ home: 'personal:alice', cron: '0 3 * * *', model: 'host-model', dailyRuns: 2 }] }
  const service = new BizAgentService(store, runtime.ledger, settings, runtime.sessionQuery)
  const fake = factory(runtime)
  const runner = new LearningSessionRunner(fake.agents, runtime.sessionQuery, service, settings)
  const scheduler = new LearningScheduler(service, runner, settings, () => now)
  assert.equal(scheduler.status('personal:alice').schedule.model, 'host-model')
  assert.equal(scheduler.status('personal:alice').policy, undefined)
  const initial = (await scheduler.runDue())[0]
  const paused = await scheduler.configure('personal:alice', {
    expectedRevision: 0, enabled: false, cron: '* * * * *', dailyRuns: 1 })
  assert.equal(paused.policy.revision, 1)
  assert.equal(paused.policy.enabled, false)
  assert.deepEqual(await scheduler.runDue(), [])
  await assert.rejects(() => scheduler.configure('personal:alice', {
    expectedRevision: 0, enabled: true, cron: '* * * * *', dailyRuns: 1 }), /refresh before saving/)
  await assert.rejects(() => scheduler.configure('personal:alice', {
    expectedRevision: 1, enabled: true, cron: '* * * * *', dailyRuns: 3 }), /between 1 and 2/)
  const reopenedService = new BizAgentService(store, await runtime.reopenLedger(), settings, runtime.sessionQuery)
  const reopened = new LearningScheduler(reopenedService, runner, settings, () => now)
  assert.equal(reopened.status('personal:alice').policy.enabled, false)
  const enabled = await reopened.configure('personal:alice', {
    expectedRevision: 1, enabled: true, cron: '* * * * *', dailyRuns: 2 })
  assert.equal(enabled.policy.revision, 2)
  const first = await reopened.runDue()
  assert.equal(first[0].nextDueAt, Date.parse('2026-09-25T00:01:00Z'))
  assert.notEqual(first[0].scheduleFingerprint, initial.scheduleFingerprint)
  now = first[0].nextDueAt + 1_000
  assert.equal((await reopened.runDue())[0].lastOutcome, 'empty')
  await runner.close()
})
