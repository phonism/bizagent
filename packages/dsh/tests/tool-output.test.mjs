import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { BizAgentService } from '../lib/service.js'
import { registerTools } from '../lib/tools.js'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'
import { makeTempDir } from './temp-dir.mjs'

test('Project and Work tools return compact summaries instead of full records', async t => {
  const root = await makeTempDir('bizagent-tool-output-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const analystCwd = join(root, 'analyst')
  await mkdir(analystCwd)
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', owner: 'alice' })
  await store.createHome({ address: 'role:analyst', owner: 'alice' })
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: analystCwd, address: 'role:analyst' }, { root, address: 'personal:alice' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery, undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  const lead = runtime.agent('lead', root, 'Lead the Project.')
  const analyst = runtime.agent('analyst', analystCwd, 'Do the Work.')
  const { project } = await service.createProject(lead, { title: 'Q3 GMV check', goal: 'Verify GMV.',
    doneWhen: 'A verified GMV is accepted.', idempotencyKey: 'p1' })
  await service.inviteProjectSeat(lead, { projectId: project.id, homeAddress: 'role:analyst', responsibility: 'Compute GMV.' })
  const criteria = 'Exclude cancelled and refunded orders. '.repeat(40)
  const resultBody = 'Order A1 paid 120.50 counted. '.repeat(100)
  const work = await service.dispatchWork(lead, { toAddress: 'role:analyst', goal: 'Compute GMV',
    acceptanceCriteria: criteria, idempotencyKey: 'w1', projectId: project.id })
  await service.acceptWork(analyst, work.work.id)
  await service.completeWork(analyst, { workId: work.work.id, subject: 'GMV computed', body: resultBody })

  const tools = new Map()
  registerTools({ tools: { register(def) { tools.set(def.name, def); return () => {} } } }, service, {}, {})
  const call = async (name, args) => {
    const def = tools.get(name)
    return def.output.render(args, await def.execute(args, { agent: lead })).map(part => part.text).join('')
  }
  for (const [name, args] of [['bizagent_project_read', { project_id: project.id }],
    ['bizagent_projects', {}], ['bizagent_work', { direction: 'requested' }]]) {
    const text = await call(name, args)
    assert.doesNotMatch(text, /\n/, `${name} output is compact JSON`)
    assert.ok(!text.includes(criteria.trim().slice(0, 200)), `${name} omits acceptance criteria`)
    assert.ok(!text.includes('Order A1 paid 120.50 counted. Order A1'), `${name} omits the result body`)
  }
  const read = JSON.parse(await call('bizagent_project_read', { project_id: project.id }))
  assert.deepEqual(Object.keys(read.work[0]).sort(),
    ['assignee', 'goal', 'id', 'projectId', 'requester', 'resultArtifacts', 'resultMessageId', 'resultSubject', 'status', 'updatedAt'])
  // The full result stays one bizagent_work_read away.
  const full = JSON.parse(await call('bizagent_work_read', { work_id: work.work.id }))
  assert.match(JSON.stringify(full), /Order A1 paid 120\.50 counted\./)
})
