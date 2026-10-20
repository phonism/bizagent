import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { HomeStore } from '../lib/home-store.js'
import { LearningLedger } from '../lib/ledger.js'
import { BizAgentService } from '../lib/service.js'
import { resolveConfig } from '../lib/config.js'
import { BizAgentUiFacade, apply as applyUiHost } from '../lib/ui-host.js'
import { createProposalReviewHttpHandler } from '../lib/proposal-review-transport.js'
import { makeTempDir } from './temp-dir.mjs'
import { createDemoRuntime } from '../examples/demo-runtime.mjs'

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

function agent(id, cwd, text = 'Reusable learning') {
  return {
    id,
    session: {
      snapshotEvents() { return this.events },
      header: { id, cwd },
      events: [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } },
      ],
    },
  }
}

async function fixture(t) {
  const root = await makeTempDir('bizagent-ui-host-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice', displayName: 'Alice' })
  await store.createHome({ address: 'role:growth-strategy', displayName: 'Growth Strategy' })
  const ledger = await LearningLedger.open({ async open() { return new Domain() } })
  const service = new BizAgentService(store, ledger, {
    homeRoot: root,
    defaultHome: 'personal:alice',
    autoCreateDefaultHome: false,
    workspaceHomes: [],
    budget: { identityMaxBytes: 2048, indexMaxBytes: 4096 },
  })
  await service.initialize()
  t.after(() => service.close())
  return { service, root }
}

test('UI facade exposes memory strata and displays a human-reviewed target decision', async (t) => {
  const { service, root } = await fixture(t)
  await service.remember(agent('alice-remember', root), 'remember-call', {
    description: 'Use evidence before promotion',
    body: 'A reusable observation must point to a durable turn.',
    tags: ['evidence'],
  })
  const proposed = await service.proposeMemory(agent('alice-propose', root), 'proposal-call', {
    toAddress: 'role:growth-strategy',
    proposedKind: 'method',
    description: 'Review landing-page hypotheses weekly',
    body: 'Run a weekly evidence review before changing acquisition strategy.',
  })
  const proposal = proposed.proposal

  const facade = new BizAgentUiFacade(service)
  const overview = await facade.overview()
  assert.equal(overview.totals.homes, 2)
  assert.equal(overview.totals.assets, 1)
  assert.equal(overview.totals.pendingProposals, 1)
  assert.equal(overview.homes.find(home => home.address === 'personal:alice').counts.memory, 1)
  assert.equal(overview.homes.find(home => home.address === 'role:growth-strategy').incomingPending, 1)

  await assert.rejects(() => service.decideProposalAsHuman({
      ownerAddress: 'personal:alice', proposalId: proposal.id,
      action: 'accept', reviewerId: 'reviewer-1', authorityRef: 'role-owner:reviewer-1',
      decision: 'Wrong owner',
    }),
    /cannot decide a proposal owned by role:growth-strategy/,
  )

  await service.decideProposalAsHuman({
    ownerAddress: 'role:growth-strategy', proposalId: proposal.id,
    action: 'accept', reviewerId: 'reviewer-1', authorityRef: 'role-owner:reviewer-1',
    decision: 'Accepted after role-owner review.',
  })
  const role = await facade.home('role:growth-strategy')
  assert.equal(role.assets.length, 1)
  assert.equal(role.assets[0].kind, 'method')
  assert.equal(role.assets[0].proposalApplications[0].proposalId, proposal.id)
  assert.equal(role.assets[0].proposalApplications[0].revision, 1)
  assert.equal(role.proposals[0].status, 'accepted')
})

