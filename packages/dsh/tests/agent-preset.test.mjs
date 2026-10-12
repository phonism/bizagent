import assert from 'node:assert/strict'
import test from 'node:test'
import { withAgentPreset } from '../lib/agent-preset.js'

function fakeRuntime({ roster, headers = [] } = {}) {
  const calls = []
  const ctx = { get: name => (name === 'agentPresets' ? roster : undefined) }
  const agents = {
    get: id => ({ id }),
    create: async options => { calls.push(['create', options]); return { agent: { id: options.sessionId } } },
    resume: async options => { calls.push(['resume', options]); return { agent: { id: options.resumeSessionId } } },
  }
  const sessions = { listSessions: async () => headers.map(header => ({ header, persisted: true })) }
  return { calls, wrapped: withAgentPreset(ctx, agents, sessions) }
}

function fakeRoster() {
  const mounts = []
  return {
    mounts,
    resolve: async id => ({ id: id ?? 'default-preset' }),
    mount: async (agentCtx, id) => { mounts.push([agentCtx.name, id]) },
  }
}

test('created Sessions join the default preset and record it on the header', async () => {
  const roster = fakeRoster()
  const { calls, wrapped } = fakeRuntime({ roster })
  const order = []
  await wrapped.create({ sessionId: 's1', meta: { cwd: '/w' },
    setup: agentCtx => { order.push(`inner:${agentCtx.name}`) } })
  const [kind, options] = calls[0]
  assert.equal(kind, 'create')
  assert.deepEqual(options.meta, { cwd: '/w', agentPreset: 'default-preset' })
  await options.setup({ name: 'agent-s1' })
  assert.deepEqual(roster.mounts, [['agent-s1', 'default-preset']])
  assert.deepEqual(order, ['inner:agent-s1'])
})

test('resumed Sessions rejoin the preset recorded on their header', async () => {
  const roster = fakeRoster()
  const { calls, wrapped } = fakeRuntime({ roster, headers: [{ id: 's2', cwd: '/w', agentPreset: 'analyst' }] })
  await wrapped.resume({ resumeSessionId: 's2' })
  const [kind, options] = calls[0]
  assert.equal(kind, 'resume')
  await options.setup({ name: 'agent-s2' })
  assert.deepEqual(roster.mounts, [['agent-s2', 'analyst']])
})

test('without a preset roster the factory options pass through unchanged', async () => {
  const { calls, wrapped } = fakeRuntime()
  const setup = () => {}
  await wrapped.create({ sessionId: 's3', meta: { cwd: '/w' }, setup })
  await wrapped.resume({ resumeSessionId: 's3' })
  assert.deepEqual(calls[0][1], { sessionId: 's3', meta: { cwd: '/w' }, setup })
  assert.deepEqual(calls[1][1], { resumeSessionId: 's3' })
})
