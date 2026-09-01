import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { test } from 'node:test'
import { HomeStore } from '../lib/home-store.js'
import { LearningLedger } from '../lib/ledger.js'
import { BizAgentService } from '../lib/service.js'
import { BizAgentUiFacade, apply as applyUiHost } from '../lib/ui-host.js'

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
      header: { id, cwd },
      events: [
        { seq: 0, type: 'turn/start', data: { turn: 1 } },
        { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } },
      ],
    },
  }
}

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/bizagent-ui-host-')
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

test('UI facade exposes memory strata and settles a proposal only as its target owner', async (t) => {
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

  await assert.rejects(
    facade.decideProposal({
      ownerAddress: 'personal:alice',
      proposalId: proposal.id,
      action: 'accept',
      decision: 'Wrong owner',
      kind: 'method',
    }),
    /cannot decide a proposal owned by role:growth-strategy/,
  )

  const role = await facade.decideProposal({
    ownerAddress: 'role:growth-strategy',
    proposalId: proposal.id,
    action: 'accept',
    decision: 'Accepted after role-owner review.',
    kind: 'method',
  })
  assert.equal(role.assets.length, 1)
  assert.equal(role.assets[0].kind, 'method')
  assert.equal(role.proposals[0].status, 'accepted')
})

test('UI host remains a separate optional Cordis adapter with four bounded routes', async (t) => {
  const { service } = await fixture(t)
  const routes = new Map()
  const disposers = []
  const ctx = {
    bizagent: service,
    webServer: {
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
    '/api/bizagent/v1/home',
    '/api/bizagent/v1/homes',
    '/api/bizagent/v1/overview',
    '/api/bizagent/v1/proposals/decision',
  ])
  for (const dispose of disposers.reverse()) await dispose()
  assert.equal(routes.size, 0)
})
