import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { WorkRunner } from '../lib/work-runner.js'
import { registerTools } from '../lib/tools.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('Project supplement stays with the original Work Session and survives retry', async t => {
  const root = await makeTempDir('bizagent-project-supplement-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const reviewerCwd = `${root}/reviewer`
  await mkdir(reviewerCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:reviewer' })
  const config = { homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: reviewerCwd, address: 'role:reviewer' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 } }
  const service = new BizAgentService(store, runtime.ledger, config, runtime.sessionQuery,
    undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('supplement-lead', root, 'Lead the Project.')
  const workerAgent = runtime.agent('supplement-worker', reviewerCwd, 'Do the formal Work.')
  const project = (await service.createProject(lead, { title: 'Definitions',
    goal: 'Check terms.', doneWhen: 'Terms verified.', idempotencyKey: 'definitions' })).project
  const work = (await service.dispatchWork(lead, { toAddress: 'role:reviewer',
    goal: 'Review terms', acceptanceCriteria: 'List each checked term.',
    idempotencyKey: 'review-terms', projectId: project.id })).work
  const input = { projectId: project.id, workId: work.id, expectedEpoch: 0,
    requestId: 'clarification-1', message: 'The source glossary is under docs/glossary.md.' }
  const retained = await service.supplementProjectWork(lead, input)
  assert.equal(retained.workerSessionId, undefined)
  assert.equal(runtime.workLedger.get(work.id).supplements.length, 1)
  assert.equal((await service.supplementProjectWork(lead, input)).idempotentReplay, true)
  await assert.rejects(() => service.supplementProjectWork(lead, { ...input,
    message: 'Different contents.' }), /conflicts/)
  await assert.rejects(() => service.supplementProjectWork(workerAgent, { ...input,
    requestId: 'other' }), /only the Project lead/)

  const live = new Map()
  const queued = []
  const worker = { id: workerAgent.id, status: 'running', session: workerAgent.session,
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      queued.push(message)
      this.inbox.nextTurn.push(message)
      this.session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    },
    async whenIdle() {},
  }
  live.set(String(worker.id), worker)
  const agents = { get(id) { return live.get(String(id)) },
    async create() { throw new Error('supplement must not create another worker') },
    async resume() { throw new Error('live worker must not be resumed') } }
  const runner = new WorkRunner(agents, runtime.sessionQuery, service, config)
  assert.equal(await runner.deliverSupplement(work.id, retained.supplement.id), 'pending')
  await service.acceptWork(workerAgent, work.id)
  assert.deepEqual((await runner.recoverSupplements()).recovered, [retained.supplement.id])
  assert.equal(queued.length, 1)
  assert.match(queued[0].content[0].text, /docs\/glossary\.md/)
  assert.equal((await runner.recoverSupplements()).recovered.length, 0)
  assert.equal(await runner.deliverSupplement(work.id, retained.supplement.id), 'already-queued')
  assert.equal(runtime.workLedger.get(work.id).workerSessionId, String(worker.id))
  assert.equal(queued.length, 1)
  const tools = new Map()
  registerTools({ tools: { register(tool) { tools.set(tool.name, tool) } },
    agents, sessionQuery: runtime.sessionQuery }, service, runner, {}, {}, {})
  const inspected = await tools.get('bizagent_project_execution_inspect').execute(
    { project_id: project.id }, { agent: lead })
  assert.equal(inspected.projectId, project.id)
  assert.equal(inspected.executionEpoch, 0)
  assert.equal(inspected.paused, false)
  assert.equal(inspected.excludedCoordinatorSessionId, String(lead.id))
  assert.deepEqual(inspected.work.map(item => item.id), [work.id])
  assert.equal(inspected.runtime.status, 'busy')
  assert.deepEqual(inspected.runtime.sessionIds, [String(worker.id)])
  const replayed = await tools.get('bizagent_project_execution_supplement').execute({
    project_id: project.id, work_id: work.id, expected_epoch: 0,
    request_id: input.requestId, message: input.message,
  }, { agent: lead })
  assert.equal(replayed.delivery, 'already-queued')
  assert.equal(queued.length, 1)

  const second = await service.supplementProjectWork(lead, { ...input,
    requestId: 'clarification-2', message: 'Also check the metric glossary.' })
  const restartedLive = new Map()
  let resumed = 0
  const restartedAgents = { get(id) { return restartedLive.get(String(id)) },
    async create() { throw new Error('recovery must retain the original worker') },
    async resume({ resumeSessionId }) {
      resumed++
      assert.equal(String(resumeSessionId), String(worker.id))
      restartedLive.set(String(worker.id), worker)
      return { agent: worker, async dispose() { restartedLive.delete(String(worker.id)) } }
    } }
  const sessions = { listSessions: () => runtime.sessionQuery.listSessions(),
    async readSession(id) {
      const snapshot = await runtime.sessionQuery.readSession(id)
      return { ...snapshot, events: worker.session.events }
    } }
  const restartedRunner = new WorkRunner(restartedAgents, sessions, service, config)
  assert.deepEqual((await restartedRunner.recoverSupplements()).recovered, [second.supplement.id])
  assert.equal(resumed, 1)
  assert.equal(queued.length, 2)
  assert.deepEqual((await restartedRunner.recoverSupplements()).recovered, [])
  assert.equal(queued.length, 2)

  await assert.rejects(() => service.supplementProjectWork(lead, { ...input,
    expectedEpoch: 1, requestId: 'wrong-epoch' }), /execution changed/)
  const paused = await service.pauseProject(lead, { projectId: project.id,
    expectedProjectRevision: project.revision, reason: 'Recheck the plan.' })
  assert.equal(paused.project.intervention.paused, true)
  await assert.rejects(() => service.supplementProjectWork(lead, { ...input,
    requestId: 'while-paused' }), /execution changed or is paused/)
  assert.equal(await runner.deliverSupplement(work.id, retained.supplement.id), 'pending')
  await restartedRunner.close()
  await runner.close()
  await service.close()
})
