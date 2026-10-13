import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
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
    projectReviewCalls: 0,
    async reviewProjectAsHuman(principal, input, authorize) {
      this.projectReviewCalls += 1
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
  const attached = []
  const workspaceRegistry = { async create(path) {
    return { async attachSession(sessionId) { attached.push([path, sessionId]) } }
  } }
  await apply({ bizagent: service, get: name => name === 'workspaceRegistry' ? workspaceRegistry : undefined,
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
  const origin = `http://127.0.0.1:${server.address().port}`
  const url = `${origin}/api/bizagent/project-review`
  const statusUrl = `http://127.0.0.1:${server.address().port}/api/bizagent/local-human/status`
  assert.equal((await fetch(statusUrl)).status, 401)
  const status = await fetch(statusUrl, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(status.status, 200)
  assert.deepEqual(await status.json(), { userId: 'alice' })
  const sessionUrl = `http://127.0.0.1:${server.address().port}/api/bizagent/agent-session`
  const openSession = (body, credential) => fetch(sessionUrl, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin,
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body) })
  assert.equal((await openSession({ homeAddress: 'personal:alice' })).status, 401)
  assert.equal((await openSession({ homeAddress: 'personal:bob' }, token)).status, 403)
  const principal = await openSession({ homeAddress: 'personal:alice' }, token)
  assert.equal(principal.status, 200)
  assert.equal((await principal.json()).sessionId, 'principal-session-1')
  // The opened Session is attached to its Home Workspace so DSH Web lists it.
  assert.deepEqual(attached, [['/tmp/home/personal:alice', 'principal-session-1']])
  assert.equal((await openSession({ projectId: 'bob-project' }, token)).status, 403)
  assert.equal((await openSession({ projectId: 'alice-project' }, token)).status, 200)
  const review = projectId => JSON.stringify({ projectId, claimId: 'claim-1',
    expectedRevision: 2, decision: 'accept', reason: 'Checked by the owner.' })
  const send = (body, credential) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin,
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body })
  assert.equal((await send(review('alice-project'))).status, 401)
  assert.equal((await send(review('alice-project'), 'x'.repeat(64))).status, 401)
  const allowed = await send(review('alice-project'), token)
  assert.equal(allowed.status, 200)
  assert.equal((await allowed.json()).review.reviewedByPrincipal, 'alice')
  assert.equal((await send(review('bob-project'), token)).status, 403)
  const sharedUrl = `http://127.0.0.1:${server.address().port}/api/bizagent/shared-knowledge/decision`
  const sharedHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: origin }
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

  // Every plugin route keeps the loopback Host / same-origin fence even with a valid Bearer token.
  const port = server.address().port
  const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
  const rebinding = `rebind.attacker.example:${port}`
  const bearer = { Authorization: `Bearer ${token}` }
  for (const path of ['/api/bizagent/local-human/status', '/api/bizagent/human-inbox',
    '/api/bizagent/shared-knowledge/decision', '/api/bizagent/project-review?projectId=alice-project',
    '/api/bizagent/v1/proposals/decision?ownerAddress=personal%3Aalice&proposalId=p']) {
    const read = await raw(path, { headers: { ...bearer, Host: rebinding } })
    assert.equal(read.status, 403, path)
    assert.equal(JSON.parse(read.body).error.code, 'untrusted-host')
    const crossSite = await raw(path, { headers: { ...bearer, Host: `127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(crossSite.status, 403, path)
  }
  const reviewsBefore = service.projectReviewCalls
  const rebindReview = await raw('/api/bizagent/project-review', { method: 'POST',
    headers: { ...bearer, Host: rebinding, Origin: `http://${rebinding}`, 'Content-Type': 'application/json' },
    body: review('alice-project') })
  assert.equal(rebindReview.status, 403)
  const noOriginReview = await raw('/api/bizagent/project-review', { method: 'POST',
    headers: { ...bearer, Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
    body: review('alice-project') })
  assert.equal(noOriginReview.status, 403)
  assert.equal(JSON.parse(noOriginReview.body).error.code, 'origin-rejected')
  assert.equal(service.projectReviewCalls, reviewsBefore)
  const noOriginSession = await raw('/api/bizagent/agent-session', { method: 'POST',
    headers: { ...bearer, Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeAddress: 'personal:alice' }) })
  assert.equal(noOriginSession.status, 403)
  const sameOrigin = await raw('/api/bizagent/project-review', { method: 'POST',
    headers: { ...bearer, Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' },
    body: review('alice-project') })
  assert.equal(sameOrigin.status, 200)
  assert.equal(service.projectReviewCalls, reviewsBefore + 1)

  await chmod(tokenFile, 0o644)
  await assert.rejects(() => apply({ bizagent: service, get: () => undefined, webServer: { host: '127.0.0.1' }, effect() {} }),
    /private regular file/)
  await chmod(tokenFile, 0o600)
  await assert.rejects(() => apply({ bizagent: service, get: () => undefined, webServer: { host: '0.0.0.0' }, effect() {} }),
    /bind 127\.0\.0\.1/)
})

test('in DSH Web the person signed in to DSH is the local reviewer, without any BizAgent token', async t => {
  const saved = Object.fromEntries(['BIZAGENT_LOCAL_HUMAN_ID', 'BIZAGENT_LOCAL_HUMAN_TOKEN_FILE', 'BIZAGENT_LOCAL_HUMAN']
    .map(name => [name, process.env[name]]))
  for (const name of Object.keys(saved)) delete process.env[name]
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const reviews = []
  const service = {
    config: { owner: 'qi' },
    store: { getHome: address => ({ owner: address === 'personal:default' ? 'qi' : 'someone-else' }) },
    projectLedger: { get: id => ({ id, lead: 'personal:default' }) },
    async reviewProjectAsHuman(principal, input, authorize) {
      const project = { id: input.projectId, lead: 'personal:default', status: 'awaiting_acceptance',
        revision: input.expectedRevision, currentClaimId: input.claimId }
      if (!await authorize(principal, project)) throw new Error('not authorized')
      reviews.push(principal)
      return { project: { ...project, status: 'accepted' }, review: { reviewedByPrincipal: principal } }
    },
  }
  // DSH's own login: its cookie is the only thing that admits a request.
  const connection = { requestRejection: request => request.headers.cookie === 'dsh-login=valid' ? undefined : 401 }
  const ctx = (host, sink) => ({ bizagent: service, bizagentAgentSessions: {},
    get: name => name === 'connection' ? connection : undefined,
    webServer: { host, register: route => { sink.set(route.path, route.handler); return () => sink.delete(route.path) } },
    effect: () => {} })

  const unused = new Map()
  await apply(ctx('0.0.0.0', unused))
  process.env.BIZAGENT_LOCAL_HUMAN = 'off'
  await apply(ctx('127.0.0.1', unused))
  delete process.env.BIZAGENT_LOCAL_HUMAN
  assert.equal(unused.size, 0)

  const routes = new Map()
  await apply(ctx('127.0.0.1', routes))
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (handler) void handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const statusUrl = `${origin}/api/bizagent/local-human/status`
  assert.equal((await fetch(statusUrl)).status, 401)
  assert.equal((await fetch(statusUrl, { headers: { Authorization: `Bearer ${'x'.repeat(64)}`,
    Cookie: 'dsh-login=valid' } })).status, 401, 'a wrong Bearer token is never rescued by the cookie')
  assert.deepEqual(await (await fetch(statusUrl, { headers: { Cookie: 'dsh-login=valid' } })).json(), { userId: 'qi' })
  const body = JSON.stringify({ projectId: 'p1', claimId: 'c1', expectedRevision: 2, decision: 'accept', reason: 'Checked.' })
  const reviewUrl = `${origin}/api/bizagent/project-review`
  assert.equal((await fetch(reviewUrl, { method: 'POST', body,
    headers: { Origin: origin, 'Content-Type': 'application/json' } })).status, 401)
  const accepted = await fetch(reviewUrl, { method: 'POST', body,
    headers: { Cookie: 'dsh-login=valid', Origin: origin, 'Content-Type': 'application/json' } })
  assert.equal(accepted.status, 200)
  assert.deepEqual(reviews, ['qi'])
})