test('proposal decision HTTP route requires host human identity, mutation protection, and target authority', async t => {
  const { service, root } = await fixture(t)
  const proposal = (await service.proposeMemory(agent('alice-http-propose', root), 'http-propose', {
    toAddress: 'role:growth-strategy', proposedKind: 'knowledge',
    description: 'Review cohorts', body: 'Use matched signup cohorts.',
  })).proposal
  const handler = createProposalReviewHttpHandler(service, {
    authenticateHuman: req => req.headers['x-human'] ? { userId: String(req.headers['x-human']) } : null,
    authorizeMutation: req => req.headers['x-csrf'] === 'valid',
    authorizeProposal: (_req, principal, candidate, action) => principal.userId === 'human-owner'
      && candidate.toAddress === 'role:growth-strategy' && action === 'accept'
      ? 'role-owner:human-owner' : null,
  })
  const decide = async (headers, ownerAddress = 'role:growth-strategy') => {
    const req = Readable.from([JSON.stringify({ ownerAddress, proposalId: proposal.id,
      action: 'accept', decision: 'Reviewed for publication.' })])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', ...headers }
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
      end(value) { this.body = JSON.parse(value) } }
    await handler(req, res)
    return res
  }
  const actions = async human => {
    const req = Readable.from([])
    req.method = 'GET'
    req.url = `/api/bizagent/v1/proposals/decision?ownerAddress=role%3Agrowth-strategy&proposalId=${proposal.id}`
    req.headers = human ? { 'x-human': human } : {}
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value },
      end(value) { this.body = JSON.parse(value) } }
    await handler(req, res)
    return res
  }
  assert.equal((await actions()).statusCode, 401)
  assert.deepEqual((await actions('other-human')).body.actions, { accept: false, reject: false })
  assert.deepEqual((await actions('human-owner')).body.actions, { accept: true, reject: false })
  assert.equal((await decide({})).statusCode, 401)
  assert.equal((await decide({ 'x-human': 'human-owner' })).statusCode, 403)
  assert.equal((await decide({ 'x-human': 'other-human', 'x-csrf': 'valid' })).statusCode, 403)
  assert.equal((await decide({ 'x-human': 'human-owner', 'x-csrf': 'valid' }, 'personal:alice')).statusCode, 404)
  assert.equal(service.ledger.getProposal(proposal.id).status, 'pending')
  const approved = await decide({ 'x-human': 'human-owner', 'x-csrf': 'valid' })
  assert.equal(approved.statusCode, 200)
  assert.equal(approved.body.proposals[0].humanReview.reviewerId, 'human-owner')
  assert.equal(approved.body.proposals[0].humanReview.authorityRef, 'role-owner:human-owner')
  assert.equal(service.store.listAssets('role:growth-strategy').length, 1)
  const rejectedCandidate = (await service.proposeMemory(agent('alice-http-reject', root), 'http-reject', {
    toAddress: 'role:growth-strategy', proposedKind: 'knowledge',
    description: 'Unsupported claim', body: 'Publish an unsupported claim.',
  })).proposal
  const rejected = await service.decideProposalAsHuman({ ownerAddress: 'role:growth-strategy',
    proposalId: rejectedCandidate.id, action: 'reject', decision: 'Evidence is insufficient.',
    reviewerId: 'human-owner', authorityRef: 'role-owner:human-owner' })
  assert.equal(rejected.proposal.status, 'rejected')
  assert.equal(rejected.proposal.humanReview.reviewerId, 'human-owner')
  assert.equal(service.store.listAssets('role:growth-strategy').length, 1)
  await assert.rejects(() => service.decideProposalAsHuman({ ownerAddress: 'role:growth-strategy',
    proposalId: rejectedCandidate.id, action: 'accept', decision: 'Approve later.',
    reviewerId: 'human-owner', authorityRef: 'role-owner:human-owner' }), /different human review/)
})

