import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/local-human-host.js'

test('local DSH human host accepts a private Bearer token and checks the current Home owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bizagent-human-host-'))
  const tokenFile = join(root, 'human.token')
  const token = randomBytes(32).toString('hex')
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
  const oldId = process.env.BIZAGENT_LOCAL_HUMAN_ID
  const oldFile = process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE
  const oldPlatformAdmin = process.env.BIZAGENT_LOCAL_PLATFORM_ADMIN
  process.env.BIZAGENT_LOCAL_HUMAN_ID = 'alice'
  process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE = tokenFile
  t.after(async () => {
    if (oldId === undefined) delete process.env.BIZAGENT_LOCAL_HUMAN_ID
    else process.env.BIZAGENT_LOCAL_HUMAN_ID = oldId
    if (oldFile === undefined) delete process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE
    else process.env.BIZAGENT_LOCAL_HUMAN_TOKEN_FILE = oldFile
    if (oldPlatformAdmin === undefined) delete process.env.BIZAGENT_LOCAL_PLATFORM_ADMIN
    else process.env.BIZAGENT_LOCAL_PLATFORM_ADMIN = oldPlatformAdmin
    await rm(root, { recursive: true, force: true })
  })
  const routes = new Map()
  const sharedProposals = new Map([
    ['line-proposal', { id: 'line-proposal', target: { scope: 'line', line: 'northstar' }, status: 'pending' }],
    ['common-proposal', { id: 'common-proposal', target: { scope: 'common' }, status: 'pending' }],
    ['other-line-proposal', { id: 'other-line-proposal', target: { scope: 'line', line: 'other' }, status: 'pending' }],
  ])
  const service = {
    store: { getHome: address => ({ owner: ['personal:alice', 'line:northstar'].includes(address) ? 'alice' : 'bob' }),
      homeWorkspacePath: address => `/tmp/home/${address}` },
    ledger: { listSharedKnowledgeProposals: () => [...sharedProposals.values()],
      getSharedKnowledgeProposal: id => sharedProposals.get(id) },
    async decideSharedKnowledgeAsHuman(input) {
      return { proposal: { ...sharedProposals.get(input.proposalId), status: 'accepted' },
        reviewerId: input.reviewerId, authorityRef: input.authorityRef }
    },
    projectLedger: { get: id => ({ id, lead: id === 'alice-project' ? 'personal:alice' : 'personal:bob' }) },
    async reviewProjectAsHuman(principal, input, authorize) {
      const project = { id: input.projectId, lead: input.projectId === 'alice-project'
        ? 'personal:alice' : 'personal:bob', status: 'awaiting_acceptance',
        revision: input.expectedRevision, currentClaimId: input.claimId }
      if (!await authorize(principal, project)) throw new Error('Project reviewer is not authorized for the current Project')
      return { project: { ...project, status: 'accepted' },
        review: { claimId: input.claimId, decision: input.decision,
          reviewedByPrincipal: principal } }
    },
  }
  let cleanup
  await apply({ bizagent: service,
    bizagentAgentSessions: {
      openPrincipal: async homeAddress => ({ kind: 'principal', homeAddress,
        sessionId: 'principal-session-1', logicalAddress: homeAddress }),
      openProjectMain: async projectId => ({ kind: 'project-main', projectId,
        homeAddress: 'personal:alice', sessionId: 'project-main-session-1',
        logicalAddress: `project:${projectId}` }),
    },
    webServer: { host: '127.0.0.1', register: route => { routes.set(route.path, route.handler)
      return () => routes.delete(route.path) } },
    effect: create => { cleanup = create() },
  })
  assert.equal(routes.size, 6)
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (handler) void handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    cleanup()
    assert.equal(routes.size, 0)
  })
  const url = `http://127.0.0.1:${server.address().port}/api/bizagent/project-review`
  const statusUrl = `http://127.0.0.1:${server.address().port}/api/bizagent/local-human/status`
  assert.equal((await fetch(statusUrl)).status, 401)
  const status = await fetch(statusUrl, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(status.status, 200)
  assert.deepEqual(await status.json(), { userId: 'alice' })
  const sessionUrl = `http://127.0.0.1:${server.address().port}/api/bizagent/agent-session`
  const openSession = (body, credential) => fetch(sessionUrl, { method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body) })
  assert.equal((await openSession({ homeAddress: 'personal:alice' })).status, 401)
  assert.equal((await openSession({ homeAddress: 'personal:bob' }, token)).status, 403)
  const principal = await openSession({ homeAddress: 'personal:alice' }, token)
  assert.equal(principal.status, 200)
  assert.equal((await principal.json()).sessionId, 'principal-session-1')
  assert.equal((await openSession({ projectId: 'bob-project' }, token)).status, 403)
  assert.equal((await openSession({ projectId: 'alice-project' }, token)).status, 200)
  const review = projectId => JSON.stringify({ projectId, claimId: 'claim-1',
    expectedRevision: 2, decision: 'accept', reason: 'Checked by the owner.' })
  const send = (body, credential) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body })
  assert.equal((await send(review('alice-project'))).status, 401)
  assert.equal((await send(review('alice-project'), 'x'.repeat(64))).status, 401)
  const allowed = await send(review('alice-project'), token)
  assert.equal(allowed.status, 200)
  assert.equal((await allowed.json()).review.reviewedByPrincipal, 'alice')
  assert.equal((await send(review('bob-project'), token)).status, 403)
  const sharedUrl = `http://127.0.0.1:${server.address().port}/api/bizagent/shared-knowledge/decision`
  const sharedHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const sharedDecision = proposalId => JSON.stringify({ proposalId, action: 'accept', decision: 'Approved.' })
  assert.equal((await fetch(sharedUrl)).status, 401)
  const lineList = await fetch(sharedUrl, { headers: sharedHeaders })
  assert.equal(lineList.status, 200)
  assert.deepEqual((await lineList.json()).proposals.map(item => item.proposal.id), ['line-proposal'])
  assert.equal((await fetch(sharedUrl, { method: 'POST', headers: sharedHeaders,
    body: sharedDecision('other-line-proposal') })).status, 403)
  assert.equal((await fetch(sharedUrl, { method: 'POST', headers: sharedHeaders,
    body: sharedDecision('common-proposal') })).status, 403)
  const lineDecision = await fetch(sharedUrl, { method: 'POST', headers: sharedHeaders,
    body: sharedDecision('line-proposal') })
  assert.equal(lineDecision.status, 200)
  assert.match((await lineDecision.json()).authorityRef, /line:line-proposal:accept/)
  process.env.BIZAGENT_LOCAL_PLATFORM_ADMIN = '1'
  const commonDecision = await fetch(sharedUrl, { method: 'POST', headers: sharedHeaders,
    body: sharedDecision('common-proposal') })
  assert.equal(commonDecision.status, 200)
  assert.match((await commonDecision.json()).authorityRef, /common:common-proposal:accept/)
  await chmod(tokenFile, 0o644)
  await assert.rejects(() => apply({ bizagent: service, webServer: { host: '127.0.0.1' }, effect() {} }),
    /private regular file/)
  await chmod(tokenFile, 0o600)
  await assert.rejects(() => apply({ bizagent: service, webServer: { host: '0.0.0.0' }, effect() {} }),
    /bind 127\.0\.0\.1/)
})
