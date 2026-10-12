import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { apply, inject } from '../lib/index.js'
import { HomeStore } from '../lib/home-store.js'
import { LearningLedger } from '../lib/ledger.js'
import { WorkLedger } from '../lib/work-ledger.js'
import { ProjectLedger } from '../lib/project-ledger.js'
import { makeTempDir } from './temp-dir.mjs'

class Table {
  records = new Map()
  get(key) { return this.records.get(key) }
  entries() { return new Map(this.records).entries() }
  keys() { return new Map(this.records).keys() }
  get size() { return this.records.size }
  async put(key, value) { this.records.set(key, structuredClone(value)) }
  async delete(key) { return this.records.delete(key) }
  async update(key, fn) {
    if (!this.records.has(key)) throw new Error('missing-key')
    const value = fn(this.records.get(key))
    this.records.set(key, structuredClone(value))
    return value
  }
}

class Domain {
  tables = new Map()
  table(name) {
    let table = this.tables.get(name)
    if (!table) {
      table = new Table()
      this.tables.set(name, table)
    }
    return table
  }
  async close() {}
}

test('fitness receipts preserve their first recorded version and reject conflicting reuse', async () => {
  const ledger = await LearningLedger.open({ async open() { return new Domain() } })
  const receipt = { id: 'receipt-1', assetId: 'asset-1', ownerAddress: 'personal:alice',
    sessionId: 'session-1', eventSeq: 2, assetRevision: 1,
    assetBodySha256: 'a'.repeat(64), signal: 'retrieved', createdAt: '2026-01-01T00:00:00Z' }
  assert.equal(await ledger.putReceipt(receipt), true)
  assert.equal(await ledger.putReceipt({ ...receipt, createdAt: '2026-01-02T00:00:00Z' }), false)
  assert.deepEqual(ledger.listReceipts('asset-1'), [receipt])
  await assert.rejects(() => ledger.putReceipt({ ...receipt, assetRevision: 2 }), /conflicts/)
  assert.deepEqual(ledger.listReceipts('asset-1'), [receipt])
  await ledger.close()
})