test('UI Home shows bounded Worklog summaries from its own Home', async (t) => {
  const root = await makeTempDir('bizagent-ui-worklog-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: `${root}/bob`, address: 'personal:bob' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery, undefined, undefined, runtime.workLedger, runtime.projectLedger, runtime.worklogLedger)
  await service.initialize()
  t.after(() => service.close())
  await service.recordWorklog(runtime.agent('alice-ui-log', root, 'Prepare result.'), {
    description: 'Result ready', body: 'Reviewed the source and prepared the result.',
    status: 'completed', idempotencyKey: 'ui-result-v1',
  })
  const facade = new BizAgentUiFacade(service)
  const alice = facade.home('personal:alice')
  assert.equal(alice.worklogCount, 1)
  assert.equal(alice.worklogs[0].description, 'Result ready')
  assert.equal(alice.worklogs[0].sessionId, 'alice-ui-log')
  assert.equal(alice.worklogs[0].body, 'Reviewed the source and prepared the result.')
  assert.equal(facade.home('personal:bob').worklogCount, 0)
})

test('UI facade bootstraps an organization and exposes it in the overview', async (t) => {
  const { service, root } = await fixture(t)
  const facade = new BizAgentUiFacade(service)
  const overview = await facade.createOrganization({
    id: 'acme',
    name: 'Acme Agents',
    mission: 'ship useful software with evidence.',
    members: [{
      id: 'builder',
      displayName: 'Builder',
      roleId: 'engineering',
      roleName: 'Engineering',
      responsibility: 'Implement, test, and maintain the product.',
    }],
    capabilities: [{
      id: 'delivery',
      displayName: 'Product Delivery',
      responsibility: 'Retain repeatable delivery methods.',
    }],
  })

  assert.equal(overview.organization.name, 'Acme Agents')
  assert.equal(overview.organization.businessHome, 'business:acme')
  assert.equal(overview.organization.lineHome, 'line:acme')
  assert.equal(overview.homeRoot, root)
  assert.deepEqual(overview.organizationLocation, {
    organizationId: 'acme',
    organizationRoot: `${root}/orgs/acme`,
  })
  // The five organization Homes, plus the two personal-space Homes that stay outside it.
  assert.equal(overview.homes.length, 7)
  assert.deepEqual(overview.homes.filter(home => home.scope === 'personal').map(home => home.address),
    ['personal:alice', 'role:growth-strategy'])
  assert.equal(overview.homes.find(home => home.address === 'business:acme').chatWorkspacePath,
    `${root}/orgs/acme`)
  assert.equal(overview.homes.find(home => home.address === 'role:engineering').chatWorkspacePath,
    undefined)
  assert.equal(overview.homes.find(home => home.address === 'role:engineering').displayName, 'Engineering')
})

test('question card Workspace targets follow exact Business Home mappings', async t => {
  const root = await makeTempDir('bizagent-ui-chat-workspace-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new HomeStore(root)
  await store.initialize()
  for (const address of ['business:shop', 'business:other', 'business:unmapped']) {
    await store.createHome({ address })
  }
  const ledger = await LearningLedger.open({ async open() { return new Domain() } })
  const service = new BizAgentService(store, ledger, resolveConfig({ homeRoot: root,
    defaultHome: 'business:unmapped', autoCreateDefaultHome: false,
    workspaceHomes: { [`${root}/workspace`]: 'business:shop',
      [`${root}/workspace/other`]: 'business:other' },
  }))
  await service.initialize()
  t.after(() => service.close())
  const homes = (await new BizAgentUiFacade(service).overview()).homes
  assert.equal(homes.find(item => item.address === 'business:shop').chatWorkspacePath,
    `${root}/workspace`)
  assert.equal(homes.find(item => item.address === 'business:other').chatWorkspacePath,
    `${root}/workspace/other`)
  assert.equal(homes.find(item => item.address === 'business:unmapped').chatWorkspacePath,
    undefined)
})

test('Agent directory UI route uses the server-side Session and rechecks selected targets', async (t) => {
  const { service, root } = await fixture(t)
  await service.store.createHome({ address: 'personal:bob', displayName: 'Bob' })
  const routes = new Map()
  const sessionEvents = []
  applyUiHost({
    bizagent: service,
    get: () => undefined,
    sessionQuery: { async readSession(id) {
      if (String(id) !== 'directory-session') throw new Error('missing Session')
      return { session: { id, cwd: root }, events: sessionEvents }
    } },
    webServer: { host: '127.0.0.1',
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect() {},
  })
  const get = async (path) => {
    const response = { statusCode: 0, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value },
      end(body) { this.body = body },
    }
    await routes.get(new URL(path, 'http://127.0.0.1:4100').pathname).handler({
      method: 'GET', url: path, headers: { host: '127.0.0.1:4100' },
    }, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
  const listed = await get('/api/bizagent/v1/agents?sessionId=directory-session')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.homes.map(home => home.address), ['personal:alice', 'role:growth-strategy'])
  assert.equal(service.ledger.getBinding('directory-session').homeAddress, 'personal:alice')
  const selected = await get('/api/bizagent/v1/agents/resolve?sessionId=directory-session&target=Growth%20Strategy')
  assert.deepEqual(selected.body, { address: 'role:growth-strategy', type: 'role', displayName: 'Growth Strategy' })
  await service.openFrame(agent('directory-session', root), { address: 'role:growth-strategy', mode: 'lead' })
  const frames = await get('/api/bizagent/v1/frames?sessionId=directory-session')
  assert.equal(frames.status, 200)
  assert.deepEqual(frames.body.primaryHome, { address: 'personal:alice', displayName: 'Alice', scope: 'personal' })
  assert.deepEqual(frames.body.frames, [{ address: 'role:growth-strategy', displayName: 'Growth Strategy',
    mode: 'lead', focused: true, refreshRequired: false }])
  sessionEvents.push({ seq: 2, type: 'compaction/end', data: {} })
  const stale = await get('/api/bizagent/v1/frames?sessionId=directory-session')
  assert.equal(stale.body.frames[0].refreshRequired, true)
  const privateTarget = await get('/api/bizagent/v1/agents/resolve?sessionId=directory-session&target=personal:bob')
  assert.equal(privateTarget.status, 409)
  // The route returns a stable code; the service keeps the specific reason server-side.
  assert.equal(privateTarget.body.error.code, 'operation-rejected')
  assert.doesNotMatch(privateTarget.body.error.message, /personal:bob|not found or inaccessible/)
  await assert.rejects(() => service.resolveHomeForSession('directory-session', root, 'personal:bob'),
    /not found or inaccessible/)
  const unknown = await get('/api/bizagent/v1/agents?sessionId=unknown')
  assert.equal(unknown.status, 400)
  assert.equal((await get('/api/bizagent/v1/frames?sessionId=unknown')).status, 400)
  assert.equal(service.ledger.getBinding('unknown'), undefined)
})

test('UI host remains a separate optional Cordis adapter', async (t) => {
  const { service } = await fixture(t)
  const routes = new Map()
  const disposers = []
  const ctx = {
    bizagent: service,
    webServer: {
      host: '127.0.0.1',
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(effect) {
      const dispose = effect()
      disposers.push(dispose)
      return dispose
    },
  }
  applyUiHost(ctx)
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/bizagent/v1/agents',
    '/api/bizagent/v1/agents/resolve',
    '/api/bizagent/v1/frames',
    '/api/bizagent/v1/home',
    '/api/bizagent/v1/homes',
    '/api/bizagent/v1/learning/schedule',
    '/api/bizagent/v1/learning/schedule/configure',
    '/api/bizagent/v1/learning/use-outcomes',
    '/api/bizagent/v1/organization',
    '/api/bizagent/v1/organization/sample',
    '/api/bizagent/v1/overview',
    '/api/bizagent/v1/projects',
    '/api/bizagent/v1/projects/detail',
    '/api/bizagent/v1/session-context',
    '/api/bizagent/v1/sessions',
  ])
  for (const dispose of disposers.reverse()) await dispose()
  assert.equal(routes.size, 0)
})

test('Project UI routes retain Session Home visibility', async t => {
  const root = await makeTempDir('bizagent-ui-projects-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = await createDemoRuntime()
  const store = new HomeStore(root)
  await store.initialize()
  await store.createHome({ address: 'personal:alice' })
  await store.createHome({ address: 'personal:bob' })
  const service = new BizAgentService(store, runtime.ledger, {
    homeRoot: root, defaultHome: 'personal:alice', autoCreateDefaultHome: false,
    workspaceHomes: [{ root: join(root, 'bob'), address: 'personal:bob' }],
    budget: { identityMaxBytes: 1024, indexMaxBytes: 2048 },
  }, runtime.sessionQuery, undefined, undefined, runtime.workLedger, runtime.projectLedger)
  await service.initialize()
  t.after(() => service.close())
  const lead = runtime.agent('ui-project-lead', root, 'Start a project.')
  runtime.agent('ui-project-bob', join(root, 'bob'), 'Read available projects.')
  const project = (await service.createProject(lead, {
    title: 'Evidence review', goal: 'Collect evidence.', doneWhen: 'Evidence is accepted.',
    idempotencyKey: 'ui-project-review',
  })).project
  const routes = new Map()
  applyUiHost({ bizagent: service, get: () => undefined, sessionQuery: runtime.sessionQuery,
    webServer: { host: '127.0.0.1',
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect() {} })
  const get = async path => {
    const response = { statusCode: 0, body: '', setHeader() {}, end(body) { this.body = body } }
    await routes.get(new URL(path, 'http://127.0.0.1:4100').pathname).handler({
      method: 'GET', url: path, headers: { host: '127.0.0.1:4100' },
    }, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
  const mine = await get('/api/bizagent/v1/projects?sessionId=ui-project-lead')
  assert.equal(mine.status, 200)
  assert.equal(mine.body.homeAddress, 'personal:alice')
  assert.deepEqual(mine.body.projects.map(item => item.id), [project.id])
  const detail = await get(`/api/bizagent/v1/projects/detail?sessionId=ui-project-lead&projectId=${project.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.project.goal, 'Collect evidence.')
  const other = await get('/api/bizagent/v1/projects?sessionId=ui-project-bob')
  assert.deepEqual(other.body.projects, [])
  const hidden = await get(`/api/bizagent/v1/projects/detail?sessionId=ui-project-bob&projectId=${project.id}`)
  assert.notEqual(hidden.status, 200)
  assert.equal(hidden.body.error.code, 'operation-rejected')
  assert.doesNotMatch(hidden.body.error.message, /not visible|Evidence review/)
  await assert.rejects(() => service.readProjectForSession('ui-project-bob', join(root, 'bob'), project.id),
    /not visible/)
  assert.notEqual((await get('/api/bizagent/v1/projects?sessionId=unknown')).status, 200)
  const asset = await store.createAsset({ id: 'ui-use-asset', ownerAddress: 'personal:alice',
    kind: 'method', description: 'Use in later Work', body: 'Compare like for like.', status: 'active',
    sourceRefs: [{ type: 'document', uri: 'test:ui-use', digest: 'test' }] })
  const usePath = `/api/bizagent/v1/learning/use-outcomes?assetId=${asset.id}`
  const uses = await get(`${usePath}&sessionId=ui-project-lead`)
  assert.equal(uses.status, 200)
  assert.equal(uses.body.homeAddress, 'personal:alice')
  assert.deepEqual(uses.body.outcomes, [])
  const denied = await get(`${usePath}&sessionId=ui-project-bob`)
  assert.notEqual(denied.status, 200)
  assert.notEqual((await get(`${usePath}&sessionId=unknown`)).status, 200)
})

test('learning schedule UI mutation checks origin and forwards revision to the host scheduler', async t => {
  const { service } = await fixture(t)
  const routes = new Map()
  const calls = []
  const scheduler = {
    status(home) { return { homeAddress: home, configured: true } },
    async configure(home, input) {
      calls.push({ home, input })
      return { homeAddress: home, policy: { revision: input.expectedRevision + 1 } }
    },
  }
  applyUiHost({ bizagent: service, get: () => undefined, bizagentLearningScheduler: scheduler,
    webServer: { host: '127.0.0.1',
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect() {},
  })
  const handler = routes.get('/api/bizagent/v1/learning/schedule/configure').handler
  const send = async origin => {
    const response = { statusCode: 0, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value },
      end(body) { this.body = body },
    }
    const request = { method: 'POST', url: '/api/bizagent/v1/learning/schedule/configure',
      headers: { host: '127.0.0.1:4100', origin, 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({
        home: 'personal:alice', expectedRevision: 4, enabled: false,
        cron: '0 3 * * *', dailyRuns: 1,
      })) },
    }
    await handler(request, response)
    return response
  }
  assert.equal((await send('https://attacker.local')).statusCode, 403)
  assert.equal(calls.length, 0)
  const allowed = await send('http://127.0.0.1:4100')
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(calls[0], { home: 'personal:alice', input: {
    home: 'personal:alice', expectedRevision: 4, enabled: false,
    cron: '0 3 * * *', dailyRuns: 1,
  } })
})

function routeHarness(service, extra = {}) {
  const routes = new Map()
  applyUiHost({ bizagent: service, get: name => extra.services?.[name], ...extra,
    webServer: { host: '127.0.0.1',
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect() {} })
  return async (path, { method = 'GET', headers = {}, body } = {}) => {
    const response = { statusCode: 0, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value },
      end(value) { this.body = value },
    }
    const request = { method, url: path, headers,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    await routes.get(new URL(path, 'http://127.0.0.1').pathname).handler(request, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
}

const ORGANIZATION_REQUEST = (_root, id = 'acme') => ({
  id, name: 'Acme Agents', mission: 'ship useful software.',
  members: [{ id: 'builder', displayName: 'Builder', roleId: 'engineering', roleName: 'Engineering',
    responsibility: 'Implement and test the product.' }],
  capabilities: [],
})

test('UI routes reject DNS-rebinding hosts, cross-site fetches, and mutations without a same-origin Origin', async t => {
  const { service, root } = await fixture(t)
  const call = routeHarness(service)
  const loopback = '127.0.0.1:4100'
  const rebinding = 'rebind.attacker.example:4100'
  const json = { 'content-type': 'application/json' }

  for (const path of ['/api/bizagent/v1/overview', '/api/bizagent/v1/home?address=personal%3Aalice']) {
    const read = await call(path, { headers: { host: rebinding } })
    assert.equal(read.status, 403)
    assert.equal(read.body.error.code, 'untrusted-host')
    assert.equal(read.body.homes, undefined)
    assert.equal(read.body.identity, undefined)
  }
  const rebindWrite = await call('/api/bizagent/v1/organization', { method: 'POST',
    headers: { ...json, host: rebinding, origin: `http://${rebinding}` }, body: ORGANIZATION_REQUEST(root) })
  assert.equal(rebindWrite.status, 403)
  assert.equal(rebindWrite.body.error.code, 'untrusted-host')
  assert.equal(service.store.getOrganization(), undefined)
  for (const host of ['localhost.attacker.example:4100', '127.0.0.1.attacker.example', 'evil@127.0.0.1:4100', '']) {
    assert.equal((await call('/api/bizagent/v1/overview', { headers: { host } })).status, 403, host)
  }
  assert.equal((await call('/api/bizagent/v1/overview', { headers: {} })).status, 403)

  const crossSite = await call('/api/bizagent/v1/overview',
    { headers: { host: loopback, 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body.error.code, 'cross-site-request')
  const crossOriginRead = await call('/api/bizagent/v1/overview',
    { headers: { host: loopback, origin: 'http://127.0.0.1:3000' } })
  assert.equal(crossOriginRead.status, 403)

  const noOrigin = await call('/api/bizagent/v1/homes', { method: 'POST',
    headers: { ...json, host: loopback }, body: { address: 'role:intruder' } })
  assert.equal(noOrigin.status, 403)
  assert.equal(noOrigin.body.error.code, 'origin-rejected')
  for (const origin of ['http://127.0.0.1:3000', 'null', `http://${rebinding}`]) {
    const rejected = await call('/api/bizagent/v1/homes', { method: 'POST',
      headers: { ...json, host: loopback, origin }, body: { address: 'role:intruder' } })
    assert.equal(rejected.status, 403, origin)
  }
  assert.equal(service.store.hasHome('role:intruder'), false)

  for (const host of [loopback, 'localhost:4100', '[::1]:4100', '127.0.0.1']) {
    const read = await call('/api/bizagent/v1/overview',
      { headers: { host, 'sec-fetch-site': 'same-origin' } })
    assert.equal(read.status, 200, host)
    assert.equal(read.body.totals.homes, 2)
  }
  const created = await call('/api/bizagent/v1/homes', { method: 'POST',
    headers: { ...json, host: loopback, origin: `http://${loopback}`, 'sec-fetch-site': 'same-origin' },
    body: { address: 'role:reviewer' } })
  assert.equal(created.status, 200)
  assert.equal(service.store.hasHome('role:reviewer'), true)
})

test('UI route errors return stable codes without raw exception text or absolute paths', async t => {
  const { service, root } = await fixture(t)
  const call = routeHarness(service)
  const headers = { 'content-type': 'application/json', host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100' }
  const first = await call('/api/bizagent/v1/organization', { method: 'POST', headers, body: ORGANIZATION_REQUEST(root) })
  assert.equal(first.status, 200)
  const activeRoot = service.store.root
  await assert.rejects(() => service.createOrganization(ORGANIZATION_REQUEST(root, 'other')),
    new RegExp(`organization already exists at ${activeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const conflict = await call('/api/bizagent/v1/organization', { method: 'POST', headers,
    body: ORGANIZATION_REQUEST(root, 'other') })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'operation-rejected')
  assert.equal(JSON.stringify(conflict.body).includes(root), false)
  const missing = await call('/api/bizagent/v1/home?address=personal%3Amissing', { headers })
  assert.equal(missing.status, 409)
  assert.doesNotMatch(missing.body.error.message, /personal:missing|not found/)
  const invalid = await call('/api/bizagent/v1/homes', { method: 'POST', headers, body: { address: 1 } })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid-request')
  assert.match(invalid.body.error.message, /address/)
})

test('UI host refuses to register routes unless DSH Web binds loopback', async t => {
  const { service } = await fixture(t)
  const routes = new Map()
  assert.throws(() => applyUiHost({ bizagent: service, get: () => undefined,
    webServer: { host: '0.0.0.0', register(route) { routes.set(route.path, route); return () => {} } },
    effect() {} }), /require DSH Web to bind 127\.0\.0\.1/)
  assert.equal(routes.size, 0)
})

test('UI routes require DSH browser login when the host provides it', async t => {
  const { service } = await fixture(t)
  const connection = { requestRejection: request => request.headers.cookie === 'dsh-login=valid' ? undefined : 401 }
  const call = routeHarness(service, { services: { connection } })
  const headers = { host: '127.0.0.1:4100' }
  for (const path of ['/api/bizagent/v1/sessions', '/api/bizagent/v1/session-context?sessionId=untrusted']) {
    assert.equal((await call(path, { headers })).status, 401)
  }
  const anonymous = await call('/api/bizagent/v1/overview', { headers })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.body.error.code, 'authentication-required')
  assert.equal((await call('/api/bizagent/v1/overview', { headers: { ...headers, cookie: 'dsh-login=valid' } })).status, 200)
  const create = await call('/api/bizagent/v1/homes', { method: 'POST',
    headers: { ...headers, origin: 'http://127.0.0.1:4100', 'content-type': 'application/json' },
    body: { address: 'role:sneaky' } })
  assert.equal(create.status, 401)
  assert.equal(service.store.hasHome('role:sneaky'), false)
})

test('the sample team is one request away and comes with its data file', async t => {
  const { service: base, root } = await fixture(t)
  const service = new BizAgentService(base.store, base.ledger, { ...base.config, owner: 'qi' })
  const call = routeHarness(service)
  const headers = { 'content-type': 'application/json', host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100' }
  const created = await call('/api/bizagent/v1/organization/sample', { method: 'POST', headers, body: {} })
  assert.equal(created.status, 200)
  assert.equal(created.body.organization.id, 'sample-shop')
  assert.equal(created.body.organizationLocation.organizationRoot, `${root}/orgs/sample-shop`)
  const team = created.body.homes.filter(home => home.scope === 'organization')
  assert.deepEqual(team.map(home => home.address).sort(), ['business:sample-shop', 'capability:metrics',
    'line:sample-shop', 'personal:data-analyst', 'personal:growth-lead', 'role:analytics', 'role:growth'])
  assert.deepEqual([...new Set(team.map(home => service.store.getHome(home.address).owner))], ['qi'])
  const orders = await readFile(join(service.store.homeWorkspacePath('personal:data-analyst'), 'orders.csv'), 'utf8')
  assert.match(orders, /A4,refunded,60\.00/)
  // Both Homes belong to the same person, so Work between them starts on its own.
  assert.equal(service.workAutoStartBlock('personal:growth-lead', 'personal:data-analyst'), undefined)
  const again = await call('/api/bizagent/v1/organization/sample', { method: 'POST', headers, body: {} })
  assert.equal(again.status, 200)
})
