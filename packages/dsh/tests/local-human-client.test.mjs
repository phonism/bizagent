import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/client/api.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { BizAgentUiHttpPort } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('local human token stays in memory and is sent only to protected human routes', async t => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ path: String(input), authorization: new Headers(init.headers).get('Authorization') })
    const path = String(input)
    if (path.endsWith('/local-human/status')) {
      const authorized = requests.at(-1).authorization === `Bearer ${'a'.repeat(64)}`
      return new Response(JSON.stringify(authorized ? { userId: 'alice' }
        : { error: 'authentication-required' }), { status: authorized ? 200 : 401,
        headers: { 'Content-Type': 'application/json' } })
    }
    if (path.includes('artifactPath=')) return new Response('verified bytes', { status: 200 })
    return Response.json({ ok: true })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const port = new BizAgentUiHttpPort()
  assert.deepEqual(await port.localHumanStatus(), { available: true, authenticated: false })
  const token = 'a'.repeat(64)
  assert.equal(await port.setLocalHumanToken(token), true)
  assert.deepEqual(await port.localHumanStatus(), { available: true, authenticated: true })
  await port.humanInbox('incoming', true)
  await port.projectReviewAccess('project-1')
  await port.proposalReviewActions('personal:alice', 'proposal-1')
  await port.sharedKnowledgeReviews()
  await port.decideSharedKnowledge({ proposalId: 'proposal-shared', action: 'accept', decision: 'Verified.' })
  await port.openAgentSession({ homeAddress: 'personal:alice' })
  const artifact = await port.downloadProjectReviewArtifact({ projectId: 'project-1',
    claimId: 'claim-1', artifactPath: 'proof.txt' })
  assert.equal(await artifact.text(), 'verified bytes')
  await port.overview()
  assert.deepEqual(requests.map(item => item.authorization), [
    null, `Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`,
    `Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`,
    `Bearer ${token}`, `Bearer ${token}`, null,
  ])
  await port.setLocalHumanToken(undefined)
  await port.humanInbox('incoming', true)
  assert.equal(requests.at(-1).authorization, null)
  assert.equal(await port.setLocalHumanToken('wrong'), false)
  await port.humanInbox('incoming', true)
  assert.equal(requests.at(-1).authorization, null)
})