test('DSH plugin entry registers durable context and the complete v0.1 tool surface', async (t) => {
  // DSH/Cordis loads the module namespace so `inject` must sit beside `apply`.
  // A default-exported bare function loses that metadata at runtime.
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'storageDomain', 'sessionQuery', 'agents', 'agentDefaultModel'])

  const root = await makeTempDir('bizagent-plugin-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = `${root}/dsh-profile`
  t.after(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })
  const tools = []
  const sections = []
  const contexts = []
  const listeners = new Map()
  const disposers = []
  const provided = new Map()
  const evidenceSessions = new Map()
  const ctx = {
    storageDomain: { async open() { return new Domain() } },
    sessionQuery: {
      async listSessions() { return [] },
      async readSession(id) {
        const snapshot = evidenceSessions.get(String(id))
        if (!snapshot) throw new Error(`missing evidence Session ${id}`)
        return structuredClone(snapshot)
      },
    },
    agents: {
      get() { return undefined },
      async create() { throw new Error('not configured for this plugin test') },
      async resume() { throw new Error('not configured for this plugin test') },
    },
    agentDefaultModel: { currentSelection() { return { provider: 'test', model: 'test-model' } } },
    tools: { register(tool) { tools.push(tool); return () => {} }, guard() { return () => {} } },
    systemPrompt: {
      section(section) { sections.push(section); return () => {} },
      context(context) { contexts.push(context); return () => {} },
    },
    effect(effect) { const dispose = effect(); disposers.push(dispose); return dispose },
    provide(name, value) { provided.set(name, value); return () => provided.delete(name) },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
  }

  await apply(ctx, {
    homeRoot: root,
    defaultHome: 'personal:alice',
    autoCreateDefaultHome: true,
    identityMaxBytes: 2048,
    indexMaxBytes: 4096,
  })

  assert.equal(tools.length, 79)
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'bizagent_agent_search',
    'bizagent_episode_read',
    'bizagent_episodes',
    'bizagent_evidence_read',
    'bizagent_frame_close',
    'bizagent_frame_open',
    'bizagent_frame_read',
    'bizagent_frame_search',
    'bizagent_frame_status',
    'bizagent_home_status',
    'bizagent_inbox',
    'bizagent_inbox_handle',
    'bizagent_inbox_read',
    'bizagent_inbox_send',
    'bizagent_knowledge_proposals',
    'bizagent_knowledge_propose',
    'bizagent_knowledge_read',
    'bizagent_knowledge_search',
    'bizagent_learning_batch_change_read',
    'bizagent_learning_batch_finish',
    'bizagent_learning_batch_settle',
    'bizagent_learning_batch_start',
    'bizagent_learning_batch_status',
    'bizagent_learning_checkpoint',
    'bizagent_learning_launch',
    'bizagent_learning_launch_abandon',
    'bizagent_learning_launch_read',
    'bizagent_learning_materials',
    'bizagent_learning_review',
    'bizagent_memory_feedback',
    'bizagent_memory_propose',
    'bizagent_memory_read',
    'bizagent_memory_remember',
    'bizagent_memory_search',
    'bizagent_memory_update',
    'bizagent_memory_use_outcomes',
    'bizagent_project_artifact_read',
    'bizagent_project_asset_publish',
    'bizagent_project_asset_read',
    'bizagent_project_create',
    'bizagent_project_delegate',
    'bizagent_project_delivery_feedback',
    'bizagent_project_delivery_feedback_read',
    'bizagent_project_delivery_feedback_resolve',
    'bizagent_project_execution_inspect',
    'bizagent_project_execution_supplement',
    'bizagent_project_invite',
    'bizagent_project_node_dispatch',
    'bizagent_project_node_read',
    'bizagent_project_node_reopen',
    'bizagent_project_node_review',
    'bizagent_project_pause',
    'bizagent_project_plan_amend',
    'bizagent_project_plan_propose',
    'bizagent_project_plan_rebuild',
    'bizagent_project_read',
    'bizagent_project_request_human',
    'bizagent_project_resume',
    'bizagent_project_resume_autonomy',
    'bizagent_project_review',
    'bizagent_project_role_suggest',
    'bizagent_project_seat_release',
    'bizagent_project_submit',
    'bizagent_project_turn_join',
    'bizagent_projects',
    'bizagent_proposals',
    'bizagent_work',
    'bizagent_work_accept',
    'bizagent_work_artifact_read',
    'bizagent_work_cancel',
    'bizagent_work_complete',
    'bizagent_work_dispatch',
    'bizagent_work_output_eval',
    'bizagent_work_read',
    'bizagent_work_start',
    'bizagent_worklog_file_read',
    'bizagent_worklog_read',
    'bizagent_worklog_record',
    'bizagent_worklogs',
  ])
  assert.equal(sections[0].name, 'bizagent:learning-policy')
  assert.equal(contexts.length, 0)
  assert.ok(provided.has('bizagent'))
  assert.equal(typeof provided.get('bizagentProjects')?.list, 'function')

  const injected = []
  const steered = []
  const agent = {
    id: 'plugin-session',
    inject(message) { injected.push(message) },
    steer(message) { steered.push(message) },
    session: {
      header: { id: 'plugin-session', cwd: `${root}/workspace` },
      events: [
        { seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
        {
          seq: 1,
          time: 2,
          type: 'user/message',
          surfaceOp: 'append',
          data: {
            id: 'user-1',
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            source: { kind: 'user' },
          },
        },
      ],
    },
  }
  listeners.get('agent/session-start')({ agent, source: 'startup' })
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /BizAgent Home Snapshot v1/)
  assert.match(injected[0].content[0].text, /Home: personal:alice/)
  assert.match(injected[0].content[0].text, /Revision: 1/)

  agent.session.events.push({
    seq: 2,
    time: 3,
    type: 'user/message',
    surfaceOp: 'append',
    data: injected[0],
  })
  listeners.get('agent/session-start')({ agent, source: 'resume' })
  assert.equal(injected.length, 1)

  const service = provided.get('bizagent')
  await service.store.createHome({ address: 'role:reviewer' })
  await service.ledger.putBinding({ sessionId: 'role-sender', homeAddress: 'role:reviewer', boundAt: '2026-01-01T00:00:00Z' })
  const roleSender = {
    id: 'role-sender',
    session: { header: { id: 'role-sender', cwd: root }, events: [] },
  }
  const pending = await service.sendInboxMessage(roleSender, 'notice-call', {
    to: ['personal:alice'], subject: 'Review this note', body: 'Please inspect the source.',
  })
  listeners.get('agent/session-start')({ agent, source: 'resume' })
  assert.equal(injected.length, 2)
  assert.match(injected[1].content[0].text, /BizAgent Inbox Digest v1/)
  assert.match(injected[1].content[0].text, new RegExp(pending.message.id))
  assert.doesNotMatch(injected[1].content[0].text, /Please inspect the source/)
  agent.session.events.push({
    seq: 3, time: 4, type: 'user/message', surfaceOp: 'append', data: injected[1],
  })
  listeners.get('agent/session-start')({ agent, source: 'resume' })
  assert.equal(injected.length, 2)

  for (let index = 0; index < 8; index++) {
    await service.sendInboxMessage(roleSender, `converge-${index}`, {
      to: ['personal:alice'], subject: `Review follow-up ${index}`, body: 'A further finding.',
      replyTo: pending.message.id,
    })
  }
  listeners.get('agent/session-start')({ agent, source: 'resume' })
  assert.equal(injected.length, 3)
  assert.match(injected[2].content[0].text,
    new RegExp(`Topic ${pending.message.id} is at 9/12 ordinary messages`))
  assert.match(injected[2].content[0].text, /kind=conclusion with context_refs/)

  const statusTool = tools.find(tool => tool.name === 'bizagent_home_status')
  const status = await statusTool.execute({}, {
    callId: 'status-call',
    rootCallId: 'status-call',
    name: statusTool.name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
    token: {},
    deferContext() {},
    concludeTurn() {},
  })
  assert.equal(status.binding.homeAddress, 'personal:alice')

  const learningAgent = {
    id: 'learning-session',
    inject() {},
    steer(message) { steered.push(message) },
    session: {
      header: { id: 'learning-session', cwd: `${root}/workspace` },
      events: [
        { seq: 0, time: 10, type: 'turn/start', data: { turn: 1 } },
        {
          seq: 1,
          time: 11,
          type: 'user/message',
          surfaceOp: 'append',
          data: {
            id: 'correction-1',
            role: 'user',
            content: [{ type: 'text', text: '记住：以后修改配置之前必须先创建备份。' }],
            source: { kind: 'user' },
          },
        },
      ],
    },
  }
  evidenceSessions.set('learning-session', {
    session: learningAgent.session.header,
    events: learningAgent.session.events,
  })
  await listeners.get('agent/turn-stopping')({
    agent: learningAgent,
    turn: 1,
    signal: new AbortController().signal,
  })
  assert.equal(steered.length, 1)
  const checkpointText = steered[0].content[0].text
  const checkpointId = checkpointText.match(/checkpoint_id: (\S+)/)?.[1]
  assert.ok(checkpointId)

  const checkpointTool = tools.find(tool => tool.name === 'bizagent_learning_checkpoint')
  let concluded = false
  const learned = await checkpointTool.execute({
    checkpoint_id: checkpointId,
    action: 'remember',
    description: 'Back up configuration files before editing them.',
    body: 'Before modifying any configuration file, create a recoverable backup of the original.',
    tags: ['configuration', 'safety'],
  }, {
    callId: 'checkpoint-call',
    rootCallId: 'checkpoint-call',
    name: checkpointTool.name,
    arguments: {},
    agent: learningAgent,
    signal: new AbortController().signal,
    token: {},
    deferContext() {},
    concludeTurn() { concluded = true },
  })
  assert.equal(concluded, true)
  assert.equal(learned.checkpoint.status, 'remembered')

  const evidenceTool = tools.find(tool => tool.name === 'bizagent_evidence_read')
  const evidence = await evidenceTool.execute({ asset_id: learned.asset.id }, {
    callId: 'evidence-call',
    rootCallId: 'evidence-call',
    name: evidenceTool.name,
    arguments: {},
    agent: learningAgent,
    signal: new AbortController().signal,
    token: {},
    deferContext() {},
    concludeTurn() {},
  })
  assert.equal(evidence.events[0].text, '记住：以后修改配置之前必须先创建备份。')

  const toolContext = {
    callId: 'method-draft', rootCallId: 'method-draft', agent: learningAgent,
    signal: new AbortController().signal, token: {}, deferContext() {}, concludeTurn() {},
  }
  const rememberTool = tools.find(tool => tool.name === 'bizagent_memory_remember')
  const draft = await rememberTool.execute({
    kind: 'method', status: 'candidate', description: 'Verify recovery procedures.',
    body: 'Restore the backup in an isolated environment and compare the result.',
  }, toolContext)
  assert.equal(draft.asset.kind, 'method')
  assert.equal(draft.asset.status, 'candidate')
  const updateTool = tools.find(tool => tool.name === 'bizagent_memory_update')
  const published = await updateTool.execute({
    asset_id: draft.asset.id, action: 'publish', expected_revision: draft.asset.revision,
  }, { ...toolContext, callId: 'publish-method' })
  assert.equal(published.asset.status, 'active')
  assert.equal(published.asset.revision, 2)

  for (const dispose of disposers.reverse()) await dispose()
})

