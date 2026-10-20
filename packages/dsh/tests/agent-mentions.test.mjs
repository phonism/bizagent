import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const built = await build({
  entryPoints: [new URL('../src/client/agent-mentions.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', write: false,
})
const { createAgentMentionSource } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

test('@Agent input source filters Personal Homes and revalidates the selected Home at submit', async () => {
  const calls = []
  let visible = true
  const source = createAgentMentionSource({
    async agentDirectory(sessionId, query) {
      calls.push({ sessionId, query })
      return { count: 3, homes: [
        { address: 'personal:alice', type: 'personal', displayName: 'Alice' },
        { address: 'role:analyst', type: 'role', displayName: 'Analyst' },
        { address: 'capability:research', type: 'capability', displayName: 'Analyst' },
      ] }
    },
    async resolveAgentTarget(sessionId, target) {
      calls.push({ sessionId, target })
      if (!visible) throw new Error('Home not found or inaccessible')
      return { address: target, type: 'role', displayName: 'Analyst' }
    },
  })
  const candidates = await source.candidates({ sessionId: 'session-1' }, {
    query: 'Analyst', position: 'inline', signal: new AbortController().signal,
  })
  assert.deepEqual(candidates.map(candidate => candidate.name), ['role:analyst', 'capability:research'])
  assert.deepEqual(calls[0], { sessionId: 'session-1', query: 'Analyst' })
  const pick = source.onPick({ candidate: candidates[0], session: { sessionId: 'session-1' },
    position: 'inline', via: 'menu', span: { start: 0, end: 2, draftRev: 1 } })
  assert.equal(pick.insert.source, 'bizagent-agent')
  assert.equal(source.codec.clipboardText(pick.insert.ref), '@role:analyst')
  const serialized = await source.codec.serialize(pick.insert.ref, new AbortController().signal)
  assert.equal(serialized, '@role:analyst\n[BIZAGENT_FRAME_REQUEST:role:analyst]')
  assert.deepEqual(calls[1], { sessionId: 'session-1', target: 'role:analyst' })
  visible = false
  await assert.rejects(() => source.codec.serialize(pick.insert.ref, new AbortController().signal),
    /not found or inaccessible/)
})
