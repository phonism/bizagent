import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentSessionCoordinator } from '../lib/agent-session-coordinator.js'
import { stableId } from '../lib/domain.js'
import { principalSessionId, projectMainSessionId } from '../lib/agent-session-address.js'

test('one Principal and a separate Project Main reuse the lead Home after restart', async () => {
  const projectId = stableId('project', 'personal:alice:session-test')
  const workspace = '/tmp/agent-session-test/personal-alice'
  const records = new Map()
  const live = new Map()
  const bindings = new Map()
  const starts = []
  const service = {
    store: { getHome: () => ({ status: 'active' }), homeWorkspacePath: () => workspace },
    projectLedger: { get: id => id === projectId
      ? { id, lead: 'personal:alice', driver: `project:${id}` } : undefined },
    ledger: { getBinding: id => bindings.get(id),
      putBinding: async binding => { bindings.set(binding.sessionId, binding) } },
  }
  const agents = {
    get: id => live.get(id),
    create: async ({ sessionId, meta, agentOptions }) => {
      starts.push({ kind: 'create', sessionId, cwd: meta.cwd, agentOptions })
      records.set(sessionId, { header: { id: sessionId, cwd: meta.cwd }, persisted: true })
      const agent = { id: sessionId, session: { snapshotEvents() { return this.events }, header: { id: sessionId, cwd: meta.cwd } } }
      live.set(sessionId, agent)
      return { agent, dispose: async () => { live.delete(sessionId) } }
    },
    resume: async ({ resumeSessionId, agentOptions }) => {
      starts.push({ kind: 'resume', sessionId: resumeSessionId, cwd: workspace, agentOptions })
      const agent = { id: resumeSessionId,
        session: { snapshotEvents() { return this.events }, header: records.get(resumeSessionId).header } }
      live.set(resumeSessionId, agent)
      return { agent, dispose: async () => { live.delete(resumeSessionId) } }
    },
  }
  const sessions = { listSessions: async () => [...records.values()] }
  const creationModel = () => ({ provider: 'local-smoke', model: 'smoke-model' })
  const first = new AgentSessionCoordinator(agents, sessions, service, creationModel)
  const [one, replay] = await Promise.all([
    first.openPrincipal('personal:alice'), first.openPrincipal('personal:alice'),
  ])
  assert.deepEqual(one, replay)
  assert.equal(one.sessionId, principalSessionId('personal:alice'))
  const main = await first.openProjectMain(projectId)
  assert.equal(main.sessionId, projectMainSessionId(projectId))
  assert.equal(main.homeAddress, one.homeAddress)
  assert.notEqual(main.sessionId, one.sessionId)
  assert.deepEqual(starts.map(item => item.kind), ['create', 'create'])
  assert.ok(starts.every(item => item.agentOptions?.model === 'smoke-model'))
  assert.ok(starts.every(item => item.cwd === workspace))
  assert.ok([...bindings.values()].every(binding => binding.homeAddress === 'personal:alice'
    && binding.cwd === workspace))
  await first.close()

  const restored = new AgentSessionCoordinator(agents, sessions, service, creationModel)
  assert.equal((await restored.openPrincipal('personal:alice')).sessionId, one.sessionId)
  assert.equal((await restored.openProjectMain(projectId)).sessionId, main.sessionId)
  assert.deepEqual(starts.map(item => item.kind), ['create', 'create', 'resume', 'resume'])
  assert.ok(starts.slice(2).every(item => item.agentOptions === undefined))
  await restored.close()
})
