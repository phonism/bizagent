import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { test } from 'node:test'
import { apply, inject } from '../lib/index.js'
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

test('DSH plugin entry registers durable context and the complete v0.1 tool surface', async (t) => {
  // DSH/Cordis loads the module namespace so `inject` must sit beside `apply`.
  // A default-exported bare function loses that metadata at runtime.
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'storageDomain', 'sessionQuery'])

  const root = await makeTempDir('bizagent-plugin-')
  t.after(() => rm(root, { recursive: true, force: true }))
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
      async readSession(id) {
        const snapshot = evidenceSessions.get(String(id))
        if (!snapshot) throw new Error(`missing evidence Session ${id}`)
        return structuredClone(snapshot)
      },
    },
    tools: { register(tool) { tools.push(tool); return () => {} } },
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

  assert.equal(tools.length, 12)
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'bizagent_evidence_read',
    'bizagent_home_status',
    'bizagent_learning_checkpoint',
    'bizagent_memory_feedback',
    'bizagent_memory_propose',
    'bizagent_memory_read',
    'bizagent_memory_remember',
    'bizagent_memory_search',
    'bizagent_memory_update',
    'bizagent_proposal_accept',
    'bizagent_proposal_reject',
    'bizagent_proposals',
  ])
  assert.equal(sections[0].name, 'bizagent:learning-policy')
  assert.equal(contexts.length, 0)
  assert.ok(provided.has('bizagent'))

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

  for (const dispose of disposers.reverse()) await dispose()
})