test('plugin startup repairs a Project paused before its linked Work was cancelled', async t => {
  const root = await makeTempDir('bizagent-plugin-paused-recovery-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = `${root}/dsh-profile`
  t.after(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'role:analyst' })
  const domains = new Map()
  const facility = { async open(definition) {
    if (!domains.has(definition.name)) domains.set(definition.name, new Domain())
    return domains.get(definition.name)
  } }
  const learning = await LearningLedger.open(facility)
  const work = await WorkLedger.open(facility)
  const projects = await ProjectLedger.open(facility)
  const now = '2026-09-26T00:00:00.000Z'
  await learning.putBinding({ sessionId: 'lead-session', homeAddress: 'personal:alice', boundAt: now })
  await projects.put({ schemaVersion: 1, id: 'paused-project', idempotencyKey: 'paused-project',
    lead: 'personal:alice', createdBySessionId: 'lead-session', title: 'Interrupted pause',
    goal: 'Review the report.', doneWhen: 'The report is reviewed.',
    status: 'open', revision: 2, claims: [], reviews: [],
    intervention: { epoch: 0, paused: true, history: [{ action: 'pause',
      reason: 'Change the plan.', bySessionId: 'lead-session', at: now, epoch: 0 }] },
    createdAt: now, updatedAt: now })
  await work.put({ schemaVersion: 1, id: 'pending-work', idempotencyKey: 'pending-work',
    requester: 'personal:alice', assignee: 'role:analyst', returnToSessionId: 'lead-session',
    goal: 'Prepare a report', acceptanceCriteria: 'Return a report.', projectId: 'paused-project',
    status: 'open', requestMessageId: 'request-pending-work', createdAt: now, updatedAt: now })
  const disposers = []
  const provided = new Map()
  const ctx = {
    storageDomain: facility,
    sessionQuery: {
      async listSessions() { return [] },
      async readSession(id) { return { session: { id: String(id) }, events: [] } },
    },
    agents: { get() { return undefined }, async create() { throw new Error('unexpected create') },
      async resume() { throw new Error('unexpected resume') } },
    tools: { register() { return () => {} }, guard() { return () => {} } },
    systemPrompt: { section() {}, context() {} },
    effect(effect) { const dispose = effect(); disposers.push(dispose); return dispose },
    provide(name, value) { provided.set(name, value); return () => provided.delete(name) },
    on() { return () => {} },
  }
  try {
    await apply(ctx, { homeRoot: root, defaultHome: 'personal:alice',
      autoCreateDefaultHome: false, identityMaxBytes: 2048, indexMaxBytes: 4096 })
    assert.equal(work.get('pending-work').status, 'cancelled')
    assert.equal(work.get('pending-work').cancelledByProjectSessionId, 'lead-session')
    assert.equal(work.get('pending-work').cancelReason, 'Project paused: Change the plan.')
    assert.equal(learning.getInboxDelivery(work.get('pending-work').cancelMessageId,
      'role:analyst').status, 'delivered')
    assert.equal(provided.get('bizagent').projectExecutionPaused('paused-project'), true)
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
})
